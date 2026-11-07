import path from "node:path";
import { z } from "zod";

import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { contextTokensOfTranscript, resumedContextTokens } from "../usage/resumeContext";
import { shellQuoted } from "../shellQuote";
import { readSessionState, writeSessionState, type RegistryFs } from "./registry";

/** Whether a turn is under way or the session is waiting for the next prompt. */
export type TurnMark = "busy" | "idle";

const MarkHookInputSchema = z.object({
  session_id: z.uuid(),
  transcript_path: z.string().refine(path.isAbsolute),
  prompt_id: z.uuid().optional(),
  hook_event_name: z.enum(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"]),
  background_tasks: z.array(z.unknown()).optional(),
  session_crons: z.array(z.unknown()).optional(),
});

/** Decides the mark from Claude's hook input. Missing task snapshots cannot prove a session safe to interrupt. */
export function markFromHook(requested: TurnMark, payload: unknown): { readonly conversationId: string; readonly transcriptPath: string; readonly promptId?: string; readonly sessionStart: boolean; readonly mark: TurnMark } {
  const input = MarkHookInputSchema.parse(payload);
  const starts = input.hook_event_name === "SessionStart" || input.hook_event_name === "UserPromptSubmit";
  if ((requested === "busy") !== starts) {
    throw new Error(`unexpected ${input.hook_event_name} hook for a ${requested} mark`);
  }
  if (input.hook_event_name === "UserPromptSubmit" && input.prompt_id === undefined) {
    throw new Error("UserPromptSubmit did not identify its prompt");
  }
  const idle = input.hook_event_name === "Stop" && input.prompt_id !== undefined && input.background_tasks?.length === 0 && input.session_crons?.length === 0;
  return { conversationId: input.session_id, transcriptPath: input.transcript_path, ...(input.prompt_id === undefined ? {} : { promptId: input.prompt_id }), sessionStart: input.hook_event_name === "SessionStart", mark: idle ? "idle" : "busy" };
}

/** How long, in seconds, Claude Code lets a mark hook run before it gives up on it: a hook that hangs must not hold up a prompt or the end of a turn. */
const MARK_HOOK_TIMEOUT_SECONDS = 10;

/** The hidden command each hook runs. */
export const SUPERVISE_MARK_COMMAND = "__supervise-mark";

/**
 * The Claude Code settings, as the JSON `--settings` takes, whose hooks identify the current conversation and its turns. `SessionStart` and `UserPromptSubmit` mark it busy; `Stop` marks it idle only when its payload proves there is no background or scheduled work, and `StopFailure` leaves it busy. Each hook runs this executable (`invocation`) against the state root it was launched under.
 */
export function markHooksSettings(invocation: { readonly command: string; readonly args: readonly string[] }, root: string, pool: string, sessionId: string): string {
  const hook = (mark: TurnMark): readonly unknown[] => [
    {
      hooks: [
        {
          type: "command",
          command: `AGENT_SHIM_HOME=${shellQuoted(root)} ${[invocation.command, ...invocation.args, SUPERVISE_MARK_COMMAND, pool, sessionId, mark].map(shellQuoted).join(" ")}`,
          timeout: MARK_HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ];
  return JSON.stringify({ hooks: { SessionStart: hook("busy"), UserPromptSubmit: hook("busy"), Stop: hook("idle"), StopFailure: hook("idle") } });
}

/** What recording a mark needs: the state root, the clock, and the session's own configuration directory and working directory, which a hook runs in. */
export interface MarkContext {
  readonly fs: RegistryFs & Pick<FarmFs, "lstat">;
  readonly paths: LayoutPaths;
  readonly now: () => number;
  /** The `CLAUDE_CONFIG_DIR` the hook inherited from the session: where its transcript is read from. */
  readonly configDir: string | undefined;
  readonly cwd: string;
}

/** Prevents compaction when a hook cannot identify its conversation, preserving the last known state for diagnostics and later hooks. */
export function recordUnknown(context: Readonly<MarkContext>, pool: string, sessionId: string): void {
  const previous = readSessionState(context.fs, context.paths, pool, sessionId);
  writeSessionState(context.fs, context.paths, pool, sessionId, { ...previous, mark: "busy", unavailable: true, at: new Date(context.now()).toISOString() });
}

/**
 * Records that a session's turn began or ended. At the end of a turn the size of the conversation's context is read from the transcript, so the supervisor knows what the session would cost to resume; a mark never forgets what the supervisor recorded about the session before it (that it was compacted on this member).
 */
export function recordMark(context: Readonly<MarkContext>, pool: string, sessionId: string, mark: TurnMark, conversationId: string = sessionId, transcriptPath?: string, promptId?: string, ending = false, sessionStart = false): void {
  if (ending && promptId === undefined) {
    recordUnknown(context, pool, sessionId);
    return;
  }
  const previous = readSessionState(context.fs, context.paths, pool, sessionId);
  if ((mark === "idle" || ending) && promptId !== undefined && ((previous?.conversationId ?? sessionId) !== conversationId || previous?.promptId !== promptId)) {
    return;
  }
  const sameConversation = (previous?.conversationId ?? sessionId) === conversationId;
  const currentPrompt = promptId ?? (sessionStart && sameConversation ? previous?.promptId : undefined);
  let contextTokens = sameConversation ? previous?.contextTokens : undefined;
  if (mark === "idle") {
    if (transcriptPath === undefined && context.configDir === undefined) {
      throw new Error("CLAUDE_CONFIG_DIR is not set, so the session's transcript cannot be found");
    }
    const transcript = transcriptPath === undefined ? undefined : context.fs.readFileUtf8(transcriptPath);
    if (transcriptPath === undefined && context.configDir !== undefined) {
      contextTokens = resumedContextTokens(context.fs, { claudeHome: context.configDir, cwd: context.cwd, passthrough: ["--resume", conversationId] }) ?? contextTokens;
    } else if (transcript !== undefined) {
      contextTokens = contextTokensOfTranscript(transcript) ?? contextTokens;
    }
  }
  writeSessionState(context.fs, context.paths, pool, sessionId, {
    mark,
    ...(conversationId === sessionId ? {} : { conversationId }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(currentPrompt === undefined ? {} : { promptId: currentPrompt }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(sameConversation && previous?.compacted === true ? { compacted: true } : {}),
    at: new Date(context.now()).toISOString(),
  });
}

import type { FarmFs } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { resumedContextTokens } from "../usage/resumeContext";
import { readSessionState, writeSessionState, type RegistryFs } from "./registry";

/** Whether a turn is under way or the session is waiting for the next prompt. */
export type TurnMark = "busy" | "idle";

/** How long, in seconds, Claude Code lets a mark hook run before it gives up on it: a hook that hangs must not hold up a prompt or the end of a turn. */
const MARK_HOOK_TIMEOUT_SECONDS = 10;

/** The hidden command each hook runs. */
export const SUPERVISE_MARK_COMMAND = "__supervise-mark";

/** A string made safe to put in a POSIX shell command line. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The Claude Code settings, as the JSON `--settings` takes, whose hooks tell the supervisor when a turn begins and ends: `UserPromptSubmit` marks the session busy, and `Stop` and `StopFailure` (a turn that ended on an API error, such as a refused quota, does not fire `Stop`) mark it idle. Each hook runs this very executable (`invocation`) against the state root it was launched under. An older Claude Code that does not know an event name ignores it.
 */
export function markHooksSettings(invocation: { readonly command: string; readonly args: readonly string[] }, root: string, pool: string, sessionId: string): string {
  const hook = (mark: TurnMark): readonly unknown[] => [
    {
      hooks: [
        {
          type: "command",
          command: `AGENT_SHIM_HOME=${shellQuote(root)} ${[invocation.command, ...invocation.args, SUPERVISE_MARK_COMMAND, pool, sessionId, mark].map(shellQuote).join(" ")}`,
          timeout: MARK_HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ];
  return JSON.stringify({ hooks: { UserPromptSubmit: hook("busy"), Stop: hook("idle"), StopFailure: hook("idle") } });
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

/**
 * Records that a session's turn began or ended. At the end of a turn the size of the conversation's context is read from the transcript, so the supervisor knows what the session would cost to resume; a mark never forgets what the supervisor recorded about the session before it (that it was compacted on this member).
 */
export function recordMark(context: Readonly<MarkContext>, pool: string, sessionId: string, mark: TurnMark): void {
  const previous = readSessionState(context.fs, context.paths, pool, sessionId);
  let contextTokens = previous?.contextTokens;
  if (mark === "idle") {
    if (context.configDir === undefined) {
      throw new Error("CLAUDE_CONFIG_DIR is not set, so the session's transcript cannot be found");
    }
    contextTokens = resumedContextTokens(context.fs, { claudeHome: context.configDir, cwd: context.cwd, passthrough: ["--resume", sessionId] }) ?? contextTokens;
  }
  writeSessionState(context.fs, context.paths, pool, sessionId, {
    mark,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(previous?.compacted === true ? { compacted: true } : {}),
    at: new Date(context.now()).toISOString(),
  });
}

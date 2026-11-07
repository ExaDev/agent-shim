import { readFileSync } from "node:fs";
import type { Command } from "commander";

import type { CommandDeps } from "../cli/commandDeps";
import { realFarmFs, realIsProcessRunning, realSleepSync } from "../realPorts";
import { announceHook, type HookGuard } from "./hookGuard";
import { markFromHook, recordMark, recordUnknown, SUPERVISE_MARK_COMMAND, type TurnMark } from "./marks";

/** The marks the hidden command accepts. */
const MARKS: readonly string[] = ["busy", "idle"];

function isTurnMark(value: string): value is TurnMark {
  return MARKS.includes(value);
}

/**
 * Registers the hidden `__supervise-mark` command, which a supervised session's hooks run at the start and end of every turn. A failure is reported on stderr and exits 1, never 2: a hook that exits 2 blocks the prompt it ran for.
 */
export function registerSuperviseMarkCommand(program: Command, deps: CommandDeps): void {
  program
    .command(`${SUPERVISE_MARK_COMMAND} <pool> <session> <mark>`, { hidden: true })
    .description("Internal: record that a supervised session's turn began or ended. Run by the session's own hooks; never by hand.")
    .action((pool: string, session: string, mark: string) => {
      const context = { fs: realFarmFs, paths: deps.paths, now: Date.now, configDir: process.env.CLAUDE_CONFIG_DIR, cwd: process.cwd() };
      let guard: HookGuard | undefined;
      try {
        const announcement = announceHook({ fs: realFarmFs, paths: deps.paths, now: Date.now, pid: process.pid, isRunning: realIsProcessRunning, sleep: realSleepSync }, pool, session);
        const raw = readFileSync(0, "utf8");
        guard = announcement.acquire();
        if (!isTurnMark(mark)) {
          throw new Error(`"${mark}" is not a turn mark: use busy or idle`);
        }
        const payload: unknown = JSON.parse(raw);
        const actual = markFromHook(mark, payload);
        recordMark(context, pool, session, actual.mark, actual.conversationId, actual.transcriptPath, actual.promptId, mark === "idle", actual.sessionStart);
        guard.finish(true, mark === "busy");
      } catch (error) {
        if (guard !== undefined) {
          try {
            recordUnknown(context, pool, session);
          } finally {
            guard.finish(false, false);
          }
        }
        console.error(`agent-shim: could not record the turn mark: ${error instanceof Error ? error.message : String(error)}`);
        deps.exit(1);
      }
    });
}

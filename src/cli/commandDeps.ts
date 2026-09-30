import type { Command } from "commander";

import { MissingInputError, PromptCancelledError } from "../cliError";
import type { PromptsPort } from "../configure";
import type { LayoutPaths } from "../paths";

/**
 * What every `claude-use` command's registration needs from `buildProgram`: where the config tree lives, the prompt surface, whether standard input is a terminal those prompts can run on, and how to end the process.
 *
 * `isInteractive` is a function rather than a snapshot so the real wiring reads `process.stdin.isTTY` at the moment a command runs, and a test can script both answers against the same program.
 */
export interface CommandDeps {
  readonly paths: LayoutPaths;
  readonly prompts: PromptsPort;
  readonly isInteractive: () => boolean;
  /** Ends the process with `code` immediately. Only the long-running `__headroom-supervisor` and `__codex-supervisor` need it (a signal must terminate it, and its servers would otherwise keep the event loop alive); every other command sets `process.exitCode` or throws, so its output is never truncated. */
  readonly exit: (code: number) => never;
}

/** Prints `value` as indented JSON on standard output: the one `--json` output format every `list`, `show`, `check`, `doctor` and `headroom status` command shares. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Appends an `Examples:` block to `command`'s help output, one `$ claude-use ...` line per entry. Every command registers at least one, so `--help` on any of them shows a runnable invocation, not just its option list.
 */
export function withExamples(command: Command, examples: readonly string[]): Command {
  return command.addHelpText("after", `\nExamples:\n${examples.map((example) => `  $ ${example}`).join("\n")}`);
}

/**
 * The confirmation every destructive `remove` verb shares. `--yes` skips it; otherwise a terminal gets a yes/no prompt (declining throws `PromptCancelledError`), and a non-terminal throws `MissingInputError` naming `--yes`, since deleting without either would be a silent destructive default.
 * @param deps - The prompt surface and terminal check.
 * @param yes - Whether `--yes` was passed.
 * @param description - What would be removed, phrased to follow "Remove ", e.g. `identity "work" and its directory`.
 */
export async function confirmRemoval(deps: CommandDeps, yes: boolean | undefined, description: string): Promise<void> {
  if (yes === true) {
    return;
  }
  if (!deps.isInteractive()) {
    throw new MissingInputError("--yes", `Confirmation to remove ${description}`);
  }
  const choice = await deps.prompts.select({
    message: `Remove ${description}?`,
    options: [
      { value: "remove", label: "Remove it" },
      { value: "keep", label: "Keep it" },
    ],
    initialValue: "keep",
  });
  if (deps.prompts.isCancel(choice) || choice === "keep") {
    throw new PromptCancelledError();
  }
}

import path from "node:path";

import { reportFatalError } from "./cliReport";
import type { CommandDeps } from "./cli/commandDeps";
import { isInvokedAsClaude } from "./claudeShim";
import { realPromptsPort } from "./configure";
import { tryRunAtIdentityShortcut } from "./identityManager";
import { resolveLayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { runClaude } from "./runClaude";

/**
 * The single entrypoint backing both the `claude` and `claude-use` binaries: one compiled artifact, dispatching on which name it was invoked as (`path.basename(process.argv[1])`).
 *
 * `claude` runs the launcher (`src/runClaude.ts`), which resolves the identity, loads and assembles the cascade for the current directory, resyncs that identity's symlink farm to match, and spawns the real `claude` binary with `CLAUDE_CONFIG_DIR` pointed at the farm.
 *
 * `claude-use` runs the Commander tree `buildProgram` (`src/program.ts`) constructs, whose `run` subcommand reaches the exact same launcher pipeline, just fed a different argv source, so a `claude`-named file on `PATH` is never required. `shim enable`/`shim disable` is the one explicit, separate action that creates or removes that `claude`-named file at all; nothing does so automatically.
 *
 * `parseAsync`, not `parse`: some Commander actions are `async` and return a promise Commander never awaits under `parse`, so a rejection there would surface as an unhandled promise rejection rather than reaching `reportFatalError`.
 */
async function main(): Promise<void> {
  const invokedName = path.basename(process.argv[1] ?? "claude-use");
  if (isInvokedAsClaude(invokedName)) {
    await runClaude();
    return;
  }
  const deps: CommandDeps = {
    paths: resolveLayoutPaths(),
    prompts: realPromptsPort,
    isInteractive: () => process.stdin.isTTY,
    exit: (code) => process.exit(code),
  };
  if (await tryRunAtIdentityShortcut(deps, process.argv.slice(2))) {
    return;
  }
  await buildProgram({ ...deps, runClaude }).parseAsync(process.argv);
}

main().catch((error: unknown) => {
  process.exitCode = reportFatalError(error, {
    writeErr: (line) => {
      console.error(line);
    },
    env: process.env,
  });
});

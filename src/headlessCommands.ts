import type { Command } from "commander";

import type { CommandDeps } from "./cli/commandDeps";
import { requireJob } from "./jobStore";
import { realFarmFs, spawnDetachedSupervisor } from "./realPorts";
import { createRealJobRunner } from "./usage/realJobRunner";
import { createRealWindowOpener } from "./usage/realWindowOpener";

/**
 * Registers the hidden `__open-window` and `__run-job` internal subcommands: the front door starts each as a short-lived child (see `usage/childRun.ts`) so the launch they make runs in a process of its own. They exit 0 when the work succeeded and print why to standard error and exit 1 when it did not.
 */
export function registerHeadlessCommands(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  program
    .command("__open-window <identity>", { hidden: true })
    .description("Internal: open a five-hour window for an identity with one request. Started by the front door's window keeper.")
    .action(async (identity: string) => {
      await createRealWindowOpener({ paths, cwd: process.cwd(), spawnDaemon: spawnDetachedSupervisor })(identity);
    });
  program
    .command("__run-job <name> <identity>", { hidden: true })
    .description("Internal: run a job as an identity. Started by the front door's job keeper.")
    .action(async (name: string, identity: string) => {
      await createRealJobRunner({ paths, spawnDaemon: spawnDetachedSupervisor, fs: realFarmFs, now: () => new Date() })(name, identity, requireJob(paths, name));
    });
}

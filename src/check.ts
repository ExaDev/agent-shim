import path from "node:path";
import type { Command } from "commander";
import { printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { checkReportHasWarnings, checkReportToJson, collectCheckReport, formatCheckReport } from "./checkReport";

/**
 * Registers `agent-shim check [path] [--identity <name>] [--json] [--strict]` onto `program`: parses the options, asks `collectCheckReport` (in `src/checkReport.ts`, which performs the real I/O and is exported by the library) for the report, and prints it as text or JSON.
 */
export function registerCheckCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const command = program
    .command("check [path]")
    .description(
      "Show what a launch in a directory would share or hide and why, plus credential and settings diagnostics. Never touches the farm or spawns claude.",
    )
    .option("--identity <name>", "Identity to check (defaults to the identity a launch there would resolve).")
    .option("--json", "Print the report as JSON.")
    .option("--strict", "Exit 1 when the report carries any warning, not only on errors.")
    .action((pathArg: string | undefined, options: Readonly<{ identity?: string; json?: boolean; strict?: boolean }>) => {
      const cwd = pathArg === undefined ? process.cwd() : path.resolve(pathArg);
      const report = collectCheckReport({ paths, cwd, ...(options.identity === undefined ? {} : { identity: options.identity }), env: process.env });

      if (options.json === true) {
        printJson(checkReportToJson(report));
      } else {
        for (const line of formatCheckReport(report)) {
          console.log(line);
        }
      }
      if (options.strict === true && checkReportHasWarnings(report)) {
        process.exitCode = 1;
      }
    });
  withExamples(command, ["agent-shim check", "agent-shim check ~/work/acme --identity work --json", "agent-shim check --strict"]);
}

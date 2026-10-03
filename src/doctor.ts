import type { Command } from "commander";
import { printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { collectDoctorReport, formatDoctorReport } from "./doctorReport";

/**
 * Registers `agent-shim doctor` onto `program`: asks `collectDoctorReport` (in `src/doctorReport.ts`, which performs the real I/O and is exported by the library) for the report, and prints it as text or JSON.
 */
export function registerDoctorCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const command = program
    .command("doctor")
    .description(
      "Audit the whole ~/.agent-shim config graph: every identity, every configuration profile's extends " +
        "chain, every provider, directory-rules.json, config.json, categories.local.json, active-identity, and real Claude " +
        "Code binary discoverability. Identity/directory-agnostic, unlike `check`. Exits 1 when any check fails.",
    )
    .option("--json", "Print the report as JSON.")
    .action((options: Readonly<{ json?: boolean }>) => {
      const report = collectDoctorReport({ paths, env: process.env });

      if (options.json === true) {
        printJson(report);
      } else {
        for (const line of formatDoctorReport(report)) {
          console.log(line);
        }
      }
      if (!report.ok) {
        process.exitCode = 1;
      }
    });
  withExamples(command, ["agent-shim doctor", "agent-shim doctor --json"]);
}

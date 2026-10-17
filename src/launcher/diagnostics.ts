import type { Diagnostic } from "../resolve/types";
import { unclassifiedEntryMessage } from "../resolve/decide";
import type { LogPort } from "./ports";

/** One line a launch prints for its resolution diagnostics: how serious it is and the text, which already carries the `agent-shim:` prefix and the diagnostic's code. */
interface DiagnosticLine {
  readonly severity: "error" | "warning";
  readonly text: string;
}

/**
 * The lines a launch prints for `diagnostics`, in the order they were raised, with informational ones left out. Every unclassified entry the launch found is reported by one line, at the place the first was raised: a directory with several unknown entries would otherwise repeat the same fix sentence once for each.
 */
export function diagnosticLines(diagnostics: readonly Diagnostic[]): readonly DiagnosticLine[] {
  const unclassified = [...new Set(diagnostics.filter((diagnostic) => diagnostic.code === "UNCLASSIFIED_ENTRY").map((diagnostic) => diagnostic.subject))];
  const lines: DiagnosticLine[] = [];
  let unclassifiedReported = false;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "info") {
      continue;
    }
    if (diagnostic.code === "UNCLASSIFIED_ENTRY") {
      if (!unclassifiedReported) {
        unclassifiedReported = true;
        lines.push({ severity: diagnostic.severity, text: `agent-shim: ${diagnostic.code}: ${unclassifiedEntryMessage(unclassified.filter((name): name is string => name !== undefined))}` });
      }
      continue;
    }
    lines.push({ severity: diagnostic.severity, text: `agent-shim: ${diagnostic.code}: ${diagnostic.message}` });
  }
  return lines;
}

/** Prints `diagnostics` through `log`: errors as errors, or as warnings when `errorsAsWarnings` says the launch carries on regardless (a read-only decision), and warnings as warnings. */
export function reportDiagnostics(log: Pick<LogPort, "warn" | "error">, diagnostics: readonly Diagnostic[], options: Readonly<{ errorsAsWarnings: boolean }>): void {
  for (const line of diagnosticLines(diagnostics)) {
    if (line.severity === "error" && !options.errorsAsWarnings) {
      log.error(line.text);
    } else {
      log.warn(line.text);
    }
  }
}

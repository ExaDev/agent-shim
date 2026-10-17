import { describe, expect, it, vi } from "vitest";

import { unclassifiedEntryMessage } from "../resolve/decide";
import type { Diagnostic } from "../resolve/types";
import { diagnosticLines, reportDiagnostics } from "./diagnostics";

const unclassified = (subject: string): Diagnostic => ({ code: "UNCLASSIFIED_ENTRY", severity: "warning", message: unclassifiedEntryMessage([subject]), subject });
const other: Diagnostic = { code: "SECRET_PATH_NEUTRALISED", severity: "warning", message: "a secret path override is ignored", subject: "x" };

describe("unclassifiedEntryMessage", () => {
  it("names one entry as the category map's own wording always has", () => {
    expect(unclassifiedEntryMessage(["a"])).toBe('"a" is not in the category map, so it is excluded. Run `agent-shim configure` to classify it.');
  });

  it("counts and lists several entries and says the fix once", () => {
    expect(unclassifiedEntryMessage(["a", "b"])).toBe('2 entries are not in the category map, so they are excluded: "a", "b". Run `agent-shim configure` to classify them.');
  });
});

describe("diagnosticLines", () => {
  it("keeps a single unclassified entry's own line", () => {
    expect(diagnosticLines([unclassified("a")])).toEqual([{ severity: "warning", text: 'agent-shim: UNCLASSIFIED_ENTRY: "a" is not in the category map, so it is excluded\n  Run `agent-shim configure` to classify it.' }]);
  });

  it("reports several unclassified entries as one line, once each, at the place the first was raised", () => {
    const lines = diagnosticLines([other, unclassified("a"), unclassified("b"), unclassified("a"), { ...other, subject: "y" }]);

    expect(lines.map((line) => line.text)).toEqual([
      "agent-shim: SECRET_PATH_NEUTRALISED: a secret path override is ignored",
      'agent-shim: UNCLASSIFIED_ENTRY: 2 entries are not in the category map, so they are excluded: "a", "b"\n  Run `agent-shim configure` to classify them.',
      "agent-shim: SECRET_PATH_NEUTRALISED: a secret path override is ignored",
    ]);
  });

  it("leaves informational diagnostics out and prints nothing for none", () => {
    expect(diagnosticLines([{ code: "FARM_SWAP_RECOVERED", severity: "info", message: "recovered" }])).toEqual([]);
    expect(diagnosticLines([])).toEqual([]);
  });
});

describe("reportDiagnostics", () => {
  const errorDiagnostic: Diagnostic = { code: "SECRET_PATH_NEUTRALISED", severity: "error", message: "refused" };

  it("prints an error as an error and a warning as a warning", () => {
    const log = { warn: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>() };

    reportDiagnostics(log, [errorDiagnostic, other], { errorsAsWarnings: false });

    expect(log.error).toHaveBeenCalledWith("agent-shim: SECRET_PATH_NEUTRALISED: refused");
    expect(log.warn).toHaveBeenCalledWith("agent-shim: SECRET_PATH_NEUTRALISED: a secret path override is ignored");
  });

  it("prints an error as a warning when the launch carries on regardless", () => {
    const log = { warn: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>() };

    reportDiagnostics(log, [errorDiagnostic], { errorsAsWarnings: true });

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("agent-shim: SECRET_PATH_NEUTRALISED: refused");
  });
});

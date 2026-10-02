import { describe, expect, it } from "vitest";

import * as library from "./index";

describe("library surface", () => {
  it("exposes the module groups", () => {
    expect(typeof library.resolveDecisions).toBe("function");
    expect(typeof library.resyncFarm).toBe("function");
    expect(typeof library.startConnectServer).toBe("function");
    expect(typeof library.runFrontDoorSupervisor).toBe("function");
    expect(typeof library.runSupervisor).toBe("function");
    expect(typeof library.evaluateAmbientCredentialGuard).toBe("function");
    expect(typeof library.readUsageSnapshot).toBe("function");
  });

  it("exposes nothing that exists for the command line alone", () => {
    const names = Object.keys(library);
    for (const cliOnly of ["buildProgram", "registerCheckCommand", "registerDoctorCommand", "reportFatalError", "runDoctor"]) {
      expect(names).not.toContain(cliOnly);
    }
  });

  it("runs the ambient-credential guard in process", () => {
    expect(library.detectAmbientCredential({ ANTHROPIC_API_KEY: "set" })).toEqual({ variable: "ANTHROPIC_API_KEY" });
    expect(library.detectAmbientCredential({})).toBeUndefined();
  });

  it("reads a usage snapshot through an injected filesystem and validates it with the exported schema", () => {
    const snapshot = {
      schemaVersion: 1,
      identity: "work",
      updatedAt: "2026-10-02T10:00:00.000Z",
      providers: { anthropic: { lastRequestAt: "2026-10-02T10:00:00.000Z", lastStatus: 200 } },
    };
    const fs = { readFileUtf8: (file: string): string | undefined => (file === library.snapshotPath("/snapshots", "work") ? JSON.stringify(snapshot) : undefined) };
    expect(library.readUsageSnapshot(fs, "/snapshots", "work")).toEqual(snapshot);
    expect(library.readUsageSnapshot(fs, "/snapshots", "other")).toBeUndefined();
    expect(library.UsageSnapshotSchema.safeParse({ ...snapshot, extra: true }).success).toBe(false);
  });
});

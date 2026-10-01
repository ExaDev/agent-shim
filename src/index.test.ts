import { describe, expect, it } from "vitest";

import * as library from "./index";

describe("library surface", () => {
  it("exposes the three module groups", () => {
    expect(typeof library.resolveDecisions).toBe("function");
    expect(typeof library.resyncFarm).toBe("function");
    expect(typeof library.startMitmServer).toBe("function");
    expect(typeof library.runSupervisor).toBe("function");
    expect(typeof library.evaluateAmbientCredentialGuard).toBe("function");
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
});

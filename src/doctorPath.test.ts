import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as realPorts from "./realPorts";
import { collectDoctorReport } from "./doctorReport";
import { findingsFor } from "./doctorTestFixtures";
import { buildLayoutPaths } from "./paths";

const FALLBACK_BINARY_BYTES = 1_048_576;
const EXECUTABLE_MODE = 0o755;

describe("collectDoctorReport: PATH dispatchers", () => {
  let root: string;
  let shimDir: string;
  let fallbackDir: string;
  let ownDir: string;
  let own: string;
  let mise: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-mise-"));
    shimDir = path.join(root, "shims");
    fallbackDir = path.join(root, "fallback");
    ownDir = path.join(root, "own");
    for (const dir of [shimDir, fallbackDir, ownDir]) fs.mkdirSync(dir);
    own = path.join(ownDir, "agent-shim");
    mise = path.join(root, "mise");
    fs.writeFileSync(own, "installed", { mode: EXECUTABLE_MODE });
    vi.spyOn(realPorts, "realOwnExecutablePath").mockImplementation(() => own);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeMise(script: string, command = "agent-shim"): void {
    fs.writeFileSync(mise, script, { mode: EXECUTABLE_MODE });
    fs.symlinkSync(mise, path.join(shimDir, command));
  }

  function inactiveMise(): void {
    writeMise("#!/bin/sh\necho not currently active >&2\nexit 1\n");
  }

  function report(env: NodeJS.ProcessEnv = { PATH: [shimDir, fallbackDir, ownDir].join(path.delimiter) }) {
    return collectDoctorReport({ paths: buildLayoutPaths(root), env });
  }

  function severity(): string | undefined {
    return findingsFor(report(), "path-resolution")[0]?.severity;
  }

  it("does not trust a shell wrapper whose target contains a glob", () => {
    ownDir = path.join(root, "own*");
    fs.mkdirSync(ownDir);
    own = path.join(ownDir, "agent-shim");
    fs.writeFileSync(own, "installed", { mode: EXECUTABLE_MODE });
    inactiveMise();
    fs.writeFileSync(path.join(fallbackDir, "agent-shim"), `#!/bin/sh\nexec ${own} "$@"\n`, { mode: EXECUTABLE_MODE });
    expect(severity()).toBe("fail");
  });

  it("keeps reporting when a fallback cannot be read", () => {
    inactiveMise();
    const fallback = path.join(fallbackDir, "agent-shim");
    fs.writeFileSync(fallback, `#!/bin/sh\nexec ${own} "$@"\n`, { mode: EXECUTABLE_MODE });
    const read = realPorts.realFsPort.readFileUtf8;
    vi.spyOn(realPorts.realFsPort, "readFileUtf8").mockImplementation((file) => { if (file === fallback) throw new Error("permission denied"); return read(file); });
    expect(() => report()).not.toThrow();
  });

  it("recognises a direct shell wrapper reached by an inactive mise shim", () => {
    inactiveMise();
    fs.writeFileSync(path.join(fallbackDir, "agent-shim"), `#!/bin/sh\nexec ${own} "$@"\n`, { mode: EXECUTABLE_MODE });
    expect(severity()).toBe("pass");
  });

  it("reports the shadow when mise cannot be started", () => {
    writeMise("#!/nonexistent/doctor-mise-interpreter\n");
    fs.symlinkSync(own, path.join(fallbackDir, "agent-shim"));
    expect(() => report()).not.toThrow();
  });

  it("does not infer a fallback after an unexpected mise failure", () => {
    writeMise("#!/bin/sh\necho unexpected failure >&2\nexit 1\n");
    fs.symlinkSync(own, path.join(fallbackDir, "agent-shim"));
    expect(severity()).toBe("fail");
  });

  it("does not read an entire fallback binary as a shell wrapper", () => {
    inactiveMise();
    const fallback = path.join(fallbackDir, "agent-shim");
    fs.writeFileSync(fallback, Buffer.alloc(FALLBACK_BINARY_BYTES), { mode: EXECUTABLE_MODE });
    const reads = vi.spyOn(realPorts.realFsPort, "readFileUtf8");
    report();
    expect(reads.mock.calls.some(([file]) => file === fallback)).toBe(false);
  });

  it("recognises the PATH fallback of an inactive mise shim", () => {
    inactiveMise();
    fs.symlinkSync(own, path.join(fallbackDir, "agent-shim"));
    expect(severity()).toBe("pass");
  });

  it("asks mise using the environment being diagnosed", () => {
    writeMise("#!/bin/sh\nprintf '%s\\n' \"$MISE_TEST_EXECUTABLE\"\n");
    const result = report({ PATH: shimDir, MISE_TEST_EXECUTABLE: own });
    expect(findingsFor(result, "path-resolution")[0]?.severity).toBe("pass");
  });

  it("recognises an active mise shim for the enabled Claude command", () => {
    const claude = path.join(ownDir, "claude");
    fs.writeFileSync(claude, "installed", { mode: EXECUTABLE_MODE });
    writeMise(`#!/bin/sh\nprintf '%s\\n' '${claude}'\n`, "claude");
    const paths = buildLayoutPaths(root);
    fs.writeFileSync(paths.claudeShimFile, JSON.stringify({ targetPath: claude, method: "copy", installedAtMs: 1 }));
    expect(findingsFor(report(), "path-resolution").find((finding) => finding.subject === "claude")?.severity).toBe("pass");
  });

  it("reports a real shadow selected by an active mise shim", () => {
    writeMise("#!/bin/sh\nprintf '%s\\n' '/different/agent-shim'\n");
    expect(severity()).toBe("fail");
  });

  it("recognises an active mise shim that selects the running executable", () => {
    writeMise(`#!/bin/sh\nprintf '%s\\n' '${own}'\n`);
    expect(severity()).toBe("pass");
  });
});

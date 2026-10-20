import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addIdentity } from "../identityStore";
import { buildLayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { declareThisProcessTheFrontDoor, resetFrontDoorDeclarationForTests } from "../frontdoor/selfIdentity";
import { FRONT_DOOR_PROTOCOL, writeFrontDoorState } from "../frontdoor/state";
import { enterProcessRole } from "../processRole";
import type { AsyncRun } from "../replayRun";
import { withIdentityClaude } from "./identityClaude";

/** Owner read, write and execute with group and other read and execute: what an installed executable carries, and all the stand-in `claude` needs. */
const EXECUTABLE_MODE = 0o755;

/** The run's own time limit, which the launch never reaches because it fails at its first wait; it only has to be a valid bound. */
const LAUNCH_TIMEOUT_MS = 1_000;

/** The state root the suite's setup file points `AGENT_SHIM_HOME` at, a throwaway directory that is never the real one. */
function throwawayRoot(): string {
  const root = process.env.AGENT_SHIM_HOME;
  if (root === undefined) {
    throw new Error("the test setup must set AGENT_SHIM_HOME");
  }
  return root;
}

describe("a launch planned inside the front door's process, through the helper the door's background work uses", () => {
  let binDirectory: string;
  let originalPath: string | undefined;
  let leave: (() => void) | undefined;

  beforeEach(() => {
    // A stand-in `claude` on PATH, so the launch gets as far as engaging the front door rather than stopping at binary discovery on a machine with none.
    binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-door-claude-"));
    const stub = path.join(binDirectory, "claude");
    fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(stub, EXECUTABLE_MODE);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    leave?.();
    leave = undefined;
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    fs.rmSync(binDirectory, { recursive: true, force: true });
  });

  /** The door's own serving state, as the supervisor writes it once it is up, so the launch finds a live door to register against. */
  const SERVING_PORT = 4100;
  const SERVING_CONNECT_PORT = 4300;

  afterEach(() => {
    resetFrontDoorDeclarationForTests();
  });

  it("plans a launch inside the door, running the git and Keychain probes it asks for without blocking", async () => {
    const paths = buildLayoutPaths(throwawayRoot());
    addIdentity(paths, "probe-target");
    writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: process.pid, port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT });
    declareThisProcessTheFrontDoor();
    leave = enterProcessRole("frontdoor-supervisor");
    const runAsync = vi.fn<AsyncRun>(async () => await Promise.resolve({ status: 1, stdout: "", stderr: "" }));
    const result = await withIdentityClaude(
      {
        paths,
        cwd: os.tmpdir(),
        timeoutMs: LAUNCH_TIMEOUT_MS,
        runAsync,
        spawnDaemon: () => {
          throw new Error("a door that is serving starts no daemon");
        },
      },
      "probe-target",
      ["--no-headroom", "--no-remote-control"],
      async (run) => await Promise.resolve(run.bin),
    );
    expect(path.isAbsolute(result)).toBe(true);
    expect(runAsync.mock.calls.map(([command]) => command)).toContain("git");
  });
});

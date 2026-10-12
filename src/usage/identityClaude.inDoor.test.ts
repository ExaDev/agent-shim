import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addIdentity } from "../identityStore";
import { buildLayoutPaths } from "../paths";
import { BlockingInEventLoopError, enterProcessRole } from "../processRole";
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

  it("fails with a named error at its first wait, and never blocks the thread that answers the door's sessions", async () => {
    const paths = buildLayoutPaths(throwawayRoot());
    addIdentity(paths, "probe-target");
    const daemonSpawns: string[] = [];
    leave = enterProcessRole("frontdoor-supervisor");
    let ran = false;
    await expect(
      withIdentityClaude(
        {
          paths,
          cwd: os.tmpdir(),
          timeoutMs: LAUNCH_TIMEOUT_MS,
          spawnDaemon: (_layout, subcommand) => {
            daemonSpawns.push(subcommand);
            return 1;
          },
        },
        "probe-target",
        ["--no-headroom", "--no-remote-control"],
        async () => {
          ran = true;
          return await Promise.resolve("ran");
        },
      ),
    ).rejects.toBeInstanceOf(BlockingInEventLoopError);
    expect(ran).toBe(false);
  });
});

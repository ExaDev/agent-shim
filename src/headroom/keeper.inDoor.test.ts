import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { enterProcessRole } from "../processRole";
import { realFarmFs, realRunningAmong } from "../realPorts";
import { createHeadroomKeeper } from "./keeper";
import { writeSession } from "./state";

describe("the headroom keeper inside the front door", () => {
  let root: string;
  let leave: (() => void) | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-keeper-door-"));
  });

  afterEach(() => {
    leave?.();
    leave = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts a supervisor for a registered launcher without a synchronous process-table read, which the door refuses", async () => {
    const paths = buildLayoutPaths(root);
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const deadSupervisorPid = exited.pid;
    writeSession(realFarmFs, paths.headroomSessionsDir, { pid: process.pid, startedAt: Date.now(), supervisorPid: deadSupervisorPid });
    leave = enterProcessRole("frontdoor-supervisor");
    let spawned = 0;
    const keeper = createHeadroomKeeper({
      paths,
      ownPid: process.pid,
      ports: {
        fs: realFarmFs,
        now: () => Date.now(),
        runningAmong: realRunningAmong,
        spawnSupervisor: () => {
          spawned += 1;
          return process.pid;
        },
      },
      log: () => undefined,
    });

    await expect(keeper.tick()).resolves.toEqual({ kind: "starting", start: "spawned", waiting: 1 });
    expect(spawned).toBe(1);
  });
});

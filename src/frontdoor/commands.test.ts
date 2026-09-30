import { describe, expect, it } from "vitest";

import { writeSession } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { collectFrontDoorStatus, formatFrontDoorStatus } from "./commands";
import { writeFrontDoorState } from "./state";

const paths = buildLayoutPaths("/home/testuser/.claude-use");
const SUPERVISOR = 10;
const LIVE_SESSION = 20;
const DEAD_SESSION = 21;
const PORT = 4100;

describe("frontdoor status", () => {
  it("reports a serving door, its sessions and the log", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR, port: PORT, lastPort: PORT });
    writeSession(fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0 });
    writeSession(fs, paths.frontdoorSessionsDir, { pid: DEAD_SESSION, startedAt: 0 });
    const alive = new Set([SUPERVISOR, LIVE_SESSION]);
    const status = collectFrontDoorStatus(fs, paths, (pid) => alive.has(pid));
    expect(status.supervisorAlive).toBe(true);
    expect(formatFrontDoorStatus(status)).toEqual([
      "supervisor: pid 10 (alive)",
      `front door: listening on 127.0.0.1:${String(PORT)}, routing /providers/<name> requests`,
      "sessions: 2 registered (20, 21 (dead))",
      `daemon log: ${paths.frontdoorLogPath} (not created yet)`,
    ]);
  });

  it("reports a stopped door with its sticky port and last error", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { lastPort: PORT, lastError: "gave up" });
    expect(formatFrontDoorStatus(collectFrontDoorStatus(fs, paths, () => false))).toEqual([
      "supervisor: not running",
      "front door: not listening (next start on 127.0.0.1:4100)",
      "sessions: none",
      "last error: gave up",
      `daemon log: ${paths.frontdoorLogPath} (not created yet)`,
    ]);
  });
});

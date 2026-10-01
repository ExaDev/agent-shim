import { describe, expect, it } from "vitest";

import { writeHeadroomState } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { collectFrontDoorStatus, formatFrontDoorStatus } from "./commands";
import { writeFrontDoorSession, writeFrontDoorState } from "./state";

const paths = buildLayoutPaths("/home/testuser/.claude-use");
const SUPERVISOR = 10;
/** A stand-in capability: front-door registry records carry one per launch. */
const SESSION_TOKEN = "test-capability";
const LIVE_SESSION = 20;
const DEAD_SESSION = 21;
const PORT = 4100;
const CONNECT_PORT = 4200;
const HEADROOM_PORT = 8123;

describe("frontdoor status", () => {
  it("reports a serving door with both listeners, the headroom hop and its sessions", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR, port: PORT, lastPort: PORT, connectPort: CONNECT_PORT, lastConnectPort: CONNECT_PORT });
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: 30, headroomPid: 31, port: HEADROOM_PORT });
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN });
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: DEAD_SESSION, startedAt: 0, token: SESSION_TOKEN });
    const alive = new Set([SUPERVISOR, LIVE_SESSION]);
    const status = collectFrontDoorStatus(fs, paths, (pid) => alive.has(pid));
    expect(status.supervisorAlive).toBe(true);
    expect(status.headroomPort).toBe(HEADROOM_PORT);
    expect(formatFrontDoorStatus(status, paths.frontdoorCaCertFile)).toEqual([
      "supervisor: pid 10 (alive)",
      `front door: listening on 127.0.0.1:${String(PORT)}, routing /providers/<name> requests`,
      `connect surface: listening on 127.0.0.1:${String(CONNECT_PORT)}, CA ${paths.frontdoorCaCertFile}`,
      `headroom hop: daemon on 127.0.0.1:${String(HEADROOM_PORT)}`,
      "sessions: 2 registered (20, 21 (dead))",
      `daemon log: ${paths.frontdoorLogPath} (not created yet)`,
    ]);
  });

  it("reports a stopped door with both sticky ports, a missing hop and any last error", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { lastPort: PORT, lastConnectPort: CONNECT_PORT, lastError: "gave up" });
    expect(formatFrontDoorStatus(collectFrontDoorStatus(fs, paths, () => false), paths.frontdoorCaCertFile)).toEqual([
      "supervisor: not running",
      "front door: not listening (next start on 127.0.0.1:4100)",
      "connect surface: not listening (next start on 127.0.0.1:4200)",
      "headroom hop: the daemon is not serving (sessions asking for headroom fail until it is up)",
      "sessions: none",
      "last error: gave up",
      `daemon log: ${paths.frontdoorLogPath} (not created yet)`,
    ]);
  });
});

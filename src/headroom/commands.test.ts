import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { collectHeadroomStatus, formatHeadroomStatus, headroomSpawnEnv } from "./commands";
import { hashAllowlist, headroomAllowlist, writeHeadroomState, writeSession } from "./state";

const paths = buildLayoutPaths("/home/testuser/.claude-use");

const SUPERVISOR_PID = 11;
const HEADROOM_PID = 12;
const SESSION_PID = 13;
const PORT = 8123;

function aliveWorld() {
  const fs = createFakeFarmFs({});
  fs.mkdirp(paths.providersDir);
  fs.writeFileUtf8(
    `${paths.providersDir}/z.json`,
    JSON.stringify({ displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }] } }),
  );
  writeHeadroomState(fs, paths.headroomStateFile, {
    supervisorPid: SUPERVISOR_PID,
    headroomPid: HEADROOM_PID,
    port: PORT,
    version: "headroom 0.39.1",
    allowlistHash: hashAllowlist(headroomAllowlist([{ baseUrl: "https://api.z.ai/api/anthropic" }])),
  });
  writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_PID, startedAt: 1000 });
  const alive = new Set([SUPERVISOR_PID, HEADROOM_PID, SESSION_PID]);
  return { fs, alive };
}

describe("collectHeadroomStatus", () => {
  it("reports a healthy daemon, its live session, the current allowlist, and no drift", () => {
    const { fs, alive } = aliveWorld();
    const status = collectHeadroomStatus(fs, paths, (pid) => alive.has(pid));
    expect(status.supervisorAlive).toBe(true);
    expect(status.headroomAlive).toBe(true);
    expect(status.state.port).toBe(PORT);
    expect(status.allowlist).toEqual(["https://api.anthropic.com", "https://api.z.ai/api/anthropic"]);
    expect(status.allowlistDrifted).toBe(false);
    expect(status.sessions).toEqual([{ pid: SESSION_PID, startedAt: 1000, alive: true }]);
  });

  it("marks dead pids and allowlist drift without touching anything", () => {
    const { fs } = aliveWorld();
    fs.writeFileUtf8(
      `${paths.providersDir}/m.json`,
      JSON.stringify({ displayName: "MiniMax", baseUrl: "https://api.minimax.io", credential: { sources: [{ env: "T" }] } }),
    );
    const status = collectHeadroomStatus(fs, paths, () => false);
    expect(status.supervisorAlive).toBe(false);
    expect(status.headroomAlive).toBe(false);
    expect(status.sessions.map((session) => session.alive)).toEqual([false]);
    expect(status.allowlistDrifted).toBe(true);
  });

  it("treats absent state as a never-run daemon rather than an error", () => {
    const status = collectHeadroomStatus(createFakeFarmFs({}), paths, () => true);
    expect(status.state).toEqual({});
    expect(status.supervisorAlive).toBe(false);
    expect(status.allowlist).toEqual(["https://api.anthropic.com"]);
  });
});

describe("formatHeadroomStatus", () => {
  it("renders the running daemon's pids, port, version, allowlist, sessions, and log path", () => {
    const { fs, alive } = aliveWorld();
    const lines = formatHeadroomStatus(collectHeadroomStatus(fs, paths, (pid) => alive.has(pid)));
    expect(lines[0]).toBe(`supervisor: pid ${String(SUPERVISOR_PID)} (alive)`);
    expect(lines[1]).toBe(
      `headroom: pid ${String(HEADROOM_PID)} (alive), listening on 127.0.0.1:${String(PORT)}, headroom 0.39.1`,
    );
    expect(lines[2]).toBe("allowlist: https://api.anthropic.com, https://api.z.ai/api/anthropic");
    expect(lines[3]).toBe("settings: headroom defaults");
    expect(lines[4]).toBe(`sessions: 1 registered (${String(SESSION_PID)})`);
    expect(lines.at(-1)).toBe(`daemon log: ${paths.headroomLogPath} (not created yet)`);
  });

  it("says plainly when nothing is running", () => {
    const lines = formatHeadroomStatus(collectHeadroomStatus(createFakeFarmFs({}), paths, () => true));
    expect(lines[0]).toBe("supervisor: not running (no state recorded)");
    expect(lines[1]).toBe("headroom: not running");
    expect(lines[2]).toBe("allowlist: https://api.anthropic.com");
    expect(lines[3]).toBe("settings: headroom defaults");
    expect(lines[4]).toBe("sessions: none");
  });
});

describe("headroomSpawnEnv", () => {
  it("defaults HEADROOM_HTTP2 to 0 and joins the allowlist into the environment", () => {
    const env = headroomSpawnEnv({ PATH: "/usr/bin" }, ["https://api.anthropic.com", "https://api.z.ai/api/anthropic"], {});
    expect(env.HEADROOM_HTTP2).toBe("0");
    expect(env.HEADROOM_ALLOWED_BASE_URLS).toBe("https://api.anthropic.com,https://api.z.ai/api/anthropic");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("leaves an explicit HEADROOM_HTTP2 from the parent environment in place", () => {
    const env = headroomSpawnEnv({ HEADROOM_HTTP2: "1" }, ["https://api.anthropic.com"], {});
    expect(env.HEADROOM_HTTP2).toBe("1");
  });
});

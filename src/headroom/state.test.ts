import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import {
  hashAllowlist,
  headroomAllowlist,
  HEADROOM_ANTHROPIC_UPSTREAM,
  listSessions,
  pruneDeadSessions,
  readAllProviders,
  readHeadroomState,
  readSession,
  removeSession,
  writeHeadroomState,
  writeSession,
  type HeadroomFs,
} from "./state";

const paths = buildLayoutPaths("/home/testuser/.claude-use");

const SESSION_EARLY_PID = 42;
const SESSION_LATE_PID = 101;

function seededProviders(fs: HeadroomFs): void {
  fs.mkdirp(paths.providersDir);
  fs.writeFileUtf8(
    `${paths.providersDir}/z.json`,
    JSON.stringify({ displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", tokenEnv: "Z_API_TOKEN" }),
  );
  fs.writeFileUtf8(
    `${paths.providersDir}/o.json`,
    JSON.stringify({ displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", tokenEnv: "OPENROUTER_API_KEY" }),
  );
}

describe("headroomAllowlist", () => {
  it("includes every provider's base URL plus Claude Code's own API, deduplicated and sorted", () => {
    const allowlist = headroomAllowlist([
      { baseUrl: "https://api.z.ai/api/anthropic" },
      { baseUrl: "https://openrouter.ai/api/v1" },
      { baseUrl: "https://api.z.ai/api/anthropic" },
    ]);
    expect(allowlist).toEqual(["https://api.anthropic.com", "https://api.z.ai/api/anthropic", "https://openrouter.ai/api/v1"]);
    expect(allowlist).toContain(HEADROOM_ANTHROPIC_UPSTREAM);
  });

  it("is only Claude Code's own API when no providers exist", () => {
    expect(headroomAllowlist([])).toEqual([HEADROOM_ANTHROPIC_UPSTREAM]);
  });

  it("hashes deterministically and distinctly", () => {
    expect(hashAllowlist(["a", "b"])).toBe(hashAllowlist(["a", "b"]));
    expect(hashAllowlist(["a", "b"])).not.toBe(hashAllowlist(["b", "a"]));
  });
});

describe("headroom state files", () => {
  it("round-trips state through the fake filesystem", () => {
    const fs = createFakeFarmFs({});
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: 11, port: 8123 });
    expect(readHeadroomState(fs, paths.headroomStateFile)).toEqual({ supervisorPid: 11, port: 8123 });
  });

  it("round-trips the sticky lastPort alongside the ready-signal port", () => {
    const fs = createFakeFarmFs({});
    writeHeadroomState(fs, paths.headroomStateFile, { port: 8123, lastPort: 8123 });
    expect(readHeadroomState(fs, paths.headroomStateFile)).toEqual({ port: 8123, lastPort: 8123 });
    writeHeadroomState(fs, paths.headroomStateFile, { lastPort: 8123 });
    expect(readHeadroomState(fs, paths.headroomStateFile)).toEqual({ lastPort: 8123 });
  });

  it("treats a missing or malformed state file as absent rather than throwing", () => {
    const fs = createFakeFarmFs({});
    expect(readHeadroomState(fs, paths.headroomStateFile)).toBeUndefined();
    fs.mkdirp(paths.headroomDir);
    fs.writeFileUtf8(paths.headroomStateFile, "{not json");
    expect(readHeadroomState(fs, paths.headroomStateFile)).toBeUndefined();
  });

  it("reads provider definitions for the allowlist, skipping non-JSON and invalid files", () => {
    const fs = createFakeFarmFs({});
    seededProviders(fs);
    fs.writeFileUtf8(`${paths.providersDir}/broken.json`, "{\"displayName\": \"no baseUrl\"}");
    const providers = readAllProviders(fs, paths.providersDir);
    expect(providers.map((entry) => entry.name).sort()).toEqual(["o", "z"]);
  });
});

describe("session registry", () => {
  it("writes, reads, lists, and removes session entries", () => {
    const fs = createFakeFarmFs({});
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_LATE_PID, startedAt: 1000 });
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_EARLY_PID, startedAt: 900 });
    expect(readSession(fs, paths.headroomSessionsDir, SESSION_LATE_PID)).toEqual({ pid: SESSION_LATE_PID, startedAt: 1000 });
    expect(listSessions(fs, paths.headroomSessionsDir).map((session) => session.pid)).toEqual([SESSION_EARLY_PID, SESSION_LATE_PID]);
    removeSession(fs, paths.headroomSessionsDir, SESSION_LATE_PID);
    expect(readSession(fs, paths.headroomSessionsDir, SESSION_LATE_PID)).toBeUndefined();
    removeSession(fs, paths.headroomSessionsDir, SESSION_LATE_PID);
  });

  it("prunes exactly the entries whose pid is no longer alive", () => {
    const fs = createFakeFarmFs({});
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_EARLY_PID, startedAt: 0 });
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_LATE_PID, startedAt: 0 });
    const alive = new Set([SESSION_LATE_PID]);
    const removed = pruneDeadSessions(fs, paths.headroomSessionsDir, (pid) => alive.has(pid));
    expect(removed).toEqual([SESSION_EARLY_PID]);
    expect(listSessions(fs, paths.headroomSessionsDir).map((session) => session.pid)).toEqual([SESSION_LATE_PID]);
  });
});

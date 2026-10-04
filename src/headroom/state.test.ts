import path from "node:path";
import { describe, expect, it } from "vitest";

import { ProviderSchema } from "../config/schema";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import {
  HEADROOM_STATE_SCHEMA_VERSION,
  hashAllowlist,
  headroomAllowlist,
  headroomUpstreams,
  HEADROOM_ANTHROPIC_UPSTREAM,
  listSessions,
  pruneDeadSessions,
  readAllProviders,
  readHeadroomState,
  readSession,
  removeSession,
  sessionsForSupervisor,
  writeHeadroomState,
  writeSession,
  type HeadroomFs,
} from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const SESSION_EARLY_PID = 42;
const SESSION_LATE_PID = 101;
const SUPERVISOR_A_PID = 7001;
const SUPERVISOR_B_PID = 7002;

function seededProviders(fs: HeadroomFs): void {
  fs.mkdirp(paths.providersDir);
  fs.writeFileUtf8(
    `${paths.providersDir}/z.json`,
    JSON.stringify({ displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }] } }),
  );
  fs.writeFileUtf8(
    `${paths.providersDir}/o.json`,
    JSON.stringify({ displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", credential: { sources: [{ env: "OPENROUTER_API_KEY" }] } }),
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

  it("admits the front door's direct origin in place of a provider's own address, once the door has one, for either kind of provider", () => {
    const providers = [
      ProviderSchema.parse({ displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z" }] } }),
      ProviderSchema.parse({ kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "x" }] } }),
    ];
    expect(headroomAllowlist(headroomUpstreams(providers, "http://127.0.0.1:4400"))).toEqual(["http://127.0.0.1:4400", HEADROOM_ANTHROPIC_UPSTREAM, "https://api.z.ai/api/anthropic"]);
    expect(headroomAllowlist(headroomUpstreams(providers, undefined))).toEqual([HEADROOM_ANTHROPIC_UPSTREAM, "https://api.z.ai/api/anthropic"]);
    // An http provider alone still needs the door's origin admitted: its headroom hop bounces through the direct listener too.
    expect(headroomAllowlist(headroomUpstreams(providers.slice(0, 1), "http://127.0.0.1:4400"))).toEqual(["http://127.0.0.1:4400", HEADROOM_ANTHROPIC_UPSTREAM, "https://api.z.ai/api/anthropic"]);
    expect(headroomAllowlist(headroomUpstreams([], "http://127.0.0.1:4400"))).toEqual([HEADROOM_ANTHROPIC_UPSTREAM]);
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
  it("round-trips the socket path the daemon serves on", () => {
    const fs = createFakeFarmFs({});
    const socketPath = `${paths.headroomSocketDir}/11.sock`;
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: 11, headroomPid: 12, socketPath });
    expect(readHeadroomState(fs, paths.headroomStateFile)).toEqual({ supervisorPid: 11, headroomPid: 12, socketPath });
  });

  it("keeps its state in a file named by the schema version, apart from the earlier port-based state.json", () => {
    expect(path.basename(paths.headroomStateFile)).toBe(`state.v${String(HEADROOM_STATE_SCHEMA_VERSION)}.json`);
    expect(path.dirname(paths.headroomStateFile)).toBe(paths.headroomDir);
  });

  it("reads a record carrying a TCP port as malformed, so nothing of the earlier schema is ever dialled", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomDir);
    fs.writeFileUtf8(paths.headroomStateFile, JSON.stringify({ supervisorPid: 11, headroomPid: 12, port: 8123, lastPort: 8123 }));
    expect(readHeadroomState(fs, paths.headroomStateFile)).toBeUndefined();
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

describe("writeHeadroomState", () => {
  it("writes through the atomic write, so a reader never sees a torn file", () => {
    const fs = createFakeFarmFs({});
    const atomicWrites: string[] = [];
    const plainWrites: string[] = [];
    const tracked = {
      ...fs,
      writeFilePrivate: (file: string, contents: string) => {
        atomicWrites.push(file);
        fs.writeFilePrivate(file, contents);
      },
      writeFileUtf8: (file: string, contents: string) => {
        plainWrites.push(file);
        fs.writeFileUtf8(file, contents);
      },
    };
    writeHeadroomState(tracked, paths.headroomStateFile, { supervisorPid: SUPERVISOR_A_PID });
    expect(atomicWrites).toEqual([paths.headroomStateFile]);
    expect(plainWrites).toEqual([]);
    expect(readHeadroomState(fs, paths.headroomStateFile)).toEqual({ supervisorPid: SUPERVISOR_A_PID });
  });
});

describe("session registry", () => {
  it("writes, reads, lists, and removes session entries", () => {
    const fs = createFakeFarmFs({});
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_LATE_PID, startedAt: 1000, supervisorPid: SUPERVISOR_A_PID });
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_EARLY_PID, startedAt: 900, supervisorPid: SUPERVISOR_A_PID });
    expect(readSession(fs, paths.headroomSessionsDir, SESSION_LATE_PID)).toEqual({ pid: SESSION_LATE_PID, startedAt: 1000, supervisorPid: SUPERVISOR_A_PID });
    expect(listSessions(fs, paths.headroomSessionsDir).map((session) => session.pid)).toEqual([SESSION_EARLY_PID, SESSION_LATE_PID]);
    removeSession(fs, paths.headroomSessionsDir, SESSION_LATE_PID);
    expect(readSession(fs, paths.headroomSessionsDir, SESSION_LATE_PID)).toBeUndefined();
    removeSession(fs, paths.headroomSessionsDir, SESSION_LATE_PID);
  });

  it("lists only the sessions registered against one supervisor, because each supervisor's idle and drift decisions concern its own daemon", () => {
    const fs = createFakeFarmFs({});
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_EARLY_PID, startedAt: 0, supervisorPid: SUPERVISOR_A_PID });
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_LATE_PID, startedAt: 0, supervisorPid: SUPERVISOR_B_PID });
    expect(sessionsForSupervisor(fs, paths.headroomSessionsDir, SUPERVISOR_A_PID).map((session) => session.pid)).toEqual([SESSION_EARLY_PID]);
    expect(sessionsForSupervisor(fs, paths.headroomSessionsDir, SUPERVISOR_B_PID).map((session) => session.pid)).toEqual([SESSION_LATE_PID]);
  });

  it("skips a registry file that names no supervisor instead of attributing it to anyone", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomSessionsDir);
    fs.writeFileUtf8(`${paths.headroomSessionsDir}/${String(SESSION_EARLY_PID)}.json`, JSON.stringify({ pid: SESSION_EARLY_PID, startedAt: 0 }));
    expect(listSessions(fs, paths.headroomSessionsDir)).toEqual([]);
  });

  it("prunes exactly the entries whose pid is no longer alive", () => {
    const fs = createFakeFarmFs({});
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_EARLY_PID, startedAt: 0, supervisorPid: SUPERVISOR_A_PID });
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_LATE_PID, startedAt: 0, supervisorPid: SUPERVISOR_A_PID });
    const alive = new Set([SESSION_LATE_PID]);
    const removed = pruneDeadSessions(fs, paths.headroomSessionsDir, (pid) => alive.has(pid));
    expect(removed).toEqual([SESSION_EARLY_PID]);
    expect(listSessions(fs, paths.headroomSessionsDir).map((session) => session.pid)).toEqual([SESSION_LATE_PID]);
  });
});

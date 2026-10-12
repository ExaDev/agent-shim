import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import {
  hashAllowlist,
  migrateHeadroomState,
  resolveServingHeadroomState,
  listSessions,
  parseAllowlistFile,
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

/** The two names the resolution runs over, as the callers pass them. */
const files = (): { stateFile: string; legacyStateFile: string } => ({ stateFile: paths.headroomStateFile, legacyStateFile: paths.headroomLegacyStateFile });

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

describe("hashAllowlist", () => {
  it("hashes deterministically and distinctly", () => {
    expect(hashAllowlist(["a", "b"])).toBe(hashAllowlist(["a", "b"]));
    expect(hashAllowlist(["a", "b"])).not.toBe(hashAllowlist(["b", "a"]));
  });
});

describe("parseAllowlistFile", () => {
  it("splits on commas, newlines, carriage returns and tabs, ignoring blank entries and surrounding space", () => {
    expect(parseAllowlistFile(" https://a.example\rhttps://b.example\thttps://c.example,https://d.example\r\n\n")).toEqual(["https://a.example", "https://b.example", "https://c.example", "https://d.example"]);
  });

  it("skips a whole line whose first non-blank character is #", () => {
    expect(parseAllowlistFile("# written by the supervisor\nhttps://a.example\n   # https://b.example, https://c.example\n")).toEqual(["https://a.example"]);
  });

  it("ignores a leading byte-order mark rather than joining it to the first entry", () => {
    expect(parseAllowlistFile("\uFEFFhttps://a.example\n")).toEqual(["https://a.example"]);
  });

  it("ends an entry's line at a # that follows whitespace, and keeps a # anywhere else as part of the entry", () => {
    expect(parseAllowlistFile("https://a.example # the prod gateway\nhttps://b.example#frag\n")).toEqual(["https://a.example", "https://b.example#frag"]);
  });

  it("drops an entry containing whitespace, one with a scheme headroom does not admit, and a URL with no host or an impossible port", () => {
    expect(parseAllowlistFile("a.example\u00a0b.example\nftp://a.example\nws://a.example\nhttp://\nhttp://a.example:99999\nhttps://ok.example\n")).toEqual(["ws://a.example", "https://ok.example"]);
  });

  it("keeps a scheme-less entry only when it is a hostname and nothing else", () => {
    expect(parseAllowlistFile("gw.internal/v1\nuser@gw.internal\n127.0.0.1:\n[::1]:80\n[::1]\ngw.internal?x\ngw.internal\n")).toEqual(["[::1]", "gw.internal"]);
  });

  it("separates entries at every line boundary headroom splits on, not only newlines and carriage returns", () => {
    const breaks = ["\u000b", "\u000c", "\u001c", "\u001d", "\u001e", "\u0085", "\u2028", "\u2029"];
    expect(parseAllowlistFile(breaks.map((separator, index) => `https://h${String(index)}.example${separator}`).join(""))).toEqual(breaks.map((_, index) => `https://h${String(index)}.example`));
  });

  it("begins a comment at a # after any whitespace headroom counts, including a no-break space and a unit separator, and ends it at the next line boundary", () => {
    expect(parseAllowlistFile("https://a.example\u00a0# note\u2028https://b.example\u001f#note\nhttps://c.example\n")).toEqual(["https://a.example", "https://b.example", "https://c.example"]);
  });

  it("drops an entry with whitespace headroom counts but a JavaScript pattern would not, such as a unit separator inside it", () => {
    expect(parseAllowlistFile("https://a.example\u001fb\nhttps://ok.example\n")).toEqual(["https://ok.example"]);
  });

  it("drops an entry carrying a port without a scheme, which headroom reads as invalid, and keeps a bare host", () => {
    expect(parseAllowlistFile("127.0.0.1:50123\n[::1]:50123\napi.example.com\nhttp://127.0.0.1:50123\n")).toEqual(["api.example.com", "http://127.0.0.1:50123"]);
  });
});

describe("headroom state files", () => {
  it("round-trips the socket path the daemon serves on", () => {
    const fs = createFakeFarmFs({});
    const socketPath = `${paths.headroomSocketDir}/11.sock`;
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: 11, headroomPid: 12, socketPath });
    expect(readHeadroomState(fs, paths.headroomStateFile)).toEqual({ supervisorPid: 11, headroomPid: 12, socketPath });
  });

  it("keeps its state in one unversioned file, with the previous release's versioned name beside it for migration", () => {
    expect(path.basename(paths.headroomStateFile)).toBe("state.json");
    expect(path.dirname(paths.headroomStateFile)).toBe(paths.headroomDir);
    expect(path.basename(paths.headroomLegacyStateFile)).toBe("state.v2.json");
  });

  it("resolves the shared file's record as the serving one", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomDir);
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: SUPERVISOR_A_PID, socketPath: `${paths.headroomSocketDir}/a.sock` });
    const resolved = resolveServingHeadroomState(fs, files(), () => true);
    expect(resolved).toEqual({ path: paths.headroomStateFile, state: { supervisorPid: SUPERVISOR_A_PID, socketPath: `${paths.headroomSocketDir}/a.sock` } });
  });

  it("resolves a live previous-release supervisor's legacy record as the serving one, without touching either file", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomDir);
    writeHeadroomState(fs, paths.headroomLegacyStateFile, { supervisorPid: SUPERVISOR_A_PID, socketPath: `${paths.headroomSocketDir}/a.sock` });
    const resolved = resolveServingHeadroomState(fs, files(), () => true);
    expect(resolved?.path).toBe(paths.headroomLegacyStateFile);
    expect(resolved?.state.supervisorPid).toBe(SUPERVISOR_A_PID);
    expect(readHeadroomState(fs, paths.headroomStateFile)).toBeUndefined();
  });

  it("resolves nothing while the shared file is absent and the legacy record's supervisor is not live", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomDir);
    writeHeadroomState(fs, paths.headroomLegacyStateFile, { supervisorPid: SUPERVISOR_A_PID, socketPath: `${paths.headroomSocketDir}/a.sock` });
    expect(resolveServingHeadroomState(fs, files(), () => false)).toBeUndefined();
  });

  it("migrates a legacy record whose generation has ended onto the shared name in place, removing the legacy file", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomDir);
    const record = { supervisorPid: SUPERVISOR_A_PID, socketPath: `${paths.headroomSocketDir}/a.sock`, installedSource: "headroom>=0.39" };
    writeHeadroomState(fs, paths.headroomLegacyStateFile, record);
    migrateHeadroomState(fs, files(), () => false);
    expect(readHeadroomState(fs, paths.headroomStateFile)).toEqual(record);
    expect(fs.readFileUtf8(paths.headroomLegacyStateFile)).toBeUndefined();
  });

  it("leaves a live legacy generation alone, and once the shared name serves it deletes the legacy file", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomDir);
    writeHeadroomState(fs, paths.headroomLegacyStateFile, { supervisorPid: SUPERVISOR_A_PID, socketPath: `${paths.headroomSocketDir}/a.sock` });
    migrateHeadroomState(fs, files(), () => true);
    expect(fs.readFileUtf8(paths.headroomLegacyStateFile)).toBeDefined();
    // The generation drains: the shared name gets claimed by a new supervisor, and the next migration retires the legacy file.
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: SUPERVISOR_B_PID, socketPath: `${paths.headroomSocketDir}/b.sock` });
    migrateHeadroomState(fs, files(), () => false);
    expect(fs.readFileUtf8(paths.headroomLegacyStateFile)).toBeUndefined();
    expect(readHeadroomState(fs, paths.headroomStateFile)?.supervisorPid).toBe(SUPERVISOR_B_PID);
  });

  it("removes a legacy file nothing can parse, and claims nothing over an unparseable shared file", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomDir);
    fs.writeFileUtf8(paths.headroomLegacyStateFile, "{bad");
    migrateHeadroomState(fs, files(), () => true);
    expect(fs.readFileUtf8(paths.headroomLegacyStateFile)).toBeUndefined();
  });

  it("migrates over a shared file carrying the TCP-port era's content, which reads as absent", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomDir);
    fs.writeFileUtf8(paths.headroomStateFile, JSON.stringify({ supervisorPid: 11, headroomPid: 12, port: 8923, lastPort: 8923 }));
    writeHeadroomState(fs, paths.headroomLegacyStateFile, { supervisorPid: SUPERVISOR_A_PID, socketPath: `${paths.headroomSocketDir}/a.sock` });
    migrateHeadroomState(fs, files(), () => false);
    expect(readHeadroomState(fs, paths.headroomStateFile)?.socketPath).toBe(`${paths.headroomSocketDir}/a.sock`);
    expect(fs.readFileUtf8(paths.headroomLegacyStateFile)).toBeUndefined();
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

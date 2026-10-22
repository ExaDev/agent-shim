import { describe, expect, it } from "vitest";

import type { HeadroomFs } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { createLiveSessionRegistry } from "./liveSessionRegistry";
import { listFrontDoorDirectRecords, listFrontDoorSessions, MAX_TCP_PORT, pruneMalformedFrontDoorDirectFiles, pruneDeadFrontDoorSessions, readFrontDoorState, removeFrontDoorSession, writeFrontDoorSession, writeFrontDoorState } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const LIVE = 301;
const DEAD = 302;
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
/** A recognisable capability, so an assertion can search every serialised output for it. */
const SECRET_CAPABILITY = "capability-that-must-never-be-listed";

describe("front-door session registry", () => {
  it("lists a registered launch even though its record carries a capability token", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 7, token: SECRET_CAPABILITY });
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir)).toEqual([{ pid: LIVE, startedAt: 7 }]);
  });

  it("never returns the token from a listing, so nothing that prints a session can leak the capability", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 7, token: SECRET_CAPABILITY });
    expect(JSON.stringify(listFrontDoorSessions(fs, paths.frontdoorSessionsDir))).not.toContain(SECRET_CAPABILITY);
    expect(createLiveSessionRegistry({ fs, sessionsDir: paths.frontdoorSessionsDir }).admits(SECRET_CAPABILITY)).toBe(true);
  });

  it("skips malformed and token-less records instead of counting them as launches", () => {
    const fs = createFakeFarmFs({
      [`${paths.frontdoorSessionsDir}/1.json`]: "not json",
      [`${paths.frontdoorSessionsDir}/2.json`]: JSON.stringify({ pid: 2, startedAt: 0 }),
      [`${paths.frontdoorSessionsDir}/notes.txt`]: "ignored",
    });
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir)).toEqual([]);
  });

  it("prunes a dead launch's record, and with it the capability it held, and keeps the live one", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0, token: "live-token" });
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: DEAD, startedAt: 0, token: "dead-token" });
    expect(pruneDeadFrontDoorSessions(fs, paths.frontdoorSessionsDir, listFrontDoorSessions(fs, paths.frontdoorSessionsDir), (pid) => pid === LIVE)).toEqual([DEAD]);
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir).map((session) => session.pid)).toEqual([LIVE]);
    const registry = createLiveSessionRegistry({ fs, sessionsDir: paths.frontdoorSessionsDir });
    expect(registry.admits("live-token")).toBe(true);
    expect(registry.admits("dead-token")).toBe(false);
  });

  it("keeps a launch that registered after the listing the liveness check covered, since it was never checked", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: DEAD, startedAt: 0, token: "dead-token" });
    const listed = listFrontDoorSessions(fs, paths.frontdoorSessionsDir);
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 1, token: "late-token" });
    expect(pruneDeadFrontDoorSessions(fs, paths.frontdoorSessionsDir, listed, () => false)).toEqual([DEAD]);
    const registry = createLiveSessionRegistry({ fs, sessionsDir: paths.frontdoorSessionsDir });
    expect(registry.admits("late-token")).toBe(true);
    expect(registry.admits("dead-token")).toBe(false);
  });

  it("removes one launcher's record idempotently", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0, token: "t" });
    removeFrontDoorSession(fs, paths.frontdoorSessionsDir, LIVE);
    removeFrontDoorSession(fs, paths.frontdoorSessionsDir, LIVE);
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir)).toEqual([]);
  });

  it("writes the registry directory owner-only and each capability record owner-only", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0, token: "t" });
    expect(fs.modeOf(paths.frontdoorSessionsDir)).toBe(OWNER_ONLY_DIR);
    expect(fs.modeOf(`${paths.frontdoorSessionsDir}/${String(LIVE)}.json`)).toBe(OWNER_ONLY_FILE);
  });
});

describe("front-door state file", () => {
  it("is replaced atomically and owner-only, so a launcher polling it never reads a half-written file and mistakes it for no door", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: LIVE, port: 4100, connectPort: 4200, directPort: 4300 });
    expect(fs.modeOf(paths.frontdoorStateFile)).toBe(OWNER_ONLY_FILE);
    expect(readFrontDoorState(fs, paths.frontdoorStateFile)).toMatchObject({ supervisorPid: LIVE, directPort: 4300 });
  });
});

describe("front-door direct records", () => {
  const recordsDir = paths.frontdoorDirectRecordsDir;

  it("skips a record whose port is above the highest TCP port", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(recordsDir);
    fs.writeFileUtf8(`${recordsDir}/4242.json`, JSON.stringify({ directPort: MAX_TCP_PORT + 1 }));
    fs.writeFileUtf8(`${recordsDir}/4243.json`, JSON.stringify({ directPort: MAX_TCP_PORT }));
    expect(listFrontDoorDirectRecords(fs, recordsDir)).toEqual([{ pid: 4243, directPort: MAX_TCP_PORT }]);
  });

  it("reads only files named by a positive pid", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(recordsDir);
    for (const name of ["0.json", "0123.json", "-5.json", "12.json.tmp", "99999999999999999999.json", "12.json"]) {
      fs.writeFileUtf8(`${recordsDir}/${name}`, JSON.stringify({ directPort: 4400 }));
    }
    expect(listFrontDoorDirectRecords(fs, recordsDir)).toEqual([{ pid: 12, directPort: 4400 }]);
  });

  it("skips an entry it cannot read, a directory or a file it may not open, instead of throwing", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(`${recordsDir}/4242.json`);
    fs.writeFileUtf8(`${recordsDir}/4243.json`, JSON.stringify({ directPort: 4400 }));
    fs.writeFileUtf8(`${recordsDir}/4244.json`, JSON.stringify({ directPort: 4401 }));
    const unreadable: HeadroomFs = {
      ...fs,
      readFileUtf8: (file: string) => {
        if (file.endsWith("4243.json")) {
          throw new Error("EACCES: permission denied");
        }
        return fs.readFileUtf8(file);
      },
    };
    expect(listFrontDoorDirectRecords(unreadable, recordsDir)).toEqual([{ pid: 4244, directPort: 4401 }]);
  });

  it("removes a record file that reads but holds no record, and a temporary file whose writer has exited, and keeps a live writer's", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(recordsDir);
    fs.writeFileUtf8(`${recordsDir}/4242.json`, "{ not json");
    fs.writeFileUtf8(`${recordsDir}/4243.json`, JSON.stringify({ directPort: 4400 }));
    fs.writeFileUtf8(`${recordsDir}/4243.json.${String(DEAD)}.tmp`, "{");
    fs.writeFileUtf8(`${recordsDir}/4243.json.${String(LIVE)}.tmp`, "{");
    pruneMalformedFrontDoorDirectFiles(fs, recordsDir, (pid) => pid === LIVE);
    expect(fs.readdir(recordsDir)).toEqual([`4243.json`, `4243.json.${String(LIVE)}.tmp`]);
  });
});

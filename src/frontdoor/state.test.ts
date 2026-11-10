import { describe, expect, it } from "vitest";

import type { HeadroomFs } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { createLiveSessionRegistry } from "./liveSessionRegistry";
import * as state from "./state";
import path from "node:path";
import { catalogueCachePath } from "../providerCatalogue";
import { MAX_TCP_PORT } from "../baseUrlDial";
import { recordOf, listFrontDoorDirectRecords, isSessionRecordName, listFrontDoorSessions, pruneMalformedFrontDoorDirectFiles, pruneDeadFrontDoorSessions, readFrontDoorCodexHome, readFrontDoorCodexRecord, readFrontDoorState, readLaunchRoute, removeFrontDoorSession, writeFrontDoorCodexHome, writeFrontDoorSession, writeFrontDoorState, writeLaunchRoute } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const LIVE = 301;
const DEAD = 302;
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;

it("isolates catalogue status by supervisor generation", () => {
  const fs = createFakeFarmFs({});
  const first = "10000000-0000-4000-8000-000000000001";
  const second = "10000000-0000-4000-8000-000000000002";
  if ("writeCatalogueStatus" in state && typeof state.writeCatalogueStatus === "function" && "readCatalogueStatus" in state && typeof state.readCatalogueStatus === "function") {
    state.writeCatalogueStatus(fs, paths, LIVE, first, "codex", "running");
    state.writeCatalogueStatus(fs, paths, LIVE, second, "codex", "failed");
    expect(state.readCatalogueStatus(fs, paths, LIVE, first, "codex")?.status).toBe("running");
    expect(state.readCatalogueStatus(fs, paths, LIVE, second, "codex")?.status).toBe("failed");
  } else {
    expect(undefined).toBe("running");
  }
});

it("stores the account fingerprint with a catalogue status", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  state.writeCatalogueStatus(fs, paths, LIVE, generation, "codex", "failed", "fingerprint");
  const file = path.join(path.dirname(catalogueCachePath(paths, "codex", LIVE, generation)), "codex.status.json");
  expect(JSON.parse(fs.readFileUtf8(file) ?? "null")).toEqual({ status: "failed", fingerprint: "fingerprint" });
});

it("reads a catalogue status that contains an account fingerprint", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  state.writeCatalogueStatus(fs, paths, LIVE, generation, "codex", "failed", "fingerprint");
  expect(state.readCatalogueStatus(fs, paths, LIVE, generation, "codex")?.status).toBe("failed");
});

it("returns the account fingerprint alongside catalogue status", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  state.writeCatalogueStatus(fs, paths, LIVE, generation, "codex", "failed", "fingerprint");
  expect(state.readCatalogueStatus(fs, paths, LIVE, generation, "codex")).toEqual({ status: "failed", fingerprint: "fingerprint" });
});

it("stores when the catalogue status was recorded", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  const recordedAt = 123;
  state.writeCatalogueStatus(fs, paths, LIVE, generation, "codex", "failed", "fingerprint", recordedAt);
  expect(state.readCatalogueStatus(fs, paths, LIVE, generation, "codex")).toEqual({ status: "failed", fingerprint: "fingerprint", recordedAt });
});
/** A recognisable capability, so an assertion can search every serialised output for it. */
const SECRET_CAPABILITY = "capability-that-must-never-be-listed";

it("records each supervisor's Codex home independently", () => {
  const fs = createFakeFarmFs({});
  writeFrontDoorCodexHome(fs, paths.frontdoorDir, LIVE, "/accounts/first", "10000000-0000-4000-8000-000000000001");
  writeFrontDoorCodexHome(fs, paths.frontdoorDir, DEAD, "/accounts/second", "10000000-0000-4000-8000-000000000002");
  expect(readFrontDoorCodexHome(fs, paths.frontdoorDir, LIVE)).toBe("/accounts/first");
  expect(readFrontDoorCodexHome(fs, paths.frontdoorDir, DEAD)).toBe("/accounts/second");
});

it("records the unique generation alongside a supervisor's Codex home", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  writeFrontDoorCodexHome(fs, paths.frontdoorDir, LIVE, "/accounts/first", generation);
  expect(readFrontDoorCodexRecord(fs, paths.frontdoorDir, LIVE)).toEqual({ codexHome: "/accounts/first", generation });
});

it("does not accept a supervisor record without a generation", () => {
  const fs = createFakeFarmFs({ [`${paths.frontdoorDir}/codex-homes/${String(LIVE)}.json`]: JSON.stringify({ codexHome: "/accounts/first" }) });
  expect(readFrontDoorCodexRecord(fs, paths.frontdoorDir, LIVE)).toBeUndefined();
});

it("does not trust a relative Codex home from a supervisor record", () => {
  const fs = createFakeFarmFs({ [`${paths.frontdoorDir}/codex-homes/${String(LIVE)}.json`]: JSON.stringify({ codexHome: "relative-home" }) });
  expect(readFrontDoorCodexHome(fs, paths.frontdoorDir, LIVE)).toBeUndefined();
});

describe("front-door session registry", () => {
  it("lists a registered launch even though its record carries a capability token", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 7, token: SECRET_CAPABILITY });
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir)).toEqual([{ pid: LIVE, startedAt: 7 }]);
  });

  it("keeps the identity a launch recorded in its record, and records none for a launch that stated none", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 7, token: SECRET_CAPABILITY, ...recordOf({ sessionId: "s-1", identity: "id-work" }) });
    const names = fs.readdir(paths.frontdoorSessionsDir);
    expect(names).toHaveLength(1);
    const written: unknown = JSON.parse(fs.readFileUtf8(`${paths.frontdoorSessionsDir}/${names[0] ?? ""}`) ?? "");
    expect(written).toMatchObject({ sessionId: "s-1", identity: "id-work" });
    expect(recordOf({ sessionId: "s-2" })).toEqual({ sessionId: "s-2" });
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

  it("removes a route file whose registry record is gone, as when the supervisor pruned the launch between the lookup and the write, and keeps one whose record exists", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0, token: "live-token" });
    writeLaunchRoute(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0 }, { kind: "provider", provider: "z" });
    // The orphan is written directly: `writeLaunchRoute` refuses a launch with no record, which is the case the prune backs up.
    fs.writeFilePrivate(`${paths.frontdoorSessionsDir}/${String(DEAD)}.route.json`, `${JSON.stringify({ version: 1, startedAt: 0, route: { kind: "provider", provider: "z" } })}\n`);
    expect(readLaunchRoute(fs, paths.frontdoorSessionsDir, { pid: DEAD, startedAt: 0 })).toEqual({ kind: "provider", provider: "z" });
    pruneDeadFrontDoorSessions(fs, paths.frontdoorSessionsDir, listFrontDoorSessions(fs, paths.frontdoorSessionsDir), (pid) => pid === LIVE);
    expect(readLaunchRoute(fs, paths.frontdoorSessionsDir, { pid: DEAD, startedAt: 0 })).toBeUndefined();
    expect(fs.readdir(paths.frontdoorSessionsDir)).not.toContain(`${String(DEAD)}.route.json`);
    expect(readLaunchRoute(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0 })).toEqual({ kind: "provider", provider: "z" });
  });

  it("removes one launcher's record idempotently", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0, token: "t" });
    removeFrontDoorSession(fs, paths.frontdoorSessionsDir, LIVE);
    removeFrontDoorSession(fs, paths.frontdoorSessionsDir, LIVE);
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir)).toEqual([]);
  });

  it("keeps a launch's main-loop route beside its record, for that launch only, and removes it with the record", () => {
    const fs = createFakeFarmFs({});
    const dir = paths.frontdoorSessionsDir;
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 1, token: "t" });
    writeLaunchRoute(fs, dir, { pid: LIVE, startedAt: 1 }, { kind: "provider", provider: "z" });
    expect(readLaunchRoute(fs, dir, { pid: LIVE, startedAt: 1 })).toEqual({ kind: "provider", provider: "z" });
    // The route file is no registry record: a listing and the live registry see one launch.
    expect(listFrontDoorSessions(fs, dir).map((session) => session.pid)).toEqual([LIVE]);
    expect(createLiveSessionRegistry({ fs, sessionsDir: dir }).rescan()).toHaveLength(1);
    // Another start time under the same pid is another launch.
    expect(readLaunchRoute(fs, dir, { pid: LIVE, startedAt: 2 })).toBeUndefined();
    removeFrontDoorSession(fs, dir, LIVE);
    expect(readLaunchRoute(fs, dir, { pid: LIVE, startedAt: 1 })).toBeUndefined();
    expect(fs.readdir(dir)).toEqual([]);
  });

  it("drops the route an earlier launch left under a pid when a launcher registers under it again", () => {
    const fs = createFakeFarmFs({});
    const dir = paths.frontdoorSessionsDir;
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 1, token: "first" });
    writeLaunchRoute(fs, dir, { pid: LIVE, startedAt: 1 }, { kind: "anthropic" });
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 2, token: "second" });
    expect(fs.readdir(dir)).toEqual([`${String(LIVE)}.json`]);
  });

  it("reads a route file as unreadable, naming why, when it is not JSON, has another shape, an extra field, or a version newer than this door reads, and as no route when there is no file", () => {
    const file = `${paths.frontdoorSessionsDir}/${String(LIVE)}.route.json`;
    const read = (text: string | undefined): unknown => {
      const fs = createFakeFarmFs(text === undefined ? {} : { [file]: text });
      return readLaunchRoute(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 1 });
    };
    const good = { version: 1, startedAt: 1, route: { kind: "provider", provider: "z" } };
    expect(read(undefined)).toBeUndefined();
    expect(read(JSON.stringify(good))).toEqual({ kind: "provider", provider: "z" });
    expect(() => read("not json")).toThrow("is not JSON");
    expect(() => read(JSON.stringify({ ...good, version: 2 }))).toThrow("written by a newer door");
    expect(() => read(JSON.stringify({ ...good, version: 99 }))).toThrow("written by a newer door");
    expect(() => read(JSON.stringify({ startedAt: 1, route: good.route }))).toThrow("is not a route file this door reads");
    expect(() => read(JSON.stringify({ ...good, extra: true }))).toThrow("is not a route file this door reads");
    expect(() => read(JSON.stringify({ ...good, route: { kind: "provider", provider: "" } }))).toThrow("is not a route file this door reads");
  });

  it("does not take a route file's name for a registry record's, so a listing and the live registry never read one as a launch", () => {
    expect(isSessionRecordName("123.json")).toBe(true);
    expect(isSessionRecordName("123.route.json")).toBe(false);
    expect(isSessionRecordName("0123.json")).toBe(false);
    expect(isSessionRecordName("abc.json")).toBe(false);
    const fs = createFakeFarmFs({});
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 1, token: "t" });
    writeLaunchRoute(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 1 }, { kind: "anthropic" });
    expect(listFrontDoorSessions(fs, paths.frontdoorSessionsDir).map((session) => session.pid)).toEqual([LIVE]);
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

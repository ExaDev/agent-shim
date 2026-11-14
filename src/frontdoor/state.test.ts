import { z } from "zod";
import { describe, expect, it } from "vitest";

import type { HeadroomFs } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs, errorWithCode } from "../test-helpers";
import { createLiveSessionRegistry } from "./liveSessionRegistry";
import * as catalogueState from "./catalogueState";
import { MAX_CONTEXT_TEXT_LENGTH } from "./state";
import path from "node:path";
import { catalogueCachePath } from "../providerCatalogue";
import { MAX_TCP_PORT } from "../baseUrlDial";
import { recordOf, listFrontDoorDirectRecords, isSessionRecordName, launchRouteStore, listFrontDoorSessions, pruneMalformedFrontDoorDirectFiles, pruneDeadFrontDoorSessions, readFrontDoorCodexHome, readFrontDoorCodexRecord, readFrontDoorState, readLaunchRoute, removeFrontDoorSession, writeFrontDoorCodexHome, writeFrontDoorSession, writeFrontDoorState, writeLaunchRoute } from "./state";

/** Versions of the route file past the one this door writes, up to well beyond what any door will reach. */
const NEXT_VERSION = 2;
const THIRD_VERSION = 3;
const NEAR_HUNDRED_VERSION = 99;
const HUNDRED_VERSION = 100;
const FAR_VERSION = 1000;
const NEWER_VERSIONS: readonly number[] = [NEXT_VERSION, THIRD_VERSION, NEAR_HUNDRED_VERSION, HUNDRED_VERSION, FAR_VERSION];

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const LIVE = 301;
const DEAD = 302;
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;

it("isolates catalogue status by supervisor generation", () => {
  const fs = createFakeFarmFs({});
  const first = "10000000-0000-4000-8000-000000000001";
  const second = "10000000-0000-4000-8000-000000000002";
  if ("writeCatalogueStatus" in catalogueState && typeof catalogueState.writeCatalogueStatus === "function" && "readCatalogueStatus" in catalogueState && typeof catalogueState.readCatalogueStatus === "function") {
    catalogueState.writeCatalogueStatus(fs, paths, LIVE, first, "codex", "running");
    catalogueState.writeCatalogueStatus(fs, paths, LIVE, second, "codex", "failed");
    expect(catalogueState.readCatalogueStatus(fs, paths, LIVE, first, "codex")?.status).toBe("running");
    expect(catalogueState.readCatalogueStatus(fs, paths, LIVE, second, "codex")?.status).toBe("failed");
  } else {
    expect(undefined).toBe("running");
  }
});

it("stores the account fingerprint with a catalogue status", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  catalogueState.writeCatalogueStatus(fs, paths, LIVE, generation, "codex", "failed", "fingerprint");
  const file = path.join(path.dirname(catalogueCachePath(paths, "codex", LIVE, generation)), "codex.status.json");
  expect(JSON.parse(fs.readFileUtf8(file) ?? "null")).toEqual({ status: "failed", fingerprint: "fingerprint" });
});

it("keeps the status file as an older launcher reads it, and records why a refresh failed beside it", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  catalogueState.writeCatalogueStatus(fs, paths, LIVE, generation, "spark", "failed", undefined, 1);
  catalogueState.writeCatalogueFailureReason(fs, paths, LIVE, generation, "spark", "no catalogue from http://x.example/v1/models: status 308");
  const statusFile = path.join(path.dirname(catalogueCachePath(paths, "spark", LIVE, generation)), "spark.status.json");
  expect(JSON.parse(fs.readFileUtf8(statusFile) ?? "null")).toEqual({ status: "failed", recordedAt: 1 });
  expect(catalogueState.readCatalogueFailure(fs, paths, LIVE, generation, "spark")?.reason).toBe("no catalogue from http://x.example/v1/models: status 308");
});

it("cuts a failure reason to its bound, and clears it when the refresh did not fail", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  catalogueState.writeCatalogueFailureReason(fs, paths, LIVE, generation, "long", "x".repeat(catalogueState.CATALOGUE_FAILURE_REASON_MAX_CHARS * 2));
  expect(catalogueState.readCatalogueFailure(fs, paths, LIVE, generation, "long")?.reason).toHaveLength(catalogueState.CATALOGUE_FAILURE_REASON_MAX_CHARS);
  catalogueState.writeCatalogueFailureReason(fs, paths, LIVE, generation, "long", undefined);
  expect(catalogueState.readCatalogueFailure(fs, paths, LIVE, generation, "long")?.reason).toBeUndefined();
});

it("keeps the failure reason of a provider apart from the catalogue cache of one named like its file", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  const cacheOfOther = catalogueCachePath(paths, "foo.failure", LIVE, generation);
  fs.mkdirp(path.dirname(cacheOfOther));
  fs.writeFilePrivate(cacheOfOther, "the cache of provider foo.failure");
  for (const [status, reason] of [["failed", "why"], ["running", undefined], ["failed", "again"], ["ready", undefined]] as const) {
    catalogueState.catalogueStatusPublisher(fs, paths, LIVE, generation, () => 1)("foo", status, undefined, reason);
    expect(fs.readFileUtf8(cacheOfOther), `${status} ${String(reason)}`).toBe("the cache of provider foo.failure");
  }
  expect(catalogueState.readCatalogueFailure(fs, paths, LIVE, generation, "foo")?.reason).toBeUndefined();
  catalogueState.writeCatalogueFailureReason(fs, paths, LIVE, generation, "foo.failure", "the reason of provider foo.failure");
  expect(catalogueState.readCatalogueFailure(fs, paths, LIVE, generation, "foo")?.reason).toBeUndefined();
  expect(fs.readFileUtf8(cacheOfOther)).toBe("the cache of provider foo.failure");
});

it("reads no reason longer than the bound a release writes, as it does from a file that is not one it wrote", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  const file = path.join(path.dirname(catalogueCachePath(paths, "spark", LIVE, generation)), "failures", "spark.json");
  fs.mkdirp(path.dirname(file));
  fs.writeFilePrivate(file, JSON.stringify({ reason: "x".repeat(catalogueState.CATALOGUE_FAILURE_REASON_MAX_CHARS) }));
  expect(catalogueState.readCatalogueFailure(fs, paths, LIVE, generation, "spark")?.reason).toHaveLength(catalogueState.CATALOGUE_FAILURE_REASON_MAX_CHARS);
  fs.writeFilePrivate(file, JSON.stringify({ reason: "x".repeat(catalogueState.CATALOGUE_FAILURE_REASON_MAX_CHARS + 1) }));
  expect(catalogueState.readCatalogueFailure(fs, paths, LIVE, generation, "spark")?.reason).toBeUndefined();
});

it("reads no reason from a file that is not one this release wrote", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  catalogueState.writeCatalogueFailureReason(fs, paths, LIVE, generation, "spark", "why");
  const file = path.join(path.dirname(catalogueCachePath(paths, "spark", LIVE, generation)), "failures", "spark.json");
  fs.writeFilePrivate(file, JSON.stringify({ reason: "why", other: 1 }));
  expect(catalogueState.readCatalogueFailure(fs, paths, LIVE, generation, "spark")?.reason).toBeUndefined();
  fs.writeFilePrivate(file, "{ not json");
  expect(catalogueState.readCatalogueFailure(fs, paths, LIVE, generation, "spark")?.reason).toBeUndefined();
});

it("reads a catalogue status that contains an account fingerprint", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  catalogueState.writeCatalogueStatus(fs, paths, LIVE, generation, "codex", "failed", "fingerprint");
  expect(catalogueState.readCatalogueStatus(fs, paths, LIVE, generation, "codex")?.status).toBe("failed");
});

it("returns the account fingerprint alongside catalogue status", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  catalogueState.writeCatalogueStatus(fs, paths, LIVE, generation, "codex", "failed", "fingerprint");
  expect(catalogueState.readCatalogueStatus(fs, paths, LIVE, generation, "codex")).toEqual({ status: "failed", fingerprint: "fingerprint" });
});

it("stores when the catalogue status was recorded", () => {
  const fs = createFakeFarmFs({});
  const generation = "10000000-0000-4000-8000-000000000001";
  const recordedAt = 123;
  catalogueState.writeCatalogueStatus(fs, paths, LIVE, generation, "codex", "failed", "fingerprint", recordedAt);
  expect(catalogueState.readCatalogueStatus(fs, paths, LIVE, generation, "codex")).toEqual({ status: "failed", fingerprint: "fingerprint", recordedAt });
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

it("reads no Codex record, instead of throwing, when the supervisor's record cannot be read", () => {
  const unreadable = { readFileUtf8: (): never => { throw errorWithCode("EACCES: permission denied", "EACCES"); } };
  expect(readFrontDoorCodexRecord(unreadable, paths.frontdoorDir, LIVE)).toBeUndefined();
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
    expect(readLaunchRoute(fs, paths.frontdoorSessionsDir, { pid: DEAD, startedAt: 0 }, () => undefined)).toEqual({ kind: "provider", provider: "z" });
    pruneDeadFrontDoorSessions(fs, paths.frontdoorSessionsDir, listFrontDoorSessions(fs, paths.frontdoorSessionsDir), (pid) => pid === LIVE);
    expect(readLaunchRoute(fs, paths.frontdoorSessionsDir, { pid: DEAD, startedAt: 0 }, () => undefined)).toBeUndefined();
    expect(fs.readdir(paths.frontdoorSessionsDir)).not.toContain(`${String(DEAD)}.route.json`);
    expect(readLaunchRoute(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 0 }, () => undefined)).toEqual({ kind: "provider", provider: "z" });
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
    expect(readLaunchRoute(fs, dir, { pid: LIVE, startedAt: 1 }, () => undefined)).toEqual({ kind: "provider", provider: "z" });
    // The route file is no registry record: a listing and the live registry see one launch.
    expect(listFrontDoorSessions(fs, dir).map((session) => session.pid)).toEqual([LIVE]);
    expect(createLiveSessionRegistry({ fs, sessionsDir: dir }).rescan()).toHaveLength(1);
    // Another start time under the same pid is another launch.
    expect(readLaunchRoute(fs, dir, { pid: LIVE, startedAt: 2 }, () => undefined)).toBeUndefined();
    removeFrontDoorSession(fs, dir, LIVE);
    expect(readLaunchRoute(fs, dir, { pid: LIVE, startedAt: 1 }, () => undefined)).toBeUndefined();
    expect(fs.readdir(dir)).toEqual([]);
  });

  it("keeps the mark that an override moved a launch's main loop, so a replacing door lets the context lapse with the override", () => {
    const fs = createFakeFarmFs({});
    const dir = paths.frontdoorSessionsDir;
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 1, token: "t" });
    writeLaunchRoute(fs, dir, { pid: LIVE, startedAt: 1 }, { kind: "provider", provider: "z", requestedModel: "claude-opus-5-5", movedBy: "override", chosenProvider: "m" });
    expect(readLaunchRoute(fs, dir, { pid: LIVE, startedAt: 1 }, () => undefined)).toEqual({ kind: "provider", provider: "z", requestedModel: "claude-opus-5-5", movedBy: "override", chosenProvider: "m" });
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
      return readLaunchRoute(fs, paths.frontdoorSessionsDir, { pid: LIVE, startedAt: 1 }, () => undefined);
    };
    const good = { version: 1, startedAt: 1, route: { kind: "provider", provider: "z" } };
    expect(read(undefined)).toBeUndefined();
    expect(read(JSON.stringify(good))).toEqual({ kind: "provider", provider: "z" });
    expect(() => read("not json")).toThrow("is not JSON");
    for (const newer of NEWER_VERSIONS) {
      expect(() => read(JSON.stringify({ ...good, version: newer })), `version ${String(newer)}`).toThrow("written by a newer door");
    }
    expect(() => read(JSON.stringify({ startedAt: 1, route: good.route }))).toThrow("is not a route file this door reads");
    expect(() => read(JSON.stringify({ ...good, extra: true }))).toThrow("is not a route file this door reads");
    expect(() => read(JSON.stringify({ ...good, route: { kind: "provider", provider: "" } }))).toThrow("is not a route file this door reads");
  });

  it("identifies a launch's route file by its modification time and size, so another door's rewrite is seen without a read, and by nothing when there is no file", () => {
    const fs = createFakeFarmFs({});
    const dir = paths.frontdoorSessionsDir;
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 1, token: "t" });
    const store = launchRouteStore(fs, dir, () => undefined);
    expect(store.identity({ pid: LIVE, startedAt: 1 })).toBeUndefined();
    store.write({ pid: LIVE, startedAt: 1 }, { kind: "anthropic" });
    const first = store.identity({ pid: LIVE, startedAt: 1 });
    expect(first).toBeDefined();
    expect(store.identity({ pid: LIVE, startedAt: 1 })).toBe(first);
    store.write({ pid: LIVE, startedAt: 1 }, { kind: "provider", provider: "z" });
    expect(store.identity({ pid: LIVE, startedAt: 1 })).not.toBe(first);
  });

  describe("the route and its facts on disk", () => {
    const launch = { pid: LIVE, startedAt: 7 };
    const dir = paths.frontdoorSessionsDir;
    const routeFile = `${dir}/${String(LIVE)}.route.json`;
    const factsFile = `${dir}/${String(LIVE)}.context.json`;
    const provider = { kind: "provider", provider: "z" } as const;

    function launched(): { readonly fs: ReturnType<typeof createFakeFarmFs>; readonly lines: string[]; readonly store: ReturnType<typeof launchRouteStore> } {
      const fs = createFakeFarmFs({});
      writeFrontDoorSession(fs, dir, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
      const lines: string[] = [];
      return { fs, lines, store: launchRouteStore(fs, dir, (line) => {
        lines.push(line);
      }) };
    }

    it("writes the route file exactly as every door has written it, whatever facts the context carries, so an older door reads the route unchanged", () => {
      const { fs, store } = launched();
      store.write(launch, { ...provider, credential: "bearer from env Z_TOKEN", requestedModel: "claude-sonnet-5-5", servedModel: "glm-5.3-pro" });
      expect(fs.readFileUtf8(routeFile)).toBe('{"version":1,"startedAt":7,"route":{"kind":"provider","provider":"z"}}\n');
      store.write(launch, { kind: "anthropic", credential: "identity work login" });
      expect(fs.readFileUtf8(routeFile)).toBe('{"version":1,"startedAt":7,"route":{"kind":"anthropic"}}\n');
    });

    it("is read by a door that knows only the route file: its reader, which is strict about the shape of that file, returns the route", () => {
      // The route file reader an earlier door has, in the shape it was written: a strict file of version 1 holding a strict route.
      const OldRouteFile = z.strictObject({ version: z.literal(1), startedAt: z.number(), route: z.union([z.strictObject({ kind: z.literal("anthropic") }), z.strictObject({ kind: z.literal("provider"), provider: z.string().min(1) })]) });
      const { fs, store } = launched();
      store.write(launch, { ...provider, credential: "bearer from env Z_TOKEN", requestedModel: "a", servedModel: "b" });
      const old = OldRouteFile.parse(JSON.parse(fs.readFileUtf8(routeFile) ?? ""));
      expect(old.route).toEqual(provider);
      expect(old.startedAt).toBe(launch.startedAt);
    });

    it("round trips a context of each route with its facts through the store", () => {
      const { store } = launched();
      const contexts = [
        { ...provider, credential: "bearer from env Z_TOKEN", requestedModel: "claude-sonnet-5-5", servedModel: "glm-5.3-pro" },
        { kind: "anthropic", credential: "identity work login", requestedModel: "anthropic/claude-sonnet-5-5", servedModel: "claude-sonnet-5-5" },
        { kind: "anthropic" },
        { ...provider, requestedModel: "fast" },
      ] as const;
      for (const context of contexts) {
        store.write(launch, context);
        expect(store.read(launch)).toEqual(context);
      }
    });

    it("leaves no facts file behind when a context has no facts, so stale facts are never read with a newer route", () => {
      const { fs, store } = launched();
      store.write(launch, { ...provider, credential: "bearer from env Z_TOKEN" });
      expect(fs.readFileUtf8(factsFile)).toBeDefined();
      store.write(launch, { kind: "anthropic" });
      expect(fs.readFileUtf8(factsFile)).toBeUndefined();
      expect(store.read(launch)).toEqual({ kind: "anthropic" });
    });

    it("refuses to write a name over the bound or an empty one, and writes nothing", () => {
      const { fs, store } = launched();
      expect(() => {
        store.write(launch, { ...provider, servedModel: "a".repeat(MAX_CONTEXT_TEXT_LENGTH + 1) });
      }).toThrow();
      expect(() => {
        store.write(launch, { ...provider, credential: "" });
      }).toThrow();
      expect(fs.readdir(dir).filter((name) => name.includes("route") || name.includes("context"))).toEqual([]);
      store.write(launch, { ...provider, servedModel: "a".repeat(MAX_CONTEXT_TEXT_LENGTH) });
      expect(store.read(launch)).toMatchObject({ servedModel: "a".repeat(MAX_CONTEXT_TEXT_LENGTH) });
    });

    it("reads the route without the facts, reporting once per launch, when the facts file is not JSON, has another shape, an empty name, an extra field or a version it does not know", () => {
      for (const facts of ["not json", JSON.stringify({ version: 1, startedAt: 7, facts: { credential: "" } }), JSON.stringify({ version: 1, startedAt: 7, facts: { servedModel: "a".repeat(MAX_CONTEXT_TEXT_LENGTH + 1) } }), JSON.stringify({ version: 1, startedAt: 7, facts: { other: "x" } }), JSON.stringify({ version: 2, startedAt: 7, facts: {} }), JSON.stringify({ startedAt: 7, facts: {} })]) {
        const { fs, lines, store } = launched();
        store.write(launch, provider);
        fs.writeFilePrivate(factsFile, facts);
        expect(store.read(launch)).toEqual(provider);
        expect(store.read(launch)).toEqual(provider);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("context.json");
      }
    });

    it("takes no facts from a file of an earlier launch under the same pid", () => {
      const { fs, store } = launched();
      store.write(launch, { ...provider, credential: "bearer from env Z_TOKEN" });
      fs.writeFilePrivate(factsFile, JSON.stringify({ version: 1, startedAt: 6, facts: { credential: "stale" } }));
      expect(store.read(launch)).toEqual(provider);
    });

    it("removes the facts file with the route file, when the launch ends, when its pid registers again, and as an orphan", () => {
      const { fs, store } = launched();
      store.write(launch, { ...provider, credential: "bearer from env Z_TOKEN" });
      removeFrontDoorSession(fs, dir, LIVE);
      expect(fs.readdir(dir)).toEqual([]);
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 7, token: "t" });
      launchRouteStore(fs, dir, () => undefined).write(launch, { ...provider, credential: "bearer from env Z_TOKEN" });
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 8, token: "u" });
      expect(fs.readdir(dir)).toEqual([`${String(LIVE)}.json`]);
      fs.writeFilePrivate(`${dir}/${String(DEAD)}.context.json`, JSON.stringify({ version: 1, startedAt: 0, facts: {} }));
      pruneDeadFrontDoorSessions(fs, dir, listFrontDoorSessions(fs, dir), () => true);
      expect(fs.readdir(dir)).not.toContain(`${String(DEAD)}.context.json`);
    });

    it("makes the identity of both files, so another door's rewrite of the facts alone is seen: one part for each, and none for a file that is not there", () => {
      const { store } = launched();
      store.write(launch, provider);
      const [routePart, factsPart] = (store.identity(launch) ?? "").split("|");
      expect(routePart).not.toBe("-");
      expect(factsPart).toBe("-");
      store.write(launch, { ...provider, servedModel: "a" });
      const [, withFacts] = (store.identity(launch) ?? "").split("|");
      expect(withFacts).toBeDefined();
      expect(withFacts).not.toBe("-");
    });
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

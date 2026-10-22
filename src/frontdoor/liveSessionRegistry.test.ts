import { describe, expect, it } from "vitest";

import type { HeadroomFs } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { createLiveSessionRegistry } from "./liveSessionRegistry";
import { listFrontDoorSessions, pruneDeadFrontDoorSessions, removeFrontDoorSession, writeFrontDoorSession } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");
const dir = paths.frontdoorSessionsDir;

const LIVE = 301;
const DEAD = 302;
const LATE = 303;
/** How many times a token is presented in a test that asserts the cost of each presentation: more than one, so a cost paid once and cached cannot pass for a cost paid per request. */
const PRESENTATIONS = 4;

/** The filesystem operations a registry performed, counted so a test can assert what a request cost. */
interface Counts {
  readdirs: number;
  stats: number;
  reads: string[];
}

/** An in-memory registry directory whose reads are counted, so admission's cost is observable as filesystem work rather than as time. */
function countedWorld(): { readonly fs: HeadroomFs; readonly counts: Counts; readonly reset: () => void } {
  const inner = createFakeFarmFs({});
  const counts: Counts = { readdirs: 0, stats: 0, reads: [] };
  const fs: HeadroomFs = {
    ...inner,
    readdir: (target) => {
      counts.readdirs += 1;
      return inner.readdir(target);
    },
    lstat: (target) => {
      counts.stats += 1;
      return inner.lstat(target);
    },
    readFileUtf8: (target) => {
      counts.reads.push(target);
      return inner.readFileUtf8(target);
    },
  };
  return {
    fs,
    counts,
    reset: () => {
      counts.readdirs = 0;
      counts.stats = 0;
      counts.reads = [];
    },
  };
}

describe("live session registry", () => {
  it("admits a token it has already read without touching the filesystem", () => {
    const { fs, counts, reset } = countedWorld();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "live-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    registry.rescan();
    reset();

    for (let request = 0; request < PRESENTATIONS; request += 1) {
      expect(registry.admits("live-token")).toBe(true);
    }
    expect(counts).toEqual({ readdirs: 0, stats: 0, reads: [] });
  });

  it("admits a launch registered after the last rescan on its very first request, reading only that launch's record", () => {
    const { fs, counts, reset } = countedWorld();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "live-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    registry.rescan();
    writeFrontDoorSession(fs, dir, { pid: LATE, startedAt: 1, token: "late-token" });
    reset();

    expect(registry.admits("late-token")).toBe(true);
    expect(counts).toEqual({ readdirs: 1, stats: 2, reads: [`${dir}/${String(LATE)}.json`] });

    reset();
    expect(registry.admits("late-token")).toBe(true);
    expect(counts).toEqual({ readdirs: 0, stats: 0, reads: [] });
  });

  it("admits a launch registered before the registry ever scanned, as a door that has just started sees one", () => {
    const { fs } = countedWorld();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "live-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    expect(registry.admits("live-token")).toBe(true);
  });

  it("refuses an unknown token with one directory listing and a stat per record but no record read, however often it is presented", () => {
    const { fs, counts, reset } = countedWorld();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "live-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    registry.rescan();
    reset();

    for (let request = 0; request < PRESENTATIONS; request += 1) {
      expect(registry.admits("guessed-token")).toBe(false);
    }
    expect(counts).toEqual({ readdirs: PRESENTATIONS, stats: PRESENTATIONS, reads: [] });
  });

  it("refuses a pruned launch's token once the tick has pruned it and told the registry", () => {
    const { fs } = countedWorld();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "live-token" });
    writeFrontDoorSession(fs, dir, { pid: DEAD, startedAt: 0, token: "dead-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    const listed = registry.rescan();
    expect(registry.admits("dead-token")).toBe(true);

    const pruned = pruneDeadFrontDoorSessions(fs, dir, listed, (pid) => pid === LIVE);
    registry.forget(pruned);

    expect(registry.admits("dead-token")).toBe(false);
    expect(registry.admits("live-token")).toBe(true);
  });

  it("refuses a removed launch's token after the next rescan", () => {
    const { fs } = countedWorld();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "live-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    registry.rescan();
    removeFrontDoorSession(fs, dir, LIVE);
    registry.rescan();
    expect(registry.admits("live-token")).toBe(false);
  });

  it("drops a removed launch's token when an unknown token's listing shows its record gone", () => {
    const { fs } = countedWorld();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "live-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    registry.rescan();
    removeFrontDoorSession(fs, dir, LIVE);
    expect(registry.admits("guessed-token")).toBe(false);
    expect(registry.admits("live-token")).toBe(false);
  });

  it("admits a token a launcher registered under a pid that already had a record, on its first request", () => {
    const { fs, counts, reset } = countedWorld();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "first-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    registry.rescan();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 5, token: "second-token" });
    reset();
    expect(registry.admits("second-token")).toBe(true);
    expect(counts.reads).toEqual([`${dir}/${String(LIVE)}.json`]);
    expect(registry.admits("first-token")).toBe(false);
  });

  it("replaces the tokens of a record rewritten under the same pid at the next rescan", () => {
    const { fs } = countedWorld();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "first-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    registry.rescan();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 5, token: "second-token" });
    registry.rescan();
    expect(registry.admits("second-token")).toBe(true);
    expect(registry.admits("first-token")).toBe(false);
  });

  it("keeps admitting the sound launches when a record is malformed, and reads the malformed one once", () => {
    const { fs, counts, reset } = countedWorld();
    fs.mkdirPrivate(dir);
    fs.writeFilePrivate(`${dir}/1.json`, "not json");
    fs.writeFilePrivate(`${dir}/2.json`, JSON.stringify({ pid: 2, startedAt: 0 }));
    fs.writeFilePrivate(`${dir}/notes.txt`, "ignored");
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "live-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    expect(registry.rescan().map((session) => session.pid)).toEqual([LIVE]);
    expect(registry.admits("live-token")).toBe(true);

    reset();
    expect(registry.admits("guessed-token")).toBe(false);
    expect(registry.admits("guessed-token")).toBe(false);
    expect(counts.reads).toEqual([]);
  });

  it("admits a launch that registers while a malformed record sits in the directory", () => {
    const { fs } = countedWorld();
    fs.mkdirPrivate(dir);
    fs.writeFilePrivate(`${dir}/1.json`, "not json");
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    registry.rescan();
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "live-token" });
    expect(registry.admits("live-token")).toBe(true);
  });

  it("lists exactly what the registry's own listing does, without a token in it", () => {
    const { fs } = countedWorld();
    writeFrontDoorSession(fs, dir, { pid: DEAD, startedAt: 2, token: "capability-that-must-never-be-listed", supervisorPid: 9 });
    writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 1, token: "other-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    const listed = registry.rescan();
    expect(listed).toEqual(listFrontDoorSessions(fs, dir));
    expect(JSON.stringify(listed)).not.toContain("capability-that-must-never-be-listed");
  });
});

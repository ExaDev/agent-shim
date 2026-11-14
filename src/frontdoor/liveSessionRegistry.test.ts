import { describe, expect, it } from "vitest";

import type { ModelsConfig } from "../config/schema";
import type { HeadroomFs } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { createLiveSessionRegistry } from "./liveSessionRegistry";
import { listFrontDoorSessions, pruneDeadFrontDoorSessions, recordOf, removeFrontDoorSession, writeFrontDoorSession } from "./state";

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

  describe("identity by capability token", () => {
    it("answers the identity a launch recorded from memory, and none for a launch that recorded none", () => {
      const { fs, counts, reset } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "a", ...recordOf({ sessionId: "s-live", identity: "id-work" }) });
      writeFrontDoorSession(fs, dir, { pid: DEAD, startedAt: 0, token: "b", ...recordOf({ sessionId: "s-plain" }) });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      reset();
      expect(registry.identityOf("a")).toBe("id-work");
      expect(registry.identityOf("b")).toBeUndefined();
      expect(counts).toEqual({ readdirs: 0, stats: 0, reads: [] });
    });

    it("finds the identity of a launch that registered since the last rescan on its first lookup", () => {
      const { fs } = countedWorld();
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      writeFrontDoorSession(fs, dir, { pid: LATE, startedAt: 1, token: "late-token", ...recordOf({ sessionId: "s-late", identity: "id-late" }) });
      expect(registry.identityOf("late-token")).toBe("id-late");
    });

    it("loses a launch's identity with the launch", () => {
      const { fs } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "a", ...recordOf({ sessionId: "s-live", identity: "id-work" }) });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      const listed = registry.rescan();
      registry.forget(pruneDeadFrontDoorSessions(fs, dir, listed, () => false));
      expect(registry.identityOf("a")).toBeUndefined();
    });
  });

  describe("models block by session id", () => {
    const BLOCK: ModelsConfig = { virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } } };

    it("answers a session id it has already read from memory, and answers a launch that added nothing with undefined", () => {
      const { fs, counts, reset } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "a", ...recordOf({ sessionId: "s-live", models: BLOCK }) });
      writeFrontDoorSession(fs, dir, { pid: DEAD, startedAt: 0, token: "b", ...recordOf({ sessionId: "s-plain" }) });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      reset();
      expect(registry.modelsOf("s-live")).toEqual(BLOCK);
      expect(registry.modelsOf("s-plain")).toBeUndefined();
      expect(counts).toEqual({ readdirs: 0, stats: 0, reads: [] });
    });

    it("finds the block of a launch that registered since the last rescan on its first lookup", () => {
      const { fs } = countedWorld();
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      writeFrontDoorSession(fs, dir, { pid: LATE, startedAt: 1, token: "late-token", ...recordOf({ sessionId: "s-late", models: BLOCK }) });
      expect(registry.modelsOf("s-late")).toEqual(BLOCK);
    });

    it("looks an unknown session id up with one listing and a stat per record but no record read", () => {
      const { fs, counts, reset } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "a", ...recordOf({ sessionId: "s-live" }) });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      reset();
      for (let request = 0; request < PRESENTATIONS; request += 1) {
        expect(registry.modelsOf("unknown")).toBeUndefined();
      }
      expect(counts).toEqual({ readdirs: PRESENTATIONS, stats: PRESENTATIONS, reads: [] });
    });

    it("loses a launch's block with the launch", () => {
      const { fs } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 0, token: "a", ...recordOf({ sessionId: "s-live", models: BLOCK }) });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      const listed = registry.rescan();
      registry.forget(pruneDeadFrontDoorSessions(fs, dir, listed, () => false));
      expect(registry.modelsOf("s-live")).toBeUndefined();
    });
  });
  describe("a launch by its capability", () => {
    it("names the launch holding a token by its pid and start time, finds one registered since the last rescan, and loses a launch with the launch", () => {
      const { fs, counts, reset } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 7, token: "a", ...recordOf({ sessionId: "s-live" }) });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      reset();
      expect(registry.launchOfToken("a")).toEqual({ pid: LIVE, startedAt: 7 });
      expect(registry.holdsLaunch({ pid: LIVE, startedAt: 7 })).toBe(true);
      expect(counts).toEqual({ readdirs: 0, stats: 0, reads: [] });
      writeFrontDoorSession(fs, dir, { pid: LATE, startedAt: 1, token: "late-token", ...recordOf({ sessionId: "s-late" }) });
      expect(registry.launchOfToken("late-token")).toEqual({ pid: LATE, startedAt: 1 });
      expect(registry.launchOfToken("unknown")).toBeUndefined();
      const listed = registry.rescan();
      registry.forget(pruneDeadFrontDoorSessions(fs, dir, listed, () => false));
      expect(registry.holdsLaunch({ pid: LIVE, startedAt: 7 })).toBe(false);
    });

    it("names the Claude Code version a launch recorded for its binary, finds one registered since the last rescan, and names none for a launch that recorded none or is gone", () => {
      const { fs } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 7, token: "a", ...recordOf({ sessionId: "s-live", claudeVersion: "2.1.319" }) });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      expect(registry.claudeVersionOf({ pid: LIVE, startedAt: 7 })).toBe("2.1.319");
      // The same pid under another start time is another launch, whose version is not this one's.
      expect(registry.claudeVersionOf({ pid: LIVE, startedAt: 8 })).toBeUndefined();
      writeFrontDoorSession(fs, dir, { pid: LATE, startedAt: 1, token: "late-token", ...recordOf({ sessionId: "s-late" }) });
      expect(registry.claudeVersionOf({ pid: LATE, startedAt: 1 })).toBeUndefined();
      const listed = registry.rescan();
      registry.forget(pruneDeadFrontDoorSessions(fs, dir, listed, () => false));
      expect(registry.claudeVersionOf({ pid: LIVE, startedAt: 7 })).toBeUndefined();
    });

    it("holds a launch registered since the last rescan by reading its record", () => {
      const { fs, counts, reset } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 7, token: "a", ...recordOf({ sessionId: "s-live" }) });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      writeFrontDoorSession(fs, dir, { pid: LATE, startedAt: 1, token: "late-token", ...recordOf({ sessionId: "s-late" }) });
      reset();
      expect(registry.holdsLaunch({ pid: LATE, startedAt: 1 })).toBe(true);
      expect(counts.reads).toEqual([`${dir}/${String(LATE)}.json`]);
      expect(registry.holdsLaunch({ pid: LIVE, startedAt: 7 })).toBe(true);
    });

    it("gives a launcher that registers again under its own pid a new launch, though it carries the same session id", () => {
      const { fs } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 1, token: "first", ...recordOf({ sessionId: "s-same" }) });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      const first = registry.launchOfToken("first");
      expect(first).toEqual({ pid: LIVE, startedAt: 1 });
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 2, token: "second", ...recordOf({ sessionId: "s-same" }) });
      registry.rescan();
      expect(registry.launchOfToken("second")).toEqual({ pid: LIVE, startedAt: 2 });
      expect(registry.launchOfToken("first")).toBeUndefined();
      expect(registry.holdsLaunch({ pid: LIVE, startedAt: 1 })).toBe(false);
    });

    it("names no launch for a record that carries no session id, such as the door's own transparent-surface session", () => {
      const { fs } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 1, token: "transparent" });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      expect(registry.admits("transparent")).toBe(true);
      expect(registry.launchOfToken("transparent")).toBeUndefined();
    });

    it("names each of two live launches that carry one session id by its own token", () => {
      const { fs } = countedWorld();
      writeFrontDoorSession(fs, dir, { pid: LIVE, startedAt: 1, token: "first", ...recordOf({ sessionId: "s-shared" }) });
      writeFrontDoorSession(fs, dir, { pid: LATE, startedAt: 2, token: "second", ...recordOf({ sessionId: "s-shared" }) });
      const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
      registry.rescan();
      expect(registry.launchOfToken("first")).toEqual({ pid: LIVE, startedAt: 1 });
      expect(registry.launchOfToken("second")).toEqual({ pid: LATE, startedAt: 2 });
    });
  });
});

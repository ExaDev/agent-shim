import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { createFakeFarmFs } from "../test-helpers";
import { createTranscriptFollower, type TranscriptFollower } from "./transcriptFollower";
import { USAGE_SCHEMA_VERSION, type UsageRecord } from "../usage/schema";
import { committedContextTokens, liveSupervised, readModelMove, requestAccountMove, readSessionState, registerSupervised, removeModelMove, sessionStatePath, stateDirOf, readSessionControl, supervisedSessionOf, supervisedSessionOfBridge, unregisterSupervised, writeModelMove, writeSessionControl, writeSessionState, type SupervisedSession } from "./registry";

const paths = buildLayoutPaths("/state");
const T0 = "2026-10-16T10:00:00.000Z";
const T1 = "2026-10-16T10:05:00.000Z";
const T2 = "2026-10-16T10:10:00.000Z";
const CONTEXT = 120_000;

function session(overrides: Readonly<Partial<SupervisedSession>> = {}): SupervisedSession {
  return { pid: 100, sessionId: "s1", pool: "subs", identity: "work", cwd: "/repo", since: T0, ...overrides };
}

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return { schemaVersion: USAGE_SCHEMA_VERSION, at: T1, provider: "anthropic", route: "anthropic", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed", ...overrides };
}

describe("the supervised session registry", () => {
  it("lists a registered session whose launcher is running, and replaces its entry when it moves", () => {
    const fs = createFakeFarmFs({});
    registerSupervised(fs, paths, session());
    expect(liveSupervised(fs, paths, "subs", () => true)).toEqual([session()]);
    registerSupervised(fs, paths, session({ identity: "spare", since: T1, carriedTokens: CONTEXT }));
    expect(liveSupervised(fs, paths, "subs", () => true)).toEqual([session({ identity: "spare", since: T1, carriedTokens: CONTEXT })]);
  });

  it("keeps each pool's sessions apart", () => {
    const fs = createFakeFarmFs({});
    registerSupervised(fs, paths, session());
    registerSupervised(fs, paths, session({ pool: "other", sessionId: "s2" }));
    expect(liveSupervised(fs, paths, "subs", () => true).map((entry) => entry.sessionId)).toEqual(["s1"]);
    expect(liveSupervised(fs, paths, "other", () => true).map((entry) => entry.sessionId)).toEqual(["s2"]);
  });

  it("removes an entry whose launcher has gone instead of counting it", () => {
    const fs = createFakeFarmFs({});
    registerSupervised(fs, paths, session());
    expect(liveSupervised(fs, paths, "subs", () => false)).toEqual([]);
    expect(liveSupervised(fs, paths, "subs", () => true)).toEqual([]);
  });

  it("removes an entry that is not valid JSON or not a session of this schema", () => {
    const fs = createFakeFarmFs({ "/state/supervise/subs/sessions/bad.json": "{not json", "/state/supervise/subs/sessions/odd.json": JSON.stringify({ pid: 1 }) });
    expect(liveSupervised(fs, paths, "subs", () => true)).toEqual([]);
    expect(fs.readdir("/state/supervise/subs/sessions")).toEqual([]);
  });

  it("unregisters a session, and doing it twice changes nothing", () => {
    const fs = createFakeFarmFs({});
    registerSupervised(fs, paths, session());
    unregisterSupervised(fs, paths, "subs", "s1");
    unregisterSupervised(fs, paths, "subs", "s1");
    expect(liveSupervised(fs, paths, "subs", () => true)).toEqual([]);
  });
});

describe("model-move requests", () => {
  it("writes a request for a session, reads it back, and removes it once claimed", () => {
    const fs = createFakeFarmFs({});
    writeModelMove(fs, paths, { sessionId: "s1", to: "work", model: "opus", at: T1 });
    expect(readModelMove(fs, paths, "s1")).toEqual({ sessionId: "s1", to: "work", model: "opus", at: T1 });
    expect(readModelMove(fs, paths, "s2")).toBeUndefined();
    removeModelMove(fs, paths, "s1");
    expect(readModelMove(fs, paths, "s1")).toBeUndefined();
  });

  it("replaces the request a session already holds, and ignores one that does not parse", () => {
    const fs = createFakeFarmFs({ "/state/model-moves/s1.json": "{not json" });
    expect(readModelMove(fs, paths, "s1")).toBeUndefined();
    writeModelMove(fs, paths, { sessionId: "s1", to: "spare", model: "glm-5.3", at: T2 });
    expect(readModelMove(fs, paths, "s1")).toEqual({ sessionId: "s1", to: "spare", model: "glm-5.3", at: T2 });
  });
});

describe("finding a session's registry entry across pools", () => {
  it("returns the live entry a session id registered, whichever pool holds it", async () => {
    const fs = createFakeFarmFs({});
    registerSupervised(fs, paths, session({ sessionId: "s9", pool: "other", identity: "spare" }));
    const everyoneRunning = async (pids: readonly number[]): Promise<ReadonlySet<number>> => await Promise.resolve(new Set(pids));
    const nobodyRunning = async (): Promise<ReadonlySet<number>> => await Promise.resolve(new Set());
    await expect(supervisedSessionOf(fs, paths, "s9", everyoneRunning)).resolves.toMatchObject({ pool: "other", identity: "spare" });
    await expect(supervisedSessionOf(fs, paths, "s9", nobodyRunning)).resolves.toBeUndefined();
    await expect(supervisedSessionOf(fs, paths, "missing", everyoneRunning)).resolves.toBeUndefined();
  });
});

/** A follower over the fake filesystem's files, read as a real one reads them: the size, then the bytes of a range. */
function fakeFollower(fs: ReturnType<typeof createFakeFarmFs>): TranscriptFollower {
  const bytesOf = (file: string): Buffer | undefined => {
    const text = fs.readFileUtf8(file);
    return text === undefined ? undefined : Buffer.from(text, "utf8");
  };
  return createTranscriptFollower({
    sizeOf: async (file) => await Promise.resolve(bytesOf(file)?.length),
    readRange: async (file, start, end) => await Promise.resolve((bytesOf(file) ?? Buffer.alloc(0)).subarray(start, end)),
  });
}

describe("finding the supervised session a Remote Control session belongs to", () => {
  const everyoneRunning = async (pids: readonly number[]): Promise<ReadonlySet<number>> => await Promise.resolve(new Set(pids));
  const BRIDGE_ROW = JSON.stringify({ type: "bridge-session", sessionId: "local-1", bridgeSessionId: "cse_abc", lastSequenceNum: 4 });

  it("joins by the bridge session id the session's own transcript records, with its control record when the same launcher wrote it", async () => {
    const fs = createFakeFarmFs({ "/t/one.jsonl": `${JSON.stringify({ type: "user" })}\n`, "/t/two.jsonl": `${BRIDGE_ROW}\n` });
    registerSupervised(fs, paths, session({ sessionId: "s1" }));
    registerSupervised(fs, paths, session({ sessionId: "s2", pool: "other" }));
    writeSessionState(fs, paths, "subs", "s1", { mark: "idle", transcriptPath: "/t/one.jsonl", at: T1 });
    writeSessionState(fs, paths, "other", "s2", { mark: "idle", transcriptPath: "/t/two.jsonl", at: T1 });
    writeSessionControl(fs, paths, "other", "s2", { pid: 100, directory: "/plugin" });
    const found = await supervisedSessionOfBridge(fs, paths, "cse_abc", everyoneRunning, fakeFollower(fs));
    expect(found.kind === "found" ? found.session.session.sessionId : found.kind).toBe("s2");
    expect(found.kind === "found" ? found.session.control : undefined).toEqual({ pid: 100, directory: "/plugin" });
    await expect(supervisedSessionOfBridge(fs, paths, "cse_other", everyoneRunning, fakeFollower(fs))).resolves.toEqual({ kind: "none" });
  });

  it("joins only by a bridge-session row, never by the same text inside another row a model could have written", async () => {
    // A tool call's input, or a structured tool result, can hold the exact key and value the join looks for.
    const injected = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { note: { bridgeSessionId: "cse_abc" } } }] }, toolUseResult: { bridgeSessionId: "cse_abc" } });
    const fs = createFakeFarmFs({ "/t/steered.jsonl": `${injected}\n` });
    registerSupervised(fs, paths, session({ sessionId: "s1" }));
    writeSessionState(fs, paths, "subs", "s1", { mark: "idle", transcriptPath: "/t/steered.jsonl", at: T1 });
    await expect(supervisedSessionOfBridge(fs, paths, "cse_abc", everyoneRunning, fakeFollower(fs))).resolves.toEqual({ kind: "none" });
  });

  it("takes each transcript's latest bridge row, so a session that reconnected under a new id no longer answers to its old one", async () => {
    const OLD = JSON.stringify({ type: "bridge-session", sessionId: "local-1", bridgeSessionId: "cse_old", lastSequenceNum: 9 });
    const fs = createFakeFarmFs({ "/t/two.jsonl": `${OLD}\n${BRIDGE_ROW}\n` });
    registerSupervised(fs, paths, session({ sessionId: "s2" }));
    writeSessionState(fs, paths, "subs", "s2", { mark: "idle", transcriptPath: "/t/two.jsonl", at: T1 });
    expect((await supervisedSessionOfBridge(fs, paths, "cse_abc", everyoneRunning, fakeFollower(fs))).kind).toBe("found");
    await expect(supervisedSessionOfBridge(fs, paths, "cse_old", everyoneRunning, fakeFollower(fs))).resolves.toEqual({ kind: "none" });
  });

  it("refuses to choose when two live launches both claim the id", async () => {
    const fs = createFakeFarmFs({ "/t/a.jsonl": `${BRIDGE_ROW}\n`, "/t/b.jsonl": `${BRIDGE_ROW}\n` });
    registerSupervised(fs, paths, session({ sessionId: "s1" }));
    registerSupervised(fs, paths, session({ sessionId: "s2", pool: "other" }));
    writeSessionState(fs, paths, "subs", "s1", { mark: "idle", transcriptPath: "/t/a.jsonl", at: T1 });
    writeSessionState(fs, paths, "other", "s2", { mark: "idle", transcriptPath: "/t/b.jsonl", at: T1 });
    const found = await supervisedSessionOfBridge(fs, paths, "cse_abc", everyoneRunning, fakeFollower(fs));
    expect(found.kind === "ambiguous" ? found.sessionIds : found.kind).toEqual(["s1", "s2"]);
  });

  it("ignores a control record a previous launcher left, and the record goes with the session's entry", async () => {
    const fs = createFakeFarmFs({ "/t/two.jsonl": `${BRIDGE_ROW}\n` });
    registerSupervised(fs, paths, session({ sessionId: "s2" }));
    writeSessionState(fs, paths, "subs", "s2", { mark: "idle", transcriptPath: "/t/two.jsonl", at: T1 });
    writeSessionControl(fs, paths, "subs", "s2", { pid: 7, directory: "/stale" });
    const found = await supervisedSessionOfBridge(fs, paths, "cse_abc", everyoneRunning, fakeFollower(fs));
    expect(found.kind === "found" ? found.session.control : "not found").toBeUndefined();
    unregisterSupervised(fs, paths, "subs", "s2");
    expect(readSessionControl(fs, paths, "subs", "s2")).toBeUndefined();
  });
});

describe("a session's recorded state", () => {
  const STATE = { mark: "idle" as const, contextTokens: CONTEXT, compacted: true, at: T1 };

  it("is written to a file of its own, outside the registry entries, and read back", () => {
    const fs = createFakeFarmFs({});
    registerSupervised(fs, paths, session());
    writeSessionState(fs, paths, "subs", "s1", STATE);
    expect(readSessionState(fs, paths, "subs", "s1")).toEqual(STATE);
    expect(sessionStatePath(paths, "subs", "s1").startsWith(stateDirOf(paths, "subs"))).toBe(true);
    // The state file is not mistaken for a session by the registry listing.
    expect(liveSupervised(fs, paths, "subs", () => true)).toEqual([session()]);
  });

  it("is absent for a session nothing has recorded, and for a file that is not a state", () => {
    const fs = createFakeFarmFs({ [sessionStatePath(paths, "subs", "bad")]: "{not json", [sessionStatePath(paths, "subs", "odd")]: JSON.stringify({ mark: "asleep" }) });
    expect(readSessionState(fs, paths, "subs", "none")).toBeUndefined();
    expect(readSessionState(fs, paths, "subs", "bad")).toBeUndefined();
    expect(readSessionState(fs, paths, "subs", "odd")).toBeUndefined();
  });

  it("is removed with the session's entry", () => {
    const fs = createFakeFarmFs({});
    registerSupervised(fs, paths, session());
    writeSessionState(fs, paths, "subs", "s1", STATE);
    unregisterSupervised(fs, paths, "subs", "s1");
    expect(readSessionState(fs, paths, "subs", "s1")).toBeUndefined();
  });
});

describe("committedContextTokens", () => {
  it("counts what a moved session carried onto a member until it makes a request there", () => {
    const moved = session({ sessionId: "m1", identity: "spare", since: T1, carriedTokens: CONTEXT });
    expect(committedContextTokens([moved], [])).toEqual({ spare: CONTEXT });
    expect(committedContextTokens([moved], [record({ sessionId: "m1", identity: "spare", at: T2 })])).toEqual({});
  });

  it("does not let another session's request, an earlier one or one on another member release the commitment", () => {
    const moved = session({ sessionId: "m1", identity: "spare", since: T1, carriedTokens: CONTEXT });
    expect(committedContextTokens([moved], [record({ sessionId: "other", identity: "spare", at: T2 })])).toEqual({ spare: CONTEXT });
    expect(committedContextTokens([moved], [record({ sessionId: "m1", identity: "spare", at: T0 })])).toEqual({ spare: CONTEXT });
    expect(committedContextTokens([moved], [record({ sessionId: "m1", identity: "work", at: T2 })])).toEqual({ spare: CONTEXT });
  });

  it("sums the sessions moved onto one member, ignores a launch that carried nothing, and keeps members apart", () => {
    const sessions = [
      session({ sessionId: "a", identity: "spare", since: T1, carriedTokens: CONTEXT }),
      session({ sessionId: "b", identity: "spare", since: T1, carriedTokens: CONTEXT }),
      session({ sessionId: "c", identity: "third", since: T1, carriedTokens: 1 }),
      session({ sessionId: "d", identity: "spare", since: T0 }),
    ];
    expect(committedContextTokens(sessions, [])).toEqual({ spare: 2 * CONTEXT, third: 1 });
  });
});

describe("requestAccountMove", () => {
  const deps = (fs: ReturnType<typeof createFakeFarmFs>, idOf: (name: string) => string | undefined) => ({ fs, paths, runningAmong: async (pids: readonly number[]) => await Promise.resolve(new Set(pids)), idOf, now: () => Date.parse(T1) });

  it("leaves the request under the id the acct: member's name resolves to now, which differs from the name", async () => {
    const fs = createFakeFarmFs({});
    registerSupervised(fs, paths, session());
    expect(await requestAccountMove(deps(fs, (name) => (name === "client" ? "work" : undefined)), session().sessionId, "client", "opus")).toBe(true);
    expect(readModelMove(fs, paths, session().sessionId)).toEqual({ sessionId: session().sessionId, to: "work", model: "opus", at: T1 });
  });

  it("leaves nothing for a session nothing supervises, or a name no identity has", async () => {
    const fs = createFakeFarmFs({});
    expect(await requestAccountMove(deps(fs, () => "work"), "unsupervised", "client", "opus")).toBe(false);
    registerSupervised(fs, paths, session());
    expect(await requestAccountMove(deps(fs, () => undefined), session().sessionId, "ghost", "opus")).toBe(false);
    expect(readModelMove(fs, paths, session().sessionId)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import type { ResolvePoolParams } from "../launcher/pool";
import { createFakeFarmFs, FAKE_NOW_MS, fakeFs, fakeLog, paths } from "../test-helpers";
import { projectDirNameOf } from "../usage/resumeContext";
import { createMover, type MoverDeps } from "./move";
import { liveSupervised, registerSupervised, superviseDirOf, type SupervisedSession } from "./registry";

const CWD = "/work/repo";
const POOL = "subs";
const SESSION = "44444444-4444-4444-8444-444444444444";
const PID = 4000;
const SIBLING_PID = 4100;
const DEAD_PID = 4999;
const CONTEXT = 300_000;
const SIBLING_AGE_MS = 60_000;
const transcriptOf = (identity: string): string => `${paths.identitiesDir}/${identity}/projects/${projectDirNameOf(CWD)}/${SESSION}.jsonl`;
const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

/** A coordinator over a fake store whose transcript is visible to `visibleTo`, with `pick` standing in for the pool ranking and every pid in `running` alive. */
function setup(options: Readonly<{ visibleTo?: readonly string[]; pick: (params: ResolvePoolParams) => ReturnType<MoverDeps["pickMember"]>; running?: readonly number[]; seed?: Readonly<Record<string, string>> }>) {
  const farmFs = createFakeFarmFs({ ...Object.fromEntries((options.visibleTo ?? ["spare"]).map((identity) => [transcriptOf(identity), "{}\n"])), ...options.seed });
  const calls: ResolvePoolParams[] = [];
  const mover = createMover({
    paths,
    fs: fakeFs({}),
    farmFs,
    pool: POOL,
    pools: { [POOL]: { identities: ["work", "spare"] } },
    cwd: CWD,
    pid: PID,
    now: () => FAKE_NOW_MS,
    isRunning: (pid) => (options.running ?? [PID, SIBLING_PID]).includes(pid),
    sleep: () => undefined,
    pickMember: (params) => {
      calls.push(params);
      return options.pick(params);
    },
    log: fakeLog(),
  });
  return { farmFs, calls, mover };
}

const picks = (identity: string) => (): ReturnType<MoverDeps["pickMember"]> => ({ ok: true, identity, explanation: `pool ${POOL}: ${identity} is next`, reasons: [], candidates: [] });
const request = { sessionId: SESSION, from: "work", contextTokens: CONTEXT };
const lockFile = `${superviseDirOf(paths, POOL)}/.move.lock`;

function sibling(overrides: Readonly<Partial<SupervisedSession>>): SupervisedSession {
  return { pid: SIBLING_PID, sessionId: "other", pool: POOL, identity: "spare", cwd: CWD, since: iso(-SIBLING_AGE_MS), ...overrides };
}

describe("the move coordinator", () => {
  it("moves the session to the member the ranking chose, records the pick and registers the session on it with the context it carries", () => {
    const { farmFs, mover } = setup({ pick: picks("spare") });
    expect(mover(request)).toEqual({ kind: "move", to: "spare", explanation: `pool ${POOL}: spare is next` });
    expect(liveSupervised(farmFs, paths, POOL, () => true)).toEqual([{ pid: PID, sessionId: SESSION, pool: POOL, identity: "spare", cwd: CWD, since: iso(0), carriedTokens: CONTEXT }]);
    const sticky = JSON.parse(farmFs.readFileUtf8(paths.usagePicksFile) ?? "{}") as { picks: Record<string, { identity: string }> };
    expect(sticky.picks[CWD]?.identity).toBe("spare");
  });

  it("ranks the pool for the conversation being resumed, with the context it carries", () => {
    const { calls, mover } = setup({ pick: picks("spare") });
    mover(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ poolName: POOL, passthrough: ["--resume", SESSION], resumeContextTokens: CONTEXT, wait: false, recordPick: false, cwd: CWD });
  });

  it("counts what sessions already moved onto a member carry, but not the session's own earlier entry nor a dead launcher's", () => {
    const { farmFs, calls, mover } = setup({ pick: picks("spare") });
    registerSupervised(farmFs, paths, sibling({ sessionId: "a", carriedTokens: CONTEXT }));
    registerSupervised(farmFs, paths, sibling({ sessionId: "b", carriedTokens: CONTEXT }));
    registerSupervised(farmFs, paths, sibling({ sessionId: "gone", pid: DEAD_PID, carriedTokens: CONTEXT }));
    registerSupervised(farmFs, paths, sibling({ sessionId: SESSION, pid: PID, identity: "work", carriedTokens: CONTEXT }));
    mover(request);
    expect(calls[0]?.committedContextTokens).toEqual({ spare: 2 * CONTEXT });
  });

  it("passes no commitments when no session is moving anywhere", () => {
    const { calls, mover } = setup({ pick: picks("spare") });
    mover(request);
    expect(calls[0]).not.toHaveProperty("committedContextTokens");
  });

  it("stays when the pool cannot pick a member, naming why, and changes nothing", () => {
    const { farmFs, mover } = setup({ pick: () => ({ ok: false, message: "agent-shim: no member of pool \"subs\" can be picked." }) });
    expect(mover(request)).toEqual({ kind: "stay", reason: "agent-shim: no member of pool \"subs\" can be picked." });
    expect(liveSupervised(farmFs, paths, POOL, () => true)).toEqual([]);
    expect(farmFs.readFileUtf8(paths.usagePicksFile)).toBeUndefined();
  });

  it("stays when the only member that can take the session is the one it is leaving", () => {
    const { mover } = setup({ pick: picks("work") });
    expect(mover(request)).toEqual({ kind: "stay", reason: `no other member of pool "${POOL}" can take it` });
  });

  it("stays when the next member does not share the conversation's history, and records nothing", () => {
    const { farmFs, mover } = setup({ visibleTo: [], pick: picks("spare") });
    const outcome = mover(request);
    expect(outcome).toEqual({ kind: "stay", reason: "spare does not share this conversation's history, so it could not resume it" });
    expect(liveSupervised(farmFs, paths, POOL, () => true)).toEqual([]);
    expect(farmFs.readFileUtf8(paths.usagePicksFile)).toBeUndefined();
  });

  it("stays when another launcher holds the move lock for good, and does not touch its lock", () => {
    const lock = JSON.stringify({ identity: "move", pid: SIBLING_PID, token: "held", acquiredAtMs: FAKE_NOW_MS });
    const { farmFs, mover } = setup({ pick: picks("spare"), seed: { [lockFile]: `${lock}\n` } });
    const outcome = mover(request);
    expect(outcome.kind).toBe("stay");
    expect(farmFs.readFileUtf8(lockFile)).toContain("held");
  });

  it("releases the lock after a move and after a stay", () => {
    const moved = setup({ pick: picks("spare") });
    moved.mover(request);
    expect(moved.farmFs.readFileUtf8(lockFile)).toBeUndefined();
    const stayed = setup({ pick: picks("work") });
    stayed.mover(request);
    expect(stayed.farmFs.readFileUtf8(lockFile)).toBeUndefined();
  });
});

import { describe, expect, it, vi, type MockedFunction } from "vitest";

import type { LaunchPlan } from "../launcher";
import type { SupervisedLaunch } from "../launcher/claudeSession";
import type { ChildProcess, SpawnResult } from "../launcher/ports";
import { fakeLog } from "../test-helpers";
import type { QuotaHit } from "./limit";
import type { MoveOutcome } from "./move";
import type { SupervisedSession } from "./registry";
import { supervise, type SupervisorDeps } from "./supervise";

const SESSION = "55555555-5555-4555-8555-555555555555";
const FIRST: SupervisedLaunch = { sessionId: SESSION, conversation: "start" };
const HIT: QuotaHit = { reason: "it is refused right now", resetAt: "2026-10-16T20:00:00.000Z" };
const MOVE: MoveOutcome = { kind: "move", to: "spare", explanation: "pool subs: spare is next" };
const SIGNAL_EXIT_OFFSET = 128;
const SIGTERM_NUMBER = 15;
const CONTEXT_TOKENS = 123_000;
const CHILD_STATUS = 3;
const START_MS = Date.parse("2026-10-16T10:00:00.000Z");

/** Lets everything queued on the promise queue and the immediate queue run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** A child whose exit the test settles, and which exits at once on a signal it is told to obey. */
class FakeChild implements ChildProcess {
  readonly signals: NodeJS.Signals[] = [];
  readonly exit: Promise<SpawnResult>;
  private finish: (result: SpawnResult) => void = () => undefined;
  constructor(private readonly obeys: readonly NodeJS.Signals[]) {
    this.exit = new Promise((resolve) => {
      this.finish = resolve;
    });
  }
  signal = (signal: NodeJS.Signals): void => {
    this.signals.push(signal);
    if (this.obeys.includes(signal)) {
      this.finish({ status: null, signal });
    }
  };
  exitWith(status: number): void {
    this.finish({ status, signal: null });
  }
  failToSpawn(error: Error): void {
    this.finish({ status: null, signal: null, error });
  }
}

interface World {
  readonly deps: SupervisorDeps;
  readonly children: FakeChild[];
  readonly launches: SupervisedLaunch[];
  readonly released: string[];
  readonly registered: SupervisedSession[];
  readonly unregistered: string[];
  readonly log: ReturnType<typeof fakeLog>;
  readonly resetTerminal: ReturnType<typeof vi.fn>;
  readonly decideMove: MockedFunction<SupervisorDeps["decideMove"]>;
  readonly timers: { fire: () => void; cancelled: number };
  readonly handlers: Map<NodeJS.Signals, () => void>;
  readonly watchers: Map<string, () => void>;
  quotaHit: (identity: string) => QuotaHit | undefined;
  obeys: readonly NodeJS.Signals[];
}

/** A supervisor over fakes. The first child runs as `work`; a relaunch runs as the member it is given. */
function world(): World {
  const children: FakeChild[] = [];
  const launches: SupervisedLaunch[] = [];
  const released: string[] = [];
  const registered: SupervisedSession[] = [];
  const unregistered: string[] = [];
  const log = fakeLog();
  const resetTerminal = vi.fn();
  const decideMove = vi.fn<SupervisorDeps["decideMove"]>().mockResolvedValue(MOVE);
  const timers = { fire: (): void => undefined, cancelled: 0 };
  const handlers = new Map<NodeJS.Signals, () => void>();
  const watchers = new Map<string, () => void>();
  const state: { quotaHit: (identity: string) => QuotaHit | undefined; obeys: readonly NodeJS.Signals[] } = { quotaHit: () => undefined, obeys: ["SIGTERM"] };
  const deps: SupervisorDeps = {
    pool: "subs",
    cwd: "/repo",
    pid: 4000,
    prepare: (launch) => {
      launches.push(launch);
      const identity = launch.member ?? "work";
      const plan: LaunchPlan = {
        bin: "/real/claude",
        args: ["--model", "opus"],
        env: {},
        sessionId: launch.sessionId,
        release: () => {
          released.push(identity);
        },
        decision: { identity, identitySource: "argv", configDirEscapeHatch: false, configProfileSource: "none" },
        markChildStarted: () => undefined,
      };
      return plan;
    },
    spawn: {
      spawn: () => {
        const child = new FakeChild(state.obeys);
        children.push(child);
        return child;
      },
    },
    signals: {
      on: (signal, handler) => {
        handlers.set(signal, handler);
        return () => {
          handlers.delete(signal);
        };
      },
    },
    timer: {
      after: () => {
        let fire: () => void = () => undefined;
        const elapsed = new Promise<void>((resolve) => {
          fire = resolve;
        });
        timers.fire = fire;
        return {
          elapsed,
          cancel: () => {
            timers.cancelled += 1;
          },
        };
      },
    },
    watchUsage: (identity, onChange) => {
      watchers.set(identity, onChange);
      return () => {
        watchers.delete(identity);
      };
    },
    quotaHit: (identity) => state.quotaHit(identity),
    decideMove,
    contextTokens: () => CONTEXT_TOKENS,
    register: (session) => {
      registered.push(session);
    },
    unregister: (sessionId) => {
      unregistered.push(sessionId);
    },
    resetTerminal: () => {
      resetTerminal();
    },
    now: () => START_MS,
    log,
  };
  return {
    deps,
    children,
    launches,
    released,
    registered,
    unregistered,
    log,
    resetTerminal,
    decideMove,
    timers,
    handlers,
    watchers,
    get quotaHit() {
      return state.quotaHit;
    },
    set quotaHit(value) {
      state.quotaHit = value;
    },
    get obeys() {
      return state.obeys;
    },
    set obeys(value) {
      state.obeys = value;
    },
  };
}

describe("supervise", () => {
  it("returns the child's own exit code when it exits by itself, releasing its plan and removing its registry entry", async () => {
    const w = world();
    const done = supervise(w.deps, FIRST);
    await settle();
    w.children[0]?.exitWith(CHILD_STATUS);
    await expect(done).resolves.toBe(CHILD_STATUS);
    expect(w.launches).toEqual([FIRST]);
    expect(w.released).toEqual(["work"]);
    expect(w.registered).toEqual([{ pid: 4000, sessionId: SESSION, pool: "subs", identity: "work", cwd: "/repo", since: "2026-10-16T10:00:00.000Z" }]);
    expect(w.unregistered).toEqual([SESSION]);
    expect(w.decideMove).not.toHaveBeenCalled();
    expect(w.watchers.size).toBe(0);
    expect(w.handlers.size).toBe(0);
  });

  it("stops the child and relaunches the session under the new member when its own request met a quota refusal", async () => {
    const w = world();
    const done = supervise(w.deps, FIRST);
    await settle();
    w.quotaHit = () => HIT;
    w.watchers.get("work")?.();
    await settle();
    expect(w.decideMove).toHaveBeenCalledWith({ sessionId: SESSION, from: "work", contextTokens: CONTEXT_TOKENS });
    expect(w.children[0]?.signals).toEqual(["SIGTERM"]);
    // The child stopped on SIGTERM and gave the terminal back itself.
    expect(w.resetTerminal).not.toHaveBeenCalled();
    expect(w.released).toEqual(["work"]);
    expect(w.launches[1]).toEqual({ sessionId: SESSION, conversation: "resume", member: "spare" });
    expect(w.log.infos.join("\n")).toContain(`agent-shim: work is out of quota; resuming session ${SESSION} under spare (pool subs: spare is next)`);
    expect(w.children).toHaveLength(2);
    // The relaunch was registered by the move that chose it, so the supervisor adds no second entry.
    expect(w.registered).toHaveLength(1);
    w.children[1]?.exitWith(0);
    await expect(done).resolves.toBe(0);
    expect(w.released).toEqual(["work", "spare"]);
    expect(w.unregistered).toEqual([SESSION]);
  });

  it("does not move a session whose own request has met no refusal, however often the snapshot changes", async () => {
    const w = world();
    const done = supervise(w.deps, FIRST);
    await settle();
    w.watchers.get("work")?.();
    w.watchers.get("work")?.();
    await settle();
    expect(w.decideMove).not.toHaveBeenCalled();
    expect(w.children[0]?.signals).toEqual([]);
    w.children[0]?.exitWith(0);
    await done;
  });

  it("asks the coordinator once when the snapshot changes again while the move is under way", async () => {
    const w = world();
    const done = supervise(w.deps, FIRST);
    await settle();
    w.quotaHit = () => HIT;
    w.watchers.get("work")?.();
    w.watchers.get("work")?.();
    await settle();
    expect(w.decideMove).toHaveBeenCalledTimes(1);
    w.children[1]?.exitWith(0);
    await done;
  });

  it("leaves the child running and says why once when the session stays, until the identity has been served again", async () => {
    const w = world();
    w.decideMove.mockResolvedValue({ kind: "stay", reason: "no other member of pool \"subs\" can take it" });
    const done = supervise(w.deps, FIRST);
    await settle();
    w.quotaHit = () => HIT;
    w.watchers.get("work")?.();
    w.watchers.get("work")?.();
    await settle();
    expect(w.decideMove).toHaveBeenCalledTimes(1);
    expect(w.log.warns).toEqual([`agent-shim: work is out of quota until ${HIT.resetAt ?? ""}, and this session stays on it: no other member of pool "subs" can take it`]);
    expect(w.children[0]?.signals).toEqual([]);
    // Served again, then refused again: the question is asked afresh.
    w.quotaHit = () => undefined;
    w.watchers.get("work")?.();
    w.quotaHit = () => HIT;
    w.watchers.get("work")?.();
    await settle();
    expect(w.decideMove).toHaveBeenCalledTimes(2);
    w.children[0]?.exitWith(0);
    await done;
  });

  it("looks again when the snapshot changed while it was still deciding", async () => {
    const w = world();
    let settleDecision: (outcome: MoveOutcome) => void = () => undefined;
    w.decideMove.mockImplementationOnce(
      async () =>
        await new Promise<MoveOutcome>((resolve) => {
          settleDecision = resolve;
        }),
    );
    const done = supervise(w.deps, FIRST);
    await settle();
    w.quotaHit = () => HIT;
    w.watchers.get("work")?.();
    await settle();
    // Served again while the coordinator was still deciding: the change is not lost.
    w.quotaHit = () => undefined;
    w.watchers.get("work")?.();
    settleDecision({ kind: "stay", reason: "no other member can take it" });
    await settle();
    // Refused again: had the check not looked again, the earlier decline would still stand and the coordinator would not be asked.
    w.quotaHit = () => HIT;
    w.watchers.get("work")?.();
    await settle();
    expect(w.decideMove).toHaveBeenCalledTimes(2);
    for (const child of w.children) {
      child.exitWith(0);
    }
    await done;
  });

  it("kills a child that has not stopped within the grace period", async () => {
    const w = world();
    w.obeys = ["SIGKILL"];
    const done = supervise(w.deps, FIRST);
    await settle();
    w.quotaHit = () => HIT;
    w.watchers.get("work")?.();
    await settle();
    expect(w.children[0]?.signals).toEqual(["SIGTERM"]);
    w.timers.fire();
    await settle();
    expect(w.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(w.resetTerminal).toHaveBeenCalledTimes(1);
    expect(w.launches).toHaveLength(2);
    w.children[1]?.exitWith(0);
    await done;
  });

  it("cancels the grace timer when the child stops in time", async () => {
    const w = world();
    const done = supervise(w.deps, FIRST);
    await settle();
    w.quotaHit = () => HIT;
    w.watchers.get("work")?.();
    await settle();
    expect(w.timers.cancelled).toBe(1);
    w.children[1]?.exitWith(0);
    await done;
  });

  it("passes SIGHUP and SIGTERM to the child and ends with its exit rather than relaunching", async () => {
    const w = world();
    const done = supervise(w.deps, FIRST);
    await settle();
    w.handlers.get("SIGTERM")?.();
    expect(w.children[0]?.signals).toEqual(["SIGTERM"]);
    await expect(done).resolves.toBe(SIGNAL_EXIT_OFFSET + SIGTERM_NUMBER);
    expect(w.launches).toHaveLength(1);
  });

  it("does not relaunch a session whose launcher was told to stop while it was being moved", async () => {
    const w = world();
    w.obeys = [];
    const done = supervise(w.deps, FIRST);
    await settle();
    w.quotaHit = () => HIT;
    w.watchers.get("work")?.();
    await settle();
    w.handlers.get("SIGHUP")?.();
    w.children[0]?.exitWith(1);
    await expect(done).resolves.toBe(1);
    expect(w.launches).toHaveLength(1);
    expect(w.resetTerminal).not.toHaveBeenCalled();
  });

  it("ignores SIGINT in the launcher, since the terminal delivers it to the child's own process group", async () => {
    const w = world();
    const done = supervise(w.deps, FIRST);
    await settle();
    w.handlers.get("SIGINT")?.();
    expect(w.children[0]?.signals).toEqual([]);
    w.children[0]?.exitWith(0);
    await done;
  });

  it("warns and carries on when checking for a refusal fails", async () => {
    const w = world();
    w.quotaHit = () => {
      throw new Error("snapshot is not valid JSON");
    };
    const done = supervise(w.deps, FIRST);
    await settle();
    w.watchers.get("work")?.();
    await settle();
    expect(w.log.warns).toEqual(["agent-shim: could not check whether work is out of quota: snapshot is not valid JSON"]);
    expect(w.children[0]?.signals).toEqual([]);
    w.children[0]?.exitWith(0);
    await done;
  });

  it("throws a spawn failure after releasing the plan and removing the registry entry", async () => {
    const w = world();
    const done = supervise(w.deps, FIRST);
    await settle();
    w.children[0]?.failToSpawn(new Error("spawn ENOENT"));
    await expect(done).rejects.toThrow("spawn ENOENT");
    expect(w.released).toEqual(["work"]);
    expect(w.unregistered).toEqual([SESSION]);
  });

  it("refuses to supervise a launch that resolved no identity", async () => {
    const w = world();
    const deps: SupervisorDeps = { ...w.deps, prepare: (launch) => ({ ...w.deps.prepare(launch), decision: { identitySource: "none", configDirEscapeHatch: false, configProfileSource: "none" } }) };
    await expect(supervise(deps, FIRST)).rejects.toThrow("resolved no identity");
    expect(w.children).toHaveLength(0);
  });
});

import type { LaunchPlan } from "../launcher";
import type { SupervisedLaunch } from "../launcher/claudeSession";
import type { LogPort, SpawnResult, SupervisedSpawnPort } from "../launcher/ports";
import { childExitCode } from "../launcher/spawn";
import type { QuotaHit } from "./limit";
import type { MoveOutcome, MoveRequest } from "./move";
import type { SupervisedSession } from "./registry";

/** How long a stopped child may take to write its transcript and give the terminal back before it is killed. A deadline rather than a measurement: a child still running after it is stuck. */
const STOP_GRACE_MS = 5_000;

/** Delivers the process signals the supervisor reacts to. `on` returns the function that removes the handler. */
export interface SignalPort {
  readonly on: (signal: NodeJS.Signals, handler: () => void) => () => void;
}

/** A timer that can be cancelled, so a deadline that was not needed does not keep the process alive. */
export interface TimerPort {
  readonly after: (ms: number) => { readonly elapsed: Promise<void>; readonly cancel: () => void };
}

/** Everything the supervisor does that touches the outside world, injected so it runs against fakes. */
export interface SupervisorDeps {
  readonly pool: string;
  readonly cwd: string;
  /** The supervising launcher's process id, which marks its registry entry as live. */
  readonly pid: number;
  /** Builds the launch plan for one launch: `prepareLaunch` with the supervised parameter set. */
  readonly prepare: (launch: SupervisedLaunch) => LaunchPlan;
  readonly spawn: SupervisedSpawnPort;
  readonly signals: SignalPort;
  readonly timer: TimerPort;
  /** Calls `onChange` whenever the identity's usage snapshot changes, which is the cue to look for a quota refusal. Returns the function that stops watching. */
  readonly watchUsage: (identity: string, onChange: () => void) => () => void;
  /** This session's quota refusal on `identity` since `sinceMs`, if it has met one. */
  readonly quotaHit: (identity: string, sessionId: string, sinceMs: number) => QuotaHit | undefined;
  /** Decides where a session leaving an identity goes, and registers it there. Asynchronous because it first brings the pool's stale usage figures up to date, which asks each stale member. */
  readonly decideMove: (request: MoveRequest) => Promise<MoveOutcome>;
  /** The size in tokens of the conversation's context, when its transcript can be read. */
  readonly contextTokens: (sessionId: string) => number | undefined;
  readonly register: (session: Readonly<SupervisedSession>) => void;
  readonly unregister: (sessionId: string) => void;
  /** Puts the terminal back as a shell expects it, after a child had to be killed and so could not do it itself. */
  readonly resetTerminal: () => void;
  readonly now: () => number;
  readonly log: LogPort;
}

/** What one child's run came to. */
type RunOutcome = { readonly kind: "exited"; readonly result: SpawnResult } | { readonly kind: "moved"; readonly next: SupervisedLaunch };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one child of a supervised session until it exits by itself or its identity runs out of quota and the session is moved.
 *
 * While the child runs, every change to its identity's usage snapshot is a cue to ask whether this session met a quota refusal. When it did, the move coordinator decides where the session goes; if it goes somewhere, the child is stopped (SIGTERM, then SIGKILL after the grace period, after which the terminal is reset) and the caller relaunches it under the new member. When the coordinator keeps the session where it is, one line says why and the child carries on, and the question is not asked again until the identity has been served once more.
 *
 * SIGHUP and SIGTERM to the launcher are passed to the child and end the run with its exit; SIGINT is ignored in the launcher, since the terminal already delivers it to the child's own process group.
 */
async function runChild(deps: Readonly<SupervisorDeps>, plan: LaunchPlan, identity: string): Promise<RunOutcome> {
  const startedMs = deps.now();
  const child = deps.spawn.spawn(plan.bin, plan.args, { stdio: "inherit", env: plan.env });
  plan.markChildStarted();

  // One object rather than separate variables: the handlers and callbacks below set these, and a variable assigned only in a closure is narrowed to its initial value where it is read.
  const state = { terminating: false, moving: false, checking: false, wakes: 0, declined: false };
  const stopHandlers = [
    ...(["SIGHUP", "SIGTERM"] as const).map((signal) =>
      deps.signals.on(signal, () => {
        state.terminating = true;
        child.signal(signal);
      }),
    ),
    deps.signals.on("SIGINT", () => undefined),
  ];

  let requestMove: (outcome: Extract<MoveOutcome, { kind: "move" }>) => void = () => undefined;
  const moveRequested = new Promise<Extract<MoveOutcome, { kind: "move" }>>((resolve) => {
    requestMove = resolve;
  });
  // `moving` is set once a move has been decided: the session is leaving, so a later change to the snapshot must not ask the coordinator again and register it a second time.
  // Every change to the snapshot counts as a wake. One check runs at a time, and a wake that arrives while it runs makes it look again once it has finished.
  const check = async (): Promise<void> => {
    state.wakes += 1;
    if (state.moving || state.checking) {
      return;
    }
    state.checking = true;
    try {
      let handled: number;
      do {
        handled = state.wakes;
        if (state.moving) {
          break;
        }
        const hit = deps.quotaHit(identity, plan.sessionId, startedMs);
        if (hit === undefined) {
          state.declined = false;
          continue;
        }
        if (state.declined) {
          continue;
        }
        const outcome = await deps.decideMove({ sessionId: plan.sessionId, from: identity, contextTokens: deps.contextTokens(plan.sessionId) });
        if (outcome.kind === "move") {
          state.moving = true;
          requestMove(outcome);
        } else {
          state.declined = true;
          deps.log.warn(`agent-shim: ${identity} is out of quota${hit.resetAt === undefined ? "" : ` until ${hit.resetAt}`}, and this session stays on it: ${outcome.reason}`);
        }
      } while (handled !== state.wakes);
    } catch (error) {
      deps.log.warn(`agent-shim: could not check whether ${identity} is out of quota: ${messageOf(error)}`);
    } finally {
      state.checking = false;
    }
  };
  const stopWatching = deps.watchUsage(identity, () => {
    void check();
  });

  try {
    const first = await Promise.race([child.exit.then((result) => ({ kind: "exited" as const, result })), moveRequested.then((move) => ({ kind: "move" as const, move }))]);
    stopWatching();
    if (first.kind === "exited") {
      return first;
    }
    deps.log.info(`agent-shim: ${identity} is out of quota; resuming session ${plan.sessionId} under ${first.move.to} (${first.move.explanation})`);
    child.signal("SIGTERM");
    const grace = deps.timer.after(STOP_GRACE_MS);
    const stopped = await Promise.race([child.exit.then((result) => ({ result })), grace.elapsed.then(() => undefined)]);
    grace.cancel();
    let result = stopped?.result;
    if (result === undefined) {
      child.signal("SIGKILL");
      result = await child.exit;
      // A child that stops on SIGTERM gives the terminal back itself; one that was killed could not.
      deps.resetTerminal();
    }
    if (state.terminating) {
      return { kind: "exited", result };
    }
    return { kind: "moved", next: { sessionId: plan.sessionId, conversation: "resume", member: first.move.to } };
  } finally {
    stopWatching();
    for (const stop of stopHandlers) {
      stop();
    }
  }
}

/**
 * Runs a supervised pool launch to its end and returns the exit code the launcher should exit with: the child's own when it exits by itself. A session whose identity runs out of quota is moved to another member of its pool and resumed there, on the same terminal, until a child exits by itself.
 *
 * Each child is a fresh launch (`prepare`) under the same session id, so the front door attributes it to one session and `claude --resume` finds the conversation. A launch's plan is released as soon as its child has ended, and the session's registry entry is removed when the supervisor does.
 */
export async function supervise(deps: Readonly<SupervisorDeps>, first: SupervisedLaunch): Promise<number> {
  let launch = first;
  try {
    for (let moved = false; ; moved = true) {
      const plan = deps.prepare(launch);
      const { identity } = plan.decision;
      if (identity === undefined) {
        plan.release();
        throw new Error("a supervised launch resolved no identity to supervise");
      }
      // A relaunch was registered by the move that chose its member, inside the move lock; only the first launch registers itself.
      if (!moved) {
        deps.register({ pid: deps.pid, sessionId: plan.sessionId, pool: deps.pool, identity, cwd: deps.cwd, since: new Date(deps.now()).toISOString() });
      }
      let outcome: RunOutcome;
      try {
        outcome = await runChild(deps, plan, identity);
      } finally {
        plan.release();
      }
      if (outcome.kind === "exited") {
        if (outcome.result.error !== undefined) {
          throw outcome.result.error;
        }
        return childExitCode(outcome.result);
      }
      launch = outcome.next;
    }
  } finally {
    // Every launch of the session carries the first one's id, so this is the entry the whole run registered under.
    deps.unregister(first.sessionId);
  }
}

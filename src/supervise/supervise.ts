import type { LaunchPlan } from "../launcher";
import type { SupervisedLaunch } from "../launcher/claudeSession";
import { LAUNCH_CANCELLED_EXIT } from "../launcher/hold";
import type { LogPort, SpawnResult, SupervisedSpawnPort } from "../launcher/ports";
import { childExitCode } from "../launcher/spawn";
import type { CompactionDecision } from "./compaction";
import type { QuotaHit } from "./limit";
import type { LifecycleEvent } from "./lifecycle";
import type { MoveOutcome, MoveRequest } from "./move";
import type { CompactionResult, CompactRequest } from "./realCompact";
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

/** The right to compact on one identity: one session compacts on an identity at a time, because a compaction spends the quota the others are waiting on. */
interface CompactionSlot {
  readonly release: () => void;
}

/** What compacting a session before its quota is spent needs, for a pool that has `compactBeforeLimit` on. */
export interface CompactionDeps {
  /** Whether this session should compact now: idle, the largest that could, and the identity's quota at the trigger. */
  readonly shouldCompact: (identity: string, sessionId: string) => CompactionDecision;
  /** Takes the identity's compaction slot, or returns undefined when another session holds it. */
  readonly acquire: (identity: string) => CompactionSlot | undefined;
  /** Compacts the conversation as the identity. Rejects when the compaction failed; resolves `unchanged` when there was nothing to compact. */
  readonly compact: (request: CompactRequest, signal: AbortSignal) => Promise<CompactionResult>;
  /** Requests compaction inside the running child, if its plugin has loaded. */
  readonly live?: { readonly ready: () => boolean; readonly compact: (conversationId: string, signal: AbortSignal) => Promise<CompactionResult> };
  /** Records on the session that it was compacted on its current member, or clears that when it moves. */
  readonly markCompacted: (sessionId: string, compacted: boolean, conversationId?: string) => boolean;
}

/** Everything the supervisor does that touches the outside world, injected so it runs against fakes. Every identity the supervisor passes to or takes from them is an id (the directory the identity is stored in, which a rename of its name keeps): what it watches, checks, registers, compacts on and moves between, and the `to` of a move. Only a launch it prepares names the member by name, read through `nameOf` as it is prepared. */
export interface SupervisorDeps {
  readonly pool: string;
  readonly cwd: string;
  /** Records only sanitised lifecycle metadata, independently of terminal output. */
  readonly lifecycle?: (event: LifecycleEvent) => void;
  /** The supervising launcher's process id, which marks its registry entry as live. */
  readonly pid: number;
  /** Builds the launch plan for one launch: `prepareLaunch` with the supervised parameter set. */
  readonly prepare: (launch: SupervisedLaunch) => LaunchPlan;
  readonly spawn: SupervisedSpawnPort;
  readonly signals: SignalPort;
  readonly timer: TimerPort;
  /** Calls `onChange` whenever something a check reads changes: the identity's usage snapshot, which is the cue to look for a quota refusal, and the session's own recorded state, which is the cue that a turn has ended. Returns the function that stops watching. */
  readonly watchChanges: (identity: string, onChange: () => void) => () => void;
  /** This session's quota refusal on `identity` since `sinceMs`, if it has met one. */
  readonly quotaHit: (identity: string, sessionId: string, sinceMs: number) => QuotaHit | undefined;
  /** Decides where a session leaving an identity goes, and registers it there. Asynchronous because it first brings the pool's stale usage figures up to date, which asks each stale member. */
  readonly decideMove: (request: MoveRequest) => Promise<MoveOutcome>;
  /** The model move the front door left for this session, when one is pending: claimed (removed from the directory) by this read. An `acct:` model member is served by relaunch, and this is how the door asks for one. */
  readonly claimModelMove: (sessionId: string) => { readonly to: string; readonly model: string } | undefined;
  /** Moves the session onto the identity a model pick named, and registers it there: no re-rank, the `acct:` member is the decision. */
  readonly decideRemodel: (request: { readonly sessionId: string; readonly conversationId?: string; readonly from: string; readonly to: string; readonly contextTokens: number | undefined }) => MoveOutcome;
  /** Calls `onChange` whenever the model-move directory changes, the cue to look for a request the door left. Absent when this supervisor cannot watch it. */
  readonly watchModelMoves?: (onChange: () => void) => () => void;
  /** The size in tokens of the conversation's context, when its transcript can be read. */
  readonly contextTokens: (sessionId: string) => number | undefined;
  /** The current Claude conversation under the stable launch id. */
  readonly currentConversationId: (sessionId: string) => string | undefined;
  /** Present for a pool that compacts before its quota is spent. */
  readonly compaction?: CompactionDeps;
  readonly register: (session: Readonly<SupervisedSession>) => void;
  readonly unregister: (sessionId: string) => void;
  /** Puts the terminal back as a shell expects it, after a child had to be killed and so could not do it itself. */
  readonly resetTerminal: () => void;
  readonly now: () => number;
  readonly log: LogPort;
  /** The name of the identity stored under an id, read fresh, or undefined when none is stored there any more. The supervisor keys everything by id, which a rename keeps, and asks for the name only to relaunch as the member and to say which it is. */
  readonly nameOf: (id: string) => string | undefined;
}

/** Raised when the identity a supervised session runs as is no longer stored under its id, so there is no member to relaunch the session as. */
class SupervisedIdentityGoneError extends Error {
  constructor(id: string) {
    super(`the identity stored under identities/${id} no longer exists, so the session cannot be relaunched on it`);
    this.name = "SupervisedIdentityGoneError";
  }
}

/** The name to relaunch as the identity stored under `id`, read now so a rename since the last launch is followed. Throws `SupervisedIdentityGoneError` when none is stored there. */
function memberName(deps: Readonly<SupervisorDeps>, id: string): string {
  const name = deps.nameOf(id);
  if (name === undefined) {
    throw new SupervisedIdentityGoneError(id);
  }
  return name;
}

/** How a line names the identity stored under `id`: its name now, or the id when none is stored there. */
function labelOf(deps: Readonly<SupervisorDeps>, id: string): string {
  return deps.nameOf(id) ?? id;
}

/** Why a child was stopped before it exited by itself. */
type Departure =
  | { readonly kind: "move"; readonly to: string; readonly explanation: string; readonly conversationId: string }
  | { readonly kind: "remodel"; readonly to: string; readonly model: string; readonly conversationId: string };

/** What one child's run came to: it exited by itself, or it was stopped for a departure. */
type RunOutcome = { readonly kind: "exited"; readonly result: SpawnResult } | Departure;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stops a child that is waiting at a prompt: SIGTERM, then SIGKILL after the grace period. A child that stops on SIGTERM gives the terminal back itself; one that was killed could not, so the terminal is reset.
 */
async function stopChild(deps: Readonly<SupervisorDeps>, child: ReturnType<SupervisedSpawnPort["spawn"]>): Promise<SpawnResult> {
  deps.lifecycle?.({ kind: "child_signal", childPid: child.pid ?? null, signal: "SIGTERM" });
  child.signal("SIGTERM");
  const grace = deps.timer.after(STOP_GRACE_MS);
  const stopped = await Promise.race([child.exit.then((result) => ({ result })), grace.elapsed.then(() => undefined)]);
  grace.cancel();
  if (stopped !== undefined) {
    return stopped.result;
  }
  deps.lifecycle?.({ kind: "child_signal", childPid: child.pid ?? null, signal: "SIGKILL" });
  child.signal("SIGKILL");
  const result = await child.exit;
  deps.resetTerminal();
  return result;
}

/**
 * Runs one child of a supervised session until it exits by itself or its identity runs out of quota and the session is moved.
 *
 * While the child runs, every change to its identity's usage snapshot, and to the session's own state, is a cue. If this session met a quota refusal, the move coordinator decides where it goes. If it did not, the compaction decision can ask the child to compact in process while holding the identity's compaction slot. A move waits for that request to finish. A child stopped for a move gets SIGTERM, then SIGKILL after the grace period. When the coordinator keeps a session where it is, one line says why and the child carries on; the question is not asked again until the identity has been served once more.
 *
 * SIGHUP and SIGTERM to the launcher are passed to the child and end the run with its exit; SIGINT is ignored in the launcher, since the terminal already delivers it to the child's own process group.
 */
async function runChild(deps: Readonly<SupervisorDeps>, plan: LaunchPlan, identity: string, compactedConversation: string | undefined, onCompacted: (conversationId: string) => void): Promise<RunOutcome> {
  const startedMs = deps.now();
  const child = deps.spawn.spawn(plan.bin, plan.args, { stdio: "inherit", env: plan.env });
  plan.markChildStarted();
  deps.lifecycle?.({ kind: "child_started", childPid: child.pid ?? null });
  const observedExit = child.exit.then((result) => {
    deps.lifecycle?.({ kind: "child_exited", childPid: child.pid ?? null, status: result.status, signal: result.signal, spawnFailed: result.error !== undefined });
    return result;
  });

  // One object rather than separate variables: the handlers and callbacks below set these, and a variable assigned only in a closure is narrowed to its initial value where it is read. `leaving` is set once a departure has been decided: a later change to the snapshot must not decide it again.
  const state = { terminating: false, leaving: false, checking: false, compacting: false, wakes: 0, declined: false, lastWarning: "" };
  const liveAbort = new AbortController();
  let attemptedWake = -1;
  let liveTask: Promise<void> | undefined;
  let compacted = compactedConversation;
  let recheck: () => void = () => undefined;
  const stopHandlers = [
    ...(["SIGHUP", "SIGTERM"] as const).map((signal) =>
      deps.signals.on(signal, () => {
        state.terminating = true;
        deps.lifecycle?.({ kind: "child_signal", childPid: child.pid ?? null, signal });
        child.signal(signal);
      }),
    ),
    deps.signals.on("SIGINT", () => undefined),
  ];

  let depart: (departure: Departure) => void = () => undefined;
  const departing = new Promise<Departure>((resolve) => {
    depart = resolve;
  });

  /** A refusal this session met: ask where it goes. */
  const handleRefusal = async (hit: QuotaHit): Promise<void> => {
    const conversationId = deps.currentConversationId(plan.sessionId);
    if (conversationId === undefined) {
      const warning = `agent-shim: cannot move session ${plan.sessionId}: its current conversation is unknown`;
      if (warning !== state.lastWarning) {
        state.lastWarning = warning;
        deps.log.warn(warning);
      }
      return;
    }
    const outcome = await deps.decideMove({ sessionId: plan.sessionId, ...(conversationId === plan.sessionId ? {} : { conversationId }), from: identity, contextTokens: deps.contextTokens(conversationId) });
    if (outcome.kind === "move") {
      state.leaving = true;
      deps.lifecycle?.({ kind: "departure", reason: "quota" });
      depart({ ...outcome, conversationId });
    } else {
      state.declined = true;
      deps.log.warn(`agent-shim: ${labelOf(deps, identity)} is out of quota${hit.resetAt === undefined ? "" : ` until ${hit.resetAt}`}, and this session stays on it: ${outcome.reason}`);
    }
  };

  /** Ask the running session to compact itself, holding the quota slot until it answers or exits. */
  const considerCompacting = (compaction: CompactionDeps): void => {
    const live = compaction.live;
    if (live === undefined || state.compacting || attemptedWake === state.wakes) return;
    const decision = compaction.shouldCompact(identity, plan.sessionId);
    if (!decision.compact || (decision.conversationId ?? plan.sessionId) === compacted) return;
    if (!live.ready()) {
      const warning = `agent-shim: cannot compact session ${plan.sessionId}: the in-process plugin is not ready`;
      if (warning !== state.lastWarning) {
        state.lastWarning = warning;
        deps.log.warn(warning);
      }
      return;
    }
    const slot = compaction.acquire(identity);
    if (slot === undefined) return;
    state.compacting = true;
    attemptedWake = state.wakes;
    const conversationId = decision.conversationId ?? plan.sessionId;
    deps.log.info(`agent-shim: ${decision.reason}; compacting session ${plan.sessionId} in process`);
    liveTask = live.compact(conversationId, liveAbort.signal).then((result) => {
      deps.lifecycle?.({ kind: "compaction", phase: "live", outcome: result.kind });
      if (result.kind === "compacted") {
        if (compaction.markCompacted(plan.sessionId, true, conversationId)) {
          compacted = conversationId;
          onCompacted(conversationId);
        }
        deps.log.info(`agent-shim: compacted session ${plan.sessionId} on ${labelOf(deps, identity)}`);
      } else {
        deps.log.info(`agent-shim: session ${plan.sessionId} was left as it was: ${result.reason}`);
      }
    }).catch((error: unknown) => {
      deps.lifecycle?.({ kind: "compaction", phase: "live", outcome: liveAbort.signal.aborted ? "interrupted" : "failed" });
      if (!liveAbort.signal.aborted) deps.log.warn(`agent-shim: could not compact session ${plan.sessionId}: ${messageOf(error)}`);
    }).finally(() => {
      slot.release();
      state.compacting = false;
      if (!liveAbort.signal.aborted && state.wakes > attemptedWake) recheck();
    });
  };

  // Read through a function so that a departure decided while a check awaits is seen: a property read directly would keep the value it had when the check began.
  const isLeaving = (): boolean => state.leaving;

  // Every change to the snapshot counts as a wake. One check runs at a time, and a wake that arrives while it runs makes it look again once it has finished.
  const check = async (): Promise<void> => {
    state.wakes += 1;
    if (isLeaving() || state.checking) {
      return;
    }
    state.checking = true;
    try {
      let handled: number;
      do {
        handled = state.wakes;
        if (isLeaving()) {
          break;
        }
        if (state.compacting) continue;
        const currentConversation = deps.currentConversationId(plan.sessionId);
        const move = currentConversation === undefined ? undefined : deps.claimModelMove(plan.sessionId);
        if (move !== undefined && currentConversation !== undefined) {
          const outcome = deps.decideRemodel({ sessionId: plan.sessionId, ...(currentConversation === plan.sessionId ? {} : { conversationId: currentConversation }), from: identity, to: move.to, contextTokens: deps.contextTokens(currentConversation) });
          if (outcome.kind === "move") {
            state.leaving = true;
            deps.lifecycle?.({ kind: "departure", reason: "model" });
            depart({ kind: "remodel", to: outcome.to, model: move.model, conversationId: currentConversation });
          } else {
            deps.log.warn(`agent-shim: session ${plan.sessionId} picked a model under ${labelOf(deps, move.to)}, but stays on ${labelOf(deps, identity)}: ${outcome.reason}`);
          }
          continue;
        }
        const hit = deps.quotaHit(identity, plan.sessionId, startedMs);
        if (hit !== undefined) {
          if (!state.declined) {
            await handleRefusal(hit);
          }
          continue;
        }
        state.declined = false;
        if (deps.compaction !== undefined) {
          considerCompacting(deps.compaction);
        }
      } while (handled !== state.wakes);
    } catch (error) {
      // Said once per distinct problem: a snapshot that stays unreadable would otherwise repeat on every request.
      const warning = `agent-shim: could not check whether ${labelOf(deps, identity)} is out of quota: ${messageOf(error)}`;
      if (warning !== state.lastWarning) {
        state.lastWarning = warning;
        deps.log.warn(warning);
      }
    } finally {
      state.checking = false;
    }
  };
  recheck = () => { void check(); };
  const stopWatching = deps.watchChanges(identity, () => {
    void check();
  });
  // A model move arrives from the door rather than the usage log, so it has its own watcher; it is checked in the same one-at-a-time loop, and a departure decided while a check awaits is seen the same way.
  const stopWatchingMoves = deps.watchModelMoves?.(() => {
    void check();
  });

  try {
    const first = await Promise.race([observedExit.then((result) => ({ kind: "exited" as const, result })), departing]);
    stopWatching();
    stopWatchingMoves?.();
    if (first.kind === "exited") {
      return first;
    }
    deps.log.info(
      first.kind === "move"
        ? `agent-shim: ${labelOf(deps, identity)} is out of quota; resuming session ${plan.sessionId} under ${labelOf(deps, first.to)} (${first.explanation})`
        : `agent-shim: resuming session ${plan.sessionId} under ${labelOf(deps, first.to)} with ${first.model}, which only runs there`,
    );
    const result = await stopChild(deps, child);
    if (state.terminating) {
      return { kind: "exited", result };
    }
    return first;
  } finally {
    liveAbort.abort();
    await liveTask;
    stopWatching();
    stopWatchingMoves?.();
    for (const stop of stopHandlers) {
      stop();
    }
  }
}

/** The exit code a launcher ends with when a signal stopped it while no child was running: the shell's convention, 128 plus the signal's number, as for a child killed by it. */
function signalExit(signal: NodeJS.Signals): number {
  return childExitCode({ status: null, signal });
}

/**
 * Compacts a session as `identity`, between children, holding the identity's compaction slot for as long as it takes. A failure is reported and the session resumes as it was. A signal to the launcher abandons the compaction and returns the signal, which ends the supervisor.
 */
async function compactSession(deps: Readonly<SupervisorDeps>, compaction: CompactionDeps, slot: CompactionSlot, identity: string, sessionId: string, conversationId: string = sessionId): Promise<NodeJS.Signals | undefined> {
  const abort = new AbortController();
  const interrupted: { signal: NodeJS.Signals | undefined } = { signal: undefined };
  const stopHandlers = (["SIGINT", "SIGHUP", "SIGTERM"] as const).map((signal) =>
    deps.signals.on(signal, () => {
      interrupted.signal = signal;
      abort.abort();
    }),
  );
  try {
    const result = await compaction.compact({ identity: memberName(deps, identity), sessionId: conversationId, cwd: deps.cwd }, abort.signal);
    deps.lifecycle?.({ kind: "compaction", phase: "after_move", outcome: result.kind });
    if (result.kind === "unchanged") {
      deps.log.info(`agent-shim: session ${sessionId} was left as it was: ${result.reason}`);
    } else {
      const sizes = result.beforeTokens === undefined ? "" : `, ${String(result.beforeTokens)} tokens${result.afterTokens === undefined ? "" : ` down to ${String(result.afterTokens)}`}`;
      deps.log.info(`agent-shim: compacted session ${sessionId} on ${labelOf(deps, identity)}${sizes}`);
    }
  } catch (error) {
    deps.lifecycle?.({ kind: "compaction", phase: "after_move", outcome: interrupted.signal === undefined ? "failed" : "interrupted" });
    if (interrupted.signal === undefined) {
      deps.log.warn(`agent-shim: could not compact session ${sessionId} on ${labelOf(deps, identity)}, which resumes as it was: ${messageOf(error)}`);
    }
  } finally {
    for (const stop of stopHandlers) {
      stop();
    }
    slot.release();
  }
  // Whatever came of it, the session is not asked again on this member: a compaction that found nothing to do would otherwise be tried at every change to the snapshot.
  compaction.markCompacted(sessionId, true);
  return interrupted.signal;
}

/**
 * Runs a supervised pool launch to its end and returns the exit code the launcher should exit with: the child's own when it exits by itself. A session whose identity runs out of quota is moved to another member of its pool and resumed there, on the same terminal, until a child exits by itself.
 *
 * A pool with `compaction` also compacts a session while its member can still afford it: the running child compacts its own conversation between turns without losing the prompt. Once per conversation on a member. A session that was refused before it was compacted is compacted under its new member before it resumes, since the context has to be written there whether it is large or small.
 *
 * Each child is a fresh launch (`prepare`) under the same session id, so the front door attributes it to one session and `claude --resume` finds the conversation. A launch's plan is released as soon as its child has ended, and the session's registry entry is removed when the supervisor does.
 */
export async function supervise(deps: Readonly<SupervisorDeps>, first: SupervisedLaunch): Promise<number> {
  const { compaction } = deps;
  // What every launch of the session carries: its id, and the hooks that mark its turns.
  const base = { sessionId: first.sessionId, ...(first.settings === undefined ? {} : { settings: first.settings }), ...(first.settingsFile === undefined ? {} : { settingsFile: first.settingsFile }) };
  let launch = first;
  let compactedHere: string | undefined;
  try {
    for (let moved = false; ; moved = true) {
      const plan = deps.prepare(launch);
      const identity = plan.decision.identityId;
      if (identity === undefined) {
        plan.release();
        throw new Error("a supervised launch resolved no identity id to supervise");
      }
      // The launch's own pause or delay applies to the session's first child only: a relaunch under another member continues a session the person is already in.
      if (!moved && plan.hold() === "cancelled") {
        plan.release();
        return LAUNCH_CANCELLED_EXIT;
      }
      // A relaunch was registered by the move that chose its member, inside the move lock, or is the same session on the same member; only the first launch registers itself.
      if (!moved) {
        deps.register({ pid: deps.pid, sessionId: plan.sessionId, pool: deps.pool, identity, cwd: deps.cwd, since: new Date(deps.now()).toISOString() });
      }
      let outcome: RunOutcome;
      try {
        outcome = await runChild(deps, plan, identity, compactedHere, (conversationId) => { compactedHere = conversationId; });
      } finally {
        plan.release();
      }
      if (outcome.kind === "exited") {
        if (outcome.result.error !== undefined) {
          throw outcome.result.error;
        }
        return childExitCode(outcome.result);
      }
      launch = { ...base, conversation: "resume", ...(outcome.conversationId === plan.sessionId ? {} : { conversationId: outcome.conversationId }), member: memberName(deps, outcome.to), from: labelOf(deps, identity), ...(outcome.kind === "remodel" ? { model: outcome.model } : {}) };
      const compactedOnOld = compactedHere === outcome.conversationId;
      compactedHere = undefined;
      if (compaction !== undefined) {
        compaction.markCompacted(plan.sessionId, false);
        // A session compacted during its stay on the member it leaves has already had its context made small; one refused before that is compacted here, since its context is written on the new member whatever it costs.
        const slot = compactedOnOld ? undefined : compaction.acquire(outcome.to);
        if (slot !== undefined) {
          const interrupted = await compactSession(deps, compaction, slot, outcome.to, plan.sessionId, outcome.conversationId);
          compactedHere = outcome.conversationId;
          if (interrupted !== undefined) {
            return signalExit(interrupted);
          }
        } else {
          deps.lifecycle?.({ kind: "compaction", phase: "after_move", outcome: "not_attempted" });
        }
      } else {
        deps.lifecycle?.({ kind: "compaction", phase: "after_move", outcome: "not_attempted" });
      }
    }
  } finally {
    // Every launch of the session carries the first one's id, so this is the entry the whole run registered under.
    deps.unregister(first.sessionId);
  }
}

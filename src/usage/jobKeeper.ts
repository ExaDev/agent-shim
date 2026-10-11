import { dueAnchor } from "./anchor";
import type { Job, JobWindow } from "../config/schema";
import { parseDuration } from "../resolve/conditions";
import { readHandled, writeHandled, type StampsFs } from "./handledStamps";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { effectiveWindow, formatAge } from "./preflight";
import type { UsageSnapshot } from "./schema";
import { refusalReason } from "./windowKeeper";

/**
 * The job keeper: runs each job when its trigger fires. A schedule trigger fires at the latest anchor that has fallen since the job was last handled; a before-reset trigger fires once per instance of the named quota window, when the window has the job's lead or less left. Pure orchestration over injected ports, so the front door's timer, `job run` and the tests share one decision.
 */

/** A job with its name. */
export interface NamedJob {
  readonly name: string;
  readonly job: Job;
}

export interface JobKeeperPorts {
  readonly fs: StampsFs;
  readonly stampsFile: string;
  readonly nowMs: () => number;
  /** The zone an anchor without one is read in. */
  readonly timeZone: string;
  /** The configured jobs, read fresh each run so a change takes effect without a restart. */
  readonly jobs: () => readonly NamedJob[];
  /** The identity a job runs as: its own, or the pool's current pick; undefined when a pool has no member that can be picked. */
  readonly resolveIdentity: (target: Job["target"]) => string | undefined;
  readonly snapshot: (identity: string) => UsageSnapshot | undefined;
  /** Runs the job as the identity, resolving when the run ends and throwing with why it failed. A run can take as long as the job's timeout, so the keeper never waits on it. */
  readonly run: (name: string, identity: string, job: Job) => Promise<void>;
  /** The jobs running now, shared across runs so a job is never started again while it is still going. */
  readonly running: Set<string>;
  readonly log: (line: string) => void;
}

/** What one run did for one job. `armed` is the first sight of a schedule job (nothing before that moment counts as missed); `waiting` means the trigger has not fired, and `running` that the previous run has not ended. */
interface JobOutcome {
  readonly name: string;
  readonly status: "armed" | "waiting" | "running" | "started" | "skipped";
  readonly detail: string;
}

/** The fired jobs' runs settle on `settled`; the front door ignores it, and tests await it. */
export interface JobKeeperResult {
  readonly outcomes: readonly JobOutcome[];
  readonly settled: Promise<void>;
}

/** The named window of an identity's Anthropic snapshot as it stands, with when it resets; undefined when the snapshot holds no such window or it has reset. */
function pendingReset(snapshot: UsageSnapshot | undefined, window: JobWindow, nowMs: number): number | undefined {
  const recorded = snapshot?.providers[ANTHROPIC_PROVIDER]?.rateLimit?.unified?.[window];
  return recorded === undefined ? undefined : effectiveWindow(recorded, nowMs).resetsAtMs;
}

/**
 * Starts every job whose trigger has fired. Each job fires once per trigger instance, remembered in the stamps file so a restart neither repeats nor skips one: a schedule job stamps the instant it was handled, a before-reset job the reset instant of the window it ran for. A job that is already running, whose pool has no member that can be picked, whose identity is refused, or whose window is absent is skipped with the reason. A failed run is logged and not retried until the trigger fires again.
 */
export function runJobs(ports: Readonly<JobKeeperPorts>): JobKeeperResult {
  const nowMs = ports.nowMs();
  const jobs = ports.jobs();
  const previous = readHandled(ports.fs, ports.stampsFile);
  // A job removed from the configuration drops out of the file with it.
  const handled: Record<string, number> = Object.fromEntries(jobs.flatMap(({ name }) => (previous[name] === undefined ? [] : [[name, previous[name]]])));
  const outcomes: JobOutcome[] = [];
  const runs: Promise<void>[] = [];

  const start = (name: string, identity: string, job: Job, stamp: number, detail: string): void => {
    handled[name] = stamp;
    ports.running.add(name);
    outcomes.push({ name, status: "started", detail });
    runs.push(
      ports
        .run(name, identity, job)
        .catch((error: unknown) => {
          ports.log(`job ${name}: failed as ${identity}: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          ports.running.delete(name);
        }),
    );
  };

  /** The identity a job's target resolves to, or why it cannot: a pool that no longer exists, or a cycle, is that one job's skip and never stops the others. */
  const resolve = (target: Job["target"]): { readonly identity?: string; readonly problem?: string } => {
    try {
      const identity = ports.resolveIdentity(target);
      return identity === undefined ? { problem: "no member of its pool can be picked" } : { identity };
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) };
    }
  };

  /** Starts the job unless its identity is refused, stamping `stamp` as handled either way so a refused trigger instance is not retried on every run. */
  const startIfServable = (name: string, identity: string, job: Job, stamp: number, firedFor: string): void => {
    const refusal = refusalReason(identity, ports.snapshot(identity), nowMs);
    if (refusal === undefined) {
      start(name, identity, job, stamp, `${firedFor}: running as ${identity}`);
      return;
    }
    handled[name] = stamp;
    outcomes.push({ name, status: "skipped", detail: `${firedFor}: ${identity}: ${refusal}` });
  };

  for (const { name, job } of jobs) {
    if (ports.running.has(name)) {
      outcomes.push({ name, status: "running", detail: "a previous run is still going" });
      continue;
    }
    const { trigger } = job;
    if ("at" in trigger) {
      const last = handled[name];
      if (last === undefined) {
        handled[name] = nowMs;
        outcomes.push({ name, status: "armed", detail: "schedule noted; the next anchor to fall is the first acted on" });
        continue;
      }
      const due = dueAnchor(trigger.at, nowMs, last, ports.timeZone);
      if (due === undefined) {
        outcomes.push({ name, status: "waiting", detail: "no anchor has fallen since the last handled" });
        continue;
      }
      const firedFor = `anchor ${new Date(due).toISOString()}`;
      const { identity, problem } = resolve(job.target);
      if (identity === undefined) {
        handled[name] = nowMs;
        outcomes.push({ name, status: "skipped", detail: `${firedFor}: ${problem ?? "no identity"}` });
        continue;
      }
      startIfServable(name, identity, job, nowMs, firedFor);
      continue;
    }
    const { identity, problem } = resolve(job.target);
    if (identity === undefined) {
      outcomes.push({ name, status: "skipped", detail: problem ?? "no identity" });
      continue;
    }
    const resetsAtMs = pendingReset(ports.snapshot(identity), trigger.beforeReset, nowMs);
    if (resetsAtMs === undefined) {
      outcomes.push({ name, status: "skipped", detail: `${identity} has no ${trigger.beforeReset} window to run before` });
      continue;
    }
    if (resetsAtMs - parseDuration(trigger.lead) > nowMs || handled[name] === resetsAtMs) {
      outcomes.push({ name, status: "waiting", detail: `${trigger.beforeReset} window resets in ${formatAge(resetsAtMs - nowMs)}` });
      continue;
    }
    startIfServable(name, identity, job, resetsAtMs, `${trigger.beforeReset} window resetting in ${formatAge(resetsAtMs - nowMs)}`);
  }
  writeHandled(ports.fs, ports.stampsFile, handled);
  // Only an outcome that consumed a trigger instance is logged, so a job that is merely waiting, or skipped on a condition that persists, does not repeat itself on every run.
  for (const outcome of outcomes) {
    if ((outcome.status === "started" || outcome.status === "skipped") && handled[outcome.name] !== previous[outcome.name]) {
      ports.log(`job ${outcome.name}: ${outcome.detail}`);
    }
  }
  return { outcomes, settled: Promise.all(runs).then(() => undefined) };
}

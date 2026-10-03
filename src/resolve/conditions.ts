import picomatch from "picomatch";

import { DURATION_RE, type WhenCondition } from "../config/schema";
import type { EntryFact } from "./types";

const MILLISECONDS_PER_UNIT: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
});

const DURATION_PARTS_RE = /^(0|[1-9][0-9]*)(ms|s|m|h|d|w)$/;

/** Parses a duration literal like `90d` or `500ms` into milliseconds. Throws on anything the schema's own regex would already have rejected, so a malformed value can never be silently treated as zero. */
export function parseDuration(value: string): number {
  const parts = DURATION_PARTS_RE.exec(value);
  if (parts === null) {
    throw new Error(`"${value}" is not a valid duration. Expected a count followed by ms, s, m, h, d, or w.`);
  }
  const [, count, unit] = parts;
  if (count === undefined || unit === undefined) {
    throw new Error(`"${value}" is not a valid duration.`);
  }
  const multiplier = MILLISECONDS_PER_UNIT[unit];
  if (multiplier === undefined) {
    throw new Error(`"${value}" is not a valid duration.`);
  }
  return Number(count) * multiplier;
}

/** True when the value would satisfy the schema's duration regex. */
export function isDuration(value: string): boolean {
  return DURATION_RE.test(value);
}

/** Everything a `when` condition can be evaluated against, injected rather than read. */
export interface ConditionContext {
  readonly nowMs: number;
  /** Facts about the specific entry being decided. Absent when evaluating a rule-level condition that has no single entry (a directory rule's own `when`). */
  readonly fact?: EntryFact;
  /** The branch checked out at `cwd`, or undefined when `cwd` is not in a repository. */
  readonly branch?: string;
  /** True when the repository is in detached-HEAD state, in which case no `branch` condition can match. */
  readonly branchDetached?: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The result of evaluating one `when` object. */
export interface WhenEvaluation {
  readonly passed: boolean;
  /** Which condition fields were present and evaluated. */
  readonly checked: readonly string[];
  /** Which of those fields did not hold. Empty when `passed` is true. */
  readonly failed: readonly string[];
}

/** True when `branch` matches `pattern`. The pattern is glob-capable (`client/*`); a detached HEAD or a non-repository directory never matches. */
export function matchBranch(pattern: string, branch: string | undefined, detached = false): boolean {
  if (branch === undefined || branch === "" || detached) {
    return false;
  }
  return picomatch(pattern, { dot: true, nocase: false })(branch);
}

/**
 * Evaluates a `when` object. Every present field must hold — conditions AND together within one object.
 *
 * An absent condition is vacuously true, so `when: {}` passes; `agent-shim check` warns about that rather than erroring, since an empty object is more likely a half-finished edit than an intentional statement.
 *
 * `newerThan`, `olderThan`, and `maxSizeBytes` read the subtree-aggregated facts (`latestMtimeMs`, `totalSizeBytes`), never the entry's own inode stat: a directory's own mtime does not change when a file three levels beneath it is rewritten, and its own size is a ~4KB inode figure that says nothing about what it contains.
 */
export function evaluateWhen(when: WhenCondition | undefined, context: ConditionContext): WhenEvaluation {
  if (when === undefined) {
    return { passed: true, checked: [], failed: [] };
  }

  const checked: string[] = [];
  const failed: string[] = [];

  if (when.newerThan !== undefined) {
    checked.push("newerThan");
    const window = parseDuration(when.newerThan);
    const latest = context.fact?.latestMtimeMs;
    if (latest === undefined || context.nowMs - latest > window) {
      failed.push("newerThan");
    }
  }

  if (when.olderThan !== undefined) {
    checked.push("olderThan");
    const window = parseDuration(when.olderThan);
    const latest = context.fact?.latestMtimeMs;
    if (latest === undefined || context.nowMs - latest <= window) {
      failed.push("olderThan");
    }
  }

  if (when.maxSizeBytes !== undefined) {
    checked.push("maxSizeBytes");
    const total = context.fact?.totalSizeBytes;
    if (total === undefined || total > when.maxSizeBytes) {
      failed.push("maxSizeBytes");
    }
  }

  if (when.branch !== undefined) {
    checked.push("branch");
    if (!matchBranch(when.branch, context.branch, context.branchDetached ?? false)) {
      failed.push("branch");
    }
  }

  if (when.env !== undefined) {
    checked.push("env");
    const mismatch = Object.entries(when.env).some(([name, expected]) => context.env[name] !== expected);
    if (mismatch) {
      failed.push("env");
    }
  }

  return { passed: failed.length === 0, checked, failed };
}

/** True when the `when` object is present but empty, which is vacuously true and therefore has no effect. */
export function isVacuousWhen(when: WhenCondition | undefined): boolean {
  return when !== undefined && Object.keys(when).length === 0;
}

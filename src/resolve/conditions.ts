import picomatch from "picomatch";
import { createSyncEvaluator, type PredicateNode, type Resolution, type SyncResolvers } from "trilean";

import { DURATION_RE, type WhenCondition, type WhenConditionObject } from "../config/schema";
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

/** One quota window's pool-selection facts, in the units a policy reads: fractions of the window, and hours until it resets. */
export interface PoolWindowFacts {
  /** The fraction of the window still unused, between zero and one. */
  readonly remaining: number;
  /** The fraction of the window already used, between zero and one. */
  readonly utilization: number;
  /** How long until the window resets, in hours. */
  readonly hoursUntilReset: number;
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
  /**
   * The pool-selection facts a member entry's policy condition reads. Present only when the condition guards a pool member, so the same reference namespace serves the cascade and the pool: `quota.fiveHour.remaining`, `quota.fiveHour.utilization`, `quota.fiveHour.hoursUntilReset`, the same three under `quota.sevenDay`, and under `quota.extraUsage` for an account metered by extra usage alone (an Enterprise one with no plan windows), `quota.burnPerHour` (the five-hour window's observed utilisation pace, in fractions per hour), `session.resuming` (this launch resumes or continues a conversation) and `session.lastPickHoursAgo` (how long ago this directory last picked this member). Conversation context is deliberately not provided: nothing the door holds knows it, so a condition referencing it is indeterminate, naming the missing fact, rather than guessed.
   */
  readonly pool?: { readonly fiveHour?: PoolWindowFacts; readonly sevenDay?: PoolWindowFacts; readonly extraUsage?: PoolWindowFacts; readonly burnPerHour?: number; readonly resuming?: boolean; readonly lastPickHoursAgo?: number };
  /**
   * The request facts a provider's route condition reads, present only when the condition routes a request the door is resolving: `request.model` (the Messages body's own model field) and `request.hasImage` (an image block anywhere in the scanned head of the body). A request the door could not read that far carries neither, so a condition naming them is indeterminate and the routing falls through, never to a cheaper provider by accident.
   */
  readonly request?: { readonly model?: string; readonly hasImage?: boolean; readonly toolsPresent?: boolean; readonly thinking?: boolean; readonly maxTokens?: number; readonly isCountTokens?: boolean };
  /** Per-provider quota facts for request routing, keyed by provider name, from the session identity's usage snapshot: a route condition names a target's windows (`provider.<name>.fiveHour.utilization` and kin, and `provider.<name>.extraUsage.*` for an account metered by extra usage alone) to skip one that is exhausted or nearly spent. The windows are the same shape the pool facts read. */
  readonly providerQuota?: Readonly<Record<string, { readonly fiveHour?: PoolWindowFacts; readonly sevenDay?: PoolWindowFacts; readonly extraUsage?: PoolWindowFacts }>>;
}

/**
 * The result of evaluating one `when`: definite, with which condition fields were present and which of those did not hold, or indeterminate, when a datum the condition needed is missing. Indeterminate is not false: a missing fact has not failed the condition, it has left it undecided, and the consumer decides what an undecided entry does (the resolver keeps today's behaviour of not passing it, so nothing changes for existing configurations; the pool ranking of #258 instead keeps such a member but ranks it last, naming the missing fact).
 */
export type WhenEvaluation =
  | { readonly status: "definite"; readonly passed: boolean; /** Which condition fields were present and evaluated. */ readonly checked: readonly string[]; /** Which of those fields did not hold. Empty when `passed` is true. */ readonly failed: readonly string[] }
  | { readonly status: "indeterminate"; /** What was missing or wrong, in the evaluation's own words. */ readonly reason: string; readonly checked: readonly string[] };

/** True when `branch` matches `pattern`. The pattern is glob-capable (`client/*`); a detached HEAD or a non-repository directory never matches. */
export function matchBranch(pattern: string, branch: string | undefined, detached = false): boolean {
  if (branch === undefined || branch === "" || detached) {
    return false;
  }
  return picomatch(pattern, { dot: true, nocase: false })(branch);
}

/** The evaluator every `when` runs through: the trilean package's own synchronous one, so OR, NOT and missing-fact indeterminacy are its semantics rather than a re-derivation. */
const evaluator = createSyncEvaluator({});

/** The reference names one set of windows answers, under `prefix` (`quota`, or `provider.<name>`): `<window>.remaining`, `.utilization` and `.hoursUntilReset` for each window present. */
function windowValues(prefix: string, windows: { readonly fiveHour?: PoolWindowFacts; readonly sevenDay?: PoolWindowFacts; readonly extraUsage?: PoolWindowFacts } | undefined): Record<string, number> {
  const values: Record<string, number> = {};
  for (const name of ["fiveHour", "sevenDay", "extraUsage"] as const) {
    const facts = windows?.[name];
    if (facts !== undefined) {
      values[`${prefix}.${name}.remaining`] = facts.remaining;
      values[`${prefix}.${name}.utilization`] = facts.utilization;
      values[`${prefix}.${name}.hoursUntilReset`] = facts.hoursUntilReset;
    }
  }
  return values;
}

/** One resolver over the condition context's facts, keyed by the reference names the `when` forms document: `now` (epoch milliseconds), `entry.latestMtimeMs`, `entry.totalSizeBytes`, `repo.branch`, `repo.detached`, and `env.<NAME>` for every environment variable. A name the context cannot answer resolves not-found, which the evaluator carries as indeterminate, the unknown semantics itself. */
function resolversOf(context: ConditionContext): SyncResolvers {
  const pool = context.pool;
  const values: Readonly<Record<string, number | string | boolean>> = {
    now: context.nowMs,
    ...(context.fact?.latestMtimeMs === undefined ? {} : { "entry.latestMtimeMs": context.fact.latestMtimeMs }),
    ...(context.fact?.totalSizeBytes === undefined ? {} : { "entry.totalSizeBytes": context.fact.totalSizeBytes }),
    ...(context.branch === undefined ? {} : { "repo.branch": context.branch }),
    "repo.detached": context.branchDetached ?? false,
    ...windowValues("quota", pool),
    ...(pool?.burnPerHour === undefined ? {} : { "quota.burnPerHour": pool.burnPerHour }),
    ...(pool?.resuming === undefined ? {} : { "session.resuming": pool.resuming }),
    ...(pool?.lastPickHoursAgo === undefined ? {} : { "session.lastPickHoursAgo": pool.lastPickHoursAgo }),
    ...(context.request?.model === undefined ? {} : { "request.model": context.request.model }),
    ...(context.request?.hasImage === undefined ? {} : { "request.hasImage": context.request.hasImage }),
    ...(context.request?.toolsPresent === undefined ? {} : { "request.toolsPresent": context.request.toolsPresent }),
    ...(context.request?.thinking === undefined ? {} : { "request.thinking": context.request.thinking }),
    ...(context.request?.maxTokens === undefined ? {} : { "request.maxTokens": context.request.maxTokens }),
    ...(context.request?.isCountTokens === undefined ? {} : { "request.isCountTokens": context.request.isCountTokens }),
    ...(context.providerQuota === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(context.providerQuota).flatMap(([name, windows]) => Object.entries(windowValues("provider." + name, windows))),
        )),
  };
  return {
    resolveValue: (key): Resolution => {
      // A computed value is tagged by its own kind, so each fact resolves as what it is: a number, a text or a boolean, never a bare primitive the evaluator would have to guess about.
      const wrap = (value: number | string | boolean): Resolution => ({ found: true, value: typeof value === "number" ? { kind: "number", value } : typeof value === "string" ? { kind: "text", value } : { kind: "boolean", value } });
      if (typeof key !== "string") {
        return { found: false };
      }
      if (key.startsWith("env.")) {
        const value = context.env[key.slice("env.".length)];
        return value === undefined ? { found: false } : wrap(value);
      }
      const value = values[key];
      return value === undefined ? { found: false } : wrap(value);
    },
    // This embedding provides the reference namespace only: a tree that asks for a lookup or a collection finds neither, which the evaluator carries as indeterminate rather than letting the tree pretend an answer.
    resolveLookup: () => ({ found: false }),
    resolveCollection: () => [],
  };
}

/** The predicate one field of the object form maps onto. Each is stated once here, so the object form and the predicate form cannot drift apart in semantics. */
function fieldPredicate(field: keyof WhenConditionObject, when: WhenConditionObject, context: ConditionContext): PredicateNode {
  switch (field) {
    case "newerThan": {
      const window = parseDuration(when.newerThan ?? "");
      return { kind: "compare", op: "gte", left: { kind: "reference", key: "entry.latestMtimeMs" }, right: { kind: "numberLiteral", value: context.nowMs - window } };
    }
    case "olderThan": {
      const window = parseDuration(when.olderThan ?? "");
      return { kind: "compare", op: "lt", left: { kind: "reference", key: "entry.latestMtimeMs" }, right: { kind: "numberLiteral", value: context.nowMs - window } };
    }
    case "maxSizeBytes":
      return { kind: "compare", op: "lte", left: { kind: "reference", key: "entry.totalSizeBytes" }, right: { kind: "numberLiteral", value: when.maxSizeBytes ?? 0 } };
    case "branch":
      // A detached HEAD never matches however its branch string reads, which is `matchBranch`'s own rule, so the pattern match is guarded by the detached fact beside it rather than losing that nuance in the mapping.
      return { kind: "allOf", operands: [{ kind: "textCompare", op: "portableMatches", left: { kind: "reference", key: "repo.branch" }, right: { kind: "textLiteral", value: when.branch ?? "" } }, { kind: "compare", op: "eq", left: { kind: "reference", key: "repo.detached" }, right: { kind: "booleanLiteral", value: false } }] };
    case "env": {
      const entries = Object.entries(when.env ?? {});
      // Every named variable must equal its expected value, so the fields AND together; an unset variable resolves not-found and the whole conjunction reports it indeterminate.
      return { kind: "allOf", operands: entries.map(([name, expected]) => ({ kind: "textCompare", op: "equals", left: { kind: "reference", key: `env.${name}` }, right: { kind: "textLiteral", value: expected } })) };
    }
  }
  // The switch is exhaustive over WhenConditionObject's own keys; the caller loops only fields that are present, so no field arrives unhandled. The empty conjunction is the matching vacuous truth for a case that cannot run.
  return { kind: "allOf", operands: [] };
}

/**
 * Evaluates a `when`, in either of its two forms.
 *
 * The object form (`newerThan`, `olderThan`, `maxSizeBytes`, `branch`, `env`) is the original configuration sugar: every present field must hold, which is the AND of the field predicates above. It is kept unchanged, so no configuration migrates, and its per-field reporting (`checked`, `failed`) survives exactly as before.
 *
 * The predicate form is a trilean predicate tree, evaluated by the package's own synchronous evaluator over the reference namespace `resolversOf` documents: `and`/`or`/`not` compose, comparisons and text matches read the facts, and a reference the context cannot answer makes the evaluation indeterminate rather than false. A predicate form is reported as one condition (`checked: ["predicate"]`), because a tree has no per-field breakdown to give.
 *
 * `newerThan`, `olderThan`, and `maxSizeBytes` read the subtree-aggregated facts (`latestMtimeMs`, `totalSizeBytes`), never the entry's own inode stat: a directory's own mtime does not change when a file three levels beneath it is rewritten, and its own size is a ~4KB inode figure that says nothing about what it contains.
 */
export function evaluateWhen(when: WhenCondition | undefined, context: ConditionContext): WhenEvaluation {
  if (when === undefined) {
    return { status: "definite", passed: true, checked: [], failed: [] };
  }

  if ("kind" in when) {
    const result = evaluator.evaluatePredicate(when, undefined, resolversOf(context));
    return result.status === "indeterminate"
      ? { status: "indeterminate", reason: result.reason.message, checked: ["predicate"] }
      : { status: "definite", passed: result.value, checked: ["predicate"], failed: result.value ? [] : ["predicate"] };
  }

  const checked: string[] = [];
  const failed: string[] = [];
  for (const field of ["newerThan", "olderThan", "maxSizeBytes", "branch", "env"] as const) {
    if (when[field] === undefined) {
      continue;
    }
    checked.push(field);
    const result = evaluator.evaluatePredicate(fieldPredicate(field, when, context), undefined, resolversOf(context));
    if (result.status === "indeterminate") {
      // The first field that cannot be decided decides the whole conjunction, and names what was missing: the rest are not evaluated, exactly as an AND that has already met an undecided operand.
      return { status: "indeterminate", reason: result.reason.message, checked };
    }
    if (!result.value) {
      failed.push(field);
    }
  }
  return { status: "definite", passed: failed.length === 0, checked, failed };
}

/** Whether a `when` references the named fact, by walking the predicate tree for reference nodes with that key. The object form references no request fact (its fields read entry and repo facts), so it answers false for those. The routing layer uses this to decide how far a request must be scanned: a condition that names `request.hasImage` needs the whole body, because an image anywhere in the conversation is the fact, and the head cannot see it. */
export function referencesFact(when: WhenCondition | undefined, key: string): boolean {
  if (when === undefined || !("kind" in when)) {
    return false;
  }
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) {
      return node.some(walk);
    }
    if (typeof node !== "object" || node === null) {
      return false;
    }
    if ("kind" in node && node.kind === "reference" && "key" in node && node.key === key) {
      return true;
    }
    return Object.values(node).some(walk);
  };
  return walk(when);
}

/** True when the `when` is present but an empty object, which is vacuously true and therefore has no effect. A predicate-form `when` is never vacuous: a tree always states something. */
export function isVacuousWhen(when: WhenCondition | undefined): boolean {
  return when !== undefined && !("kind" in when) && Object.keys(when).length === 0;
}

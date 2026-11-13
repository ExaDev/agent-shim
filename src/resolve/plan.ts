import path from "node:path";

import { patternCouldReachUnder } from "./match";
import type { Decision, EntryFacts, FlattenedCascade } from "./types";

/** What the farm should contain at one path. */
type FarmPlanEntry =
  /** A single symlink standing in for this whole path — always absolute, always under `claudeHome`. */
  | { readonly kind: "link"; readonly rel: string; readonly target: string }
  /** A real local directory the farm builds itself, because the decision beneath it is not uniform or because a conditional rule could touch it. */
  | { readonly kind: "materialise"; readonly rel: string; readonly reason: MaterialiseReason }
  /** Nothing at all in the farm for this path. */
  | { readonly kind: "omit"; readonly rel: string };

/** Why a directory has to be built rather than symlinked. */
type MaterialiseReason =
  /** Descendants of this directory resolve to different decisions, so a single symlink cannot express the outcome. */
  | "split-decision"
  /** A conditional entries rule could match something under this directory, so the decision has to stay live. */
  | "conditional-rule";

/** The full farm plan for one resolved cascade. */
export interface FarmPlan {
  /** Every planned path, parents before children. */
  readonly entries: readonly FarmPlanEntry[];
  /** Directories the farm builds itself, in plan order. Written into the farm manifest so the next resync can tell them apart from directories Claude Code created. */
  readonly materialised: readonly string[];
  readonly links: readonly { readonly rel: string; readonly target: string }[];
  /** Shared entries left out of the farm because their `~/.claude` path is a symlink that reaches nothing, in plan order. */
  readonly dangling: readonly string[];
}

/** Everything `planFarm` needs, all of it already resolved. */
export interface PlanFarmParams {
  readonly facts: EntryFacts;
  readonly decisions: ReadonlyMap<string, Decision>;
  readonly flattened: FlattenedCascade;
}

function parentOf(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index === -1 ? "" : rel.slice(0, index);
}

/** Indexes the fact manifest by parent path, so the plan can descend the tree without touching a filesystem. */
export function buildChildIndex(facts: EntryFacts): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const rel of facts.entries.keys()) {
    const parent = parentOf(rel);
    const bucket = children.get(parent);
    if (bucket === undefined) {
      children.set(parent, [rel]);
    } else {
      bucket.push(rel);
    }
  }
  for (const bucket of children.values()) {
    bucket.sort();
  }
  return children;
}

/**
 * Turns a resolved set of decisions into a concrete farm layout.
 *
 * A directory becomes one symlink when the decision is uniform across its whole subtree, which is what keeps the common resync cheap — a few dozen top-level symlinks rather than a rebuilt tree. It is materialised, and recursed into, when either:
 *
 * - its subtree's decisions genuinely disagree, so no single symlink can express the outcome; or
 * - **any** conditional entries rule could reach something under it, even when today's evaluation happens to be uniform. This second case is the one a naive "is the decision uniform right now" check gets wrong: a symlinked directory freezes the decision for every file Claude Code creates *after* the resync, so a `newerThan` condition meant to share recent sessions would never see a session written five minutes from now. The bug only surfaces for files that do not exist yet, which is precisely why the check has to be structural rather than observational.
 *
 * A farm link always leads somewhere when it is made: a shared entry whose `~/.claude` path is a symlink reaching nothing is left out, exactly as an entry `~/.claude` does not hold at all, and listed in `dangling`. Linking it would hand Claude Code a path it cannot write through (a `sessions/` record written there is lost, so the session is missing from `claude agents`), while leaving it out lets the identity keep its own copy until the entry leads somewhere, when the next resync links it (and holds any copy the identity kept meanwhile in the superseded farm for `identity resolve-conflicts`, as for any entry `~/.claude` gains). Nothing is created for it: what a dangling symlink should point at, a directory or a file, is not known, and the link shared nothing while it dangled, so leaving it out changes nothing that is shared.
 *
 * Every symlink target is `<claudeHome>/<rel>`, unconditionally. That matters for the entries inside a materialised directory that are themselves relative symlinks escaping `~/.claude` (a real condition, not a hypothetical one — a skills directory linked out to a separate dotfiles repository, for instance). Copying such a link's own relative target verbatim would resolve to a different place from the farm's own depth, and copying its resolved absolute target would pin the farm to wherever that link pointed at resync time. Linking at `<claudeHome>/<rel>` and letting the OS follow the remaining hops from there is the only form that stays correct.
 */
export function planFarm(params: PlanFarmParams): FarmPlan {
  const children = buildChildIndex(params.facts);
  const entries: FarmPlanEntry[] = [];
  const materialised: string[] = [];
  const links: { rel: string; target: string }[] = [];
  const dangling: string[] = [];

  const conditionalPatterns = [...params.flattened.rules.values()]
    .filter((rule) => rule.when !== undefined)
    .map((rule) => rule.canonicalPattern);

  const conditionalRuleCouldReach = (dir: string): boolean =>
    conditionalPatterns.some((pattern) => patternCouldReachUnder(pattern, dir));

  const subtreeDecision = (rel: string): boolean | undefined => {
    const own = params.decisions.get(rel);
    let value = own?.shared;
    const stack = [...(children.get(rel) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined) {
        continue;
      }
      const decision = params.decisions.get(next);
      if (decision === undefined) {
        continue;
      }
      if (value === undefined) {
        value = decision.shared;
      } else if (decision.shared !== value) {
        return undefined;
      }
      stack.push(...(children.get(next) ?? []));
    }
    return value;
  };

  const linkTarget = (rel: string): string => path.join(params.facts.claudeHome, rel);

  const visit = (rel: string): void => {
    const fact = params.facts.entries.get(rel);
    const decision = params.decisions.get(rel);

    if (fact === undefined) {
      return;
    }

    if (!fact.isDirectory) {
      if (decision?.shared === true && fact.isDanglingSymlink) {
        entries.push({ kind: "omit", rel });
        dangling.push(rel);
      } else if (decision?.shared === true) {
        entries.push({ kind: "link", rel, target: linkTarget(rel) });
        links.push({ rel, target: linkTarget(rel) });
      } else {
        entries.push({ kind: "omit", rel });
      }
      return;
    }

    if (conditionalRuleCouldReach(rel)) {
      entries.push({ kind: "materialise", rel, reason: "conditional-rule" });
      materialised.push(rel);
      for (const child of children.get(rel) ?? []) {
        visit(child);
      }
      return;
    }

    const uniform = subtreeDecision(rel);
    if (uniform === true) {
      entries.push({ kind: "link", rel, target: linkTarget(rel) });
      links.push({ rel, target: linkTarget(rel) });
      return;
    }
    if (uniform === false) {
      entries.push({ kind: "omit", rel });
      return;
    }

    entries.push({ kind: "materialise", rel, reason: "split-decision" });
    materialised.push(rel);
    for (const child of children.get(rel) ?? []) {
      visit(child);
    }
  };

  for (const rel of children.get("") ?? []) {
    visit(rel);
  }

  return { entries, materialised, links, dangling };
}

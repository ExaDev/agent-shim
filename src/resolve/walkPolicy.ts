import type { CompiledRule } from "./types";

/**
 * Whether the walk that builds entry facts must enter the directory at `dirRel` (relative to `~/.claude`). A directory it does not enter is one entry: nothing recorded below it, because nothing below it can be decided differently from the directory itself.
 */
export type DescendPolicy = (dirRel: string) => boolean;

/** Enters every directory: the walk before it was made lazy, and the only one that yields the subtree aggregates a size or age condition reads. */
const ENTER_EVERYTHING: DescendPolicy = () => true;

/** Whether `rule` reads the subtree aggregates (`latestMtimeMs`, `totalSizeBytes`) of the entry it matches, which only a complete walk below that entry can supply. */
function readsSubtreeAggregates(rule: CompiledRule): boolean {
  const when = rule.when;
  return when !== undefined && (when.newerThan !== undefined || when.olderThan !== undefined || when.maxSizeBytes !== undefined);
}

/** Pattern syntax whose match depth is not the number of its `/`-separated segments: `**` spans segments, and a brace or extglob group may contain a `/`. */
function hasUnboundedDepth(pattern: string): boolean {
  return pattern.includes("**") || /[{(]/.test(pattern);
}

/**
 * Whether the walk must record what is inside `dirRel` for `rule`: it could match a path strictly inside that it does not already cover by matching `dirRel` itself, or it is a conditional rule matching `dirRel` itself, whose subtree the farm plans entry by entry. Deliberately conservative: it may say yes for a rule that in the end matches nothing there, never no for one that does.
 */
function couldMatchBeneath(rule: CompiledRule, dirRel: string): boolean {
  if (rule.matches(dirRel)) {
    // A rule that matches a directory covers its whole subtree uniformly, except that a conditional one is evaluated per entry, so the farm materialises the matched directory and links every descendant individually: the whole subtree must be recorded.
    return rule.when !== undefined;
  }
  if (rule.isExact) {
    return rule.canonicalPattern.startsWith(`${dirRel}/`);
  }
  const depth = dirRel.split("/").length;
  if (!hasUnboundedDepth(rule.canonicalPattern) && rule.segmentCount <= depth) {
    return false;
  }
  const prefix = rule.literalPrefix;
  return prefix === "" || prefix.startsWith(`${dirRel}/`) || dirRel.startsWith(prefix);
}

/**
 * The walk policy for a flattened cascade. A directory is entered only when some rule can decide a path inside it differently from the directory itself, so a configuration with no rule below a top-level entry reads that entry with one `lstat`; with a rule that reads subtree aggregates anywhere, every directory is entered.
 *
 * Why this is safe: a rule matching a directory also matches everything beneath it (see `compileMatcher`), and the category toggles decide by top-level entry, so a subtree no rule reaches into resolves to one uniform decision, which the farm plan collapses to a single link either way.
 */
export function descendPolicy(rules: Readonly<Iterable<CompiledRule>>): DescendPolicy {
  const all = [...rules];
  if (all.some(readsSubtreeAggregates)) {
    return ENTER_EVERYTHING;
  }
  return (dirRel) => all.some((rule) => couldMatchBeneath(rule, dirRel));
}

/**
 * `policy`, widened to also enter `target` and every directory on the way to it, for a caller that needs the direct children of that path recorded (the interactive picker). With no `target` it is `policy` itself.
 */
export function enterRulesAnd(policy: DescendPolicy, target: string | undefined): DescendPolicy {
  if (target === undefined || target === "") {
    return policy;
  }
  return (dirRel) => dirRel === target || target.startsWith(`${dirRel}/`) || policy(dirRel);
}

import { canonicalJson } from "../canonicalJson";
import { holdFrom, within } from "../elapsedWindow";
import { buildLayoutPaths, resolveAgentShimHome } from "../paths";
import { expandTilde, isAncestorOrSelf, normaliseRulePath } from "../pathNorm";
import { ignoresCase, sameDirectory } from "../sameDirectory";
import { shellQuoted } from "../shellQuote";
import { environment, numeric, text } from "./args";
import type { CaseTable } from "../../conformance/runner/run.mjs";

/** What a case's `resolveAgentShimHome` third argument means: `true` (every directory exists), `false` (none does) or the list of those that do. */
function directoryTest(value: unknown): (candidate: string) => boolean {
  if (typeof value === "boolean") {
    return () => value;
  }
  if (Array.isArray(value)) {
    const existing = new Set(value.map(text));
    return (candidate) => existing.has(candidate);
  }
  throw new TypeError(`expected true, false or a list of paths, got ${JSON.stringify(value)}`);
}

/** The functions of the pure root helpers (the layout paths, tilde and rule paths, canonical JSON, shell quoting, elapsed windows and directory identity), by the name a `function` case gives. */
export const rootTable: CaseTable = {
  resolveAgentShimHome: (env, home, exists) => resolveAgentShimHome(environment(env), text(home), directoryTest(exists)),
  buildLayoutPaths: (root) => buildLayoutPaths(text(root)),
  canonicalJson: (value) => canonicalJson(value),
  expandTilde: (value, home) => expandTilde(text(value), text(home)),
  normaliseRulePath: (rule, home) => normaliseRulePath(text(rule), text(home)),
  isAncestorOrSelf: (ancestor, descendant) => isAncestorOrSelf(text(ancestor), text(descendant)),
  shellQuoted: (value) => shellQuoted(text(value)),
  within: (since, now, window) => within(numeric(since), numeric(now), numeric(window)),
  holdFrom: (since, now, window) => holdFrom(numeric(since), numeric(now), numeric(window)),
  sameDirectory: (first, second) => sameDirectory(text(first), text(second)),
  ignoresCase: (directory) => ignoresCase(text(directory)),
};

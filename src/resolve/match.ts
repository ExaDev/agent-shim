import picomatch from "picomatch";

import { isCategoryName, type CategoryName } from "../config/schema";
import { CliError } from "../cliError";
import { encodeProjectPattern, UnrootedProjectPathError } from "./projects";
import type { CompiledRule } from "./types";

const GLOB_METACHARACTERS = /[*?[\]{}!()]/;

/** True when `pattern` contains no glob metacharacter, so it can only ever match one literal path. */
export function isExactPattern(pattern: string): boolean {
  return !GLOB_METACHARACTERS.test(pattern);
}

/** The pattern's leading run of characters before the first glob metacharacter — the part that is definitely literal. */
export function literalPrefixOf(pattern: string): string {
  const match = GLOB_METACHARACTERS.exec(pattern);
  return match === null ? pattern : pattern.slice(0, match.index);
}

/** Normalises a relative path fragment: collapses repeated slashes, drops `./` segments, and strips a trailing slash. Deliberately case-preserving and case-sensitive. */
export function normaliseRelative(fragment: string): string {
  const segments = fragment.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.join("/");
}

/** The literal prefix every `history` entries key that names a project directory must carry. */
const PROJECTS_PREFIX = "projects/";

/** The outcome of canonicalising one entries key. */
export interface CanonicalKey {
  readonly declaredCategory: CategoryName;
  /** The pattern with its category prefix stripped, relative to `~/.claude`, with any `history/projects/` path fragment already encoded. */
  readonly canonicalPattern: string;
  /** The `history/projects/` path fragment as written, before encoding — retained so ambiguity reporting can name what the author actually typed. */
  readonly projectFragment?: string;
}

/** Raised when an entries key cannot be canonicalised. Carries the offending key so the diagnostic can name it. */
export class EntryKeyError extends CliError {
  constructor(
    readonly key: string,
    message: string,
    readonly reason: "unrooted-project-path" | "malformed",
  ) {
    super(message);
    this.name = "EntryKeyError";
  }
}

/**
 * Canonicalises one entries key into a pattern over paths relative to `~/.claude`.
 *
 * Every key is `<category>/<real-relative-path>`, so the category prefix is stripped and the remainder kept as written — with one deliberately narrow exception. Anything written after the literal `history/projects/` prefix is a real absolute working directory (optionally globbed), not a literal child directory name, because that directory's only real children are Claude Code's own encoded names and there is nothing else meaningful to reference there. Those fragments get `~`-expanded and forward-encoded; every other key in the whole design is a plain literal path or an ordinary glob over one, matched exactly as written.
 */
export function canonicaliseEntryKey(key: string, options: Readonly<{ home: string }>): CanonicalKey {
  const separator = key.indexOf("/");
  if (separator <= 0) {
    throw new EntryKeyError(key, `Entry key "${key}" has no "<category>/" prefix.`, "malformed");
  }
  const category = key.slice(0, separator);
  if (!isCategoryName(category)) {
    throw new EntryKeyError(key, `Entry key "${key}" starts with "${category}", which is not a category name.`, "malformed");
  }
  const rest = key.slice(separator + 1);
  if (rest === "") {
    throw new EntryKeyError(key, `Entry key "${key}" names a category with no path after it.`, "malformed");
  }

  if (category === "history" && rest.startsWith(PROJECTS_PREFIX)) {
    const fragment = rest.slice(PROJECTS_PREFIX.length);
    try {
      const encoded = encodeProjectPattern(fragment, { home: options.home });
      return { declaredCategory: category, canonicalPattern: PROJECTS_PREFIX + encoded, projectFragment: fragment };
    } catch (error) {
      if (error instanceof UnrootedProjectPathError) {
        throw new EntryKeyError(key, error.message, "unrooted-project-path");
      }
      throw error;
    }
  }

  return { declaredCategory: category, canonicalPattern: normaliseRelative(rest) };
}

/**
 * Compiles a canonical pattern into a matcher that covers the pattern itself *and* everything beneath it, so a rule written as `knowledge/skills` decides `skills/commit/SKILL.md` too. Two picomatch matchers are needed rather than one: `skills/**` alone covers the subtree but `projects/*` does not match `projects/x/y`, and `projects/*` alone does not cover the files inside a matched project directory.
 *
 * Matching is deliberately case-sensitive (`nocase: false`) whatever the host filesystem does, so the same config behaves identically on a case-insensitive APFS volume and a case-sensitive one. `dot: true` so a glob can match a leading-dot entry.
 */
export function compileMatcher(canonicalPattern: string): (relPath: string) => boolean {
  const options = { dot: true, nocase: false } as const;
  const self = picomatch(canonicalPattern, options);
  const subtree = picomatch(`${canonicalPattern}/**`, options);
  return (relPath: string) => self(relPath) || subtree(relPath);
}

/**
 * True when some path *underneath* `dir` could match `canonicalPattern`, whether or not such a path exists today.
 *
 * This is what makes a conditional rule force materialisation: a directory Claude Code will write new children into cannot be symlinked wholesale if a rule might have something to say about those not-yet-existing children. Answering that from the pattern's structure rather than from the current file listing is the whole point — asking "does any existing child match" would pass the obvious test and fail the real one.
 */
export function patternCouldReachUnder(canonicalPattern: string, dir: string): boolean {
  const patternSegments = canonicalPattern.split("/").filter((segment) => segment !== "");
  const dirSegments = dir.split("/").filter((segment) => segment !== "");
  return couldReach(patternSegments, dirSegments);
}

function couldReach(patternSegments: readonly string[], dirSegments: readonly string[]): boolean {
  if (dirSegments.length === 0) {
    // Every remaining pattern segment is free to match something beneath this directory.
    return true;
  }
  if (patternSegments.length === 0) {
    // The pattern matched a proper ancestor of `dir`; subtree semantics mean it covers `dir` and everything under it.
    return true;
  }
  const [head, ...restPattern] = patternSegments;
  if (head === "**") {
    return true;
  }
  const [dirHead, ...restDir] = dirSegments;
  if (head === undefined || dirHead === undefined) {
    return true;
  }
  if (!picomatch(head, { dot: true, nocase: false })(dirHead)) {
    return false;
  }
  return couldReach(restPattern, restDir);
}

/**
 * Ranks two compiled rules that both match the same path. A positive result means `a` wins.
 *
 * The order, exactly:
 *
 * 1. **Different layers — the later layer wins, period.** This rank sits deliberately *above* exactness. Ranking exactness first would let an untrusted committed `.agent-shim.json`'s exact key beat your own later, personal glob override, breaking the design's stated trust property that a directory-scoped local rule can only ever tighten what a committed file opened, never the reverse. Nothing in the design asserts that an earlier exact key beats a later glob, so nothing is lost by closing that hole.
 * 2. Same layer: an exact literal beats a glob.
 * 3. Same layer: the longer literal prefix wins.
 * 4. Same layer: more path segments wins, which separates a one-wildcard pattern from a two-wildcard one at the same depth.
 * 5. Same layer: the later ordinal — source order within the file — wins.
 * 6. Canonical pattern, compared as a string, as a last-resort determinism guarantee.
 *
 * The order must be **total**: returning 0 for two distinct rules would make the winner depend on iteration order, which tests would only catch intermittently.
 */
export function compareSpecificity(a: CompiledRule, b: CompiledRule): number {
  if (a.layer !== b.layer) {
    return a.layer - b.layer;
  }
  if (a.isExact !== b.isExact) {
    return a.isExact ? 1 : -1;
  }
  if (a.literalPrefix.length !== b.literalPrefix.length) {
    return a.literalPrefix.length - b.literalPrefix.length;
  }
  if (a.segmentCount !== b.segmentCount) {
    return a.segmentCount - b.segmentCount;
  }
  if (a.ordinal !== b.ordinal) {
    return a.ordinal - b.ordinal;
  }
  if (a.canonicalPattern === b.canonicalPattern) {
    return 0;
  }
  return a.canonicalPattern < b.canonicalPattern ? -1 : 1;
}

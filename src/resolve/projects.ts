/**
 * Forward-only encoding of a real working directory into the single directory name Claude Code gives it under `~/.claude/projects/`.
 *
 * The encoding collapses the *entire* non-alphanumeric character class to `-`, not just the path separator: `.`, `_`, ` `, `@`, and `/` all become `-`, while letters and digits pass through with their case preserved. This was confirmed against a real installation's project directories, not assumed from the one `/`-becomes-`-` sample the README quotes.
 *
 * The encoding is therefore many-to-one: `~/work/clients/acme`, `~/work/clients-acme`, and `~/work-clients/acme` all produce the identical name. That makes it impossible to invert, so this module never tries: there is no decode function here, and `projects.test.ts` asserts the module's export list to keep it that way. Only the forward direction — real path to encoded name — is ever computed, and `detectEncodingAmbiguity` reports when a pattern's encoded form could plausibly correspond to more than one real path rather than resolving it silently.
 */

import { CliError } from "../cliError";

const NON_ALPHANUMERIC = /[^A-Za-z0-9]/g;
/** The same character class without the `g` flag, so `.test()` is stateless — a global regex carries `lastIndex` between calls and would return alternating results. */
const NON_ALPHANUMERIC_CHARACTER = /[^A-Za-z0-9]/;

/** The wildcard tokens a pattern may contain. Longest first, so `**` is never mistaken for two `*`. */
const WILDCARD_TOKENS = ["**", "*", "?"] as const;

/** Encodes one real, fully-literal path into the directory name Claude Code would give it under `~/.claude/projects/`. */
export function encodeProjectPath(realPath: string): string {
  return realPath.replace(NON_ALPHANUMERIC, "-");
}

/** One piece of a pattern split on its wildcard tokens: either a literal run to encode, or a wildcard to leave alone. */
export interface PatternFragment {
  readonly kind: "literal" | "wildcard";
  readonly text: string;
}

/**
 * Splits a pattern into alternating literal runs and wildcard tokens. Encoding the whole pattern string in one pass would turn `*` into `-` along with everything else, silently converting a glob into a literal that matches nothing.
 */
export function splitOnWildcards(pattern: string): PatternFragment[] {
  const fragments: PatternFragment[] = [];
  let literal = "";
  let index = 0;

  while (index < pattern.length) {
    const token = WILDCARD_TOKENS.find((candidate) => pattern.startsWith(candidate, index));
    if (token === undefined) {
      literal += pattern.charAt(index);
      index += 1;
      continue;
    }
    if (literal !== "") {
      fragments.push({ kind: "literal", text: literal });
      literal = "";
    }
    fragments.push({ kind: "wildcard", text: token });
    index += token.length;
  }
  if (literal !== "") {
    fragments.push({ kind: "literal", text: literal });
  }
  return fragments;
}

/** Raised when a `history/projects/` pattern's path fragment is neither `~`-rooted nor absolute, so there is no real path to encode. */
export class UnrootedProjectPathError extends CliError {
  constructor(readonly fragment: string) {
    super(
      `"${fragment}" is not a rooted path. Everything written after the "history/projects/" prefix is a real ` +
        `absolute working directory (optionally globbed), so it must start with "/" or "~/" — a bare relative ` +
        `path has nothing to encode against.`,
    );
    this.name = "UnrootedProjectPathError";
  }
}

/** Expands a leading `~` to the given home directory. A `~` anywhere else in the path is an ordinary character. */
export function expandHome(fragment: string, home: string): string {
  if (fragment === "~") {
    return home;
  }
  if (fragment.startsWith("~/")) {
    return home + fragment.slice(1);
  }
  return fragment;
}

/**
 * Encodes a possibly-globbed real path into a pattern that matches Claude Code's own `~/.claude/projects/` directory names.
 *
 * Order matters and is fixed: expand `~` to the real home first (encoding `~` would turn it into `-` and lose the reference), reject anything not home-or-root-rooted, then split on wildcard tokens and encode only the literal runs.
 */
export function encodeProjectPattern(fragment: string, options: Readonly<{ home: string }>): string {
  const expanded = expandHome(fragment, options.home);
  if (!expanded.startsWith("/")) {
    throw new UnrootedProjectPathError(fragment);
  }
  return splitOnWildcards(expanded)
    .map((piece) => (piece.kind === "literal" ? encodeProjectPath(piece.text) : piece.text))
    .join("");
}

/** Why a pattern's encoded form might not identify the real path its author had in mind. */
export const ENCODING_AMBIGUITY_REASONS = [
  /** The literal portion contains a character other than `/` that encodes to `-`, so a sibling path differing only in that character encodes identically. */
  "lossy-characters",
  /** Two different patterns in the same configuration encode to the identical form. */
  "collides-with-sibling-pattern",
] as const;
type EncodingAmbiguityReason = (typeof ENCODING_AMBIGUITY_REASONS)[number];

/** One reported ambiguity in a `history/projects/` pattern. */
export interface EncodingAmbiguity {
  readonly fragment: string;
  readonly encoded: string;
  readonly reason: EncodingAmbiguityReason;
  readonly detail: string;
}

/** The characters, other than `/`, that a real path can contain and that the encoding collapses to `-`. */
function lossyCharacters(literal: string): string[] {
  const found = new Set<string>();
  for (const character of literal) {
    if (character !== "/" && NON_ALPHANUMERIC_CHARACTER.test(character)) {
      found.add(character);
    }
  }
  return [...found];
}

/**
 * Reports, for a set of `history/projects/` path fragments, every case where the encoded form could plausibly correspond to more than one real path.
 *
 * Two signals, both actionable:
 *
 * - `lossy-characters` — the fragment's literal portion contains a character besides `/` that encodes to `-`. Because encoding is many-to-one, a sibling path with that character replaced by a separator (or vice versa) produces the identical name, so this pattern may match a directory belonging to a different real path.
 * - `collides-with-sibling-pattern` — two distinct fragments in the same configuration encode identically, which proves a collision outright rather than merely suggesting one.
 *
 * When `existingNames` is supplied, `detail` also names how many real project directories the encoded form currently matches, so the report says what actually happened rather than only what could.
 */
export function detectEncodingAmbiguity(
  fragments: readonly string[],
  options: { home: string; existingNames?: readonly string[] },
): EncodingAmbiguity[] {
  const ambiguities: EncodingAmbiguity[] = [];
  const encodedByFragment = new Map<string, string>();

  for (const fragment of fragments) {
    let encoded: string;
    try {
      encoded = encodeProjectPattern(fragment, { home: options.home });
    } catch {
      continue;
    }
    encodedByFragment.set(fragment, encoded);

    const expanded = expandHome(fragment, options.home);
    const literalText = splitOnWildcards(expanded)
      .filter((piece) => piece.kind === "literal")
      .map((piece) => piece.text)
      .join("");
    const lossy = lossyCharacters(literalText);
    if (lossy.length > 0) {
      const matched = options.existingNames?.filter((name) => name === encoded).length;
      const suffix =
        matched === undefined ? "" : ` It currently matches ${String(matched)} existing project directory name(s).`;
      ambiguities.push({
        fragment,
        encoded,
        reason: "lossy-characters",
        detail:
          `The literal portion contains ${lossy.map((character) => JSON.stringify(character)).join(", ")}, which the ` +
          `encoding collapses to "-" exactly as it collapses "/". A different real path differing only in those ` +
          `characters would encode to the same name.${suffix}`,
      });
    }
  }

  const byEncoded = new Map<string, string[]>();
  for (const [fragment, encoded] of encodedByFragment) {
    const group = byEncoded.get(encoded);
    if (group === undefined) {
      byEncoded.set(encoded, [fragment]);
    } else {
      group.push(fragment);
    }
  }
  for (const [encoded, group] of byEncoded) {
    if (group.length < 2) {
      continue;
    }
    for (const fragment of group) {
      ambiguities.push({
        fragment,
        encoded,
        reason: "collides-with-sibling-pattern",
        detail: `Encodes identically to ${group
          .filter((other) => other !== fragment)
          .map((other) => JSON.stringify(other))
          .join(", ")}.`,
      });
    }
  }

  return ambiguities;
}

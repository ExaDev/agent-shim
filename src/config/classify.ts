import picomatch from "picomatch";

import categoriesDefaultJson from "./categories.default.json";
import {
  CATEGORY_NAMES,
  CategoryClassificationOverlaySchema,
  CategoryClassificationSchema,
  type CategoryClassification,
  type CategoryClassificationOverlay,
  type CategoryName,
} from "./schema";
import { readJson } from "./store";
import type { LayoutPaths } from "../paths";

/** Which map a classification pattern came from. A `local` pattern is an answer the user gave to an "unclassified entry" prompt; a `default` pattern is shipped with the tool. */
type ClassificationSource = "default" | "local";

/** One compiled classification pattern: which category it assigns, where it came from, and how specific it is. */
export interface ClassificationPattern {
  readonly pattern: string;
  readonly category: CategoryName;
  readonly source: ClassificationSource;
  /** True when the pattern contains no glob metacharacter, so it can only ever match one literal name. */
  readonly isExact: boolean;
  /** Position of the pattern within its own category list, used only as the final deterministic tie-break. */
  readonly ordinal: number;
  readonly matches: (name: string) => boolean;
}

/** The outcome of classifying a set of real top-level `~/.claude` entry names. */
export interface ClassifyResult {
  /** Every input name mapped to its category, or to null when nothing in either map recognises it. */
  readonly classification: ReadonlyMap<string, CategoryName | null>;
  /** The input names that nothing recognised, in input order. These are the names `claude-use configure` prompts about. */
  readonly unclassified: readonly string[];
  /** For each classified name, the pattern that decided it — used by `claude-use check` to explain a classification. */
  readonly decidedBy: ReadonlyMap<string, ClassificationPattern>;
}

const GLOB_METACHARACTERS = /[*?[\]{}!()]/;

/** True when `pattern` contains no glob metacharacter, so it matches exactly one literal name. */
export function isExactPattern(pattern: string): boolean {
  return !GLOB_METACHARACTERS.test(pattern);
}

function compile(pattern: string, category: CategoryName, source: ClassificationSource, ordinal: number): ClassificationPattern {
  const isExact = isExactPattern(pattern);
  // Deliberately case-sensitive (`nocase: false`) regardless of the host filesystem's own case behaviour, so a config resolves identically on a case-insensitive APFS volume and a case-sensitive one. `dot: true` so a leading-dot entry like `.credentials.json` is matchable by a glob such as `.git*`.
  const matcher = picomatch(pattern, { dot: true, nocase: false });
  return {
    pattern,
    category,
    source,
    isExact,
    ordinal,
    matches: isExact ? (name: string) => name === pattern : (name: string) => matcher(name),
  };
}

/** Compiles a shipped classification map plus an optional local overlay into one flat, ranked pattern list. */
export function compileClassificationPatterns(
  defaults: CategoryClassification,
  overlay?: CategoryClassificationOverlay,
): ClassificationPattern[] {
  const compiled: ClassificationPattern[] = [];
  let ordinal = 0;
  for (const category of CATEGORY_NAMES) {
    for (const pattern of defaults[category]) {
      compiled.push(compile(pattern, category, "default", ordinal));
      ordinal += 1;
    }
  }
  if (overlay !== undefined) {
    for (const category of CATEGORY_NAMES) {
      for (const pattern of overlay[category] ?? []) {
        compiled.push(compile(pattern, category, "local", ordinal));
        ordinal += 1;
      }
    }
  }
  return compiled;
}

/**
 * Ranks two matching classification patterns. Higher wins. The order is exactness first, then source:
 *
 * 1. An exact literal beats a glob, regardless of which map it came from. This is the safe direction — a shipped exact `.credentials.json` (secret) can never be reclassified out from under itself by a broad local glob, while a local *exact* answer still wins over a shipped *glob*, which is the case the local overlay actually exists to serve (`claude-use configure` only ever writes exact names).
 * 2. A local overlay pattern beats a shipped default pattern of equal exactness.
 * 3. Longest pattern wins (a longer glob is the more specific one).
 * 4. Later ordinal wins, so the comparison is total and never iteration-order-dependent.
 */
function compareClassificationPatterns(a: ClassificationPattern, b: ClassificationPattern): number {
  if (a.isExact !== b.isExact) {
    return a.isExact ? 1 : -1;
  }
  if (a.source !== b.source) {
    return a.source === "local" ? 1 : -1;
  }
  if (a.pattern.length !== b.pattern.length) {
    return a.pattern.length - b.pattern.length;
  }
  return a.ordinal - b.ordinal;
}


/** The classification input every real call site needs: the shipped defaults plus this user's own local overlay, when one exists. */
export interface LoadedClassification {
  readonly defaults: CategoryClassification;
  readonly overlay?: CategoryClassificationOverlay;
}

/**
 * Loads the classification input `classifyEntries` needs — the shipped `categories.default.json`, plus `categories.local.json` when the user has answered at least one "unclassified entry" prompt.
 *
 * Real-wired convenience over reading and validating the two files. Every command that classifies anything (`cli.ts`'s farm runtime, `check`, `configure`, `identity resolve-conflicts`) was independently repeating this exact pair of `readJson`/`.parse()` calls before this existed; centralising it here means the four command files stay thin call sites rather than each holding its own copy of a validation step that never varies between them.
 */
export function loadClassification(paths: LayoutPaths): LoadedClassification {
  const overlay = readJson(paths.categoriesLocalFile, CategoryClassificationOverlaySchema);
  return {
    defaults: CategoryClassificationSchema.parse(categoriesDefaultJson),
    ...(overlay === undefined ? {} : { overlay }),
  };
}

/**
 * Classifies a list of real top-level `~/.claude` entry names against the shipped category map plus an optional local overlay.
 *
 * An unrecognised name maps to `null` rather than being silently assumed safe or silently dropped: the resolver treats it as not-shared and reports it, and `claude-use configure` prompts for an answer that is then written to the local overlay.
 */
export function classifyEntries(
  names: readonly string[],
  options: { defaults: CategoryClassification; overlay?: CategoryClassificationOverlay },
): ClassifyResult {
  const patterns = compileClassificationPatterns(options.defaults, options.overlay);
  const classification = new Map<string, CategoryName | null>();
  const decidedBy = new Map<string, ClassificationPattern>();
  const unclassified: string[] = [];

  for (const name of names) {
    let winner: ClassificationPattern | undefined;
    for (const candidate of patterns) {
      if (!candidate.matches(name)) {
        continue;
      }
      if (winner === undefined || compareClassificationPatterns(candidate, winner) > 0) {
        winner = candidate;
      }
    }
    if (winner === undefined) {
      classification.set(name, null);
      unclassified.push(name);
      continue;
    }
    classification.set(name, winner.category);
    decidedBy.set(name, winner);
  }

  return { classification, unclassified, decidedBy };
}

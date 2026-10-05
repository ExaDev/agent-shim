import type {
  CategoryMap,
  CategoryName,
  Entries,
  LaunchFlags,
  OverridableCategory,
  WhenCondition,
} from "../config/schema";

/** A layer's index in the assembled cascade. Strictly ascending in composition order: a higher id was composed later and therefore wins on the comparator's first rank. */
export type LayerId = number;

/** Where a cascade layer came from. Purely descriptive — precedence is carried by `LayerId`, never by kind. */
export const LAYER_KINDS = [
  "global-config",
  "config-profile",
  "directory-rule",
  "portable",
  "portable-local",
  "cli-override",
] as const;
type LayerKind = (typeof LAYER_KINDS)[number];

/** One composable layer of the cascade: its own category toggles and entries overrides, plus the entries key order captured at load time. */
export interface Layer {
  readonly id: LayerId;
  readonly kind: LayerKind;
  /** Human-readable origin (a file path, or a profile name) used by `agent-shim check` to explain a decision. */
  readonly source: string;
  readonly categories?: CategoryMap;
  readonly entries?: Entries;
  /** The entries object's own key insertion order, from `src/config/load.ts`. Falls back to `Object.keys(entries)` when absent. */
  readonly entryOrder?: readonly string[];
  readonly launch?: LaunchFlags;
}

/** Facts about one entry under `~/.claude`, relative to `~/.claude` itself. */
export interface EntryFact {
  /** Path relative to `~/.claude`, forward-slash separated, never leading or trailing slash. */
  readonly relPath: string;
  readonly isDirectory: boolean;
  /** True when the entry is itself a symlink (including the relative, tree-escaping symlinks that already exist inside a real `~/.claude`). */
  readonly isSymlink: boolean;
  /** The entry's own mtime. */
  readonly mtimeMs: number;
  /** The most recent mtime anywhere in this entry's subtree — its own mtime for a plain file. A directory-scoped `newerThan` must read this, never the directory's own inode mtime, which does not change when a file three levels down is rewritten. */
  readonly latestMtimeMs: number;
  /** The entry's own size. */
  readonly sizeBytes: number;
  /** The recursive total size of this entry's subtree — its own size for a plain file. A directory-scoped `maxSizeBytes` must read this, never the directory's own ~4KB inode size. */
  readonly totalSizeBytes: number;
}

/**
 * Every fact the resolver needs, injected rather than read. Nothing in `src/resolve/` ever touches a real filesystem, git repository, clock, or environment: something else builds this structure and hands it over, which is what makes the whole resolver unit-testable with fake mtimes, a fake branch, and a fake environment.
 */
export interface EntryFacts {
  readonly nowMs: number;
  /** The real home directory, used to expand `~` in `history/projects/` patterns. */
  readonly home: string;
  /** The canonical `~/.claude` directory every relative path in `entries` is relative to. */
  readonly claudeHome: string;
  /** The working directory the cascade was resolved for. */
  readonly cwd: string;
  /** The git branch checked out at `cwd`, or undefined when `cwd` is not in a repository. */
  readonly branch?: string;
  /** True when `cwd`'s repository is in detached-HEAD state, in which case no `branch` condition can match. */
  readonly branchDetached?: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Every entry under `~/.claude`, keyed by its path relative to `~/.claude`. Directories appear alongside their descendants. */
  readonly entries: ReadonlyMap<string, EntryFact>;
}

/** A single entries override, compiled into the form the resolver actually matches against. */
export interface CompiledRule {
  /** The key exactly as written in its source file, for diagnostics. */
  readonly rawKey: string;
  /** The category prefix the key declared. Cross-checked against the real classification of every path it matches. */
  readonly declaredCategory: CategoryName;
  /** The key with its category prefix stripped and (under `history/projects/`) its path fragment encoded — a pattern over paths relative to `~/.claude`. Two differently-spelled but equivalent keys share one canonical pattern and therefore collapse to one rule. */
  readonly canonicalPattern: string;
  readonly value: boolean;
  readonly when?: WhenCondition;
  readonly layer: LayerId;
  /** The key's position within its own layer's entries object, used only by the comparator's final same-layer tie-break. */
  readonly ordinal: number;
  /** True when the canonical pattern contains no glob metacharacter. */
  readonly isExact: boolean;
  /** The pattern's leading run of literal (non-wildcard) characters. */
  readonly literalPrefix: string;
  /** How many `/`-separated segments the canonical pattern has. */
  readonly segmentCount: number;
  /** Matches the pattern itself and everything beneath it, so a rule on `skills` covers `skills/commit/SKILL.md`. */
  readonly matches: (relPath: string) => boolean;
}

/** How a decision was reached, for `agent-shim check`'s "which layer decided this" output. */
export const DECISION_VIAS = [
  /** The unconditional pre-cascade floor: the path's real classification is `secret`. */
  "secret-floor",
  /** Nothing in the classification map recognises the path's top-level entry. */
  "unclassified",
  /** An entries rule matched and its condition (if any) held. */
  "entry-rule",
  /** No entries rule survived; a layer's category toggle decided it. */
  "category-override",
  /** No entries rule and no category toggle; the shipped default for the category decided it. */
  "category-default",
] as const;
type DecisionVia = (typeof DECISION_VIAS)[number];

/** One entry's resolved sharing decision plus the reasoning behind it. */
export interface Decision {
  readonly relPath: string;
  readonly shared: boolean;
  readonly via: DecisionVia;
  readonly category: CategoryName | null;
  /** The winning entries rule, when `via` is "entry-rule". */
  readonly rule?: CompiledRule;
  /** Rules that matched but whose `when` condition failed, in descending specificity — each was eliminated and resolution continued to the next candidate. */
  readonly eliminated?: readonly EliminatedRule[];
}

/** A candidate rule that matched the path but was eliminated because its `when` condition did not hold. */
export interface EliminatedRule {
  readonly rule: CompiledRule;
  readonly failed: readonly string[];
}

/** Every diagnostic the resolver can raise. Codes are stable strings so `agent-shim check` and tests can assert on them. */
export const DIAGNOSTIC_CODES = [
  /** A profile's `extends` graph contains a cycle. */
  "EXTENDS_CYCLE",
  /** An `extends` entry names a profile that does not exist. */
  "MISSING_PROFILE",
  /** An entries key was written under the `secret/` prefix. Rejected at compile time — `secret` can never be overridden by any layer. */
  "SECRET_ENTRY_KEY",
  /** An entries key under some other prefix matched a path whose real classification is `secret`. Neutralised at resolve time by the floor check. */
  "SECRET_PATH_NEUTRALISED",
  /** An entries key's declared category prefix disagrees with the real classification of a path it matched. */
  "CATEGORY_PREFIX_MISMATCH",
  /** An entries key is not of the form `<category>/<path>`. The schema rejects these at parse time; this fires only for a layer built in code. */
  "MALFORMED_ENTRY_KEY",
  /** An earlier layer's exact key lost to a later layer's glob. Correct per the comparator, but worth surfacing rather than resolving silently. */
  "EXACT_ENTRY_OVERRIDDEN_BY_LATER_GLOB",
  /** A `history/projects/` pattern's encoded form could plausibly correspond to more than one real path. */
  "AMBIGUOUS_PROJECT_ENCODING",
  /** A `history/projects/` key's path fragment is neither home-rooted nor absolute, so it cannot be encoded. */
  "UNROOTED_PROJECT_PATH",
  /** A `~/.claude` entry nothing in the classification map recognises. */
  "UNCLASSIFIED_ENTRY",
  /** An empty `when: {}` object, which is vacuously true and therefore has no effect. */
  "EMPTY_WHEN",
  /** The previous farm's manifest is missing or unreadable, so reconciliation ran in conservative mode. */
  "FARM_MANIFEST_MISSING",
  /** A file Claude Code wrote into a materialised farm directory differs from the canonical copy of the same path. */
  "RECONCILE_CONFLICT",
  /** Reconciliation proposed adopting a path whose real classification is `secret`. Refused: the secret floor applies to data moving into `~/.claude` exactly as it applies to data moving out. */
  "RECONCILE_SECRET_BLOCKED",
  /** A previous launch was interrupted mid-swap and this launch completed or undid the half-finished work. */
  "FARM_SWAP_RECOVERED",
  /** A superseded farm could not be discarded because it still held data the new farm has its own entry for, so it was left on disk for the user to look at. */
  "FARM_PREVIOUS_RETAINED",
] as const;
type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** Severity of a diagnostic. An `error` means a configuration layer asked for something the tool refused to do. */
export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "info"] as const;
type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/** One structured diagnostic. */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** The config key, profile name, or entry path the diagnostic concerns. */
  readonly subject?: string;
  /** The layer that raised it, when the diagnostic is attributable to one. */
  readonly layer?: LayerId;
}

/** The flattened result of cascade phase one. */
export interface FlattenedCascade {
  /** The last value each overridable category was set to across every layer. Categories no layer touched are absent. */
  readonly categories: ReadonlyMap<OverridableCategory, boolean>;
  /** One compiled rule per canonical pattern — later layers having already overwritten earlier ones for identical patterns. */
  readonly rules: ReadonlyMap<string, CompiledRule>;
  /** Launch flags, last layer wins per field. */
  readonly launch: LaunchFlags;
  readonly diagnostics: readonly Diagnostic[];
}

import type { Diagnostic } from "./types";

/** The manifest the farm builder writes into each scratch tree before the atomic swap. */
export interface FarmManifest {
  readonly version: 1;
  readonly builtAtMs: number;
  readonly identity: string;
  readonly configProfile?: string;
  readonly cwd: string;
  readonly claudeHome: string;
  /** Directories the previous resync built itself. Without this list, a directory the farm materialised and a directory Claude Code created are indistinguishable on disk — both are real, both contain real children. */
  readonly materialised: readonly string[];
  readonly links: readonly { readonly rel: string; readonly target: string }[];
}

/** One node of a directory listing, relative to the tree's own root. */
export interface ListingEntry {
  /** Path relative to the tree root, forward-slash separated. */
  readonly rel: string;
  readonly kind: "dir" | "file" | "symlink";
  /** A content hash for a file, used to recognise data that has already been adopted. Absent for directories and symlinks. */
  readonly contentHash?: string;
}

/** What to do about one path found in the old farm. */
export type ReconcileAction =
  /** New data Claude Code wrote that the canonical tree does not have. Copy it to `to`. */
  | { readonly kind: "adopt"; readonly rel: string; readonly reason: "absent-from-canonical" }
  /** New data whose canonical counterpart exists but differs. The canonical copy is authoritative; the farm copy is preserved alongside it for the user to reconcile. */
  | { readonly kind: "adopt-conflict"; readonly rel: string }
  /** Nothing to do, with the reason recorded so `agent-shim check` can explain a no-op. */
  | { readonly kind: "skip"; readonly rel: string; readonly reason: SkipReason };

/** Why a path in the old farm needs no action. */
type SkipReason =
  /** A symlink the previous resync placed. It is a view of the canonical tree, so there is nothing to write back. */
  | "is-symlink"
  /** A directory the previous resync materialised. Not new data itself; its children are examined individually. */
  | "tracked-materialised-dir"
  /** Real data whose canonical counterpart already holds identical content — already adopted, possibly by an earlier run that then crashed before the swap. */
  | "identical-content";

/** The result of planning a reconciliation pass. */
export interface ReconciliationPlan {
  readonly actions: readonly ReconcileAction[];
  readonly diagnostics: readonly Diagnostic[];
  /** True when the manifest was missing or unusable and every real directory in the farm was treated as materialised. */
  readonly conservative: boolean;
}

/** Everything the reconciliation planner reads. It performs no I/O of its own — the launcher executes the actions it returns. */
export interface ReconcileParams {
  /** The previous resync's manifest, or undefined when it is missing or failed to parse. */
  readonly manifest?: FarmManifest;
  /** A flat listing of the old, still-live farm. */
  readonly farmListing: readonly ListingEntry[];
  /** A flat listing of the canonical `~/.claude`. */
  readonly canonicalListing: readonly ListingEntry[];
}

function parentOf(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index === -1 ? "" : rel.slice(0, index);
}

function indexByParent(listing: readonly ListingEntry[]): Map<string, ListingEntry[]> {
  const children = new Map<string, ListingEntry[]>();
  for (const entry of listing) {
    const parent = parentOf(entry.rel);
    const bucket = children.get(parent);
    if (bucket === undefined) {
      children.set(parent, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  for (const bucket of children.values()) {
    bucket.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }
  return children;
}

/**
 * Plans the write-through reconciliation pass that runs before each resync builds its new scratch tree.
 *
 * A materialised directory stops being a live view of `~/.claude` and becomes a locally-built directory of symlinks frozen at resync time. Anything Claude Code writes into it afterwards — a brand-new project subdirectory, a new session file inside an existing one — lands as a real, untracked child: invisible to every other identity, and liable to be read as stale scaffolding and pruned by a later resync. This pass finds that data and copies it back into the canonical `~/.claude`, where it belongs, before anything else happens.
 *
 * The manifest is what makes this possible at all. A directory the farm materialised and a directory Claude Code created look identical on disk, so without the previous resync's own record of what it built, there is no way to tell the two apart. When the manifest is missing or unreadable, the pass falls back to **conservative mode** — every real directory in the farm is treated as materialised, so every real child anywhere becomes an adopt candidate — and reports it. That is deliberately over-eager rather than a silent no-op: over-adopting copies data into the place it was always meant to live, while under-adopting loses it.
 *
 * The pass is deliberately independent of the *new* resolved state. A directory whose new decision is `omit`, or one collapsing back from materialised to a plain symlink, still gets reconciled first — those are precisely the cases where the data would otherwise be discarded, which is the whole reason this exists.
 *
 * It is also idempotent: re-running against the same old farm after a crash mid-resync produces only `skip("identical-content")` for anything the interrupted run already copied across.
 */
export function planReconciliation(params: ReconcileParams): ReconciliationPlan {
  const conservative = params.manifest === undefined;
  const diagnostics: Diagnostic[] = [];
  const actions: ReconcileAction[] = [];

  const farmChildren = indexByParent(params.farmListing);
  const canonicalByRel = new Map(params.canonicalListing.map((entry) => [entry.rel, entry]));

  const materialised = new Set<string>([""]);
  if (params.manifest !== undefined) {
    for (const rel of params.manifest.materialised) {
      materialised.add(rel);
    }
  } else {
    for (const entry of params.farmListing) {
      if (entry.kind === "dir") {
        materialised.add(entry.rel);
      }
    }
    diagnostics.push({
      code: "FARM_MANIFEST_MISSING",
      severity: "warning",
      message:
        "The previous farm's manifest is missing or unreadable, so there is no record of which directories the farm " +
        "built itself. Every real directory in the farm was treated as materialised and every real child examined for " +
        "adoption. This over-adopts rather than risking data Claude Code wrote being discarded.",
    });
  }

  const visit = (dir: string): void => {
    for (const child of farmChildren.get(dir) ?? []) {
      if (child.kind === "symlink") {
        actions.push({ kind: "skip", rel: child.rel, reason: "is-symlink" });
        continue;
      }

      if (child.kind === "dir" && materialised.has(child.rel)) {
        actions.push({ kind: "skip", rel: child.rel, reason: "tracked-materialised-dir" });
        visit(child.rel);
        continue;
      }

      if (child.kind === "dir") {
        const grandchildren = farmChildren.get(child.rel) ?? [];
        if (grandchildren.length === 0) {
          if (canonicalByRel.has(child.rel)) {
            actions.push({ kind: "skip", rel: child.rel, reason: "identical-content" });
          } else {
            actions.push({ kind: "adopt", rel: child.rel, reason: "absent-from-canonical" });
          }
          continue;
        }
        // A real directory Claude Code created: its own existence is implied by its contents, so no action is emitted for the directory itself — descending emits one action per leaf, which is what keeps the pass idempotent.
        visit(child.rel);
        continue;
      }

      const canonical = canonicalByRel.get(child.rel);
      if (canonical === undefined) {
        actions.push({ kind: "adopt", rel: child.rel, reason: "absent-from-canonical" });
        continue;
      }
      if (canonical.contentHash !== undefined && canonical.contentHash === child.contentHash) {
        actions.push({ kind: "skip", rel: child.rel, reason: "identical-content" });
        continue;
      }
      actions.push({ kind: "adopt-conflict", rel: child.rel });
      diagnostics.push({
        code: "RECONCILE_CONFLICT",
        severity: "warning",
        message:
          `"${child.rel}" exists both in the farm and in the canonical ~/.claude with different content. The canonical ` +
          `copy is left authoritative and the farm's copy is preserved alongside it rather than either being discarded.`,
        subject: child.rel,
      });
    }
  };

  visit("");

  return { actions, diagnostics, conservative };
}

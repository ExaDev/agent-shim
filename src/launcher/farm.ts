import path from "node:path";
import { z } from "zod";

import { classifyEntries } from "../config/classify";
import type { CategoryClassification, CategoryClassificationOverlay } from "../config/schema";
import { planReconciliation, type FarmManifest, type ListingEntry, type ReconcileAction } from "../resolve/reconcile";
import { resolveDecisions, type ResolvedState } from "../resolve/pipeline";
import type { CascadeInput } from "../resolve/walk";
import type { Diagnostic, EntryFact, EntryFacts } from "../resolve/types";
import type { FarmPlan } from "../resolve/plan";
import { acquireIdentityLock, type IdentityLock } from "./lock";
import type { FarmFs } from "./ports";

/** The manifest file each farm carries at its own root, recording what that resync built. Named distinctly from anything Claude Code itself writes into a config directory. */
export const FARM_MANIFEST_FILENAME = ".claude-use-farm.json";

/**
 * The manifest as it is validated coming back off disk.
 *
 * A manifest that fails this parse is treated exactly like a missing one — reconciliation falls back to conservative mode and reports it, rather than trusting a half-written record of what the farm contains. That degradation is the whole reason this is a parse rather than a cast.
 */
const FarmManifestSchema = z.strictObject({
  version: z.literal(1),
  builtAtMs: z.number(),
  identity: z.string(),
  configProfile: z.string().optional(),
  cwd: z.string(),
  claudeHome: z.string(),
  materialised: z.array(z.string()),
  links: z.array(z.strictObject({ rel: z.string(), target: z.string() })),
});

/** Reads and validates the manifest at a farm root, or undefined when it is missing, unparseable, or does not validate. */
export function readFarmManifest(fs: FarmFs, farmRoot: string): FarmManifest | undefined {
  const raw = fs.readFileUtf8(path.join(farmRoot, FARM_MANIFEST_FILENAME));
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = FarmManifestSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Everything `buildEntryFacts` needs. Everything except the tree itself is injected, so the fact manifest is reproducible from a fake filesystem, a fake clock, and a fake branch. */
export interface BuildEntryFactsParams {
  readonly fs: FarmFs;
  readonly claudeHome: string;
  readonly home: string;
  readonly cwd: string;
  readonly nowMs: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly branch?: string;
  readonly branchDetached?: boolean;
}

/**
 * Walks the canonical `~/.claude` and builds the `EntryFacts` manifest the pure resolver consumes.
 *
 * Two properties matter more than the walk itself. Symlinks are never followed: a directory symlink escaping the tree is one entry, not a subtree, which keeps the walk finite and matches how the farm links such an entry back. And every directory's `latestMtimeMs`/`totalSizeBytes` aggregate over its whole subtree rather than reporting its own inode, because a directory-scoped `newerThan` or `maxSizeBytes` condition asks about the data inside the directory — a directory's own mtime does not move when a file three levels down is rewritten.
 */
export function buildEntryFacts(params: BuildEntryFactsParams): EntryFacts {
  const entries = new Map<string, EntryFact>();

  const visit = (rel: string): { latestMtimeMs: number; totalSizeBytes: number } | undefined => {
    const absolute = path.join(params.claudeHome, rel);
    const stat = params.fs.lstat(absolute);
    if (stat === undefined) {
      return undefined;
    }
    const isDirectory = stat.kind === "dir";
    let latestMtimeMs = stat.mtimeMs;
    let totalSizeBytes = stat.sizeBytes;

    if (isDirectory) {
      for (const name of [...params.fs.readdir(absolute)].sort()) {
        const child = visit(`${rel}/${name}`);
        if (child !== undefined) {
          latestMtimeMs = Math.max(latestMtimeMs, child.latestMtimeMs);
          totalSizeBytes += child.totalSizeBytes;
        }
      }
    }

    entries.set(rel, {
      relPath: rel,
      isDirectory,
      isSymlink: stat.kind === "symlink",
      mtimeMs: stat.mtimeMs,
      latestMtimeMs,
      sizeBytes: stat.sizeBytes,
      totalSizeBytes,
    });
    return { latestMtimeMs, totalSizeBytes };
  };

  for (const name of [...params.fs.readdir(params.claudeHome)].sort()) {
    visit(name);
  }

  return {
    nowMs: params.nowMs,
    home: params.home,
    claudeHome: params.claudeHome,
    cwd: params.cwd,
    ...(params.branch === undefined ? {} : { branch: params.branch }),
    ...(params.branchDetached === undefined ? {} : { branchDetached: params.branchDetached }),
    env: params.env,
    entries,
  };
}

// A pure recursive listing, returning each level's entries rather than mutating a shared out-parameter (the latter was this function's original shape, but that requires a non-readonly array parameter -- exadev/prefer-readonly-array-param wants every array parameter readonly unconditionally, forcing exactly this kind of in-place-mutation pattern to be reconsidered rather than merely annotated around. This also fixed a genuine pre-existing bug: the old out-parameter was typed readonly ListingEntry[] while every caller passed a real mutable array for it to push into -- a real TS2339 tsc --noEmit was masking behind a stale tsconfig.tsbuildinfo from incremental compilation).
function listSubtree(fs: FarmFs, root: string, rel: string): ListingEntry[] {
  const absolute = path.join(root, rel);
  const stat = fs.lstat(absolute);
  if (stat === undefined) {
    return [];
  }
  if (stat.kind === "symlink") {
    return [{ rel, kind: "symlink" }];
  }
  if (stat.kind === "dir") {
    const children = [...fs.readdir(absolute)].sort().flatMap((name) => listSubtree(fs, root, `${rel}/${name}`));
    return [{ rel, kind: "dir" }, ...children];
  }
  const contentHash = fs.hashFile(absolute);
  return [{ rel, kind: "file", ...(contentHash === undefined ? {} : { contentHash }) }];
}

/** Drops any scope root that already sits beneath another, so a nested materialised directory is not walked twice. */
function topLevelScopeRoots(roots: readonly string[]): string[] {
  const sorted = [...new Set(roots)].sort();
  const kept: string[] = [];
  for (const root of sorted) {
    if (kept.some((existing) => root === existing || root.startsWith(`${existing}/`))) {
      continue;
    }
    kept.push(root);
  }
  return kept;
}

/**
 * Decides which parts of the old farm reconciliation is allowed to look at.
 *
 * With a manifest, the answer is exactly the directories that resync materialised — nothing else in the farm can hold data that belongs in the canonical tree. That precision is load-bearing rather than an optimisation: a top-level directory Claude Code created in its own config directory because that category was *not* shared (a `todos/` under an identity that shares no history, say) is identity-local data, and copying it into the canonical `~/.claude` would merge one identity's private history into the tree every other identity reads. It stays local, and the swap carries it across instead.
 *
 * Without a usable manifest there is no way to tell the two apart, so every top-level real directory becomes a scope root and `planReconciliation` runs in its conservative mode. That over-adopts, which the swap then compensates for by retaining the superseded farm rather than discarding it.
 */
function reconciliationScope(fs: FarmFs, farmRoot: string, manifest: FarmManifest | undefined): string[] {
  if (manifest !== undefined) {
    return topLevelScopeRoots(manifest.materialised);
  }
  return [...fs.readdir(farmRoot)]
    .filter((name) => name !== FARM_MANIFEST_FILENAME && fs.lstat(path.join(farmRoot, name))?.kind === "dir")
    .sort();
}

/** Lists the old farm's reconcilable subtrees, flat and hashed, ready for `planReconciliation`. */
function collectFarmListing(fs: FarmFs, farmRoot: string, scopeRoots: readonly string[]): ListingEntry[] {
  return scopeRoots.flatMap((root) => listSubtree(fs, farmRoot, root));
}

/**
 * Lists the canonical counterparts of exactly the paths the farm listing contains.
 *
 * Deliberately not a full walk of `~/.claude`: `planReconciliation` only ever looks a farm path up by name, and hashing every session transcript in a real history directory to answer questions about a handful of files would cost more than the whole resync.
 */
function collectCanonicalCounterparts(fs: FarmFs, claudeHome: string, farmListing: readonly ListingEntry[]): ListingEntry[] {
  const out: ListingEntry[] = [];
  for (const entry of farmListing) {
    const absolute = path.join(claudeHome, entry.rel);
    const stat = fs.lstat(absolute);
    if (stat === undefined) {
      continue;
    }
    if (stat.kind === "file") {
      const contentHash = fs.hashFile(absolute);
      out.push({ rel: entry.rel, kind: "file", ...(contentHash === undefined ? {} : { contentHash }) });
      continue;
    }
    out.push({ rel: entry.rel, kind: stat.kind });
  }
  return out;
}

/** Inputs to `carryOver`. */
export interface CarryOverParams {
  readonly fs: FarmFs;
  /** The superseded farm, already renamed aside. */
  readonly previousRoot: string;
  /** The new farm, already swapped into place. */
  readonly farmRoot: string;
  /**
   * When given, a colliding name classified as `runtime` is resolved automatically rather than reported — see `CarryOverResult.autoResolved` for why that is always safe. Optional because a caller with no classification loaded (there is none, today) should get the old, fully-manual behaviour rather than a crash; every real call site passes it.
   */
  readonly classification?: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
}

/** What `carryOver` moved, resolved on its own, and could not. */
export interface CarryOverResult {
  /** Top-level names moved from the superseded farm into the new one. */
  readonly carried: readonly string[];
  /** Top-level names that collided but were resolved automatically because their category is `runtime` — see the doc comment on `carryOver` for why discarding the old copy is always safe here. */
  readonly autoResolved: readonly string[];
  /** Top-level names left behind because the new farm has its own entry of that name, and resolving them needs a human — everything that collided but was not classified `runtime`. */
  readonly collided: readonly string[];
}

/**
 * Moves an identity's own locally-written state out of a superseded farm and into the new one.
 *
 * This is what makes a whole-directory swap safe at all. The farm root *is* `CLAUDE_CONFIG_DIR`, so it holds more than symlinks: the identity's own `identity.json`, the credentials file Claude Code writes on Linux and Windows, its `.claude.json`, its daemon and runtime state. None of that is shared, none of it is rebuildable, and a swap that simply replaced the directory would destroy all of it.
 *
 * Anything the previous resync built itself is skipped rather than carried: a symlink is a view of the canonical tree with no data of its own, and a directory the manifest records as materialised had its real children adopted into `~/.claude` before the swap ever started. Everything else is real local data and moves across by rename, so a credential file is relocated rather than duplicated — never briefly existing as two copies on disk.
 *
 * A name that exists in both is genuinely ambiguous in general — overwriting the new farm's own entry would discard whatever the resync just decided; overwriting the old one would discard data — so by default it is reported rather than resolved here, and the caller keeps the superseded farm on disk in that case.
 *
 * One category is not ambiguous, though: `runtime`'s own definition (see `config/categories.default.json`'s category table in the README) is specifically "live per-process or per-machine artifacts" — daemon locks, an MCP auth-needed cache, an update-check result — that make no sense being preserved across a swap at all, let alone fought over. When `classification` is given, a colliding name whose category resolves to `runtime` is discarded from the superseded copy and left exactly as the new farm already has it, with no data ever moved: `keep-new` is not a judgement call for this category, it is what the category already means. This needs only the name's *static* classification, never the resolved shared/not-shared decision for the current directory — a `runtime` entry is disposable whether or not this identity currently chooses to share it, so no cascade resolution is needed to make the call.
 *
 * Exported so `launcher/farmResolve.ts` can reuse this exact collision detection (and the same `runtime` auto-resolution) for `claude-use identity resolve`'s interactive pass, rather than a second implementation that could drift from this one.
 */
export function carryOver(params: CarryOverParams): CarryOverResult {
  const manifest = readFarmManifest(params.fs, params.previousRoot);
  const accounted = new Set<string>([FARM_MANIFEST_FILENAME]);
  for (const rel of manifest?.materialised ?? []) {
    const head = rel.split("/")[0];
    if (head !== undefined && head !== "") {
      accounted.add(head);
    }
  }

  const carried: string[] = [];
  const autoResolved: string[] = [];
  const collided: string[] = [];

  for (const name of [...params.fs.readdir(params.previousRoot)].sort()) {
    if (accounted.has(name)) {
      continue;
    }
    const stat = params.fs.lstat(path.join(params.previousRoot, name));
    if (stat === undefined || stat.kind === "symlink") {
      continue;
    }
    if (params.fs.lstat(path.join(params.farmRoot, name)) !== undefined) {
      const category =
        params.classification === undefined
          ? undefined
          : classifyEntries([name], params.classification).classification.get(name);
      if (category === "runtime") {
        params.fs.removeRecursive(path.join(params.previousRoot, name));
        autoResolved.push(name);
        continue;
      }
      collided.push(name);
      continue;
    }
    params.fs.rename(path.join(params.previousRoot, name), path.join(params.farmRoot, name));
    carried.push(name);
  }

  return { carried, autoResolved, collided };
}

/** Inputs to `buildScratchTree`. */
interface BuildScratchTreeParams {
  readonly fs: FarmFs;
  readonly scratchRoot: string;
  readonly plan: FarmPlan;
  readonly manifest: FarmManifest;
}

/**
 * Materialises a farm plan into a scratch directory, manifest included, ready to be swapped into place.
 *
 * The plan already emits parents before children, so a materialised directory always exists before anything is written inside it. The manifest is written last, into the scratch tree itself, which is what lets the next resync tell the directories this build created apart from the ones Claude Code went on to create inside them.
 */
function buildScratchTree(params: BuildScratchTreeParams): void {
  params.fs.mkdirp(params.scratchRoot);
  for (const entry of params.plan.entries) {
    const absolute = path.join(params.scratchRoot, entry.rel);
    if (entry.kind === "link") {
      params.fs.mkdirp(path.dirname(absolute));
      params.fs.symlink(entry.target, absolute);
      continue;
    }
    if (entry.kind === "materialise") {
      params.fs.mkdirp(absolute);
    }
  }
  params.fs.writeFileUtf8(
    path.join(params.scratchRoot, FARM_MANIFEST_FILENAME),
    `${JSON.stringify(params.manifest, null, 2)}\n`,
  );
}

/** Inputs to `swapIn`. */
interface SwapInParams {
  readonly fs: FarmFs;
  readonly farmRoot: string;
  readonly scratchRoot: string;
  /** Where the superseded farm is renamed to. Must be a sibling of `farmRoot` so the rename stays within one filesystem. */
  readonly previousRoot: string;
  readonly classification?: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
}

/** What the swap did. */
interface SwapInResult extends CarryOverResult {
  /** Set when the superseded farm still held data after carry-over and was therefore left on disk rather than discarded. */
  readonly retainedPrevious?: string;
}

/**
 * Puts a freshly built scratch tree in place as the live farm.
 *
 * A single rename cannot do this: `rename(2)` refuses to replace a non-empty directory (`ENOTEMPTY`), and even if it could, the identity's own local state lives inside the directory being replaced. So the swap is two renames — the live farm moves aside to `previousRoot`, then the scratch tree takes its place — followed by carrying the identity's local state across from the superseded copy.
 *
 * Carry-over deliberately happens *after* the swap rather than before it. Doing it first would mean either copying credentials (two copies of a secret on disk, and any write landing in the copy that is about to be discarded) or moving them out of a farm that is still live. Doing it after means the scratch tree never holds unique data at any point, which is what makes an orphaned scratch tree from a crashed run always safe to delete outright — see `recoverInterruptedSwap`.
 *
 * The window in which no directory exists at `farmRoot` is one rename wide. Concurrent *resyncs* cannot observe it at all, because the per-identity lock serialises them; a concurrent `claude` process already running under this identity can, which is inherent to replacing a directory a live process is reading and is why the window is kept to a single syscall.
 */
function swapIn(params: SwapInParams): SwapInResult {
  if (params.fs.lstat(params.farmRoot) === undefined) {
    params.fs.mkdirp(path.dirname(params.farmRoot));
    params.fs.rename(params.scratchRoot, params.farmRoot);
    return { carried: [], autoResolved: [], collided: [] };
  }

  params.fs.rename(params.farmRoot, params.previousRoot);
  params.fs.rename(params.scratchRoot, params.farmRoot);

  const result = carryOver({
    fs: params.fs,
    previousRoot: params.previousRoot,
    farmRoot: params.farmRoot,
    ...(params.classification === undefined ? {} : { classification: params.classification }),
  });
  if (result.collided.length === 0) {
    params.fs.removeRecursive(params.previousRoot);
    return result;
  }
  return { ...result, retainedPrevious: params.previousRoot };
}

/** Inputs to `recoverInterruptedSwap`. */
interface RecoverInterruptedSwapParams {
  readonly fs: FarmFs;
  readonly identitiesDir: string;
  readonly identity: string;
  readonly farmRoot: string;
  readonly classification?: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
}

/** What recovery found and did. */
export interface RecoveryResult {
  /** Abandoned scratch trees removed. */
  readonly removedScratch: readonly string[];
  /** Set when the farm root was missing and a superseded farm was restored into its place. */
  readonly restoredFrom?: string;
  /** Superseded farms whose carry-over was completed and which were then discarded. */
  readonly completed: readonly string[];
  /** Top-level names, across every superseded farm processed, resolved automatically because their category is `runtime` — see `carryOver`'s own doc comment for why that needs no human decision. */
  readonly autoResolved: readonly string[];
  /** Superseded farms left on disk because they still held colliding data a human still needs to decide. */
  readonly retained: readonly string[];
  /** True when recovery changed anything, in which case the farm cannot be assumed to match its own manifest. */
  readonly recovered: boolean;
}

/**
 * Finishes, or undoes, a swap a previous launch was killed in the middle of.
 *
 * The swap has exactly three interruptible points and each leaves a distinguishable trace. A crash while the scratch tree was still being built leaves a `.<identity>.scratch.*` directory, which holds only freshly created symlinks and empty directories — never unique data, by construction — so it is simply removed. A crash between the two renames leaves no farm at all and a `.<identity>.previous.*` directory holding everything: it is renamed back, restoring the identity exactly as it was. A crash after the second rename leaves both a farm and a superseded copy whose local state may not have been carried across yet, so carry-over is re-run and the copy discarded once it is empty of anything unique.
 *
 * Every branch preserves data. Nothing here removes a directory that could still be the only copy of something.
 */
function recoverInterruptedSwap(params: RecoverInterruptedSwapParams): RecoveryResult {
  const scratchPrefix = `.${params.identity}.scratch.`;
  const previousPrefix = `.${params.identity}.previous.`;
  const names = [...params.fs.readdir(params.identitiesDir)].sort();

  const removedScratch: string[] = [];
  for (const name of names.filter((candidate) => candidate.startsWith(scratchPrefix))) {
    params.fs.removeRecursive(path.join(params.identitiesDir, name));
    removedScratch.push(name);
  }

  let previous = names.filter((candidate) => candidate.startsWith(previousPrefix));
  let restoredFrom: string | undefined;
  const first = previous[0];
  if (first !== undefined && params.fs.lstat(params.farmRoot) === undefined) {
    params.fs.rename(path.join(params.identitiesDir, first), params.farmRoot);
    restoredFrom = first;
    previous = previous.slice(1);
  }

  const completed: string[] = [];
  const autoResolved: string[] = [];
  const retained: string[] = [];
  for (const name of previous) {
    const previousRoot = path.join(params.identitiesDir, name);
    const result = carryOver({
      fs: params.fs,
      previousRoot,
      farmRoot: params.farmRoot,
      ...(params.classification === undefined ? {} : { classification: params.classification }),
    });
    autoResolved.push(...result.autoResolved);
    if (result.collided.length === 0) {
      params.fs.removeRecursive(previousRoot);
      completed.push(name);
      continue;
    }
    retained.push(previousRoot);
  }

  return {
    removedScratch,
    ...(restoredFrom === undefined ? {} : { restoredFrom }),
    completed,
    autoResolved,
    retained,
    recovered:
      removedScratch.length > 0 ||
      restoredFrom !== undefined ||
      completed.length > 0 ||
      autoResolved.length > 0 ||
      retained.length > 0,
  };
}

/** Inputs to `recoverFarm`: the lock-taking wrapper around `recoverInterruptedSwap`. */
export interface RecoverFarmParams {
  readonly fs: FarmFs;
  readonly identitiesDir: string;
  readonly identity: string;
  readonly now: () => number;
  readonly lock: ResyncFarmParams["lock"];
  readonly classification?: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
}

/**
 * Runs `recoverInterruptedSwap` under the identity's own lock.
 *
 * This exists as its own entry point because recovery has to happen *before* the identity's `identity.json` is read, not merely before the farm is rebuilt: that file lives inside the farm root, so a crash between the swap's two renames leaves it sitting in a superseded directory where nothing will find it. Reading the identity first would silently launch with its `defaultConfigProfile` and `allowAmbientCredential` unset — the first of which decides what the farm is about to share.
 *
 * `resyncFarm` calls `recoverInterruptedSwap` directly rather than calling this, since it already holds the lock; taking it a second time from the same process would block against itself.
 */
export function recoverFarm(params: RecoverFarmParams): RecoveryResult {
  const farmRoot = path.join(params.identitiesDir, params.identity);
  const lock = acquireIdentityLock({
    identity: params.identity,
    dir: params.identitiesDir,
    fs: params.fs,
    nowMs: params.now,
    pid: params.lock.pid,
    isRunning: params.lock.isRunning,
    sleep: params.lock.sleep,
    ...(params.lock.staleAfterMs === undefined ? {} : { staleAfterMs: params.lock.staleAfterMs }),
    ...(params.lock.retryDelayMs === undefined ? {} : { retryDelayMs: params.lock.retryDelayMs }),
    ...(params.lock.maxAttempts === undefined ? {} : { maxAttempts: params.lock.maxAttempts }),
  });
  try {
    return recoverInterruptedSwap({
      fs: params.fs,
      identitiesDir: params.identitiesDir,
      identity: params.identity,
      farmRoot,
      ...(params.classification === undefined ? {} : { classification: params.classification }),
    });
  } finally {
    lock.release();
  }
}

/** Inputs to `executeReconciliation`. */
interface ExecuteReconciliationParams {
  readonly fs: FarmFs;
  readonly farmRoot: string;
  readonly claudeHome: string;
  readonly actions: readonly ReconcileAction[];
  readonly nowMs: number;
  readonly classification: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
}

/** What adoption actually wrote. */
interface ReconciliationOutcome {
  readonly adopted: readonly string[];
  readonly conflicts: readonly string[];
  readonly blocked: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Performs the adopt actions `planReconciliation` decided on: copies data Claude Code wrote into a materialised farm directory back into the canonical `~/.claude`, where it belongs and where every other view of it can see it.
 *
 * This is the only write in the whole resync that lands outside the farm, and it runs before anything else touches the farm at all — the plan's fixed order exists so the fact manifest is built from a `~/.claude` that already includes this data, making it resolvable in the same resync rather than invisible until the next launch.
 *
 * A conflicting path is never overwritten in either direction: the canonical copy stays authoritative and the farm's differing copy is written alongside it under a suffixed name, so a user can look at both. And the secret floor applies here too — a path classified `secret` is never adopted, because a floor that only governs data leaving `~/.claude` while ignoring data entering it would not be a floor.
 */
function executeReconciliation(params: ExecuteReconciliationParams): ReconciliationOutcome {
  const heads = new Set<string>();
  for (const action of params.actions) {
    if (action.kind === "skip") {
      continue;
    }
    const head = action.rel.split("/")[0];
    if (head !== undefined && head !== "") {
      heads.add(head);
    }
  }
  const classified = classifyEntries([...heads], {
    defaults: params.classification.defaults,
    ...(params.classification.overlay === undefined ? {} : { overlay: params.classification.overlay }),
  });

  const adopted: string[] = [];
  const conflicts: string[] = [];
  const blocked: string[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const action of params.actions) {
    if (action.kind === "skip") {
      continue;
    }
    const head = action.rel.split("/")[0] ?? "";
    if (classified.classification.get(head) === "secret") {
      blocked.push(action.rel);
      diagnostics.push({
        code: "RECONCILE_SECRET_BLOCKED",
        severity: "warning",
        message:
          `"${action.rel}" was found in the farm but was not copied into ~/.claude: its top-level entry "${head}" is ` +
          "classified secret, and no configuration layer or reconciliation pass may move data across that floor.",
        subject: action.rel,
      });
      continue;
    }

    const from = path.join(params.farmRoot, action.rel);
    const canonical = path.join(params.claudeHome, action.rel);
    if (action.kind === "adopt") {
      params.fs.mkdirp(path.dirname(canonical));
      params.fs.copyRecursive(from, canonical);
      adopted.push(action.rel);
      continue;
    }

    const preserved = `${canonical}.farm-conflict-${String(params.nowMs)}`;
    params.fs.mkdirp(path.dirname(canonical));
    params.fs.copyRecursive(from, preserved);
    conflicts.push(action.rel);
  }

  return { adopted, conflicts, blocked, diagnostics };
}

/** Inputs to `resyncFarm`. */
export interface ResyncFarmParams {
  readonly fs: FarmFs;
  /** `~/.claude-use/identities` — the farm root's parent, and where the lock, scratch trees, and superseded farms all live. */
  readonly identitiesDir: string;
  readonly identity: string;
  /** The configuration profile this launch resolved to, recorded in the manifest for `claude-use check`. */
  readonly configProfile?: string;
  /** The canonical `~/.claude` every farm symlink points back into. */
  readonly claudeHome: string;
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly branch?: string;
  readonly branchDetached?: boolean;
  readonly cascade: CascadeInput;
  readonly classification: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
  /** Reads the current time. Called repeatedly while waiting on the lock, then once more to stamp the build. */
  readonly now: () => number;
  /** Distinguishes this resync's scratch and superseded directory names from any other process's. `${pid}.${uuid}` in real use; a fixed string in tests. */
  readonly uniqueSuffix: string;
  readonly lock: {
    readonly pid: number;
    readonly isRunning: (pid: number) => boolean;
    readonly sleep: (ms: number) => void;
    readonly staleAfterMs?: number;
    readonly retryDelayMs?: number;
    readonly maxAttempts?: number;
  };
}

/** The outcome of one resync. */
export interface ResyncFarmResult {
  readonly farmRoot: string;
  /** True when the resolved decision already matched what the farm's own manifest recorded, so nothing was written. */
  readonly noOp: boolean;
  /** The manifest the farm now carries — the newly written one, or the existing one on a no-op. */
  readonly manifest: FarmManifest;
  /** The fully resolved state, including the flattened cascade's launch flags, which the launcher goes on to use. */
  readonly resolved: ResolvedState;
  readonly adopted: readonly string[];
  readonly recovery: RecoveryResult;
  readonly diagnostics: readonly Diagnostic[];
  readonly retainedPrevious?: string;
}

function sameLinks(a: FarmManifest["links"], b: FarmManifest["links"]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((link, index) => {
    const other = b[index];
    if (other === undefined) {
      return false;
    }
    return other.rel === link.rel && other.target === link.target;
  });
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => b[index] === value);
}

/**
 * Whether the farm already reflects the decision that was just resolved.
 *
 * The comparison is over the decision only — which paths are linked where, and which directories are built rather than linked. The manifest's `cwd` and `configProfile` are provenance, recorded for `claude-use check` to explain a farm, and a launch from a sibling directory that resolves to an identical layout is genuinely a no-op even though those fields differ. The cost is that after such a launch those two fields describe the last resync that actually changed something, which is exactly what they mean.
 */
function farmAlreadyMatches(existing: FarmManifest, next: FarmManifest): boolean {
  return (
    existing.identity === next.identity &&
    existing.claudeHome === next.claudeHome &&
    sameStrings(existing.materialised, next.materialised) &&
    sameLinks(existing.links, next.links)
  );
}

/**
 * Brings one identity's farm into line with the cascade resolved for the current directory, and hands back everything the launcher needs to go on and spawn the real binary.
 *
 * The order below is fixed and each step depends on the one before it:
 *
 * 1. Take the per-identity lock, so two sessions under one identity in two directories cannot rewrite the same farm toward two different states at once.
 * 2. Finish or undo any swap a previous launch was killed in the middle of, so everything after this point sees a coherent farm.
 * 3. Read the previous manifest and, guided by it, list the parts of the still-live farm reconciliation is allowed to look at. This step only reads the farm; nothing mutates it.
 * 4. Adopt anything Claude Code wrote into a materialised directory back into the canonical `~/.claude`.
 * 5. **Then** build the fact manifest, from a canonical tree that now includes everything step 4 adopted. Building facts before adoption would make newly adopted data invisible to this resync and only visible on the next launch — the single most important ordering constraint in this module.
 * 6. Resolve the cascade and plan the farm, both of them pure functions over those facts.
 * 7. If the plan matches what the farm's manifest already records and step 4 adopted nothing, stop: no filesystem write happens at all. Launching repeatedly from the same directory with no configuration change is the overwhelmingly common case and it must stay cheap.
 * 8. Otherwise build a scratch tree, write its manifest, and swap it into place.
 * 9. Release the lock — before the real binary is spawned, never held across it.
 */
export function resyncFarm(params: ResyncFarmParams): ResyncFarmResult {
  const farmRoot = path.join(params.identitiesDir, params.identity);
  const lock: IdentityLock = acquireIdentityLock({
    identity: params.identity,
    dir: params.identitiesDir,
    fs: params.fs,
    nowMs: params.now,
    pid: params.lock.pid,
    isRunning: params.lock.isRunning,
    sleep: params.lock.sleep,
    ...(params.lock.staleAfterMs === undefined ? {} : { staleAfterMs: params.lock.staleAfterMs }),
    ...(params.lock.retryDelayMs === undefined ? {} : { retryDelayMs: params.lock.retryDelayMs }),
    ...(params.lock.maxAttempts === undefined ? {} : { maxAttempts: params.lock.maxAttempts }),
  });

  try {
    const recovery = recoverInterruptedSwap({
      fs: params.fs,
      identitiesDir: params.identitiesDir,
      identity: params.identity,
      farmRoot,
      classification: params.classification,
    });

    const previousManifest = readFarmManifest(params.fs, farmRoot);
    const scope = reconciliationScope(params.fs, farmRoot, previousManifest);
    const farmListing = collectFarmListing(params.fs, farmRoot, scope);
    const canonicalListing = collectCanonicalCounterparts(params.fs, params.claudeHome, farmListing);
    // An empty scope means the farm holds no directory this pass is allowed to look at — a first-ever launch, or an identity whose whole farm is plain symlinks. There is nothing to reconcile, and running the planner anyway would report conservative mode on a farm that has never had a manifest to lose.
    const reconciliation =
      scope.length === 0
        ? { actions: [], diagnostics: [], conservative: false }
        : planReconciliation({
            ...(previousManifest === undefined ? {} : { manifest: previousManifest }),
            farmListing,
            canonicalListing,
          });

    const nowMs = params.now();
    const outcome = executeReconciliation({
      fs: params.fs,
      farmRoot,
      claudeHome: params.claudeHome,
      actions: reconciliation.actions,
      nowMs,
      classification: params.classification,
    });

    const facts = buildEntryFacts({
      fs: params.fs,
      claudeHome: params.claudeHome,
      home: params.home,
      cwd: params.cwd,
      nowMs,
      env: params.env,
      ...(params.branch === undefined ? {} : { branch: params.branch }),
      ...(params.branchDetached === undefined ? {} : { branchDetached: params.branchDetached }),
    });

    const resolved = resolveDecisions({ facts, cascade: params.cascade, classification: params.classification });

    const manifest: FarmManifest = {
      version: 1,
      builtAtMs: nowMs,
      identity: params.identity,
      ...(params.configProfile === undefined ? {} : { configProfile: params.configProfile }),
      cwd: params.cwd,
      claudeHome: params.claudeHome,
      materialised: resolved.farm.materialised,
      links: resolved.farm.links,
    };

    const diagnostics: Diagnostic[] = [
      ...resolved.diagnostics,
      ...reconciliation.diagnostics,
      ...outcome.diagnostics,
      ...recoveryDiagnostics(recovery, params.identity),
    ];

    const farmExists = params.fs.lstat(farmRoot) !== undefined;
    const nothingAdopted = outcome.adopted.length === 0 && outcome.conflicts.length === 0;
    if (
      farmExists &&
      !recovery.recovered &&
      nothingAdopted &&
      previousManifest !== undefined &&
      farmAlreadyMatches(previousManifest, manifest)
    ) {
      return {
        farmRoot,
        noOp: true,
        manifest: previousManifest,
        resolved,
        adopted: outcome.adopted,
        recovery,
        diagnostics,
      };
    }

    const scratchRoot = path.join(params.identitiesDir, `.${params.identity}.scratch.${params.uniqueSuffix}`);
    const previousRoot = path.join(params.identitiesDir, `.${params.identity}.previous.${params.uniqueSuffix}`);
    buildScratchTree({ fs: params.fs, scratchRoot, plan: resolved.farm, manifest });
    const swap = swapIn({ fs: params.fs, farmRoot, scratchRoot, previousRoot, classification: params.classification });

    if (swap.retainedPrevious !== undefined) {
      diagnostics.push({
        code: "FARM_PREVIOUS_RETAINED",
        severity: "warning",
        message:
          `The superseded farm was left at ${swap.retainedPrevious} because it still holds ` +
          `${swap.collided.join(", ")}, which the new farm has its own entry for. Nothing was overwritten in either ` +
          `direction; run \`claude-use identity resolve ${params.identity}\` to resolve it interactively.`,
        subject: swap.retainedPrevious,
      });
    }

    return {
      farmRoot,
      noOp: false,
      manifest,
      resolved,
      adopted: outcome.adopted,
      recovery,
      diagnostics,
      ...(swap.retainedPrevious === undefined ? {} : { retainedPrevious: swap.retainedPrevious }),
    };
  } finally {
    lock.release();
  }
}

/** Turns a recovery result into the one diagnostic worth reporting about it, or nothing when there was nothing to recover. */
export function recoveryDiagnostics(recovery: RecoveryResult, identity: string): Diagnostic[] {
  if (!recovery.recovered) {
    return [];
  }
  const parts: string[] = [];
  if (recovery.removedScratch.length > 0) {
    parts.push(`removed ${String(recovery.removedScratch.length)} abandoned scratch tree(s)`);
  }
  if (recovery.restoredFrom !== undefined) {
    parts.push(`restored the farm from ${recovery.restoredFrom}, which a previous launch was killed mid-swap`);
  }
  if (recovery.completed.length > 0) {
    parts.push(`finished carrying local state out of ${String(recovery.completed.length)} superseded farm(s)`);
  }
  if (recovery.autoResolved.length > 0) {
    parts.push(`discarded ${String(recovery.autoResolved.length)} superseded runtime entr${recovery.autoResolved.length === 1 ? "y" : "ies"} (${recovery.autoResolved.join(", ")}) — disposable per-machine state, safe to drop without asking`);
  }
  if (recovery.retained.length > 0) {
    parts.push(
      `kept ${recovery.retained.join(", ")}, which still holds data the current farm also has an entry for — ` +
        `run \`claude-use identity resolve ${identity}\` to resolve it interactively`,
    );
  }
  return [
    {
      code: "FARM_SWAP_RECOVERED",
      severity: "warning",
      message: `A previous launch left this identity's farm mid-swap. This launch ${parts.join("; ")}.`,
    },
  ];
}

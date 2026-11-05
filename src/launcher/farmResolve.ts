import path from "node:path";

import { isResyncFarmOf } from "../identityRecords";
import { carryOver } from "./farm";
import type { CategoryClassification, CategoryClassificationOverlay } from "../config/schema";
import type { FarmFs } from "./ports";

/** What to do with one colliding top-level name between a superseded farm and the current one. */
export type FarmConflictChoice = "keep-new" | "keep-old" | "skip";

/** One colliding top-level name, named but not yet decided. */
export interface FarmConflict {
  /** The superseded farm directory this conflict was found in. */
  readonly previousRoot: string;
  /** The live farm directory the conflict is against. */
  readonly farmRoot: string;
  /** The colliding top-level name, relative to both `previousRoot` and `farmRoot`. */
  readonly name: string;
}

/** One conflict, plus what was decided for it. */
interface ResolvedFarmConflict extends FarmConflict {
  readonly choice: FarmConflictChoice;
}

/** Inputs to `resolveFarmConflicts`. */
export interface ResolveFarmConflictsParams {
  readonly fs: FarmFs;
  readonly identitiesDir: string;
  readonly identity: string;
  /** Decides one conflict at a time, called once per colliding name across every retained previous farm, in a stable (sorted) order. A `runtime`-category collision never reaches this callback at all — see `classification` below. */
  readonly decide: (conflict: FarmConflict) => Promise<FarmConflictChoice>;
  /** When given, threaded straight through to `carryOver`, so a colliding name classified `runtime` is resolved automatically (its old copy discarded) rather than asked about — the same auto-resolution an ordinary resync already applies, available here too since a superseded farm can sit retained for a long time before anyone thinks to run this command. */
  readonly classification?: { readonly defaults: CategoryClassification; readonly overlay?: CategoryClassificationOverlay };
}

/** What `resolveFarmConflicts` did. */
export interface ResolveFarmConflictsResult {
  /** Every conflict a human decided, in the order it was decided, alongside what was chosen for it. Never includes a `runtime`-category collision — those are counted in `autoResolved` instead, having never reached `decide`. */
  readonly resolved: readonly ResolvedFarmConflict[];
  /** Top-level names, across every previous farm processed, resolved automatically because their category is `runtime` — see `carryOver`'s own doc comment for why that needs no human decision. */
  readonly autoResolved: readonly string[];
  /** Previous-farm directories with every conflict decided (none skipped) and therefore removed. */
  readonly removed: readonly string[];
  /** Previous-farm directories still holding at least one skipped conflict, and therefore still on disk. */
  readonly retained: readonly string[];
}

/**
 * Walks every `.<identity>.previous.*` directory still on disk and, for each top-level name that collides with the current farm, asks `decide` what to do rather than leaving it for a human to resolve by hand outside the tool.
 *
 * Reuses `carryOver`'s own collision detection rather than a second implementation: anything that does *not* collide has already been carried across automatically by an earlier resync, so this only ever has to ask about genuine conflicts — `carryOver`'s own `carried` list is not otherwise interesting here, and (when `classification` is given) its `autoResolved` list means `decide` is only ever called for a collision `carryOver` itself could not already settle.
 *
 * `keep-new` discards the old copy outright. `keep-old` removes the current farm's own entry at that name and moves the old copy into its place — the same rename `carryOver` already uses for a non-colliding name, just preceded by clearing the spot it collided with. `skip` leaves both copies exactly as they were, and the directory they live in is not removed, so a later run of this same function finds the exact same conflict again rather than silently losing track of it.
 */
export async function resolveFarmConflicts(params: ResolveFarmConflictsParams): Promise<ResolveFarmConflictsResult> {
  const farmRoot = path.join(params.identitiesDir, params.identity);
  const previousRoots = [...params.fs.readdir(params.identitiesDir)]
    .filter((name) => isResyncFarmOf(name, params.identity, "previous"))
    .sort()
    .map((name) => path.join(params.identitiesDir, name));

  const resolved: ResolvedFarmConflict[] = [];
  const autoResolved: string[] = [];
  const removed: string[] = [];
  const retained: string[] = [];

  for (const previousRoot of previousRoots) {
    const carryOverResult = carryOver({
      fs: params.fs,
      previousRoot,
      farmRoot,
      ...(params.classification === undefined ? {} : { classification: params.classification }),
    });
    const { collided } = carryOverResult;
    autoResolved.push(...carryOverResult.autoResolved);
    let anySkipped = false;

    for (const name of collided) {
      const choice = await params.decide({ previousRoot, farmRoot, name });
      resolved.push({ previousRoot, farmRoot, name, choice });

      if (choice === "skip") {
        anySkipped = true;
        continue;
      }
      if (choice === "keep-new") {
        params.fs.removeRecursive(path.join(previousRoot, name));
        continue;
      }
      params.fs.removeRecursive(path.join(farmRoot, name));
      params.fs.rename(path.join(previousRoot, name), path.join(farmRoot, name));
    }

    if (anySkipped) {
      retained.push(previousRoot);
    } else {
      params.fs.removeRecursive(previousRoot);
      removed.push(previousRoot);
    }
  }

  return { resolved, autoResolved, removed, retained };
}

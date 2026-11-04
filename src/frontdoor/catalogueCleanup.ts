import path from "node:path";
import { z } from "zod";

import type { HeadroomFs } from "../headroom/state";
import type { LayoutPaths } from "../paths";

/** Removes abandoned generation directories while preserving the current generation, other live supervisors and unrecognised entries. */
export async function pruneAbandonedCatalogueGenerations(fs: HeadroomFs, paths: LayoutPaths, ownPid: number, generation: string, runningAmong: (pids: readonly number[]) => Promise<ReadonlySet<number>>): Promise<void> {
  const root = path.join(paths.catalogueDir, "supervisors");
  const owners = fs.readdir(root).flatMap((entry) => {
    const pid = Number(entry);
    return Number.isSafeInteger(pid) && pid > 0 && String(pid) === entry && fs.lstat(path.join(root, entry))?.kind === "dir" ? [pid] : [];
  });
  const running = await runningAmong(owners);
  for (const pid of owners) {
    if (pid !== ownPid && running.has(pid)) continue;
    const directory = path.join(root, String(pid));
    for (const entry of fs.readdir(directory)) {
      const candidate = path.join(directory, entry);
      if (z.uuid().safeParse(entry).success && (pid !== ownPid || entry !== generation) && fs.lstat(candidate)?.kind === "dir") fs.removeRecursive(candidate);
    }
  }
}

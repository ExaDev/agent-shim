import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deletedProblems, listedCounts } from "../src/conformance/keptTests.ts";
import { listSuite, readAccounting, runCommand } from "../src/conformance/keptTestsIo.ts";

/**
 * Fails when a change deletes a test that no case and no dropped row accounts for.
 *
 * Usage: `node scripts/deleted-tests.mts --base <revision>`. It lists this checkout's tests with vitest's own listing, checks the revision out in a throwaway worktree (sharing this checkout's installed packages) and lists that, then reports every test the revision has and this checkout lacks that is neither the source of a case nor a row of the README's dropped table. Exits 0 when there is none, 1 naming each, and 2 when it could not run.
 */
const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

async function main(): Promise<number> {
  const [flag, base] = process.argv.slice(2);
  if (flag !== "--base" || base === undefined) {
    process.stderr.write("usage: node scripts/deleted-tests.mts --base <revision>\n");
    return 2;
  }
  // The real path, since the listing reports the files by theirs and a temporary directory is often reached through a link.
  const worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deleted-tests-")));
  try {
    await runCommand("git", ["-C", root, "worktree", "add", "--detach", "--force", worktree, base]);
    fs.symlinkSync(path.join(root, "node_modules"), path.join(worktree, "node_modules"));
    const [baseListing, headListing] = [await listSuite(worktree), await listSuite(root)];
    const problems = deletedProblems(listedCounts(baseListing, worktree), listedCounts(headListing, root), readAccounting(root));
    for (const problem of problems) {
      process.stdout.write(`${problem}\n`);
    }
    return problems.length === 0 ? 0 : 1;
  } finally {
    await runCommand("git", ["-C", root, "worktree", "remove", "--force", worktree]).catch(() => undefined);
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`deleted-tests: ${error instanceof Error ? error.message : String(error)}\n`);
  return 2;
});

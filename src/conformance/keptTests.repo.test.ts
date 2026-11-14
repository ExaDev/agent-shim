import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { accountingFrom, guardProblems, listedCounts } from "./keptTests";
import { corpusCases, listSuite } from "./keptTestsIo";

/** The repository root, by its real path, which is how the suite's listing reports its files. */
const ROOT = fs.realpathSync(path.join(__dirname, "..", ".."));

/** The outer limit of the test, which only stops a hang: the listing enforces its own budget, derived from the number of test files, and fails saying that the host was too slow, so that is the failure a slow host shows and not a bare timeout. */
const OUTER_TIMEOUT_MS = 3_600_000;

describe("the kept and dropped tests of the conformance corpus", () => {
  it("account for every test in a file whose tests moved to the corpus, and every row names what it says", async () => {
    const readme = fs.readFileSync(path.join(ROOT, "conformance", "README.md"), "utf8");
    const listing = await listSuite(ROOT);
    expect(listing.length).toBeGreaterThan(0);
    expect(guardProblems(listedCounts(listing, ROOT), accountingFrom(readme, corpusCases(ROOT)))).toEqual([]);
  }, OUTER_TIMEOUT_MS);
});

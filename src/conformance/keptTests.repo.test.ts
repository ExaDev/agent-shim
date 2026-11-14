import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { accountingFrom, guardProblems, listedCounts } from "./keptTests";
import { corpusFroms, listSuite } from "./keptTestsIo";

/** The repository root, by its real path, which is how the suite's listing reports its files. */
const ROOT = fs.realpathSync(path.join(__dirname, "..", ".."));

/** The listing collects every test file of the suite, which takes as long as the suite's collection does on a loaded machine. */
const LISTING_TIMEOUT_MS = 300_000;

describe("the kept and dropped tests of the conformance corpus", () => {
  it("account for every test in a file whose tests moved to the corpus, and every row names what it says", async () => {
    const readme = fs.readFileSync(path.join(ROOT, "conformance", "README.md"), "utf8");
    const listing = await listSuite(ROOT);
    expect(listing.length).toBeGreaterThan(0);
    expect(guardProblems(listedCounts(listing, ROOT), accountingFrom(readme, corpusFroms(ROOT)))).toEqual([]);
  }, LISTING_TIMEOUT_MS);
});

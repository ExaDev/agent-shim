import { describe, expect, it } from "vitest";

import { DAY_MS, FAKE_NOW_MS, makeFacts } from "../test-helpers";

// Well outside the 90-day window the cases of the corpus check against.
const ANCIENT_DIR_MTIME_AGE_DAYS = 400;

describe("the fact manifest's directory aggregates", () => {
  it("holds a directory's own mtime and size beside the latest mtime and total size of its subtree", () => {
    // The directory's own mtime is ancient; a file three levels down was written a day ago.
    const mtimeFacts = makeFacts({
      "projects/-a-b": { dir: true, mtimeMs: FAKE_NOW_MS - ANCIENT_DIR_MTIME_AGE_DAYS * DAY_MS },
      "projects/-a-b/nested/session.jsonl": { mtimeMs: FAKE_NOW_MS - 1 * DAY_MS, sizeBytes: 10 },
    });
    const mtimeDirectory = mtimeFacts.entries.get("projects/-a-b");
    expect(mtimeDirectory?.mtimeMs).toBe(FAKE_NOW_MS - ANCIENT_DIR_MTIME_AGE_DAYS * DAY_MS);
    expect(mtimeDirectory?.latestMtimeMs).toBe(FAKE_NOW_MS - 1 * DAY_MS);

    const dirOwnSizeBytes = 4_096;
    const fileOneSizeBytes = 5_000;
    const fileTwoSizeBytes = 6_000;
    const sizeFacts = makeFacts({
      "projects/-a-b": { dir: true, sizeBytes: dirOwnSizeBytes },
      "projects/-a-b/one.jsonl": { sizeBytes: fileOneSizeBytes },
      "projects/-a-b/two.jsonl": { sizeBytes: fileTwoSizeBytes },
    });
    const sizeDirectory = sizeFacts.entries.get("projects/-a-b");
    expect(sizeDirectory?.sizeBytes).toBe(dirOwnSizeBytes);
    expect(sizeDirectory?.totalSizeBytes).toBe(dirOwnSizeBytes + fileOneSizeBytes + fileTwoSizeBytes);
  });
});

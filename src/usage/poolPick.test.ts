import { describe, expect, it } from "vitest";

import { FAKE_NOW_MS, createFakeFarmFs, paths } from "../test-helpers";
import { loadPoolMembers, readStickyPick, recordStickyPick } from "./poolPick";
import { USAGE_RETENTION_MS } from "./store";

const HOUR_MS = 3_600_000;
const SIX_HOURS_MS = 21_600_000;
const MINUTE_MS = 60_000;
const DIRECTORY = "/home/testuser/work";
const OTHER_DIRECTORY = "/home/testuser/other";

const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

function recordLine(identity: string, offsetMs: number, provider = "anthropic"): string {
  return `${JSON.stringify({ schemaVersion: 1, at: iso(offsetMs), identity, provider, route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`;
}

describe("loadPoolMembers", () => {
  it("carries a member with a corrupt snapshot as unreadable instead of failing the pick", () => {
    const fs = createFakeFarmFs({ [`${paths.usageSnapshotsDir}/work.json`]: "{ not json" });
    const [member] = loadPoolMembers(fs, paths, ["work"], FAKE_NOW_MS);
    expect(member?.readError).toContain("not valid JSON");
  });

  it("reads only the member's own anthropic records from inside the current five-hour window", () => {
    const day = iso(0).slice(0, "YYYY-MM-DD".length);
    const log = [
      recordLine("work", -MINUTE_MS),
      recordLine("work", -SIX_HOURS_MS),
      recordLine("work", -MINUTE_MS, "z"),
      recordLine("personal", -MINUTE_MS),
    ].join("");
    const fs = createFakeFarmFs({ [`${paths.usageLogDir}/${day}.1.jsonl`]: log });
    const [member] = loadPoolMembers(fs, paths, ["work"], FAKE_NOW_MS);
    expect(member?.records.map((record) => record.at)).toEqual([iso(-MINUTE_MS)]);
  });

  it("has no snapshot or account for an identity that was never recorded", () => {
    const [member] = loadPoolMembers(createFakeFarmFs({}), paths, ["work"], FAKE_NOW_MS);
    expect(member).toEqual({ identity: "work", records: [] });
  });
});

describe("last-pick record", () => {
  it("round-trips a pick per directory", () => {
    const fs = createFakeFarmFs({});
    recordStickyPick(fs, paths.usagePicksFile, DIRECTORY, "work", FAKE_NOW_MS);
    recordStickyPick(fs, paths.usagePicksFile, OTHER_DIRECTORY, "personal", FAKE_NOW_MS);
    expect(readStickyPick(fs, paths.usagePicksFile, DIRECTORY)).toEqual({ sticky: { identity: "work", at: iso(0) } });
    expect(readStickyPick(fs, paths.usagePicksFile, OTHER_DIRECTORY).sticky?.identity).toBe("personal");
    expect(readStickyPick(fs, paths.usagePicksFile, "/nowhere")).toEqual({});
  });

  it("drops entries older than the usage log's retention when it writes", () => {
    const fs = createFakeFarmFs({});
    recordStickyPick(fs, paths.usagePicksFile, OTHER_DIRECTORY, "personal", FAKE_NOW_MS - USAGE_RETENTION_MS - HOUR_MS);
    recordStickyPick(fs, paths.usagePicksFile, DIRECTORY, "work", FAKE_NOW_MS);
    expect(readStickyPick(fs, paths.usagePicksFile, OTHER_DIRECTORY)).toEqual({});
    expect(readStickyPick(fs, paths.usagePicksFile, DIRECTORY).sticky?.identity).toBe("work");
  });

  it("reports an unreadable file and treats it as empty, rather than blocking a launch", () => {
    const fs = createFakeFarmFs({ [paths.usagePicksFile]: "{ not json" });
    expect(readStickyPick(fs, paths.usagePicksFile, DIRECTORY).problem).toContain("not valid JSON");
    recordStickyPick(fs, paths.usagePicksFile, DIRECTORY, "work", FAKE_NOW_MS);
    expect(readStickyPick(fs, paths.usagePicksFile, DIRECTORY).sticky?.identity).toBe("work");
  });
});

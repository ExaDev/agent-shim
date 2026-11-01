import { describe, expect, it } from "vitest";

import { createFakeFarmFs } from "../test-helpers";
import { liveLaunchesOn, registerLaunch } from "./launchRecords";

const DIR = "/home/testuser/.agent-shim/launches";
const STARTED_AT_MS = Date.parse("2026-10-30T12:00:00.000Z");
const OWNER_ONLY_DIRECTORY = 0o700;
const OWNER_ONLY_FILE = 0o600;
/** Launcher process ids, which mean nothing beyond being different from each other. */
const FIRST = 1;
const SECOND = 2;
const THIRD = 3;

describe("a launch record", () => {
  it("is written owner-only under the launches directory, named for the launcher and the identity, and removed by what registering returns", () => {
    const fs = createFakeFarmFs();
    const remove = registerLaunch(fs, DIR, { pid: 42, identity: "work", startedAtMs: STARTED_AT_MS }, () => true);
    expect(fs.readdir(DIR)).toEqual(["42.work.json"]);
    expect(JSON.parse(fs.readFileUtf8(`${DIR}/42.work.json`) ?? "")).toEqual({ pid: 42, identity: "work", startedAt: "2026-10-30T12:00:00.000Z" });
    expect(fs.modeOf(DIR)).toBe(OWNER_ONLY_DIRECTORY);
    expect(fs.modeOf(`${DIR}/42.work.json`)).toBe(OWNER_ONLY_FILE);
    remove();
    remove();
    expect(fs.readdir(DIR)).toEqual([]);
  });

  it("is told apart by identity when one launcher process launches two in turn", () => {
    const fs = createFakeFarmFs();
    registerLaunch(fs, DIR, { pid: 42, identity: "work", startedAtMs: STARTED_AT_MS }, () => true);
    registerLaunch(fs, DIR, { pid: 42, identity: "personal", startedAtMs: STARTED_AT_MS }, () => true);
    expect([...fs.readdir(DIR)].sort()).toEqual(["42.personal.json", "42.work.json"]);
  });
});

describe("liveLaunchesOn", () => {
  it("names the launchers of the identity whose process is still running, and no other identity's, and no dead one's", () => {
    const fs = createFakeFarmFs();
    registerLaunch(fs, DIR, { pid: FIRST, identity: "work", startedAtMs: STARTED_AT_MS }, () => true);
    registerLaunch(fs, DIR, { pid: SECOND, identity: "work", startedAtMs: STARTED_AT_MS }, () => true);
    registerLaunch(fs, DIR, { pid: THIRD, identity: "personal", startedAtMs: STARTED_AT_MS }, () => true);
    expect(liveLaunchesOn(fs, DIR, "work", (pid) => pid === FIRST || pid === THIRD)).toEqual([FIRST]);
    expect(liveLaunchesOn(fs, DIR, "personal", (pid) => pid === FIRST || pid === THIRD)).toEqual([THIRD]);
    expect(liveLaunchesOn(fs, DIR, "nobody", () => true)).toEqual([]);
  });

  it("reads and writes nothing else, so a dry run that asks leaves the machine as it was", () => {
    const fs = createFakeFarmFs();
    registerLaunch(fs, DIR, { pid: FIRST, identity: "work", startedAtMs: STARTED_AT_MS }, () => true);
    const writesBefore = fs.writes.length;
    liveLaunchesOn(fs, DIR, "work", () => false);
    expect(fs.writes).toHaveLength(writesBefore);
  });

  it("answers none when the directory does not exist, and ignores a file that is not a record", () => {
    const fs = createFakeFarmFs({ [`${DIR}/notes.txt`]: "hello", [`${DIR}/7.work.json`]: "{ not json", [`${DIR}/8.work.json`]: JSON.stringify({ pid: 8 }) });
    expect(liveLaunchesOn(fs, DIR, "work", () => true)).toEqual([]);
    expect(liveLaunchesOn(createFakeFarmFs(), DIR, "work", () => true)).toEqual([]);
  });
});

describe("registering a launch", () => {
  it("removes the records of launchers that are no longer running first, so a crashed launcher leaves nothing behind for long", () => {
    const fs = createFakeFarmFs();
    registerLaunch(fs, DIR, { pid: FIRST, identity: "work", startedAtMs: STARTED_AT_MS }, () => true);
    registerLaunch(fs, DIR, { pid: SECOND, identity: "personal", startedAtMs: STARTED_AT_MS }, () => true);
    registerLaunch(fs, DIR, { pid: THIRD, identity: "work", startedAtMs: STARTED_AT_MS }, (pid) => pid === SECOND || pid === THIRD);
    expect([...fs.readdir(DIR)].sort()).toEqual(["2.personal.json", "3.work.json"]);
  });
});

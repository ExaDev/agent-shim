import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { observeBlockingSteps } from "./blockingSteps";
import { nodeStoreFs } from "./config/store";
import { strayNameRenameRecordFiles } from "./identityNameRenameRecord";
import { listIdentityDirectories } from "./identityStore";
import { buildEntryFacts } from "./launcher/farm";
import { buildLayoutPaths } from "./paths";
import { readProvider } from "./providersStore";
import { findExecutableInDir, realFarmFs, realFsPort } from "./realPorts";

/** Every loop over local data reports each unit of its work to the observer a report child registers, so a loop that grows with the user's data is never mistaken for a stall. */
let root: string;
let stopObserving: (() => void) | undefined;
let works: number;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "local-work-"));
  works = 0;
  stopObserving = observeBlockingSteps({ begin: () => undefined, end: () => undefined, localWork: () => { works += 1; }, unboundedStepLimitMs: 1 });
});

afterEach(() => {
  stopObserving?.();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The work notes `run` makes. */
function worksOf(run: () => unknown): number {
  const before = works;
  run();
  return works - before;
}

describe("local work notes", () => {
  const file = (): string => {
    const target = path.join(root, "f.txt");
    fs.writeFileSync(target, "x");
    return target;
  };

  it.each([
    ["the farm port's lstat", () => realFarmFs.lstat(file())],
    ["the farm port's readdir", () => realFarmFs.readdir(root)],
    ["the farm port's file read", () => realFarmFs.readFileUtf8(file())],
    ["the file port's revision read", () => realFsPort.fileRevision?.(file())],
    ["the file port's file read", () => realFsPort.readFileUtf8(file())],
    ["the file port's readdir", () => realFsPort.readdir(root)],
    ["the store's file read", () => nodeStoreFs.readFileUtf8(file())],
    ["the PATH search of one directory", () => findExecutableInDir(root, "nothing-here")],
  ])("notes one unit of work for %s", (_name, run) => {
    expect(worksOf(run)).toBeGreaterThanOrEqual(1);
  });

  it("notes a unit of work for each identity directory entry listed", () => {
    const paths = buildLayoutPaths(root);
    const ENTRIES = 4;
    fs.mkdirSync(paths.identitiesDir, { recursive: true });
    for (let index = 0; index < ENTRIES; index += 1) {
      fs.mkdirSync(path.join(paths.identitiesDir, `id${String(index)}`));
    }
    expect(worksOf(() => listIdentityDirectories(paths))).toBe(ENTRIES);
  });

  it("notes a unit of work for each provider file read", () => {
    const paths = buildLayoutPaths(root);
    expect(worksOf(() => readProvider(paths, "absent"))).toBe(1);
  });

  it("notes a unit of work for each identity name rename record file listed", () => {
    const paths = buildLayoutPaths(root);
    const RECORDS = 3;
    fs.mkdirSync(paths.identityNameRenamesDir, { recursive: true });
    for (let index = 0; index < RECORDS; index += 1) {
      fs.writeFileSync(path.join(paths.identityNameRenamesDir, `r${String(index)}.json`), "{}");
    }
    expect(worksOf(() => strayNameRenameRecordFiles(paths))).toBeGreaterThanOrEqual(RECORDS);
  });

  it("notes at least one unit of work for each entry the fact walk of a tree visits", () => {
    const DIRECTORIES = 3;
    for (let index = 0; index < DIRECTORIES; index += 1) {
      fs.mkdirSync(path.join(root, `d${String(index)}`));
      fs.writeFileSync(path.join(root, `d${String(index)}`, "f"), "x");
    }
    const entryCount = DIRECTORIES * 2;
    let facts: ReturnType<typeof buildEntryFacts> | undefined;
    const noted = worksOf(() => { facts = buildEntryFacts({ fs: realFarmFs, claudeHome: root, home: root, cwd: root, nowMs: 0, env: {}, descend: () => true }); });
    expect(facts?.entries.size).toBe(entryCount);
    expect(noted).toBeGreaterThanOrEqual(entryCount);
  });
});

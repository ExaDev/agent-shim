import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noteFileSystemWork, observeBlockingSteps } from "./blockingSteps";
import { collectCheckReport } from "./checkReport";
import { collectDoctorReport } from "./doctorReport";
import { realInstalledClaudeVersions } from "./realPorts";
import { buildLayoutPaths } from "./paths";

/** Every synchronous call of `node:fs` is a unit of local work a report child announces, so a loop over the user's files cannot be mistaken for a stall however it is written. */
let stopObserving: (() => void) | undefined;
let restoreFileSystem: (() => void) | undefined;
let works: number;

beforeEach(() => {
  works = 0;
  stopObserving = observeBlockingSteps({ begin: () => undefined, end: () => undefined, localWork: () => { works += 1; }, unboundedStepLimitMs: 1 });
});

afterEach(() => {
  restoreFileSystem?.();
  restoreFileSystem = undefined;
  stopObserving?.();
  stopObserving = undefined;
});

describe("noteFileSystemWork", () => {
  const NATIVE_PROPERTY = "native";
  const CONSTANT = 5;

  /** A module of the shape `node:fs` has, with a property on one function the way `realpathSync.native` is. */
  function fakeModule() {
    const calls: { readonly name: string; readonly args: readonly unknown[] }[] = [];
    const readSync = (...args: readonly unknown[]): string => { calls.push({ name: "readSync", args }); return "read"; };
    const statSync = (...args: readonly unknown[]): string => { calls.push({ name: "statSync", args }); return "stat"; };
    Reflect.set(statSync, NATIVE_PROPERTY, "kept");
    return { module: { readSync, statSync, notSynchronous: () => "plain", constantSync: CONSTANT }, calls, statSync };
  }

  it("notes one unit of work before each synchronous function runs, passing its arguments and result through", () => {
    const { module, calls } = fakeModule();
    restoreFileSystem = noteFileSystemWork(module);
    expect(module.statSync("a", { b: 1 })).toBe("stat");
    expect(works).toBe(1);
    expect(module.readSync("c")).toBe("read");
    expect(works).toBe(2);
    expect(calls).toEqual([
      { name: "statSync", args: ["a", { b: 1 }] },
      { name: "readSync", args: ["c"] },
    ]);
  });

  it("leaves other exports alone and keeps a function's own properties", () => {
    const { module } = fakeModule();
    restoreFileSystem = noteFileSystemWork(module);
    expect(module.notSynchronous()).toBe("plain");
    expect(module.constantSync).toBe(CONSTANT);
    expect(works).toBe(0);
    expect(Reflect.get(Reflect.get(module, "statSync") as object, NATIVE_PROPERTY)).toBe("kept");
  });

  it("puts the originals back", () => {
    const { module, statSync } = fakeModule();
    const restore = noteFileSystemWork(module);
    expect(Reflect.get(module, "statSync")).not.toBe(statSync);
    restore();
    expect(Reflect.get(module, "statSync")).toBe(statSync);
  });

  it("wraps every synchronous function the source calls through node:fs", () => {
    const calledNames = new Set<string>();
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(?:ts|mts)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
          const text = fs.readFileSync(full, "utf8");
          for (const match of text.matchAll(/\bfs\.(\w+Sync)\b/g)) {
            calledNames.add(match[1] ?? "");
          }
          for (const match of text.matchAll(/import \{([^}]*)\} from "node:fs"/g)) {
            for (const name of (match[1] ?? "").split(",").map((part) => part.trim()).filter((part) => part.endsWith("Sync"))) {
              calledNames.add(name);
            }
          }
        }
      }
    };
    walk(path.resolve(__dirname));
    expect(calledNames.size).toBeGreaterThan(0);
    const originals = new Map([...calledNames].map((name) => [name, Reflect.get(fs, name)]));
    restoreFileSystem = noteFileSystemWork(fs);
    for (const name of calledNames) {
      expect(typeof originals.get(name), `${name} is not a function of node:fs`).toBe("function");
      expect(Reflect.get(fs, name), `${name} is not wrapped`).not.toBe(originals.get(name));
    }
  });
});

describe("the reports' file system access", () => {
  /** A real report spawns the commands it checks (process table, keychain), which a loaded host can slow. */
  const REPORT_RUN_TIMEOUT_MS = 120_000;
  const PROJECTS = 4;
  const FILES_PER_PROJECT = 5;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "report-work-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    for (let project = 0; project < PROJECTS; project += 1) {
      const directory = path.join(home, ".claude", "projects", `p${String(project)}`);
      fs.mkdirSync(directory, { recursive: true });
      for (let file = 0; file < FILES_PER_PROJECT; file += 1) {
        fs.writeFileSync(path.join(directory, `s${String(file)}.jsonl`), "{}");
      }
    }
    fs.mkdirSync(path.join(home, ".agent-shim", "identities", "one"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agent-shim", "identities", "one", "identity.json"), JSON.stringify({ name: "one" }));
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** Counts every synchronous `node:fs` call made while `run` runs, by a counter beneath the notes, and returns it with the notes made. */
  function countedRun(run: () => void): { readonly calls: number; readonly notes: number } {
    let calls = 0;
    const counters = new Map<string, unknown>();
    for (const name of Object.keys(fs).filter((candidate) => candidate.endsWith("Sync"))) {
      const original: unknown = Reflect.get(fs, name);
      if (typeof original !== "function") {
        continue;
      }
      counters.set(name, original);
      const counted = function (this: unknown, ...args: readonly unknown[]): unknown {
        calls += 1;
        return Reflect.apply(original, this, args);
      };
      Object.defineProperties(counted, Object.getOwnPropertyDescriptors(original));
      Reflect.set(fs, name, counted);
    }
    restoreFileSystem = noteFileSystemWork(fs);
    works = 0;
    try {
      run();
    } finally {
      restoreFileSystem();
      restoreFileSystem = undefined;
      for (const [name, original] of counters) {
        Reflect.set(fs, name, original);
      }
    }
    return { calls, notes: works };
  }

  it("is noted for every entry of the installed versions directory, which is stat-ed one by one", () => {
    const VERSIONS = 6;
    const versionsDirectory = path.join(home, ".local", "share", "claude", "versions");
    fs.mkdirSync(versionsDirectory, { recursive: true });
    for (let index = 0; index < VERSIONS; index += 1) {
      fs.writeFileSync(path.join(versionsDirectory, `1.0.${String(index)}`), "");
    }
    const { calls, notes } = countedRun(() => { realInstalledClaudeVersions(); });
    expect(calls).toBeGreaterThanOrEqual(VERSIONS);
    expect(notes).toBe(calls);
  });

  it("is noted for every call the doctor report makes, with a tree of the user's files to walk", () => {
    const paths = buildLayoutPaths(path.join(home, ".agent-shim"));
    const { calls, notes } = countedRun(() => { collectDoctorReport({ paths, env: { ...process.env, HOME: home } }); });
    expect(calls).toBeGreaterThan(0);
    expect(notes).toBe(calls);
  }, REPORT_RUN_TIMEOUT_MS);

  it("is noted for every call the check report makes, with a conditional rule that walks the user's files", () => {
    const paths = buildLayoutPaths(path.join(home, ".agent-shim"));
    fs.writeFileSync(paths.globalConfigFile, JSON.stringify({ entries: { "history/projects/*": { value: true, when: { newerThan: "30d" } } } }));
    const { calls, notes } = countedRun(() => { collectCheckReport({ paths, cwd: home, env: { ...process.env, HOME: home } }); });
    // The rule makes the fact walk visit every project directory and every session file in it.
    expect(calls).toBeGreaterThan(PROJECTS * FILES_PER_PROJECT);
    expect(notes).toBe(calls);
  }, REPORT_RUN_TIMEOUT_MS);
});

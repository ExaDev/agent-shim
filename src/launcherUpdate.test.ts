import { describe, expect, it } from "vitest";

import { prepareLaunch } from "./launcher";
import type { UpdateLaunchPort } from "./update/launchHook";
import { DAY_MS, FAKE_NOW_MS, discovered, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit } from "./test-helpers";

/** A scripted `UpdateLaunchPort`: the release check stays pending until the test settles it, and every operation is recorded in order, so the launcher-level tests prove both placement and late-answer suppression without touching the network. */
function fakeUpdatePort(options: { readonly stamp?: string } = {}): UpdateLaunchPort & {
  readonly events: string[];
  readonly errLines: string[];
  readonly spawns: readonly (readonly string[])[];
  readonly settle: (url: string) => void;
} {
  const events: string[] = [];
  const errLines: string[] = [];
  const spawns: string[][] = [];
  let settle!: (url: string) => void;
  const pending = new Promise<string>((resolve) => {
    settle = (url: string) => {
      events.push("resolve");
      resolve(url);
    };
  });
  return {
    events,
    errLines,
    spawns,
    settle,
    effectiveUrl: async (url) => {
      events.push(`http ${url}`);
      return await pending;
    },
    readStamp: (filePath) => {
      events.push(`read ${filePath}`);
      return options.stamp;
    },
    writeStamp: (filePath) => {
      events.push(`write ${filePath}`);
    },
    now: () => FAKE_NOW_MS,
    spawnDetached: (args) => {
      events.push(`spawn ${args.join(" ")}`);
      spawns.push([...args]);
    },
    writeErr: (line) => {
      events.push("stderr");
      errLines.push(line);
    },
  };
}

/** Lets every pending microtask (and one macrotask turn) run, so a check settled by the test has been acted on. */
async function flushUpdateCheck(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("launch-time update check", () => {
  /** How much older than "now" the stale stamp is, in days: well past the one-day cooldown. */
  const STALE_AFTER_DAYS = 2;
  /** A stamp far older than the cooldown, so the check is due without each test computing one. */
  const STALE_STAMP = new Date(FAKE_NOW_MS - STALE_AFTER_DAYS * DAY_MS).toISOString();
  const NEWER_TAG_URL = "https://github.com/ExaDev/agent-shim/releases/tag/v99.0.0";

  it("runs through the wired port against <root>/update.check when the mode resolves on", () => {
    const update = fakeUpdatePort({ stamp: STALE_STAMP });
    prepareLaunch({
      paths,
      fs: fakeFs({}),
      proc: fakeProc({}, ["--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      updateMode: "notify",
      update,
    });
    expect(update.events).toEqual([
      `read ${paths.root}/update.check`,
      `write ${paths.root}/update.check`,
      "http https://github.com/ExaDev/agent-shim/releases/latest",
    ]);
  });

  it("reads nothing at all when the mode is absent, off, or no port is wired", () => {
    for (const params of [
      { updateMode: undefined, update: fakeUpdatePort({ stamp: STALE_STAMP }) },
      { updateMode: "off" as const, update: fakeUpdatePort({ stamp: STALE_STAMP }) },
      { updateMode: "notify" as const, update: undefined },
    ]) {
      prepareLaunch({
        paths,
        fs: fakeFs({}),
        proc: fakeProc({}, ["--print"]),
        log: fakeLog(),
        resolveClaudeBinary: () => discovered,
        ...(params.updateMode === undefined ? {} : { updateMode: params.updateMode }),
        ...(params.update === undefined ? {} : { update: params.update }),
      });
      expect(params.update?.events ?? []).toEqual([]);
    }
  });

  it("prints its line once when the answer lands before the child starts, and the plan exposes the marker", async () => {
    const update = fakeUpdatePort({ stamp: STALE_STAMP });
    const plan = prepareLaunch({
      paths,
      fs: fakeFs({}),
      proc: fakeProc({}, ["--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      updateMode: "notify",
      update,
    });
    update.settle(NEWER_TAG_URL);
    await flushUpdateCheck();
    expect(update.errLines).toHaveLength(1);
    expect(update.errLines[0]).toContain("update available");
    expect(() => {
      plan.markChildStarted();
      plan.markChildStarted();
    }).not.toThrow();
  });

  it("marks the child as started before spawning, so an answer the launch outlived prints nothing", async () => {
    const update = fakeUpdatePort({ stamp: STALE_STAMP });
    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn: fakeSpawn(),
      proc: fakeProc({}, ["--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      updateMode: "auto",
      update,
    });
    update.settle(NEWER_TAG_URL);
    await flushUpdateCheck();
    expect(update.errLines).toEqual([]);
    expect(update.spawns).toEqual([["update"]]);
  });
});

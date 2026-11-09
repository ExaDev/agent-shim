import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noteFileSystemWork, observeBlockingSteps } from "./blockingSteps";
import { collectCheckReport } from "./checkReport";
import { collectDoctorReport } from "./doctorReport";
import { addPool } from "./poolStore";
import { buildLayoutPaths } from "./paths";
import { growsLinearly, startStepMeter } from "./test-helpers";

/**
 * Each report is run against a farm in which every collection the user sizes is large and degenerate at once: identities with a readable name, with none (a file that is not JSON), all claiming one name, symlinks to one directory and displaced ones (an interrupted resync left their identity.json only in a superseded farm), a pool of many members with a usage log of several records for each, many registered sessions, many providers and many configuration profiles. The array steps a report makes (`countSteps`) must grow exactly linearly with the farm (`growsLinearly`: counts are deterministic, so the slope may not grow), and so must the most steps it makes between two file system notes, which is what the door's silence window sees as a stall.
 *
 * What this can catch: a pass over a collection nested inside a pass over it that runs through the counted array operations, over the whole farm. What it cannot see: a quadratic cost that does not run through them (a `Set` or `Map` iteration, an indexed `for` loop, a sort comparator, a copy by `slice`, `concat` or `JSON.stringify`, string building), one in native code, one over a collection this farm does not hold (registered sessions, many providers), and a cost that grows with something other than the farm's size.
 */
/** The smallest farm a report is measured at, and the factors of it the next two are: doubling twice, so a pass over a collection inside a pass over it makes the last step cost four times the first. */
const FIRST_FARM = 200;
const DOUBLE = 2;
const QUADRUPLE = 4;
const REPORT_SIZES = [FIRST_FARM, FIRST_FARM * DOUBLE, FIRST_FARM * QUADRUPLE] as const;
const GROUPS = 4;
const UUID_TAIL_DIGITS = 12;
const RECORDS_PER_MEMBER = 5;
const MINUTE_MS = 60_000;
const FIRST_SESSION_PID = 400_000;
const SUPERVISOR_PID = 399_999;

let home: string;
let previousHome: string | undefined;
let restoreFileSystem: (() => void) | undefined;
let stopObserving: (() => void) | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "report-linearity-"));
  previousHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  restoreFileSystem?.();
  stopObserving?.();
  restoreFileSystem = undefined;
  stopObserving = undefined;
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

/** A farm of `size` identities in four equal degenerate groups plus as many displaced records, with a pool of the readable ones and a profile for each. Returns the layout paths. */
function buildFarm(size: number) {
  const paths = buildLayoutPaths(path.join(home, ".agent-shim"));
  const each = size / GROUPS;
  const write = (id: string, contents: string): void => {
    fs.mkdirSync(path.join(paths.identitiesDir, id), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, id, "identity.json"), contents);
  };
  const members: string[] = [];
  for (let index = 0; index < each; index += 1) {
    write(`readable${String(index)}`, JSON.stringify({ name: `readable${String(index)}` }));
    members.push(`readable${String(index)}`);
    write(`nameless${String(index)}`, "{ not json");
    write(`dup${String(index)}`, JSON.stringify({ name: "dup" }));
  }
  // Displaced identities: an interrupted resync left each one's identity.json only in a superseded farm, and it names nothing.
  for (let index = 0; index < each; index += 1) {
    const uuid = `00000000-0000-4000-8000-${String(index).padStart(UUID_TAIL_DIGITS, "0")}`;
    fs.mkdirSync(path.join(paths.identitiesDir, `.lost${String(index)}.previous.4242.${uuid}`), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, `.lost${String(index)}.previous.4242.${uuid}`, "identity.json"), "{ not json");
  }
  const real = path.join(home, "shared-real");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "identity.json"), JSON.stringify({ name: "shared" }));
  for (let index = 0; index < each; index += 1) {
    fs.symlinkSync(real, path.join(paths.identitiesDir, `link${String(index)}`));
  }
  fs.mkdirSync(paths.configProfilesDir, { recursive: true });
  for (let index = 0; index < each; index += 1) {
    fs.writeFileSync(path.join(paths.configProfilesDir, `profile${String(index)}.json`), "{}");
  }
  // A usage log whose records reach into the current five-hour window, several for each member: what a pool pick reads for each member.
  const day = new Date().toISOString().slice(0, "YYYY-MM-DD".length);
  const lines = members.flatMap((member) => Array.from({ length: RECORDS_PER_MEMBER }, (_, index) => `${JSON.stringify({ schemaVersion: 1, at: new Date(Date.now() - (index + 1) * MINUTE_MS).toISOString(), identity: member, provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`));
  fs.mkdirSync(paths.usageLogDir, { recursive: true });
  fs.writeFileSync(path.join(paths.usageLogDir, `${day}.1.jsonl`), lines.join(""));
  // Registered front-door sessions, one record each, half of them naming an identity, against a supervisor that is not running: what the door's status and doctor read.
  fs.mkdirSync(paths.frontdoorSessionsDir, { recursive: true });
  for (let index = 0; index < each; index += 1) {
    fs.writeFileSync(path.join(paths.frontdoorSessionsDir, `${String(FIRST_SESSION_PID + index)}.json`), JSON.stringify({ pid: FIRST_SESSION_PID + index, startedAt: Date.now(), token: `token-${String(index)}`, supervisorPid: SUPERVISOR_PID, ...(index % 2 === 0 ? { identity: members[index % members.length] ?? "readable0" } : {}) }));
  }
  // Providers of the kinds that are never probed over the network, one file each.
  fs.mkdirSync(paths.providersDir, { recursive: true });
  for (let index = 0; index < each; index += 1) {
    fs.writeFileSync(path.join(paths.providersDir, `codexp${String(index)}.json`), JSON.stringify({ kind: "codex", displayName: `Codex ${String(index)}`, credential: { sources: [{ literal: "placeholder" }] } }));
  }
  addPool(paths, "wide", members);
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  return paths;
}

/** Runs `run` with the array steps counted, and returns them with the most made between two file system notes. */
function measured(run: () => void): { readonly steps: number; readonly longestGap: number } {
  const meter = startStepMeter();
  let longestGap = 0;
  let sinceNote = 0;
  stopObserving = observeBlockingSteps({
    begin: () => undefined,
    end: () => undefined,
    output: () => undefined,
    unboundedStepLimitMs: 1,
    localWork: () => {
      longestGap = Math.max(longestGap, meter.now() - sinceNote);
      sinceNote = meter.now();
    },
  });
  restoreFileSystem = noteFileSystemWork(fs);
  try {
    run();
  } finally {
    restoreFileSystem();
    restoreFileSystem = undefined;
    stopObserving();
    stopObserving = undefined;
    meter.stop();
  }
  return { steps: meter.now(), longestGap: Math.max(longestGap, meter.now() - sinceNote) };
}

describe("the reports on a farm where every collection is large and degenerate", () => {
  const REPORT_TIMEOUT_MS = 300_000;

  it.each([
    ["check for an identity", REPORT_SIZES, (paths: ReturnType<typeof buildFarm>) => { collectCheckReport({ paths, cwd: path.join(home, "work"), identity: "readable1", env: { ...process.env, HOME: home } }); }],
    ["check for a pool", REPORT_SIZES, (paths: ReturnType<typeof buildFarm>) => { collectCheckReport({ paths, cwd: path.join(home, "work"), identity: "pool:wide", env: { ...process.env, HOME: home } }); }],
    ["doctor", REPORT_SIZES, (paths: ReturnType<typeof buildFarm>) => { collectDoctorReport({ paths, env: { ...process.env, HOME: home } }); }],
  ])("%s makes array steps, and steps between notes, that grow linearly with the farm", (_name, sizes, run) => {
    // One run first, so what a first run loads once (modules, lazily built tables) is not counted against the smallest size.
    const warm = buildFarm(sizes[0]);
    run(warm);
    fs.rmSync(path.join(home, ".agent-shim"), { recursive: true, force: true });
    fs.rmSync(path.join(home, "shared-real"), { recursive: true, force: true });
    const results = sizes.map((size) => {
      const paths = buildFarm(size);
      try {
        return measured(() => { run(paths); });
      } finally {
        fs.rmSync(path.join(home, ".agent-shim"), { recursive: true, force: true });
        fs.rmSync(path.join(home, "shared-real"), { recursive: true, force: true });
      }
    });
    const steps = results.map((result) => result.steps);
    const gaps = results.map((result) => result.longestGap);
    expect(growsLinearly(sizes, [steps[0] ?? 0, steps[1] ?? 0, steps[2] ?? 0]), `steps ${steps.join(", ")}`).toBe(true);
    expect(growsLinearly(sizes, [gaps[0] ?? 0, gaps[1] ?? 0, gaps[2] ?? 0]), `longest steps between notes ${gaps.join(", ")}`).toBe(true);
  }, REPORT_TIMEOUT_MS);
});

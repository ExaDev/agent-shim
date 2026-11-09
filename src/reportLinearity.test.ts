import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noteFileSystemWork, observeBlockingSteps } from "./blockingSteps";
import { collectCheckReport } from "./checkReport";
import { collectDoctorReport } from "./doctorReport";
import { buildLayoutPaths } from "./paths";
import { diamondChainPools, growsLinearly, ringPools, startStepMeter } from "./test-helpers";

/**
 * Each report (`check` for an identity, `check` for a pool, `doctor`) is run against a farm in which every collection the user sizes is large and degenerate at once, with `ps`, `security` and `git` standing in as scripts that answer at once with the output the real ones give, so the code that reads their output runs and not its failure branch. The farm holds: identities with a readable name, with none (a file that is not JSON), all claiming one name, symlinks to one directory and displaced ones (an interrupted resync left their identity.json only in a superseded farm); a usage log of several records for each readable identity; registered front-door sessions, half of them naming an identity; codex providers; a chain of configuration profiles, each extending the next and adding a virtual model, named as the default profile; directory rules, half of them for the directory the reports run in; global `launch`; pools (one of every readable identity, a chain of diamonds, a ring) and jobs on the wide pool; and a models block with virtual models, tiers, hidden targets, `same` and `distinct` assertions, a family pin for each target, and prices. The array steps a report makes (`countSteps`), the blocking steps it begins and the most steps it makes between two file system notes (which is what the door's silence window sees as a stall) must each grow exactly linearly with the farm (`growsLinearly`: counts are deterministic, so the slope may not grow).
 *
 * What this can catch: a pass over a collection nested inside a pass over it that runs through the counted array operations (see `countSteps` for which), over the whole farm, and a command run once for each element. What it cannot see: a quadratic cost that does not run through them, one in native code, and a cost that grows with something other than the farm's size.
 *
 * The scripts are `sh` scripts, so the farm is built for the platforms the tests run on (Linux and macOS); the Windows jobs only build and smoke-test the binary. Not held by the farm, so not measured: the global `walkUpLimit`, `categories`, `entries`, `headroom`, `frontdoor` and `update` keys and a models `show` list; committed `.agent-shim.json` files; identities with a credential block, a provider, a codex login or account metadata; providers of the kinds `http`, `router` and `antigravity`; a `check` for a codex agent; and any command other than `ps`, `security` and `git`, which are the ones the reports ran on this farm when every command was logged. The reports are also run on one shape of each collection: the farm grows by repeating it, so a cost that depends on a different shape (a profile chain that branches, pools that nest unevenly) is covered by the walk tests of `graphWalks.test.ts` and not here.
 */
/** The smallest farm a report is measured at, and the factors of it the next two are: doubling twice, so a pass over a collection inside a pass over it makes the last step cost four times the first. */
const FIRST_FARM = 200;
const DOUBLE = 2;
const QUADRUPLE = 4;
const REPORT_SIZES = [FIRST_FARM, FIRST_FARM * DOUBLE, FIRST_FARM * QUADRUPLE] as const;
const GROUPS = 4;
const UUID_TAIL_DIGITS = 12;
const RECORDS_PER_MEMBER = 5;
const SAME_GROUP_SIZE = 3;
const MINUTE_MS = 60_000;
const FIRST_SESSION_PID = 400_000;
const SUPERVISOR_PID = 399_999;
const FIRST_UNRELATED_PID = 500_000;
/** The limit a blocking step gets when its caller names none: far above what a stub takes, so a step that exceeds it is stuck and not slow. */
const UNBOUNDED_STEP_LIMIT_MS = 30_000;
/** How many identities of the farm there are for each level of the diamond chain of pools, and for each job and each directory rule. */
const IDENTITIES_PER_LEVEL = 10;
const IDENTITIES_PER_JOB = 2;
const IDENTITIES_PER_RULE = 2;
const STUB_MODE = 0o755;


/**
 * The stubbed commands, by name. `ps` prints the listing the farm wrote beside it (what `ps -E` prints on macOS: a pid, a parent pid, the command and its environment). `security` (asked on macOS only) finds the item of every service whose hash ends in an even hex digit and reports the rest missing, as the Keychain does; elsewhere a login is a `.credentials.json` file, which the farm writes for every second readable identity so both answers occur on every platform. `git` answers the branch query only.
 */
const STUBS: Readonly<Record<string, string>> = {
  ps: 'cat "$(dirname "$0")/ps.out"',
  security: 'service=""\nwhile [ $# -gt 0 ]; do\n  [ "$1" = "-s" ] && service="$2"\n  shift\ndone\ncase "${service#"${service%?}"}" in\n  0|2|4|6|8|a|c|e) printf \'keychain: "login.keychain-db"\\nclass: "genp"\\n\'; exit 0 ;;\n  *) echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44 ;;\nesac',
  git: 'case "$*" in\n  *rev-parse*--abbrev-ref*) echo main ;;\n  *) echo "fatal: not supported by the stub" >&2; exit 128 ;;\nesac',
};

/** The other commands the package spawns, stubbed to log that they were run and to fail, so the claim that the reports run none of them is tested and not only stated. */
const UNREACHED_COMMANDS = ["launchctl", "mise", "codex", "uv", "headroom", "ssh", "stty", "claude"] as const;
const UNREACHED_LOG = "unreached.log";

let home: string;
let previousHome: string | undefined;
let previousPath: string | undefined;
let restoreFileSystem: (() => void) | undefined;
let stopObserving: (() => void) | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "report-linearity-"));
  previousHome = process.env.HOME;
  previousPath = process.env.PATH;
  process.env.HOME = home;
  // The commands the reports run (`ps`, `security`, `git`) are stubs that answer at once with the output the real ones give, so the code that reads their output runs instead of its failure branch.
  const stubs = path.join(home, "stubs");
  fs.mkdirSync(stubs, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: STUB_MODE });
  }
  for (const name of UNREACHED_COMMANDS) {
    fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\necho ${name} >> "$(dirname "$0")/${UNREACHED_LOG}"\nexit 1\n`, { mode: STUB_MODE });
  }
  process.env.PATH = `${stubs}${path.delimiter}${previousPath ?? ""}`;
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
  if (previousPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
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
    // A stored login in the file Claude Code keeps on every platform, for every second identity; macOS also asks the Keychain, whose stub answers for some of the rest.
    if (index % IDENTITIES_PER_RULE === 0) {
      fs.writeFileSync(path.join(paths.identitiesDir, `readable${String(index)}`, ".credentials.json"), "{}");
    }
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
  // Profiles in one chain, each extending the next and adding a virtual model of its own, so resolving the default profile follows the whole chain and merges a models block at each link.
  fs.mkdirSync(paths.configProfilesDir, { recursive: true });
  for (let index = 0; index < each; index += 1) {
    fs.writeFileSync(path.join(paths.configProfilesDir, `profile${String(index)}.json`), JSON.stringify({
      ...(index + 1 < each ? { extends: [`profile${String(index + 1)}`] } : {}),
      launch: { trackUsage: true },
      models: { virtual: { [`pv${String(index)}`]: { mode: "ordered", members: [`codexp${String(index)}/model-${String(index)}`] } } },
    }));
  }
  // Directory rules: half of them for the directory the reports run in, each applying a profile and a launch setting, the rest for other directories.
  fs.writeFileSync(paths.directoryRulesFile, JSON.stringify({
    rules: Array.from({ length: each }, (_, index) => ({ path: index % 2 === 0 ? path.join(home, "work") : path.join(home, `elsewhere${String(index)}`), configProfile: `profile${String(each - 1)}`, launch: { delay: "1s" } })),
  }));
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
  // What `ps -E` prints: one session of Claude Code for each registered front-door session, running against an identity's configuration directory, and some processes that are none of them.
  const listing = [
    ...Array.from({ length: each }, (_, index) => `${String(FIRST_SESSION_PID + index)} 1 /usr/local/bin/claude --resume CLAUDE_CONFIG_DIR=${path.join(paths.identitiesDir, members[index % members.length] ?? "readable0")} HOME=${home}`),
    ...Array.from({ length: each }, (_, index) => `${String(FIRST_UNRELATED_PID + index)} 1 /usr/bin/unrelated-${String(index)} HOME=${home}`),
  ];
  fs.writeFileSync(path.join(home, "stubs", "ps.out"), `${listing.join("\n")}\n`);
  // Providers of the kinds that are never probed over the network, one file each.
  fs.mkdirSync(paths.providersDir, { recursive: true });
  for (let index = 0; index < each; index += 1) {
    fs.writeFileSync(path.join(paths.providersDir, `codexp${String(index)}.json`), JSON.stringify({ kind: "codex", displayName: `Codex ${String(index)}`, credential: { sources: [{ literal: "placeholder" }] } }));
  }
  // A models block as large as the farm: a virtual model naming every provider's target, one virtual model for each identity, a `same` assertion over each three targets, a `distinct` assertion between neighbours, a family pin for each target, tier pointers, hidden targets and prices for every target. Groups are small as a person writes them; it is their number that grows.
  const targets = Array.from({ length: each }, (_, index) => `codexp${String(index)}/model-${String(index)}`);
  const triples = Array.from({ length: Math.floor(each / SAME_GROUP_SIZE) }, (_, index) => targets.slice(index * SAME_GROUP_SIZE, (index + 1) * SAME_GROUP_SIZE));
  // Pools: one of every readable identity, a chain of diamonds of them (the paths through it double with each level) and a ring, which `pool add` refuses and a hand-edited file can hold. One job for each pair of identities runs on the wide pool before its five-hour window resets.
  const levels = Math.floor(each / IDENTITIES_PER_LEVEL);
  const jobs = Object.fromEntries(Array.from({ length: Math.floor(each / IDENTITIES_PER_JOB) }, (_, index) => [`job${String(index)}`, { target: { pool: "wide" }, trigger: { beforeReset: "fiveHour", lead: "10m" }, prompt: "summarise", cwd: path.join(home, "work"), timeout: "1h" }]));
  fs.writeFileSync(paths.globalConfigFile, JSON.stringify({
    defaultConfigProfile: "profile0",
    launch: { trackUsage: true },
    pools: { wide: { identities: members }, ...diamondChainPools(levels, (side, level) => members[(level * IDENTITIES_PER_LEVEL + (side === "a" ? 1 : 2)) % members.length] ?? "readable0"), ...ringPools(Math.floor(each / IDENTITIES_PER_RULE)) },
    jobs,
    models: {
      pickerLabelSpaces: true,
      virtual: { wide: { mode: "cheapest", members: targets }, ...Object.fromEntries(members.map((member) => [`v-${member}`, { mode: "ordered", members: [targets[0] ?? "x/y", `acct:${member}/opus`] }])) },
      tiers: { opus: "wide", sonnet: targets[0] ?? "x/y" },
      hide: targets.filter((_, index) => index % IDENTITIES_PER_RULE === 0),
      same: triples,
      distinct: targets.slice(1).map((target, index) => [targets[index] ?? "x/y", target]),
      families: Object.fromEntries(targets.map((target, index) => [`family-${String(index)}`, { names: [target], mode: "ordered" }])),
      prices: Object.fromEntries(targets.map((target) => [target, { input: 1, output: 2 }])),
    },
  }));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  return paths;
}

/** Runs `run` with the array steps counted, and returns them with the most made between two file system notes. */
function measured(run: () => void): { readonly steps: number; readonly longestGap: number; readonly commands: number } {
  const meter = startStepMeter();
  let longestGap = 0;
  let sinceNote = 0;
  let commands = 0;
  stopObserving = observeBlockingSteps({
    begin: () => { commands += 1; },
    end: () => undefined,
    output: () => undefined,
    unboundedStepLimitMs: UNBOUNDED_STEP_LIMIT_MS,
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
  return { steps: meter.now(), longestGap: Math.max(longestGap, meter.now() - sinceNote), commands };
}

describe("the reports on a farm where every collection is large and degenerate", () => {
  const REPORT_TIMEOUT_MS = 300_000;

  it.each([
    ["check for an identity", REPORT_SIZES, (paths: ReturnType<typeof buildFarm>) => { collectCheckReport({ paths, cwd: path.join(home, "work"), identity: "readable1", env: { ...process.env, HOME: home } }); }],
    ["check for a pool", REPORT_SIZES, (paths: ReturnType<typeof buildFarm>) => { collectCheckReport({ paths, cwd: path.join(home, "work"), identity: "pool:wide", env: { ...process.env, HOME: home } }); }],
    ["doctor", REPORT_SIZES, (paths: ReturnType<typeof buildFarm>) => { collectDoctorReport({ paths, env: { ...process.env, HOME: home } }); }],
  ])("%s makes array steps, blocking steps and steps between notes that grow linearly with the farm", (_name, sizes, run) => {
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
    const commands = results.map((result) => result.commands);
    expect(growsLinearly(sizes, [steps[0] ?? 0, steps[1] ?? 0, steps[2] ?? 0]), `steps ${steps.join(", ")}`).toBe(true);
    expect(growsLinearly(sizes, [gaps[0] ?? 0, gaps[1] ?? 0, gaps[2] ?? 0]), `longest steps between notes ${gaps.join(", ")}`).toBe(true);
    expect(growsLinearly(sizes, [commands[0] ?? 0, commands[1] ?? 0, commands[2] ?? 0]), `blocking steps ${commands.join(", ")}`).toBe(true);
  }, REPORT_TIMEOUT_MS);

  it("runs the stubbed commands, so both the found and the missing answer of each is read", () => {
    const paths = buildFarm(FIRST_FARM);
    const report = collectDoctorReport({ paths, env: { ...process.env, HOME: home } });
    const text = JSON.stringify(report);
    // A login file is there for some identities and not for others (and on macOS the `security` stub finds the item of some of the rest), so the doctor reports both on every platform.
    expect(text).toContain("signed in");
    expect(text).toContain("signed out");
  });

  it("runs none of the other commands the package spawns", () => {
    const paths = buildFarm(FIRST_FARM);
    const env = { ...process.env, HOME: home };
    collectCheckReport({ paths, cwd: path.join(home, "work"), identity: "readable1", env });
    collectCheckReport({ paths, cwd: path.join(home, "work"), identity: "pool:wide", env });
    collectDoctorReport({ paths, env });
    expect(fs.existsSync(path.join(home, "stubs", UNREACHED_LOG))).toBe(false);
  });
});

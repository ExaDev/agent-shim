import { describe, expect, it } from "vitest";

import type { Pool } from "./config/schema";
import type { FarmRuntime } from "./launcher";
import { PROMPT_CACHE_TTL_MS } from "./usage/pick";
import { FAKE_NOW_MS, createFakeFarmFs, discovered, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv } from "./test-helpers";

const HOUR_MS = 3_600_000;
const SIX_DAYS_MS = 518_400_000;
const TWO_HOURS_MS = 7_200_000;
const FIVE_MINUTES_MS = 300_000;
const MAX_20X = "default_claude_max_20x";
const FRONTDOOR_PORT = 4100;
const U10 = 0.1;
const U60 = 0.6;
const FULL = 1;

const snapshotPath = (identity: string): string => `${paths.usageSnapshotsDir}/${identity}.json`;
const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

interface SevenDay {
  readonly utilization: number;
  readonly resetsInMs: number;
  readonly status?: string;
}

function snapshotOf(identity: string, sevenDay: SevenDay): string {
  const seen = iso(-HOUR_MS);
  return JSON.stringify({
    schemaVersion: 1,
    identity,
    updatedAt: seen,
    account: { organizationRateLimitTier: MAX_20X },
    providers: {
      anthropic: {
        lastRequestAt: seen,
        lastStatus: 200,
        rateLimit: { observedAt: seen, headers: {}, unified: { sevenDay: { utilization: sevenDay.utilization, resetsAt: iso(sevenDay.resetsInMs), ...(sevenDay.status === undefined ? {} : { status: sevenDay.status }) } } },
      },
    },
  });
}

/** `work` expires its quota tonight and `personal` has plenty but a week away, so the pool should pick `work`. */
const WORK_SOON = { [snapshotPath("work")]: snapshotOf("work", { utilization: U60, resetsInMs: HOUR_MS }), [snapshotPath("personal")]: snapshotOf("personal", { utilization: U10, resetsInMs: SIX_DAYS_MS }) };

const POOLS = { main: { identities: ["work", "personal"] } };

interface Launch {
  readonly log: ReturnType<typeof fakeLog>;
  readonly code: number;
  readonly spawn: ReturnType<typeof fakeSpawn>;
  readonly frontdoor: ReturnType<typeof fakeFrontDoorPort>;
  readonly farmFs: ReturnType<typeof createFakeFarmFs>;
}

function launch(options: { readonly seed?: Readonly<Record<string, string>>; readonly argv?: readonly string[]; readonly env?: Record<string, string>; readonly pools?: Readonly<Record<string, Pool>> | undefined; readonly farm?: (base: FarmRuntime) => FarmRuntime; readonly farmFs?: ReturnType<typeof createFakeFarmFs>; readonly files?: Record<string, unknown> } = {}): Launch {
  const farmFs = options.farmFs ?? createFakeFarmFs(options.seed ?? WORK_SOON);
  const log = fakeLog();
  const spawn = fakeSpawn();
  const frontdoor = fakeFrontDoorPort(FRONTDOOR_PORT);
  const base = fakeFarm(farmFs);
  const code = runAndCaptureExit({
    paths,
    fs: fakeFs(options.files ?? {}),
    spawn,
    proc: fakeProc(options.env ?? {}, options.argv ?? ["@pool:main", "--print"]),
    log,
    resolveClaudeBinary: () => discovered,
    farm: options.farm === undefined ? base : options.farm(base),
    frontdoor,
    ...(options.pools === undefined && "pools" in options ? {} : { pools: options.pools ?? POOLS }),
  });
  return { log, code, spawn, frontdoor, farmFs };
}

describe("runLauncher with a pool selector", () => {
  it("launches as the member whose quota expires soonest, and says why on the decision line", () => {
    const { log, code, spawn } = launch();
    expect(code).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
    const decision = log.infos.find((line) => line.includes("identity work"));
    expect(decision).toContain("pool main:");
    expect(decision).toContain("7d 60% used");
  });

  it("takes a pool from AGENT_SHIM_IDENTITY and from --identity", () => {
    expect(spawnedEnv(launch({ argv: ["--print"], env: { AGENT_SHIM_IDENTITY: "pool:main" } }).spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
    expect(spawnedEnv(launch({ argv: ["--identity", "pool:main", "--print"] }).spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
  });

  it("launches as the first listed member when the pool prefers listed order", () => {
    const listed = launch({ pools: { main: { identities: ["personal", "work"], preference: "listed" } } });
    expect(listed.code).toBe(0);
    expect(spawnedEnv(listed.spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
  });

  it("takes a pool from the active-identity file", () => {
    const active = launch({ argv: ["--print"], files: { [paths.activeIdentityFile]: "pool:main\n" } });
    expect(spawnedEnv(active.spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
  });

  it("turns usage tracking on for a pool launch, and lets --no-track-usage turn it off", () => {
    const tracked = launch();
    expect(tracked.frontdoor.ensures()).toBe(1);
    const untracked = launch({ argv: ["@pool:main", "--no-track-usage", "--print"] });
    expect(untracked.frontdoor.ensures()).toBe(0);
  });

  it("refuses a pool that is not defined, naming how to define it", () => {
    const { log, code, spawn } = launch({ argv: ["@pool:nope", "--print"] });
    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain('no pool named "nope"');
    expect(log.errors[0]).toContain("pool add nope");
  });

  it("skips a member that is not an identity, with a warning, and refuses when none is", () => {
    const partial = launch({ pools: { main: { identities: ["ghost", "personal"] } } });
    expect(partial.code).toBe(0);
    expect(spawnedEnv(partial.spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
    expect(partial.log.warns.join("\n")).toContain('names identity "ghost", which does not exist');
    const none = launch({ pools: { main: { identities: ["ghost"] } } });
    expect(none.code).toBe(1);
    expect(none.log.errors[0]).toContain("no member of pool");
  });

  it("ignores the pool when CLAUDE_CONFIG_DIR is already set", () => {
    const { code, spawn, log } = launch({ env: { CLAUDE_CONFIG_DIR: "/elsewhere" } });
    expect(code).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe("/elsewhere");
    expect(log.infos.join("\n")).not.toContain("pool main");
  });

  describe("when every member is refused", () => {
    const refused = { [snapshotPath("work")]: snapshotOf("work", { utilization: FULL, resetsInMs: TWO_HOURS_MS, status: "rejected" }), [snapshotPath("personal")]: snapshotOf("personal", { utilization: FULL, resetsInMs: HOUR_MS, status: "rejected" }) };

    it("refuses, naming the earliest return and --wait", () => {
      const { log, code, spawn } = launch({ seed: refused });
      expect(code).toBe(1);
      expect(spawn.spawnSync).not.toHaveBeenCalled();
      expect(log.errors[0]).toContain("personal, returns at");
      expect(log.errors[0]).toContain("--wait");
    });

    it("sleeps until the earliest member returns under --wait, then launches as it", () => {
      let clock = FAKE_NOW_MS;
      const slept: number[] = [];
      const { code, spawn, log } = launch({
        seed: refused,
        argv: ["@pool:main", "--wait", "--print"],
        farm: (base) => ({
          ...base,
          now: () => clock,
          lock: {
            ...base.lock,
            sleep: (ms) => {
              slept.push(ms);
              clock += ms;
            },
          },
        }),
      });
      expect(code).toBe(0);
      expect(slept).toEqual([HOUR_MS]);
      expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
      expect(log.infos.join("\n")).toContain("waiting until");
    });
  });

  describe("keeping the account whose prompt cache is warm", () => {
    /** Runs two launches in one directory over one filesystem; between them the other member becomes the better pick. */
    function twoLaunches(secondAtMs: number, secondArgv: readonly string[]): { readonly first: Launch; readonly second: Launch } {
      const farmFs = createFakeFarmFs(WORK_SOON);
      const first = launch({ farmFs });
      farmFs.writeFileUtf8(snapshotPath("work"), snapshotOf("work", { utilization: U60, resetsInMs: SIX_DAYS_MS }));
      farmFs.writeFileUtf8(snapshotPath("personal"), snapshotOf("personal", { utilization: U10, resetsInMs: HOUR_MS }));
      const second = launch({ farmFs, argv: secondArgv, farm: (base) => ({ ...base, now: () => FAKE_NOW_MS + secondAtMs }) });
      return { first, second };
    }
    it("stays on the last pick while the cache is warm", () => {
      const { first, second } = twoLaunches(FIVE_MINUTES_MS, ["@pool:main", "--print"]);
      expect(spawnedEnv(first.spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
      expect(spawnedEnv(second.spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
      expect(second.log.infos.join("\n")).toContain("prompt cache still warm");
    });

    it("re-ranks once the cache has gone cold", () => {
      const { second } = twoLaunches(PROMPT_CACHE_TTL_MS + FIVE_MINUTES_MS, ["@pool:main", "--print"]);
      expect(spawnedEnv(second.spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
    });

    it("keeps the last pick for a resumed conversation however long ago it was", () => {
      const { second } = twoLaunches(PROMPT_CACHE_TTL_MS + FIVE_MINUTES_MS, ["@pool:main", "--resume"]);
      expect(spawnedEnv(second.spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
      expect(second.log.infos.join("\n")).toContain("resuming a conversation");
    });

    it("does not treat --resume after a -- terminator as claude's own", () => {
      const { second } = twoLaunches(PROMPT_CACHE_TTL_MS + FIVE_MINUTES_MS, ["@pool:main", "--", "mcp", "--resume"]);
      expect(spawnedEnv(second.spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
    });
  });
});

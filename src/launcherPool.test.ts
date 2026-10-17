import { describe, expect, it } from "vitest";

import type { Pool } from "./config/schema";
import { prepareLaunch, type FarmRuntime, type LaunchDecision } from "./launcher";
import type { SupervisedLaunch } from "./launcher/claudeSession";
import { PROMPT_CACHE_TTL_MS } from "./usage/pick";
import { FAKE_NOW_MS, createFakeFarmFs, discovered, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv, reportedRow } from "./test-helpers";

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

function snapshotOf(identity: string, sevenDay: SevenDay, overage?: string): string {
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
        rateLimit: { observedAt: seen, headers: {}, unified: { sevenDay: { utilization: sevenDay.utilization, resetsAt: iso(sevenDay.resetsInMs), ...(sevenDay.status === undefined ? {} : { status: sevenDay.status }) }, ...(overage === undefined ? {} : { overageStatus: overage }) } },
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

/** The decision of a pool launch over `farmFs`, made the way `launch` makes its own. */
function decisionOf(farmFs: ReturnType<typeof createFakeFarmFs>, argv: readonly string[], nowOffsetMs = 0): LaunchDecision {
  const base = fakeFarm(farmFs);
  return prepareLaunch({
    paths,
    fs: fakeFs({}),
    proc: fakeProc({}, argv),
    log: fakeLog(),
    resolveClaudeBinary: () => discovered,
    farm: { ...base, now: () => FAKE_NOW_MS + nowOffsetMs },
    frontdoor: fakeFrontDoorPort(FRONTDOOR_PORT),
    pools: POOLS,
  }).decision;
}

describe("the decision of a pool launch", () => {
  it("names the pool, the member it picked and every reason the ranking gave", () => {
    const decision = decisionOf(createFakeFarmFs(WORK_SOON), ["@pool:main", "--print"]);
    expect(decision).toMatchObject({ identity: "work", identitySource: "argv", configDir: `${paths.identitiesDir}/work`, pool: { name: "main" } });
    expect(decision.pool?.reasons.join("\n")).toContain("7d 60% used");
    expect(decision.pool?.movedOff).toBeUndefined();
  });

  it("names the member a resumed conversation moved off, and why", () => {
    const farmFs = createFakeFarmFs(WORK_SOON);
    launch({ farmFs });
    farmFs.writeFileUtf8(snapshotPath("work"), snapshotOf("work", { utilization: 1, resetsInMs: SIX_DAYS_MS, status: "rejected" }, "allowed"));
    farmFs.writeFileUtf8(snapshotPath("personal"), snapshotOf("personal", { utilization: U10, resetsInMs: HOUR_MS }));
    const decision = decisionOf(farmFs, ["@pool:main", "--resume"], PROMPT_CACHE_TTL_MS + FIVE_MINUTES_MS);
    expect(decision.identity).toBe("personal");
    expect(decision.pool?.movedOff).toMatchObject({ identity: "work" });
    expect(decision.pool?.movedOff?.reason).toContain("continues as extra usage");
  });

  it("carries no pool for a launch that named an identity", () => {
    expect(decisionOf(createFakeFarmFs(WORK_SOON), ["@work", "--print"]).pool).toBeUndefined();
  });
});

describe("runLauncher with a pool selector", () => {
  it("launches as the member whose quota expires soonest, and says why in the pool row", () => {
    const { log, code, spawn } = launch();
    expect(code).toBe(0);
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
    const pool = reportedRow(log, "pool");
    expect(pool?.value).toBe("main");
    expect(pool?.detail).toContain("7d 60% used");
  });

  it("lists every member the pick ranked, with the one picked marked, when the launch asks to explain it", () => {
    const { log } = launch({ argv: ["@pool:main", "--explain", "--print"] });

    const notes = reportedRow(log, "pool")?.notes ?? [];
    expect(notes.filter((line) => /^\d+\. /.test(line))).toEqual([expect.stringContaining("work [scored"), expect.stringContaining("personal [scored")]);
    expect(notes[0]).toContain("(picked)");
    expect(notes.join("\n")).not.toContain("personal [scored score 0.00 by 7d reset] (picked)");
    expect(notes[1]).toContain("7d 60% used");
  });

  it("names no member beyond the one picked when the launch does not ask", () => {
    expect(reportedRow(launch().log, "pool")).not.toHaveProperty("notes");
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

  it("falls back to a nested pool's pick when a listed pool's first member is refused", () => {
    const seed = {
      [snapshotPath("personal")]: snapshotOf("personal", { utilization: FULL, resetsInMs: TWO_HOURS_MS, status: "rejected" }),
      [snapshotPath("work")]: snapshotOf("work", { utilization: U60, resetsInMs: HOUR_MS }),
    };
    const nested = launch({ seed, pools: { main: { identities: ["personal", "pool:fleet"], preference: "listed" }, fleet: { identities: ["work"] } } });
    expect(nested.code).toBe(0);
    expect(spawnedEnv(nested.spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
    const pool = reportedRow(nested.log, "pool");
    expect(pool?.value).toBe("main");
    expect(pool?.detail).toContain('picked by pool "fleet"');
  });

  it("refuses a launch whose pool graph is a cycle or names an undefined pool", () => {
    const cycle = launch({ pools: { main: { identities: ["pool:main"] } } });
    expect(cycle.code).toBe(1);
    expect(cycle.log.errors[0]).toContain("main -> main");
    const missing = launch({ pools: { main: { identities: ["pool:fleet"] }, other: { identities: ["work"] } } });
    expect(missing.code).toBe(1);
    expect(missing.log.errors[0]).toContain('names a pool that is not defined');
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

  describe("when every plan is exhausted but extra usage is allowed", () => {
    // `personal` returns first; both would otherwise continue on extra usage.
    const exhausted = {
      [snapshotPath("work")]: snapshotOf("work", { utilization: FULL, resetsInMs: TWO_HOURS_MS, status: "rejected" }, "allowed"),
      [snapshotPath("personal")]: snapshotOf("personal", { utilization: FULL, resetsInMs: HOUR_MS, status: "rejected" }, "allowed"),
    };

    it("continues on extra usage straight away without --wait, saying when the plan returns", () => {
      const { code, spawn, log } = launch({ seed: exhausted, argv: ["@pool:main", "--print"] });
      expect(code).toBe(0);
      expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
      expect(log.infos.join("\n")).toContain("plan exhausted until");
    });

    it("sleeps until the earliest plan window resets under --wait, then launches on plan quota", () => {
      let clock = FAKE_NOW_MS;
      const slept: number[] = [];
      const { code, spawn, log } = launch({
        seed: exhausted,
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
      expect(log.infos.join("\n")).toContain("on extra usage; waiting until");
      expect(log.infos.join("\n")).not.toContain("plan exhausted until");
    });
  });

  describe("when the pick would run dry before its window resets and another member returns first", () => {
    const FOUR_HOURS_MS = 14_400_000;
    const HALF_HOUR_MS = 1_800_000;
    const TEN_MINUTES_MS = 600_000;
    const U50 = 0.5;
    const U80 = 0.8;
    const MS_PER_SECOND = 1000;
    const DAY_LENGTH = 10;
    const epoch = (offsetMs: number): string => String(Math.floor((FAKE_NOW_MS + offsetMs) / MS_PER_SECOND));
    const logRecord = (agoMs: number, utilization: number): string =>
      JSON.stringify({
        schemaVersion: 1,
        at: iso(-agoMs),
        identity: "work",
        provider: "anthropic",
        route: "anthropic",
        method: "POST",
        endpoint: "/v1/messages",
        status: 200,
        latencyMs: 1,
        durationMs: 1,
        outcome: "completed",
        rateLimitHeaders: { "anthropic-ratelimit-unified-5h-utilization": String(utilization), "anthropic-ratelimit-unified-5h-reset": epoch(FOUR_HOURS_MS) },
      });
    const seen = iso(-HOUR_MS);
    const hotSnapshot = JSON.stringify({
      schemaVersion: 1,
      identity: "work",
      updatedAt: seen,
      account: { organizationRateLimitTier: MAX_20X },
      providers: { anthropic: { lastRequestAt: seen, lastStatus: 200, rateLimit: { observedAt: seen, headers: {}, unified: { fiveHour: { utilization: U80, resetsAt: iso(FOUR_HOURS_MS) }, sevenDay: { utilization: U10, resetsAt: iso(SIX_DAYS_MS) } } } } },
    });
    const seed = {
      [snapshotPath("work")]: hotSnapshot,
      [snapshotPath("personal")]: snapshotOf("personal", { utilization: FULL, resetsInMs: TEN_MINUTES_MS, status: "rejected" }),
      [`${paths.usageLogDir}/${new Date(FAKE_NOW_MS).toISOString().slice(0, DAY_LENGTH)}.1.jsonl`]: `${logRecord(HALF_HOUR_MS, U50)}\n${logRecord(0, U80)}\n`,
    };

    it("launches on the pick straight away without --wait", () => {
      const { code, spawn } = launch({ seed, argv: ["@pool:main", "--print"] });
      expect(code).toBe(0);
      expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
    });

    it("sleeps until the returning member is back under --wait, then launches as it", () => {
      let clock = FAKE_NOW_MS;
      const slept: number[] = [];
      const { code, spawn, log } = launch({
        seed,
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
      expect(slept).toEqual([TEN_MINUTES_MS]);
      expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
      expect(log.infos.join("\n")).toContain("would run dry before its window resets; waiting until");
    });
  });

  describe("keeping the account whose prompt cache is warm", () => {
    /** Runs two launches in one directory over one filesystem; between them the other member becomes the better pick. */
    function twoLaunches(secondAtMs: number, secondArgv: readonly string[], between?: (farmFs: ReturnType<typeof createFakeFarmFs>) => void): { readonly first: Launch; readonly second: Launch } {
      const farmFs = createFakeFarmFs(WORK_SOON);
      const first = launch({ farmFs });
      farmFs.writeFileUtf8(snapshotPath("work"), snapshotOf("work", { utilization: U60, resetsInMs: SIX_DAYS_MS }));
      farmFs.writeFileUtf8(snapshotPath("personal"), snapshotOf("personal", { utilization: U10, resetsInMs: HOUR_MS }));
      between?.(farmFs);
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

    it("says in the pool row which member a resumed conversation moved off, and why", () => {
      // Between the launches, the member the conversation started on exhausts its plan and keeps serving on extra usage: stickiness yields, the conversation continues on the other member, and the line names the move.
      const { second } = twoLaunches(PROMPT_CACHE_TTL_MS + FIVE_MINUTES_MS, ["@pool:main", "--resume"], (farmFs) => {
        farmFs.writeFileUtf8(snapshotPath("work"), snapshotOf("work", { utilization: 1, resetsInMs: SIX_DAYS_MS, status: "rejected" }, "allowed"));
      });
      expect(spawnedEnv(second.spawn).CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
      const pool = reportedRow(second.log, "pool");
      expect(pool?.detail).toContain("moved off work: ");
      expect(pool?.detail).toContain("continues as extra usage");
    });
  });

  describe("a supervised launch", () => {
    const SESSION = "33333333-3333-4333-8333-333333333333";

    /** The plan a pool launch makes under a supervising launcher, over the pool state `launch` uses. */
    function planOf(argv: readonly string[], supervised?: SupervisedLaunch): ReturnType<typeof prepareLaunch> {
      return prepareLaunch({
        paths,
        fs: fakeFs({}),
        proc: fakeProc({}, argv),
        log: fakeLog(),
        resolveClaudeBinary: () => discovered,
        farm: fakeFarm(createFakeFarmFs(WORK_SOON)),
        frontdoor: fakeFrontDoorPort(FRONTDOOR_PORT),
        pools: POOLS,
        ...(supervised === undefined ? {} : { supervised }),
      });
    }

    it("carries the session id it was given and tells claude to start the conversation under it", () => {
      const plan = planOf(["@pool:main", "--model", "opus"], { sessionId: SESSION, conversation: "start" });
      expect(plan.sessionId).toBe(SESSION);
      expect(plan.args.join(" ")).toMatch(new RegExp(`--session-id ${SESSION}$`));
      expect(plan.env.CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
      expect(plan.decision.pool?.name).toBe("main");
    });

    it("draws a fresh session id and leaves claude's arguments alone when no launcher supervises", () => {
      const plan = planOf(["@pool:main", "--model", "opus"]);
      expect(plan.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(plan.args).not.toContain("--session-id");
      expect(plan.args.join(" ")).toMatch(/--model opus$/);
    });

    it("keeps a --resume the person named, as given, under that id", () => {
      const plan = planOf(["@pool:main", "--resume", SESSION], { sessionId: SESSION, conversation: "as-given" });
      expect(plan.sessionId).toBe(SESSION);
      expect(plan.args.filter((arg) => arg === "--resume")).toHaveLength(1);
      expect(plan.args).not.toContain("--session-id");
    });

    it("runs a relaunch as the member it was given, without a pick, and resumes the conversation", () => {
      // The ranking would still choose `work`; the supervising launcher has chosen `personal` under its own lock.
      const plan = planOf(["@pool:main", "--continue", "--model", "opus"], { sessionId: SESSION, conversation: "resume", member: "personal" });
      expect(plan.env.CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
      expect(plan.args.join(" ")).toMatch(new RegExp(`--model opus --resume ${SESSION}$`));
      expect(plan.args).not.toContain("--continue");
      expect(plan.decision.pool).toEqual({ name: "main", reasons: ["resumed here by the supervising launcher after the previous member ran out of quota"] });
    });
  });
});

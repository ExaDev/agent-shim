import * as http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { checkReportToJson, runCheck, type CheckReport, type RunCheckParams } from "../checkReport";
import type { DoctorReport } from "../doctorReport";
import type { CascadeInput } from "../resolve/walk";
import { createFakeFarmFs, FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, shippedClassification } from "../test-helpers";
import { USAGE_SCHEMA_VERSION, type UsageSnapshot } from "../usage/schema";
import { type ControlApiClient, createControlApiRouter, type ControlApiDeps } from "./controlApi";
import type { RcLiveRateLimit } from "./rcSchemas";
import { rcSessionNotObservedMessage } from "./rcWrites";
import { RC_ORPC_PATH_PREFIX, doorApiNodeHandlerOf } from "./rcApi";
import type { FrontDoorStatus } from "./status";

/** The token the router under test accepts, standing in for the door's per-generation file-backed token. */
const CONTROL_TOKEN = "unit-control-token";
/** The instant every window read in these tests happens at, so reset boundaries are stated as instants around it rather than as magic offsets. */
const NOW_MS = Date.parse("2026-10-05T12:00:00.000Z");
/** One hour in milliseconds, the unit the reset boundaries below are stated in. */
const HOUR_MS = 3_600_000;
/** The milliseconds in one second, the unit that converts the fixed ISO instants into the unix epoch seconds the payload states. */
const MS_PER_SECOND = 1_000;
/** How much of each window the fixed snapshot reports as used, so the assertions name fractions rather than bare numbers. */
const FIVE_HOUR_UTILIZATION = 0.4;
const SEVEN_DAY_UTILIZATION = 0.9;
/** The supervisor and launcher pids the fixed status carries. */
const SUPERVISOR_PID = 10;
const LIVE_LAUNCH_PID = 20;
const DEAD_LAUNCH_PID = 21;
const PROVIDER_PORT = 4100;
const CONNECT_PORT = 4200;

/** A cascade with no configured layers at all, the same stand-in `check`'s own tests use. */
function emptyCascade(): CascadeInput {
  return { home: FAKE_HOME, loadProfile: () => undefined };
}

/** The minimal `runCheck` input, the same stand-in `check`'s own tests use, so the report the check procedure returns is a real one rather than a hand-built lookalike. */
function baseCheckParams(overrides: Partial<RunCheckParams> = {}): RunCheckParams {
  return {
    cwd: `${FAKE_HOME}/work`,
    home: FAKE_HOME,
    claudeHome: FAKE_CLAUDE_HOME,
    env: {},
    nowMs: FAKE_NOW_MS,
    farmFs: createFakeFarmFs({ [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "content", [`${FAKE_CLAUDE_HOME}/.credentials.json`]: "secret" }),
    cascade: emptyCascade(),
    classification: { defaults: shippedClassification },
    identitySource: "none",
    configProfileSource: "none",
    settingsFiles: {},
    platform: "linux",
    ...overrides,
  };
}

/** One identity's snapshot, with the anthropic rate-limit state carrying both unified windows. */
function snapshotOf(identity: string, overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    identity,
    updatedAt: new Date(NOW_MS - HOUR_MS).toISOString(),
    providers: {
      anthropic: {
        lastRequestAt: new Date(NOW_MS - HOUR_MS).toISOString(),
        lastStatus: 200,
        rateLimit: {
          observedAt: new Date(NOW_MS - HOUR_MS).toISOString(),
          headers: {},
          unified: {
            fiveHour: { utilization: FIVE_HOUR_UTILIZATION, resetsAt: new Date(NOW_MS + HOUR_MS).toISOString(), status: "allowed_warning" },
            sevenDay: { utilization: SEVEN_DAY_UTILIZATION, resetsAt: new Date(NOW_MS - HOUR_MS).toISOString(), status: "rejected" },
          },
        },
      },
    },
    ...overrides,
  };
}

const SNAPSHOTS: readonly UsageSnapshot[] = [snapshotOf("personal"), snapshotOf("work")];

const STATUS: FrontDoorStatus = {
  state: { supervisorPid: SUPERVISOR_PID, port: PROVIDER_PORT, lastPort: PROVIDER_PORT, connectPort: CONNECT_PORT, lastConnectPort: CONNECT_PORT },
  supervisorAlive: true,
  sessions: [
    { pid: LIVE_LAUNCH_PID, startedAt: 0, alive: true },
    { pid: DEAD_LAUNCH_PID, startedAt: 0, alive: false },
  ],
  headroomSocket: { socketPath: "/home/testuser/.agent-shim/headroom/socket/30.sock" },
  logPath: "/home/testuser/.agent-shim/logs/frontdoor.log",
  logExists: false,
};

const DOCTOR: DoctorReport = {
  ok: false,
  findings: [
    { section: "ambient-credential", severity: "pass", message: "No ambient-credential environment variable is set." },
    { section: "identity", subject: "work", severity: "warn", message: "identity work pins Claude Code 9.9.9, which is not installed." },
    { section: "provider", subject: "z", severity: "fail", message: "provider z has no credential that yields a token." },
  ],
};

/** The report the check procedure returns, a real `runCheck` product so the procedure's own output validation proves the schema matches what the collector produces. */
const CHECK: CheckReport = runCheck(baseCheckParams());

/** The deps every procedure in these tests runs against, each read answered by a fixed value the assertions name. */
const DEPS: ControlApiDeps = {
  expectedToken: CONTROL_TOKEN,
  list: () => [],
  liveRateLimits: () => [],
  latestRateLimit: () => undefined,
  usageSnapshots: () => SNAPSHOTS,
  usageSnapshotOf: (identity) => SNAPSHOTS.find((snapshot) => snapshot.identity === identity),
  now: () => NOW_MS,
  frontDoorStatus: () => STATUS,
  checkReport: (target) => {
    if (target !== `${FAKE_HOME}/work`) {
      throw new Error(`the fixed check dep answers one directory only, not ${target}`);
    }
    return CHECK;
  },
  doctorReport: () => DOCTOR,
};

/** Mounts one router of the door's typed API on a plain loopback listener and returns a typed client for it with the given token, the same node handler the provider listener mounts so the prefix, the token middleware and both directions of validation all run. */
async function mountClient(deps: ControlApiDeps, token: string): Promise<{ readonly client: ControlApiClient; readonly close: () => Promise<void> }> {
  const surface = doorApiNodeHandlerOf(createControlApiRouter(deps), CONTROL_TOKEN);
  // The listener owns the rejection path here (the door's own listener logs it), so a rejection surfaces on the console rather than being swallowed or failing the process.
  const server = http.createServer((request, response) => {
    void surface.handle(request, response).catch((error: unknown) => {
      console.error(error);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a bound TCP server");
  }
  return {
    client: createORPCClient(new RPCLink({ url: `http://127.0.0.1:${String(address.port)}${RC_ORPC_PATH_PREFIX}`, headers: { authorization: `Bearer ${token}` } })),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    },
  };
}

describe("the door's control-plane API", () => {
  let client: ControlApiClient;
  let refused: ControlApiClient;
  const closes: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    const mounted = await mountClient(DEPS, CONTROL_TOKEN);
    client = mounted.client;
    closes.push(mounted.close);
    const refusedMount = await mountClient(DEPS, "not-the-control-token");
    refused = refusedMount.client;
    closes.push(refusedMount.close);
  });

  afterAll(async () => {
    for (const close of closes) {
      await close();
    }
  });

  describe("usage", () => {
    it("lists every identity's snapshot through the store's own schema", async () => {
      const listed = await client.usage.list();
      expect(listed.snapshots.map((snapshot) => snapshot.identity)).toEqual(["personal", "work"]);
      expect(listed.snapshots[0]?.providers.anthropic?.rateLimit?.unified?.fiveHour?.utilization).toBe(FIVE_HOUR_UTILIZATION);
    });

    it("reads a provider's windows through the effective-window semantics, at the door's own clock", async () => {
      const windows = await client.usage.effectiveWindow({ identity: "work" });
      // The default provider is the OAuth one, and a window past its reset reads as reset and empty, exactly as every in-process consumer reads it.
      expect(windows).toEqual({
        identity: "work",
        provider: "anthropic",
        observedAt: new Date(NOW_MS - HOUR_MS).toISOString(),
        fiveHour: { reset: false, utilization: FIVE_HOUR_UTILIZATION, resetsAtMs: NOW_MS + HOUR_MS, status: "allowed_warning" },
        sevenDay: { reset: true, utilization: 0 },
      });
    });

    it("answers a named provider's windows, or none observed when the snapshot has no rate-limit state for it", async () => {
      const named = await client.usage.effectiveWindow({ identity: "work", provider: "z" });
      expect(named).toEqual({ identity: "work", provider: "z" });
    });

    it("refuses an identity with no snapshot rather than answering it as empty", async () => {
      await expect(client.usage.effectiveWindow({ identity: "nobody" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("reads the live rate-limit observations the event backbone has filed, the door-wide latest beside the per-session list", async () => {
      const FIVE_HOUR_RESETS_AT = Date.parse("2025-10-06T16:00:00.000Z") / MS_PER_SECOND;
      const observation: RcLiveRateLimit = {
        session: "cse_live",
        observedAt: NOW_MS,
        rateLimit: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          resetsAt: FIVE_HOUR_RESETS_AT,
          utilization: 0.42,
          unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: FIVE_HOUR_RESETS_AT } },
          overageStatus: "allowed",
        },
      };
      const mounted = await mountClient(
        {
          ...DEPS,
          liveRateLimits: (sessionId) => (sessionId === undefined || sessionId === observation.session ? [observation] : []),
          latestRateLimit: () => observation,
        },
        CONTROL_TOKEN,
      );
      try {
        // The read's own output validation is the proof the observation satisfies the contract: the payload's own fields, carried verbatim, survive the round trip.
        expect(await mounted.client.usage.live({})).toEqual({ latest: observation, sessions: [observation] });
        expect(await mounted.client.usage.live({ session: "cse_live" })).toEqual({ latest: observation, sessions: [observation] });
      } finally {
        await mounted.close();
      }
    });

    it("answers the live read as empty while no rate_limit_event has been filed, and refuses a named session rather than answering it as empty", async () => {
      expect(await client.usage.live({})).toEqual({ sessions: [] });
      // A session the door never observed is refused with the Remote Control family's own message for one.
      await expect(client.usage.live({ session: "cse_never" })).rejects.toMatchObject({ code: "NOT_FOUND", message: rcSessionNotObservedMessage("cse_never") });
      // A session the tracker lists but whose stream has filed no rate_limit_event yet is refused naming exactly that cause, because the worker emits one only once a turn has completed.
      const mounted = await mountClient({ ...DEPS, list: () => [{ id: "cse_quiet", createdAt: NOW_MS, lastSeenAt: NOW_MS }] }, CONTROL_TOKEN);
      try {
        await expect(mounted.client.usage.live({ session: "cse_quiet" })).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: "session cse_quiet has filed no rate_limit_event on its stream yet: the worker emits one only once a turn has completed, so retry after this session's next turn",
        });
      } finally {
        await mounted.close();
      }
    });

    it("refuses a caller without this generation's control token", async () => {
      await expect(refused.usage.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(refused.usage.live({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  describe("frontdoor", () => {
    it("returns the status the CLI's own verb collects: state, liveness, registry, hop, log", async () => {
      expect(await client.frontdoor.status()).toEqual(STATUS);
    });

    it("returns the session registry's live launches alone", async () => {
      const sessions = await client.frontdoor.sessions();
      expect(sessions.sessions).toEqual([
        { pid: LIVE_LAUNCH_PID, startedAt: 0, alive: true },
        { pid: DEAD_LAUNCH_PID, startedAt: 0, alive: false },
      ]);
    });

    it("refuses a caller without this generation's control token", async () => {
      await expect(refused.frontdoor.status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  describe("check", () => {
    it("returns the report as the same JSON `check --json` prints, over an absolute path", async () => {
      const report = await client.check.run({ path: `${FAKE_HOME}/work` });
      expect(report).toEqual(checkReportToJson(CHECK));
      expect(report.entries.map((entry) => entry.path)).toContain("skills");
      expect(report.entries.find((entry) => entry.path === ".credentials.json")).toMatchObject({ shared: false, via: "secret-floor" });
    });

    it("hands the named identity through to the collector", async () => {
      let seen: string | undefined;
      const spy = await mountClient(
        {
          ...DEPS,
          checkReport: (target, identity) => {
            seen = identity;
            return DEPS.checkReport(target);
          },
        },
        CONTROL_TOKEN,
      );
      try {
        await spy.client.check.run({ path: `${FAKE_HOME}/work`, identity: "work" });
        expect(seen).toBe("work");
      } finally {
        await spy.close();
      }
    });

    it("refuses a relative path, which the door could only resolve somewhere the caller did not mean", async () => {
      const refusal = await client.check.run({ path: "work/acme" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({ code: "BAD_REQUEST" });
      expect(JSON.stringify(refusal)).toContain("path must be absolute");
    });

    it("refuses a caller without this generation's control token", async () => {
      await expect(refused.check.run({ path: `${FAKE_HOME}/work` })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  describe("doctor", () => {
    it("returns the report as data: every finding and whether any failed", async () => {
      expect(await client.doctor.run()).toEqual(DOCTOR);
    });

    it("refuses a caller without this generation's control token", async () => {
      await expect(refused.doctor.run()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });
});

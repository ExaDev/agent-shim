import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkReportToJson, runCheck, type CheckReport, type RunCheckParams } from "../checkReport";
import type { DoctorReport } from "../doctorReport";
import { createFakeFarmFs, FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, shippedClassification } from "../test-helpers";
import { USAGE_SCHEMA_VERSION, type UsageSnapshot } from "../usage/schema";
import { generateCa, LOOPBACK_LEAF_NAMES, mintLeaf, type CaMaterial } from "./connect";
import { KEYGEN_TIMEOUT_MS } from "./connectTestWorld";
import { createDoorApiNodeHandler, frontDoorApiClient } from "./controlApi";
import { LAUNCH_EVENT_SOURCE, type DoorEvent } from "./eventSchemas";
import { createDoorEventHub, rcFanoutOnDoorHub } from "./eventHub";
import { createRcLiveUsage } from "./rcLiveUsage";
import { createRcSessionTracker, RC_IDLE_EXPIRY_MS } from "./rcSessions";
import type { RcEventWriteResult } from "./rcWrites";
import { createRcEventFanout } from "./rcStream";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import type { FrontDoorStatus } from "./status";

/** The token the mounted door accepts, standing in for the per-generation value the real door writes owner-only. */
const CONTROL_TOKEN = "e2e-control-token";
/** The instant the one window read in this test happens at. */
const NOW_MS = Date.parse("2026-10-05T12:00:00.000Z");
/** One hour in milliseconds, the unit the snapshot's reset instant is stated in. */
const HOUR_MS = 3_600_000;
/** The milliseconds in one second, the unit that converts the fixed ISO instants into the unix epoch seconds the payload states. */
const MS_PER_SECOND = 1_000;
/** How much of the five-hour window the read snapshot reports as used, so the assertion names a fraction rather than a bare number. */
const FIVE_HOUR_UTILIZATION = 0.5;
const SUPERVISOR_PID = 10;
const LAUNCH_PID = 20;
const PROVIDER_PORT = 4100;

/** One identity's snapshot with one live window, the read this test drives across the door's real TLS. */
const SNAPSHOT: UsageSnapshot = {
  schemaVersion: USAGE_SCHEMA_VERSION,
  identity: "work",
  updatedAt: new Date(NOW_MS).toISOString(),
  providers: {
    anthropic: {
      lastRequestAt: new Date(NOW_MS).toISOString(),
      lastStatus: 200,
      rateLimit: { observedAt: new Date(NOW_MS).toISOString(), headers: {}, unified: { fiveHour: { utilization: FIVE_HOUR_UTILIZATION, resetsAt: new Date(NOW_MS + HOUR_MS).toISOString(), status: "allowed" } } },
    },
  },
};

const STATUS: FrontDoorStatus = {
  state: { supervisorPid: SUPERVISOR_PID, port: PROVIDER_PORT, lastPort: PROVIDER_PORT },
  supervisorAlive: true,
  sessions: [{ pid: LAUNCH_PID, startedAt: 0, alive: true }],
  headroomSocket: undefined,
  logPath: "/home/testuser/.agent-shim/logs/frontdoor.log",
  logExists: false,
};

const DOCTOR: DoctorReport = { ok: true, findings: [{ section: "ambient-credential", severity: "pass", message: "No ambient-credential environment variable is set." }] };

/** A real `runCheck` product over the same stand-ins `check`'s own tests use, so the door's own output validation proves the schema matches the collector across real transport. */
const CHECK: CheckReport = runCheck({
  cwd: `${FAKE_HOME}/work`,
  home: FAKE_HOME,
  claudeHome: FAKE_CLAUDE_HOME,
  env: {},
  nowMs: FAKE_NOW_MS,
  farmFs: createFakeFarmFs({ [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "content" }),
  cascade: { home: FAKE_HOME, loadProfile: () => undefined },
  classification: { defaults: shippedClassification },
  identitySource: "none",
  configProfileSource: "none",
  settingsFiles: {},
  platform: "linux",
} satisfies RunCheckParams);

/** The write operations this test never drives: present because the merged mount wires them, typed because the router demands them. */
const unexercised = async (): Promise<RcEventWriteResult> => await Promise.resolve({ ok: false, message: "this test drives no Remote Control write" });

/**
 * How long the events case may wait for the publish it drives to cross the wire. Loopback TLS and the bridge run in milliseconds; the bound exists only so an overloaded machine fails visibly instead of hanging the suite.
 */
const WAIT_BUDGET_MS = 5_000;
/** The polling cadence of `until`, generous against a loopback hop's real sub-millisecond cost. */
const SETTLE_MS = 50;

/** Waits until the condition holds, failing loudly at the budget rather than hanging. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("the door did not reach the awaited state within the test's wait budget");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
  }
}

describe("the door's typed API with the control plane mounted beside Remote Control", () => {
  let ca: CaMaterial;
  let port: number;
  let close: (() => Promise<void>) | undefined;
  // The door's event backbone and the Remote Control fan-out wrapped on it, hoisted so a test can publish exactly as the held client stream publishes and read the result back through the merged mount's own surfaces.
  const doorEvents = createDoorEventHub();
  const rcFanout = rcFanoutOnDoorHub(createRcEventFanout(), doorEvents);
  /** Every request URL the mount served, so a test can await a subscription having landed before publishing what it must deliver. */
  const served: string[] = [];

  // The real listener shape the rc API's own e2e tests mount: the door's server builder with the merged typed API (Remote Control, control plane and events together) as its one pre-pipeline surface, serving TLS signed by a freshly generated CA, so the pinned client's handshake, the mount prefix, the token middleware and both directions of validation all run exactly as they do on a serving door.
  beforeAll(async () => {
    ca = generateCa(new Date());
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS });
    // The live quota state exactly as the door wires it: subscribed to the backbone before any stream can publish, so the rate_limit envelope this suite publishes through the wrapped fan-out is filed the way the real held stream's would be.
    const rcLiveUsage = createRcLiveUsage({ now: () => NOW_MS, hub: doorEvents });
    const doorApi = createDoorApiNodeHandler({
      expectedToken: CONTROL_TOKEN,
      list: tracker.list,
      statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
      pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
      inject: unexercised,
      answer: unexercised,
      interrupt: unexercised,
      setModel: unexercised,
      setPermissionMode: unexercised,
      endSession: unexercised,
      getUsage: unexercised,
      getContextUsage: unexercised,
      readFile: unexercised,
      fileSuggestions: unexercised,
      keepAlive: unexercised,
      mcpStatus: unexercised,
      mcpReconnect: unexercised,
      mcpAuthenticate: unexercised,
      mcpOAuthCallbackUrl: unexercised,
      teleport: unexercised,
      fanout: rcFanout,
      events: doorEvents,
      liveRateLimits: rcLiveUsage.liveOf,
      latestRateLimit: rcLiveUsage.latestOf,
      usageSnapshots: () => [SNAPSHOT],
      usageSnapshotOf: (identity) => (identity === SNAPSHOT.identity ? SNAPSHOT : undefined),
      now: () => NOW_MS,
      frontDoorStatus: () => STATUS,
      checkReport: (target) => {
        if (target !== `${FAKE_HOME}/work`) {
          throw new Error(`the fixed check dep answers one directory only, not ${target}`);
        }
        return CHECK;
      },
      doctorReport: () => DOCTOR,
      poolPick: (): undefined => undefined,
      poolNames: () => [],
    });
    const server = createFrontDoorServer(
      async () => {
        await Promise.resolve();
      },
      () => undefined,
      mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()),
      undefined,
      [{ ...doorApi, handle: async (request, response) => { served.push(request.url ?? ""); return await doorApi.handle(request, response); } }],
    );
    const handle = await listenFrontDoor(server, { ca: ca.certPem });
    port = handle.port;
    close = handle.close;
  }, KEYGEN_TIMEOUT_MS);

  afterAll(async () => {
    await close?.();
  });

  it("serves the control plane beside Remote Control over the door's own TLS, one token for both", async () => {
    const api = frontDoorApiClient(port, ca.certPem, CONTROL_TOKEN);

    // Remote Control still answers on the same mount, so adding the control plane did not displace it.
    expect(await api.rc.list()).toEqual({ sessions: [] });

    expect((await api.usage.list()).snapshots.map((snapshot) => snapshot.identity)).toEqual(["work"]);
    expect(await api.usage.effectiveWindow({ identity: "work" })).toEqual({
      identity: "work",
      provider: "anthropic",
      observedAt: new Date(NOW_MS).toISOString(),
      fiveHour: { reset: false, utilization: FIVE_HOUR_UTILIZATION, resetsAtMs: NOW_MS + HOUR_MS, status: "allowed" },
    });

    expect(await api.frontdoor.status()).toEqual(STATUS);
    expect((await api.frontdoor.sessions()).sessions).toEqual([{ pid: LAUNCH_PID, startedAt: 0, alive: true }]);

    expect(await api.check.run({ path: `${FAKE_HOME}/work` })).toEqual(checkReportToJson(CHECK));
    expect(await api.doctor.run()).toEqual(DOCTOR);

    // A caller without this generation's control token is refused by the control plane exactly as the Remote Control surface refuses it.
    const wrongToken = frontDoorApiClient(port, ca.certPem, "not-the-control-token");
    await expect(wrongToken.usage.effectiveWindow({ identity: "work" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(wrongToken.check.run({ path: `${FAKE_HOME}/work` })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("streams the door's events on the same merged mount, a source-tagged publish reaching a subscriber live", async () => {
    const api = frontDoorApiClient(port, ca.certPem, CONTROL_TOKEN);
    const received: DoorEvent[] = [];
    const stop = new AbortController();
    const watching = (async () => {
      for await (const event of await api.events.subscribe({}, { signal: stop.signal })) {
        received.push(event);
      }
    })().catch(() => {
      // Leaving the subscription aborts its request; the iterator ending on that abort is the expected shape, not a failure to surface.
    });
    try {
      // The subscription lands before anything is published, because the backbone holds no replay: an event published before the subscriber's bridge attached is simply not seen by it.
      await until(() => served.some((url) => url.includes("/events/subscribe")));
      // One launch lifecycle event published on the backbone the mount serves: the whole-door client receives it source-tagged, with the backbone's own sequence.
      doorEvents.publisher(LAUNCH_EVENT_SOURCE).publish({ kind: "registered", pid: LAUNCH_PID, startedAt: 0, observedAt: NOW_MS });
      await until(() => received.length === 1);
      expect(received[0]).toEqual({ source: LAUNCH_EVENT_SOURCE, sequence: 1, payload: { kind: "registered", pid: LAUNCH_PID, startedAt: 0, observedAt: NOW_MS } });
    } finally {
      stop.abort();
      await watching;
    }
  });

  it("serves the live quota a rate_limit envelope filed on the backbone, and files nothing but that family", async () => {
    const api = frontDoorApiClient(port, ca.certPem, CONTROL_TOKEN);
    const FIVE_HOUR_RESETS_AT = Date.parse("2025-10-06T16:00:00.000Z") / MS_PER_SECOND;
    const SEVEN_DAY_RESETS_AT = Date.parse("2025-10-13T16:00:00.000Z") / MS_PER_SECOND;

    // Before any rate_limit envelope, the live read answers empty and a named session is refused, exactly as the unit suite proves against fakes; here through the real mount.
    expect(await api.usage.live({})).toEqual({ sessions: [] });
    await expect(api.usage.live({ session: "cse_e2e_live" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Envelopes the live state must not file: an ordinary assistant event, and a rate_limit_event whose info lacks the family's own required status. Both leave the read empty, which is the discrimination: the surface reads only the filed rate-limit family, not whatever else crossed the fan-out.
    rcFanout.publish({ session: "cse_e2e_live", envelope: { event_type: "assistant", sequence_num: 20, source: "worker", payload: { type: "assistant", content: [] } } });
    rcFanout.publish({ session: "cse_e2e_live", envelope: { event_type: "rate_limit_event", sequence_num: 21, source: "worker", payload: { type: "rate_limit_event", rate_limit_info: { utilization: 0.5 } } } });
    expect(await api.usage.live({})).toEqual({ sessions: [] });

    // The real family's shape, published through the wrapped fan-out exactly as the held client stream publishes every envelope it reads, with the payload the 2.1.289 bundle's own schema declares.
    rcFanout.publish({
      session: "cse_e2e_live",
      envelope: {
        event_type: "rate_limit_event",
        sequence_num: 22,
        source: "worker",
        payload: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            resetsAt: FIVE_HOUR_RESETS_AT,
            utilization: 0.42,
            overageStatus: "allowed",
            isUsingOverage: false,
            unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: FIVE_HOUR_RESETS_AT }, seven_day: { utilization: 0.12, resetsAt: SEVEN_DAY_RESETS_AT } },
          },
          uuid: "00000000-0000-4000-8000-000000000000",
          session_id: "cse_e2e_live",
        },
      },
    });

    const expected = {
      session: "cse_e2e_live",
      observedAt: NOW_MS,
      rateLimit: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        resetsAt: FIVE_HOUR_RESETS_AT,
        utilization: 0.42,
        overageStatus: "allowed",
        isUsingOverage: false,
        unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: FIVE_HOUR_RESETS_AT }, seven_day: { utilization: 0.12, resetsAt: SEVEN_DAY_RESETS_AT } },
      },
    };
    // The read crosses the door's real TLS and its own output validation, so the observation's shape is proven against the contract, not asserted from the fake alone.
    expect(await api.usage.live({})).toEqual({ latest: expected, sessions: [expected] });
    expect(await api.usage.live({ session: "cse_e2e_live" })).toEqual({ latest: expected, sessions: [expected] });
  });
});

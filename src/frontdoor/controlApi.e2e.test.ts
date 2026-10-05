import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkReportToJson, runCheck, type CheckReport, type RunCheckParams } from "../checkReport";
import type { DoctorReport } from "../doctorReport";
import { createFakeFarmFs, FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, shippedClassification } from "../test-helpers";
import { USAGE_SCHEMA_VERSION, type UsageSnapshot } from "../usage/schema";
import { generateCa, LOOPBACK_LEAF_NAMES, mintLeaf, type CaMaterial } from "./connect";
import { KEYGEN_TIMEOUT_MS } from "./connectTestWorld";
import { createDoorApiNodeHandler, frontDoorApiClient } from "./controlApi";
import { createRcSessionTracker, RC_IDLE_EXPIRY_MS, type RcEventWriteResult } from "./rcSessions";
import { createRcEventFanout } from "./rcStream";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import type { FrontDoorStatus } from "./status";

/** The token the mounted door accepts, standing in for the per-generation value the real door writes owner-only. */
const CONTROL_TOKEN = "e2e-control-token";
/** The instant the one window read in this test happens at. */
const NOW_MS = Date.parse("2026-10-05T12:00:00.000Z");
/** One hour in milliseconds, the unit the snapshot's reset instant is stated in. */
const HOUR_MS = 3_600_000;
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

describe("the door's typed API with the control plane mounted beside Remote Control", () => {
  let ca: CaMaterial;
  let port: number;
  let close: (() => Promise<void>) | undefined;

  // The real listener shape the rc API's own e2e tests mount: the door's server builder with the merged typed API (Remote Control and control plane together) as its one pre-pipeline surface, serving TLS signed by a freshly generated CA, so the pinned client's handshake, the mount prefix, the token middleware and both directions of validation all run exactly as they do on a serving door.
  beforeAll(async () => {
    ca = generateCa(new Date());
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS });
    const server = createFrontDoorServer(
      async () => {
        await Promise.resolve();
      },
      () => undefined,
      mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()),
      undefined,
      createDoorApiNodeHandler({
        expectedToken: CONTROL_TOKEN,
        list: tracker.list,
        statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
        pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
        inject: unexercised,
        answer: unexercised,
        interrupt: unexercised,
        setModel: unexercised,
        setPermissionMode: unexercised,
        fanout: createRcEventFanout(),
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
      }),
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
});

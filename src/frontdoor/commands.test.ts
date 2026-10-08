import { describe, expect, it } from "vitest";

import realFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeHeadroomState } from "../headroom/state";
import { buildLayoutPaths } from "../paths";
import { FAKE_UID, createFakeFarmFs, fakeSocketTrust } from "../test-helpers";
import { RC_PENDING_SUMMARY_EXCERPT_CHARS } from "./rcSessions";
import { formatRcPendingList, formatRcRateLimitInfo, formatRcSelfHostMint, formatRcSessionList, formatRcSessionStatus, formatRcStreamEvent, frontDoorRcApiFromState, frontDoorRcControlFromState } from "./rcCommands";
import { realStatOwnExecutable } from "./commands";
import { collectFrontDoorStatus, formatFrontDoorStatus } from "./status";
import { writeFrontDoorSession, writeFrontDoorState } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");
const SUPERVISOR = 10;
/** The milliseconds in one second, the unit that converts the fixed ISO instants into the unix epoch seconds the payload states. */
const MS_PER_SECOND = 1_000;
/** A stand-in capability: front-door registry records carry one per launch. */
const SESSION_TOKEN = "test-capability";
const LIVE_SESSION = 20;
const DEAD_SESSION = 21;
const PORT = 4100;
const CONNECT_PORT = 4200;
const HEADROOM_SOCKET = `${paths.headroomSocketDir}/30.sock`;
/** An owner-only socket mode, as headroom creates it. */
const SOCKET_MODE = 0o600;
/** A socket directory mode that lets every user in. */
const WORLD_DIR_MODE = 0o777;

describe("frontdoor status", () => {
  it("reports a serving door with both listeners, the headroom hop and its sessions", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR, port: PORT, lastPort: PORT, connectPort: CONNECT_PORT, lastConnectPort: CONNECT_PORT });
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: 30, headroomPid: 31, socketPath: HEADROOM_SOCKET });
    fs.mkdirPrivate(paths.headroomSocketDir);
    const trust = fakeSocketTrust(fs, { overrides: { [HEADROOM_SOCKET]: { kind: "socket", uid: FAKE_UID, mode: SOCKET_MODE } } });
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: LIVE_SESSION, startedAt: 0, token: SESSION_TOKEN });
    writeFrontDoorSession(fs, paths.frontdoorSessionsDir, { pid: DEAD_SESSION, startedAt: 0, token: SESSION_TOKEN });
    const alive = new Set([SUPERVISOR, LIVE_SESSION]);
    const status = collectFrontDoorStatus(fs, trust, paths, (pid) => alive.has(pid));
    expect(status.supervisorAlive).toBe(true);
    expect(status.headroomSocket).toEqual({ socketPath: HEADROOM_SOCKET });
    expect(formatFrontDoorStatus(status, paths.frontdoorCaCertFile)).toEqual([
      "supervisor: pid 10 (alive)",
      `front door: listening on https://127.0.0.1:${String(PORT)}, routing /providers/<name> requests`,
      `connect surface: listening on 127.0.0.1:${String(CONNECT_PORT)}, CA ${paths.frontdoorCaCertFile}`,
      `headroom hop: daemon on unix socket ${HEADROOM_SOCKET}`,
      "sessions: 2 registered (20, 21 (dead))",
      `daemon log: ${paths.frontdoorLogPath} (not created yet)`,
    ]);
  });

  it("reports a stopped door with both sticky ports, a missing hop and any last error", () => {
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { lastPort: PORT, lastConnectPort: CONNECT_PORT, lastError: "gave up" });
    expect(formatFrontDoorStatus(collectFrontDoorStatus(fs, fakeSocketTrust(fs), paths, () => false), paths.frontdoorCaCertFile)).toEqual([
      "supervisor: not running",
      "front door: not listening (next start on 127.0.0.1:4100)",
      "connect surface: not listening (next start on 127.0.0.1:4200)",
      "headroom hop: the daemon is not serving (sessions asking for headroom fail until it is up)",
      "sessions: none",
      "last error: gave up",
      `daemon log: ${paths.frontdoorLogPath} (not created yet)`,
    ]);
  });

  it("reports a recorded socket the hop refuses, naming why, rather than a serving daemon", () => {
    const fs = createFakeFarmFs({});
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: 30, headroomPid: 31, socketPath: HEADROOM_SOCKET });
    fs.mkdirp(paths.headroomSocketDir);
    const trust = fakeSocketTrust(fs, {
      overrides: {
        [paths.headroomSocketDir]: { kind: "dir", uid: FAKE_UID, mode: WORLD_DIR_MODE },
        [HEADROOM_SOCKET]: { kind: "socket", uid: FAKE_UID, mode: SOCKET_MODE },
      },
    });
    const lines = formatFrontDoorStatus(collectFrontDoorStatus(fs, trust, paths, () => false), paths.frontdoorCaCertFile);
    expect(lines).toContain(
      `headroom hop: REFUSING the daemon's socket (sessions asking for headroom fail until it is fixed): the headroom socket directory ${paths.headroomSocketDir} has mode 0777, which lets other users reach it; it must be accessible to its owner only`,
    );
  });
});

describe("frontdoor rc", () => {
  /** One heartbeat's cadence in the fake timestamps, so the last-seen offset is the protocol's own rather than a bare literal. */
  const ONE_HEARTBEAT_MS = 20;
  it("opens the control client only when the door is serving with its CA and control token, naming exactly what is missing otherwise", () => {
    const nothing = createFakeFarmFs({});
    expect(() => frontDoorRcControlFromState(nothing, paths)).toThrow("the front door is not serving");
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR, port: PORT, lastPort: PORT });
    expect(() => frontDoorRcControlFromState(fs, paths)).toThrow(`the front door's CA certificate is missing at ${paths.frontdoorCaCertFile}`);
    fs.mkdirp(paths.frontdoorCaDir);
    fs.writeFileUtf8(paths.frontdoorCaCertFile, "ca-pem");
    expect(() => frontDoorRcControlFromState(fs, paths)).toThrow(`the serving front door's control token is missing at ${paths.frontdoorControlTokenFile}`);
    fs.writeFileUtf8(paths.frontdoorControlTokenFile, "the-control-token");
    expect(frontDoorRcControlFromState(fs, paths)).toBeDefined();
  });

  it("opens the typed API client under the same serving, CA and control-token contract as the control client", () => {
    const nothing = createFakeFarmFs({});
    expect(() => frontDoorRcApiFromState(nothing, paths)).toThrow("the front door is not serving");
    const fs = createFakeFarmFs({});
    writeFrontDoorState(fs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR, port: PORT, lastPort: PORT });
    expect(() => frontDoorRcApiFromState(fs, paths)).toThrow(`the front door's CA certificate is missing at ${paths.frontdoorCaCertFile}, so its typed API cannot be authenticated`);
    fs.mkdirp(paths.frontdoorCaDir);
    fs.writeFileUtf8(paths.frontdoorCaCertFile, "ca-pem");
    expect(() => frontDoorRcApiFromState(fs, paths)).toThrow(`the serving front door's control token is missing at ${paths.frontdoorControlTokenFile}`);
    fs.writeFileUtf8(paths.frontdoorControlTokenFile, "the-control-token");
    expect(frontDoorRcApiFromState(fs, paths)).toBeDefined();
  });

  it("formats the observed session list, one line per session and a plain line when there are none", () => {
    expect(formatRcSessionList([])).toEqual(["no Remote Control sessions observed"]);
    const createdAt = 1_000;
    const lastSeenAt = createdAt + ONE_HEARTBEAT_MS;
    expect(formatRcSessionList([{ id: "cse_1", createdAt, lastSeenAt }])).toEqual([
      "cse_1  created 1970-01-01T00:00:01.000Z  last seen 1970-01-01T00:00:01.020Z",
    ]);
  });

  it("formats the session status, the worker facts, and the pending requests, with plain lines for what was never observed", () => {
    const createdAt = 1_000;
    expect(formatRcSessionStatus([])).toEqual(["no Remote Control sessions observed"]);
    expect(formatRcSessionStatus([{ id: "cse_1", createdAt, lastSeenAt: createdAt, workerState: undefined, workerIdleSeconds: undefined, pending: [] }])).toEqual([
      "cse_1  created 1970-01-01T00:00:01.000Z  last seen 1970-01-01T00:00:01.000Z",
      "  worker: not observed",
      "  pending: none",
    ]);
    expect(
      formatRcSessionStatus([
        {
          id: "cse_1",
          createdAt,
          lastSeenAt: createdAt + ONE_HEARTBEAT_MS,
          workerState: { value: "WORKER_STATUS_RUNNING", observedAt: createdAt },
          workerIdleSeconds: { value: 7, observedAt: createdAt + ONE_HEARTBEAT_MS },
          pending: [{ sessionId: "cse_1", requestId: "req_1", type: "can_use_tool", summary: 'Bash {"command":"pnpm test"}', observedAt: createdAt }],
        },
      ]),
    ).toEqual([
      "cse_1  created 1970-01-01T00:00:01.000Z  last seen 1970-01-01T00:00:01.020Z",
      "  worker: state WORKER_STATUS_RUNNING since 1970-01-01T00:00:01.000Z, idle 7 s as of 1970-01-01T00:00:01.020Z",
      "  pending:",
      '    cse_1  req_1  can_use_tool  Bash {"command":"pnpm test"}  observed 1970-01-01T00:00:01.000Z',
    ]);
  });

  it("formats the pending request list, one line per request and a plain line when there are none", () => {
    expect(formatRcPendingList([])).toEqual(["no pending control requests observed"]);
    expect(formatRcPendingList([{ sessionId: "cse_1", requestId: "req_1", type: "can_use_tool", summary: 'Bash {"command":"pnpm test"}', observedAt: 1_000 }])).toEqual([
      'cse_1  req_1  can_use_tool  Bash {"command":"pnpm test"}  observed 1970-01-01T00:00:01.000Z',
    ]);
  });

  it("formats one stream event with its session, identification and a bounded payload sketch, and omits the sketch when the envelope carried no payload", () => {
    expect(
      formatRcStreamEvent({
        session: "cse_1",
        envelope: { event_type: "control_request", sequence_num: 12, source: "worker", payload: { type: "control_request", request_id: "req_1", request: { subtype: "can_use_tool", tool_name: "Bash" } } },
      }),
    ).toBe('cse_1  control_request  sequence_num 12  source worker  {"type":"control_request","request_id":"req_1","request":{"subtype":"can_use_tool","tool_name":"Bash"}}');
    expect(formatRcStreamEvent({ session: "cse_1", envelope: { event_type: "user", sequence_num: 13, source: "worker" } })).toBe("cse_1  user  sequence_num 13  source worker");
    // The sketch is the excerpt budget applied to the payload's JSON form, quotes included: one opening quote and all but one of the payload's x's fit inside it.
    const long = "x".repeat(RC_PENDING_SUMMARY_EXCERPT_CHARS);
    expect(formatRcStreamEvent({ session: "cse_1", envelope: { event_type: "user", sequence_num: 14, source: "worker", payload: long } })).toBe(
      `cse_1  user  sequence_num 14  source worker  "${"x".repeat(RC_PENDING_SUMMARY_EXCERPT_CHARS - 1)}...`,
    );
  });

  it("formats one stream event with its session, identification and a bounded payload sketch, and omits the sketch when the envelope carried no payload", () => {
    expect(
      formatRcStreamEvent({
        session: "cse_1",
        envelope: { event_type: "control_request", sequence_num: 12, source: "worker", payload: { type: "control_request", request_id: "req_1", request: { subtype: "can_use_tool", tool_name: "Bash" } } },
      }),
    ).toBe('cse_1  control_request  sequence_num 12  source worker  {"type":"control_request","request_id":"req_1","request":{"subtype":"can_use_tool","tool_name":"Bash"}}');
    expect(formatRcStreamEvent({ session: "cse_1", envelope: { event_type: "user", sequence_num: 13, source: "worker" } })).toBe("cse_1  user  sequence_num 13  source worker");
    // The sketch is the excerpt budget applied to the payload's JSON form, quotes included: one opening quote and all but one of the payload's x's fit inside it.
    const long = "x".repeat(RC_PENDING_SUMMARY_EXCERPT_CHARS);
    expect(formatRcStreamEvent({ session: "cse_1", envelope: { event_type: "user", sequence_num: 14, source: "worker", payload: long } })).toBe(
      `cse_1  user  sequence_num 14  source worker  "${"x".repeat(RC_PENDING_SUMMARY_EXCERPT_CHARS - 1)}...`,
    );
  });

  it("formats a rate_limit_event as the account's quota state: the payload's own words, resets as the instants it names, never a countdown of the door's making", () => {
    const FIVE_HOUR_RESETS_AT = Date.parse("2025-10-06T16:00:00.000Z") / MS_PER_SECOND;
    const SEVEN_DAY_RESETS_AT = Date.parse("2025-10-13T16:00:00.000Z") / MS_PER_SECOND;
    expect(
      formatRcStreamEvent({
        session: "cse_1",
        envelope: {
          event_type: "rate_limit_event",
          sequence_num: 15,
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
            session_id: "cse_1",
          },
        },
      }),
    ).toBe(
      "cse_1  rate_limit_event  sequence_num 15  source worker  allowed_warning five_hour 42% resets 2025-10-06T16:00:00.000Z windows five_hour 42% resets 2025-10-06T16:00:00.000Z, seven_day 12% resets 2025-10-13T16:00:00.000Z overage allowed",
    );
    // The summary states only what the payload states: a bare status alone, and overage in use named as the payload's own flag.
    expect(formatRcRateLimitInfo({ status: "rejected" })).toBe("rejected");
    expect(formatRcRateLimitInfo({ status: "allowed", isUsingOverage: true })).toBe("allowed overage in use");
    // A rate_limit_event the narrowing cannot read keeps the bounded JSON sketch, the fallback every other payload takes.
    expect(formatRcStreamEvent({ session: "cse_1", envelope: { event_type: "rate_limit_event", sequence_num: 16, source: "worker", payload: { type: "rate_limit_event", rate_limit_info: { utilization: 0.5 } } } })).toBe(
      'cse_1  rate_limit_event  sequence_num 16  source worker  {"type":"rate_limit_event","rate_limit_info":{"utilization":0.5}}',
    );
  });

  it("formats the self-hosted mint's result as names and next steps, never a token", () => {
    const lines = formatRcSelfHostMint({
      identity: "rig",
      organizationUuid: "11111111-1111-4111-8111-111111111111",
      credentialsFile: "/state/identities/rig/.credentials.json",
      claudeJsonFile: "/state/identities/rig/.claude.json",
      recordFile: "/state/frontdoor/rc-selfhost/credential.json",
      replaced: false,
    });
    expect(lines[0]).toContain("identity:       rig");
    expect(lines[1]).toContain("credential:     /state/identities/rig/.credentials.json");
    expect(lines[lines.length - 1]).toContain("AGENT_SHIM_FRONTDOOR_RC_SELF_HOST=1");
    // The mint's own output contract: no line of it ever carries token material, because the result never received any to print.
    expect(lines.join("\n")).not.toMatch(/sk-ant-/);
  });
});

describe("realStatOwnExecutable", () => {
  it("reports the entry's identity, follows a symlink to what it points at, and sees a rename-install replace it", () => {
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-turnover-test-"));
    try {
      const entry = path.join(dir, "agent-shim");
      realFs.writeFileSync(entry, "first");
      const stat = realStatOwnExecutable(entry);
      const before = stat();
      expect(before).toBeDefined();
      // A symlinked alias resolves to the entry it points at, so a door spawned through one watches the same identity.
      const alias = path.join(dir, "claude-use");
      realFs.symlinkSync(entry, alias);
      expect(realStatOwnExecutable(alias)()).toEqual(before);
      // The updater's install shape: verified bytes written beside the target and renamed over it, a new inode at the same path.
      const staged = path.join(dir, "agent-shim.staged");
      realFs.writeFileSync(staged, "second, different bytes so the size differs too");
      realFs.renameSync(staged, entry);
      const after = stat();
      expect(after).toBeDefined();
      expect(after).not.toEqual(before);
    } finally {
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports undefined for a missing entry and for one that is not a regular file", () => {
    const dir = realFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-turnover-test-"));
    try {
      expect(realStatOwnExecutable(path.join(dir, "agent-shim"))()).toBeUndefined();
      const asDirectory = path.join(dir, "agent-shim");
      realFs.mkdirSync(asDirectory);
      expect(realStatOwnExecutable(asDirectory)()).toBeUndefined();
    } finally {
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

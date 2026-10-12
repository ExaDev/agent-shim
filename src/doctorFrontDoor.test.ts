import { describe, expect, it } from "vitest";

import { runDoctor, type RunDoctorParams } from "./doctorReport";
import { baseParams, findingsFor } from "./doctorTestFixtures";

const ALIVE_SUPERVISOR_PID = 11;
const ALIVE_DAEMON_PID = 12;
const HEADROOM_SOCKET = "/agent-shim/headroom/run/8123.sock";

const FRONT_DOOR_STATE_PATH = "/agent-shim/frontdoor/state.json";
const SERVING_DOOR_PID = 301;
const SUPERSEDED_DOOR_PID = 302;
const OTHER_SUPERSEDED_DOOR_PID = 303;
const DOOR_ORIGIN = "http://127.0.0.1:50123";

function frontDoorParams(
  state: Record<string, unknown> | undefined,
  supervisors: NonNullable<RunDoctorParams["frontDoor"]>["supervisors"],
  liveSessions: NonNullable<RunDoctorParams["frontDoor"]>["liveSessions"] = [],
): Partial<RunDoctorParams> {
  return { frontDoor: { state: { path: FRONT_DOOR_STATE_PATH, raw: state === undefined ? undefined : JSON.stringify(state) }, supervisors, liveSessions } };
}

describe("runDoctor: front door", () => {
  it("reports nothing when the platform cannot list processes", () => {
    expect(findingsFor(runDoctor(baseParams()), "frontdoor")).toEqual([]);
  });

  it("passes with a single supervisor", () => {
    const report = runDoctor(baseParams(frontDoorParams({ supervisorPid: SERVING_DOOR_PID }, { ok: true, pids: [SERVING_DOOR_PID] })));
    const findings = findingsFor(report, "frontdoor");
    expect(findings.map((finding) => finding.severity)).toEqual(["pass"]);
    expect(report.ok).toBe(true);
  });

  it("passes when no supervisor is running", () => {
    const report = runDoctor(baseParams(frontDoorParams(undefined, { ok: true, pids: [] })));
    expect(findingsFor(report, "frontdoor").map((finding) => finding.severity)).toEqual(["pass"]);
  });

  it("fails once per superseded supervisor, naming it and the command that stops it", () => {
    const report = runDoctor(
      baseParams(frontDoorParams({ supervisorPid: SERVING_DOOR_PID }, { ok: true, pids: [SERVING_DOOR_PID, SUPERSEDED_DOOR_PID, OTHER_SUPERSEDED_DOOR_PID] })),
    );
    const findings = findingsFor(report, "frontdoor");
    expect(findings.map((finding) => [finding.severity, finding.subject])).toEqual([
      ["fail", String(SUPERSEDED_DOOR_PID)],
      ["fail", String(OTHER_SUPERSEDED_DOOR_PID)],
    ]);
    expect(findings[0]?.message).toContain(`kill ${String(SUPERSEDED_DOOR_PID)}`);
    expect(findings[0]?.message).toContain(`pid ${String(SERVING_DOOR_PID)}`);
    expect(findings[1]?.message).toContain(`kill ${String(OTHER_SUPERSEDED_DOOR_PID)}`);
    expect(report.ok).toBe(false);
  });

  it("only warns for a superseded supervisor still serving launches registered against it, and fails for one serving nothing", () => {
    const report = runDoctor(
      baseParams(
        frontDoorParams({ supervisorPid: SERVING_DOOR_PID }, { ok: true, pids: [SERVING_DOOR_PID, SUPERSEDED_DOOR_PID, OTHER_SUPERSEDED_DOOR_PID] }, [
          { pid: 9001, startedAt: 0, supervisorPid: SUPERSEDED_DOOR_PID },
          { pid: 9002, startedAt: 0, supervisorPid: SERVING_DOOR_PID },
        ]),
      ),
    );
    const findings = findingsFor(report, "frontdoor");
    expect(findings.map((finding) => [finding.severity, finding.subject])).toEqual([
      ["warn", String(SUPERSEDED_DOOR_PID)],
      ["fail", String(OTHER_SUPERSEDED_DOOR_PID)],
    ]);
    expect(findings[0]?.message).toBe(
      `Front door supervisor pid ${String(SUPERSEDED_DOOR_PID)} has been superseded by pid ${String(SERVING_DOOR_PID)} and still serves 1 launch registered against it; it exits once they end.`,
    );
    expect(report.ok).toBe(false);
  });

  it("fails for every supervisor when the state file names none of them", () => {
    const report = runDoctor(baseParams(frontDoorParams({ supervisorPid: 999 }, { ok: true, pids: [SERVING_DOOR_PID, SUPERSEDED_DOOR_PID] })));
    const findings = findingsFor(report, "frontdoor");
    expect(findings.map((finding) => finding.subject)).toEqual([String(SERVING_DOOR_PID), String(SUPERSEDED_DOOR_PID)]);
    expect(findings.every((finding) => finding.severity === "fail")).toBe(true);
    expect(findings[0]?.message).toContain("names no running supervisor");
  });

  it("warns, without failing, when the process table could not be read", () => {
    const report = runDoctor(baseParams(frontDoorParams(undefined, { ok: false, message: "ps exited 1" })));
    const findings = findingsFor(report, "frontdoor");
    expect(findings.map((finding) => finding.severity)).toEqual(["warn"]);
    expect(findings[0]?.message).toContain("ps exited 1");
    expect(report.ok).toBe(true);
  });
});

describe("runDoctor: headroom allowlist file and the serving door", () => {
  const ALLOWLIST_FILE = "/agent-shim/headroom/allowlist.txt";
  const LOG_PATH = "/agent-shim/logs/headroom.log";
  const MOVED_DOOR_ORIGIN = "http://127.0.0.1:50999";
  const OTHER_DOOR_ORIGIN = "http://127.0.0.1:50777";
  const alive = new Set([ALIVE_SUPERVISOR_PID, ALIVE_DAEMON_PID]);
  const headroomWith = (
    drift: NonNullable<RunDoctorParams["headroom"]["allowlist"]>["drift"],
    running: ReadonlySet<number> = alive,
    undeterminedFrontDoors: NonNullable<RunDoctorParams["headroom"]["allowlist"]>["undeterminedFrontDoors"] = [],
    fileProblem?: { readonly message: string; readonly repairable: boolean },
  ): Partial<RunDoctorParams> => ({
    headroom: {
      state: { path: "/agent-shim/headroom/state.json", raw: JSON.stringify({ supervisorPid: ALIVE_SUPERVISOR_PID, headroomPid: ALIVE_DAEMON_PID, socketPath: HEADROOM_SOCKET }) },
      isRunning: (pid: number) => running.has(pid),
      allowlist: { drift, file: ALLOWLIST_FILE, logPath: LOG_PATH, undeterminedFrontDoors, fileProblem },
    },
  });
  const failures = (report: ReturnType<typeof runDoctor>) => findingsFor(report, "headroom").filter((finding) => finding.severity === "fail");

  it("fails when the allowlist file lacks the serving door's origin, naming the file, the origin, and the supervisor that rewrites it", () => {
    const report = runDoctor(baseParams(headroomWith({ missingFromFile: [DOOR_ORIGIN], staleInFile: [MOVED_DOOR_ORIGIN], hashLags: true })));
    expect(failures(report)).toHaveLength(1);
    const message = failures(report)[0]?.message ?? "";
    expect(message).toContain(`${ALLOWLIST_FILE} lacks ${DOOR_ORIGIN}`);
    expect(message).toContain("live front doors' direct origins");
    expect(message).toContain(`supervisor ${String(ALIVE_SUPERVISOR_PID)} rewrites the file on its next tick`);
    expect(message).toContain(LOG_PATH);
    expect(report.ok).toBe(false);
  });

  it("fails for a missing door origin or a lagging recorded hash, since provider launches are refused or wait on either", () => {
    expect(runDoctor(baseParams(headroomWith({ missingFromFile: [OTHER_DOOR_ORIGIN], staleInFile: [], hashLags: true }))).ok).toBe(false);
    const hashOnly = runDoctor(baseParams(headroomWith({ missingFromFile: [], staleInFile: [], hashLags: true })));
    expect(hashOnly.ok).toBe(false);
    expect(failures(hashOnly)[0]?.message).toContain("has not yet recorded");
  });

  it("says nothing rewrites the file when the daemon outlived its supervisor", () => {
    const report = runDoctor(baseParams(headroomWith({ missingFromFile: [DOOR_ORIGIN], staleInFile: [], hashLags: true }, new Set([ALIVE_DAEMON_PID]))));
    expect(failures(report)[0]?.message).toContain("the supervisor is not running, so nothing rewrites the file until the next launch through headroom starts one");
  });

  it("fails, naming the restart that fixes it, for a daemon started by an earlier release whose fixed allowlist lags", () => {
    const report = runDoctor(baseParams(headroomWith({ startedByEarlierRelease: true })));
    expect(failures(report)[0]?.message).toContain("started by an earlier release with an allowlist fixed at start; it restarts once its sessions end");
  });

  it("only warns when the file still lists an upstream nothing routes to any more", () => {
    const report = runDoctor(baseParams(headroomWith({ missingFromFile: [], staleInFile: [MOVED_DOOR_ORIGIN], hashLags: false })));
    expect(report.ok).toBe(true);
    expect(findingsFor(report, "headroom").find((finding) => finding.severity === "warn")?.message).toContain(`still lists ${MOVED_DOOR_ORIGIN}`);
  });

  it("warns, without failing, naming a recorded door the process table could not answer for", () => {
    const report = runDoctor(baseParams(headroomWith(undefined, alive, [{ pid: 7004, origin: MOVED_DOOR_ORIGIN, reason: "ps timed out" }])));
    expect(report.ok).toBe(true);
    expect(findingsFor(report, "headroom").find((finding) => finding.severity === "warn")?.message).toBe(
      `Could not tell whether front door 7004 is still running (ps timed out), so headroom keeps admitting its direct origin ${MOVED_DOOR_ORIGIN} until a later read can.`,
    );
  });

  it("warns, naming why, for an allowlist file that breaks agent-shim's owner-only rule, which its supervisor repairs or stops the daemon over", () => {
    const report = runDoctor(baseParams(headroomWith(undefined, alive, [], { message: "the headroom allowlist directory /agent-shim/headroom/run has mode 0775, which lets other users reach it; it must be accessible to its owner only", repairable: true })));
    expect(report.ok).toBe(true);
    expect(findingsFor(report, "headroom").find((finding) => finding.severity === "warn")?.message).toBe(
      "Headroom's allowlist file breaks agent-shim's owner-only rule for it: the headroom allowlist directory /agent-shim/headroom/run has mode 0775, which lets other users reach it; it must be accessible to its owner only. Its supervisor repairs this on its next tick, and stops the daemon if it cannot.",
    );
  });

  it("fails, naming the directory and the remedy, for an ancestor of the allowlist file headroom refuses it over, which no repair can fix", () => {
    const message = "the directory /home/user on the allowlist file's path is writable by group or others (mode 0775), so headroom refuses the file; run `chmod go-w /home/user`";
    const report = runDoctor(baseParams(headroomWith(undefined, alive, [], { message, repairable: false })));
    expect(report.ok).toBe(false);
    expect(failures(report)[0]?.message).toBe(`Headroom refuses its allowlist file, so it admits nothing and every provider request through headroom fails: ${message}.`);
  });

  it("fails over such an ancestor after the supervisor stopped over it, since every later start stops the same way", () => {
    const message = "the directory /tmp on the allowlist file's path is writable by group or others (mode 1777), so headroom refuses the file; move the agent-shim root (AGENT_SHIM_HOME) to where every directory above it is owned by this user or root and not writable by group or others";
    const report = runDoctor(
      baseParams({
        headroom: {
          state: { path: "/agent-shim/headroom/state.json", raw: JSON.stringify({ lastError: `headroom would refuse its allowlist file, and agent-shim cannot repair it: ${message}` }) },
          isRunning: () => false,
          allowlist: { drift: undefined, file: ALLOWLIST_FILE, logPath: LOG_PATH, undeterminedFrontDoors: [], fileProblem: { message, repairable: false } },
        },
      }),
    );
    expect(report.ok).toBe(false);
    expect(failures(report).map((finding) => finding.message)).toEqual([`Headroom refuses its allowlist file, so it admits nothing and every provider request through headroom fails: ${message}.`]);
  });

  it("leaves a repairable break unreported while no daemon serves, since the next supervisor repairs it before serving", () => {
    const report = runDoctor(
      baseParams({
        headroom: {
          state: { path: "/agent-shim/headroom/state.json", raw: JSON.stringify({}) },
          isRunning: () => false,
          allowlist: { drift: undefined, file: ALLOWLIST_FILE, logPath: LOG_PATH, undeterminedFrontDoors: [], fileProblem: { message: `the headroom allowlist file ${ALLOWLIST_FILE} does not exist`, repairable: true } },
        },
      }),
    );
    expect(findingsFor(report, "headroom").filter((finding) => finding.message.includes("allowlist file"))).toEqual([]);
  });

  it("does not fail when the allowlist file and the recorded hash are current", () => {
    expect(runDoctor(baseParams(headroomWith(undefined))).ok).toBe(true);
  });
});

describe("runDoctor: front door listeners", () => {
  const baseDoor = { supervisorPid: SERVING_DOOR_PID, port: 4100, connectPort: 4200 };
  const serving = { ok: true as const, pids: [SERVING_DOOR_PID] };

  /** The door's report input with the listener readings a probe of it produced. */
  function withListeners(listeners: NonNullable<NonNullable<RunDoctorParams["frontDoor"]>["listeners"]>): Partial<RunDoctorParams> {
    const { frontDoor } = frontDoorParams(baseDoor, serving);
    if (frontDoor === undefined) {
      throw new Error("the helper always supplies a front door");
    }
    return { frontDoor: { ...frontDoor, listeners } };
  }

  it("passes a listener that accepted and says how long the probe took", () => {
    const report = runDoctor({ ...baseParams(), ...withListeners([{ listener: "connect", port: 4200, ok: true, elapsedMs: 12.4 }]) });
    expect(findingsFor(report, "frontdoor").some((finding) => finding.severity === "pass" && finding.message.includes("connect listener on 127.0.0.1:4200 accepted a probe in 12 ms"))).toBe(true);
  });

  it("fails a listener that did not accept, naming the sessions it cuts off and the way out", () => {
    const report = runDoctor({
      ...baseParams(),
      ...withListeners([{ listener: "connect", port: 4200, ok: false, reason: "no connection accepted within 2000ms", elapsedMs: 2000 }]),
    });
    const failing = findingsFor(report, "frontdoor").find((finding) => finding.severity === "fail");
    expect(failing?.message).toContain("every plain OAuth session");
    expect(failing?.message).toContain("agent-shim frontdoor restart");
  });
});


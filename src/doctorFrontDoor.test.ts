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

function frontDoorParams(state: Record<string, unknown> | undefined, supervisors: NonNullable<RunDoctorParams["frontDoor"]>["supervisors"]): Partial<RunDoctorParams> {
  return { frontDoor: { state: { path: FRONT_DOOR_STATE_PATH, raw: state === undefined ? undefined : JSON.stringify(state) }, supervisors } };
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

describe("runDoctor: headroom allowlist and the serving door", () => {
  const alive = new Set([ALIVE_SUPERVISOR_PID, ALIVE_DAEMON_PID]);
  const headroomWith = (allowlist: NonNullable<RunDoctorParams["headroom"]["allowlist"]>): Partial<RunDoctorParams> => ({
    headroom: {
      state: { path: "/agent-shim/headroom/state.json", raw: JSON.stringify({ supervisorPid: ALIVE_SUPERVISOR_PID, headroomPid: ALIVE_DAEMON_PID, socketPath: HEADROOM_SOCKET }) },
      isRunning: (pid: number) => alive.has(pid),
      allowlist,
    },
  });

  it("fails when the running daemon's allowlist excludes the serving door's origin", () => {
    const report = runDoctor(baseParams(headroomWith({ driftInputs: ["front-door-origin"], frontDoorOrigin: DOOR_ORIGIN })));
    const failures = findingsFor(report, "headroom").filter((finding) => finding.severity === "fail");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain(DOOR_ORIGIN);
    expect(failures[0]?.message).toContain("excludes");
    expect(report.ok).toBe(false);
  });

  it("fails with the candidate wording when the origin moved or a provider changed", () => {
    const report = runDoctor(baseParams(headroomWith({ driftInputs: ["provider-files", "front-door-origin"], frontDoorOrigin: DOOR_ORIGIN })));
    const failure = findingsFor(report, "headroom").find((finding) => finding.severity === "fail");
    expect(failure?.message).toContain("may exclude");
  });

  it("does not fail for a provider-file drift alone", () => {
    const report = runDoctor(baseParams(headroomWith({ driftInputs: ["provider-files"], frontDoorOrigin: undefined })));
    expect(report.ok).toBe(true);
  });

  it("does not fail when the allowlist has not drifted", () => {
    const report = runDoctor(baseParams(headroomWith({ driftInputs: undefined, frontDoorOrigin: DOOR_ORIGIN })));
    expect(report.ok).toBe(true);
  });
});

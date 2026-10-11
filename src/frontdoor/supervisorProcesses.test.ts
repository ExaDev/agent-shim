import { describe, expect, it } from "vitest";

import type { RunPort } from "../launcher/ports";
import { listFrontDoorSupervisors, parseFrontDoorSupervisorPids } from "./supervisorProcesses";

const FIRST_PID = 101;
const SECOND_PID = 202;
const UID = 501;

const PS_OUTPUT = [
  `  ${String(FIRST_PID)} /usr/local/bin/agent-shim __frontdoor-supervisor`,
  `  ${String(SECOND_PID)} /Users/u/.local/bin/agent-shim __frontdoor-supervisor --extra`,
  "  303 /usr/bin/vim notes-about-__frontdoor-supervisor.txt",
  "  404 grep __frontdoor-supervisor-ish",
  "  505 /usr/local/bin/agent-shim __headroom-supervisor",
  "",
].join("\n");

describe("parseFrontDoorSupervisorPids", () => {
  it("returns the pid of each process whose argument is exactly the subcommand", () => {
    expect(parseFrontDoorSupervisorPids(PS_OUTPUT)).toEqual([FIRST_PID, SECOND_PID]);
  });

  it("returns nothing for empty output", () => {
    expect(parseFrontDoorSupervisorPids("")).toEqual([]);
  });
});

describe("listFrontDoorSupervisors", () => {
  it("asks ps for the given user's processes and parses the answer", () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const run: RunPort = {
      run: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: PS_OUTPUT, stderr: "" };
      },
    };
    expect(listFrontDoorSupervisors(run, UID)).toEqual({ ok: true, pids: [FIRST_PID, SECOND_PID] });
    expect(calls).toEqual([{ command: "ps", args: ["-U", String(UID), "-o", "pid=,command="] }]);
  });

  it("reports a ps that could not be run", () => {
    const run: RunPort = { run: () => ({ status: null, stdout: "", stderr: "" }) };
    expect(listFrontDoorSupervisors(run, UID)).toEqual({ ok: false, message: "ps could not be run" });
  });

  it("reports a failed ps rather than an empty list", () => {
    const run: RunPort = { run: () => ({ status: 1, stdout: "", stderr: "ps: illegal option\n" }) };
    expect(listFrontDoorSupervisors(run, UID)).toEqual({ ok: false, message: "ps exited 1: ps: illegal option" });
  });
});

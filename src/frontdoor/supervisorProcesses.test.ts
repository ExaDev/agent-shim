import { describe, expect, it } from "vitest";

import type { RunPort } from "../launcher/ports";
import { frontDoorLivenessFromPs, frontDoorLivenessOf, listFrontDoorSupervisors, parseFrontDoorSupervisorPids } from "./supervisorProcesses";

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

describe("frontDoorLivenessFromPs", () => {
  const DOOR = 4100;
  const ZOMBIE_DOOR = 4101;
  const OTHER = 4102;
  const GONE = 4103;
  const UNASKED = 4199;
  const asked = [DOOR, ZOMBIE_DOOR, OTHER, GONE];

  it("counts a listed, non-zombie front-door supervisor as a door and every other pid the table answers for as not one", () => {
    const stdout = [
      `${String(DOOR)} Ss /usr/local/bin/agent-shim __frontdoor-supervisor`,
      `${String(ZOMBIE_DOOR)} Z <defunct> __frontdoor-supervisor`,
      `${String(OTHER)} S /usr/bin/vim notes-about-__frontdoor-supervisor.md`,
    ].join("\n");
    expect(frontDoorLivenessFromPs({ status: 0, stdout, stderr: "" }, asked)).toEqual({ doors: new Set([DOOR]), unknown: new Map() });
  });

  it("reads only lines led by a pid it asked about, and only the first line for each, so a command line holding a line break cannot forge a door", () => {
    const stdout = [
      `${String(OTHER)} S /usr/bin/evil`,
      `${String(OTHER)} S x __frontdoor-supervisor`,
      `${String(UNASKED)} S /usr/local/bin/agent-shim __frontdoor-supervisor`,
    ].join("\n");
    expect(frontDoorLivenessFromPs({ status: 0, stdout, stderr: "" }, asked)).toEqual({ doors: new Set(), unknown: new Map() });
  });

  it("reads ps exiting 1 with no output as none of the pids running", () => {
    expect(frontDoorLivenessFromPs({ status: 1, stdout: "", stderr: "" }, asked)).toEqual({ doors: new Set(), unknown: new Map() });
  });

  it("leaves every pid unknown, with the reason, when ps could not be run, was killed or timed out, or failed with a message", () => {
    const unknownAll = (reason: string): Map<number, string> => new Map(asked.map((pid) => [pid, reason]));
    expect(frontDoorLivenessFromPs({ status: null, stdout: "", stderr: "", error: new Error("spawnSync ps ETIMEDOUT") }, asked)).toEqual({ doors: new Set(), unknown: unknownAll("spawnSync ps ETIMEDOUT") });
    expect(frontDoorLivenessFromPs({ status: null, stdout: "", stderr: "" }, asked)).toEqual({ doors: new Set(), unknown: unknownAll("ps was terminated before it answered") });
    expect(frontDoorLivenessFromPs({ status: 1, stdout: "", stderr: "ps: illegal option" }, asked)).toEqual({ doors: new Set(), unknown: unknownAll("ps exited 1: ps: illegal option") });
  });
});

describe("frontDoorLivenessOf", () => {
  const DOOR = 4100;
  const TOO_LARGE = 999_999;

  it("reads every pid in one run when that run answers", () => {
    const runs: (readonly number[])[] = [];
    const liveness = frontDoorLivenessOf([DOOR, TOO_LARGE], (pids) => {
      runs.push(pids);
      return { status: 0, stdout: `${String(DOOR)} S agent-shim __frontdoor-supervisor`, stderr: "" };
    });
    expect(runs).toEqual([[DOOR, TOO_LARGE]]);
    expect(liveness).toEqual({ doors: new Set([DOOR]), unknown: new Map() });
  });

  it("falls back to reading each pid on its own when the batch fails, and reads a pid ps calls too large as not running", () => {
    const runs: (readonly number[])[] = [];
    const liveness = frontDoorLivenessOf([DOOR, TOO_LARGE], (pids) => {
      runs.push(pids);
      if (pids.includes(TOO_LARGE)) {
        return { status: 1, stdout: "", stderr: `ps: process id too large: ${String(TOO_LARGE)}` };
      }
      return { status: 0, stdout: `${String(DOOR)} S agent-shim __frontdoor-supervisor`, stderr: "" };
    });
    expect(runs).toEqual([[DOOR, TOO_LARGE], [DOOR], [TOO_LARGE]]);
    // ps saying a pid is too large to exist is an answer: that pid is not running, so its record can go.
    expect(liveness).toEqual({ doors: new Set([DOOR]), unknown: new Map() });
  });

  it("leaves a pid unknown when its own read fails for any other reason", () => {
    const liveness = frontDoorLivenessOf([DOOR, TOO_LARGE], (pids) =>
      pids.includes(TOO_LARGE) ? { status: 1, stdout: "", stderr: "ps: unknown option" } : { status: 0, stdout: `${String(DOOR)} S agent-shim __frontdoor-supervisor`, stderr: "" },
    );
    expect(liveness).toEqual({ doors: new Set([DOOR]), unknown: new Map([[TOO_LARGE, "ps exited 1: ps: unknown option"]]) });
  });

  it("never reads a batch refused over one too-large pid as every pid gone", () => {
    const liveness = frontDoorLivenessFromPs({ status: 1, stdout: "", stderr: `ps: process id too large: ${String(TOO_LARGE)}` }, [DOOR, TOO_LARGE]);
    expect([...liveness.unknown.keys()]).toEqual([DOOR, TOO_LARGE]);
  });

  it("runs nothing when there is nothing to ask about", () => {
    expect(frontDoorLivenessOf([], () => {
      throw new Error("no run expected");
    })).toEqual({ doors: new Set(), unknown: new Map() });
  });
});

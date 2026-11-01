import { describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { createIdentitySessionProbe, parseEnvironmentListing, type ProcessTableFs } from "./identitySessions";
import type { RunPort } from "./launcher/ports";

const WORK_DIR = "/example/identities/work";
const OWN_PID = 900;
const LINUX_UID = 1000;
const MACOS_UID = 501;

describe("parseEnvironmentListing", () => {
  it("finds the processes whose environment names the directory, and names only the roots of each tree", () => {
    const listing = [
      `  100     1 /usr/local/bin/claude --resume HOME=/home/alex CLAUDE_CONFIG_DIR=${WORK_DIR} TERM=xterm`,
      `  101   100 /bin/zsh -c ls HOME=/home/alex CLAUDE_CONFIG_DIR=${WORK_DIR}`,
      `  102   101 /bin/ls HOME=/home/alex CLAUDE_CONFIG_DIR=${WORK_DIR}`,
      "  200     1 /usr/bin/vim HOME=/home/alex",
    ].join("\n");
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID)).toEqual([{ pid: 100, program: "claude" }]);
  });

  it("does not take a directory whose name merely starts with the identity's", () => {
    const listing = `  100     1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=${WORK_DIR}2 TERM=xterm\n  101     1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=${WORK_DIR}-old`;
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID)).toEqual([]);
  });

  it("matches the variable at the end of the line and with the command's own arguments before it", () => {
    const listing = `  100     1 /usr/bin/env CLAUDE_CONFIG_DIR=${WORK_DIR}`;
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID)).toEqual([{ pid: 100, program: "env" }]);
  });

  it("leaves out the process asking and the helper it started to ask with", () => {
    const listing = [`  900   800 node agent-shim CLAUDE_CONFIG_DIR=${WORK_DIR}`, `  901   900 ps -E -ww CLAUDE_CONFIG_DIR=${WORK_DIR}`].join("\n");
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID)).toEqual([]);
  });

  it("reports the shell that started the asking process, because it holds the directory too", () => {
    const listing = [`  800     1 /bin/zsh CLAUDE_CONFIG_DIR=${WORK_DIR}`, `  900   800 node agent-shim CLAUDE_CONFIG_DIR=${WORK_DIR}`].join("\n");
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID)).toEqual([{ pid: 800, program: "zsh" }]);
  });

  it("ignores lines that are not a process", () => {
    expect(parseEnvironmentListing(`\nnot a process line CLAUDE_CONFIG_DIR=${WORK_DIR}\n`, WORK_DIR, OWN_PID)).toEqual([]);
  });
});

/** A fake `/proc`: a directory of process directories, each with an `environ` (NUL separated), a `stat` and a `comm`. */
function fakeProc(processes: readonly { readonly pid: number; readonly ppid: number; readonly comm: string; readonly environment: readonly string[]; readonly readable?: boolean }[]): ProcessTableFs {
  const files = new Map<string, string>();
  for (const process of processes) {
    if (process.readable !== false) {
      files.set(`/proc/${String(process.pid)}/environ`, `${process.environment.join("\u0000")}\u0000`);
    }
    files.set(`/proc/${String(process.pid)}/stat`, `${String(process.pid)} (${process.comm}) S ${String(process.ppid)} 1 1 0 -1`);
    files.set(`/proc/${String(process.pid)}/comm`, `${process.comm}\n`);
  }
  return {
    readdir: (dir) => (dir === "/proc" ? [...processes.map((process) => String(process.pid)), "self", "cpuinfo"] : []),
    readFile: (file) => files.get(file),
  };
}

const unusedRun: RunPort = {
  run: () => {
    throw new Error("a Linux probe must not run a command");
  },
};

describe("createIdentitySessionProbe", () => {
  it("on Linux reads each process's own environment, so a directory with spaces or a lookalike name is exact", () => {
    const procFs = fakeProc([
      { pid: 100, ppid: 1, comm: "claude", environment: ["HOME=/home/alex", `CLAUDE_CONFIG_DIR=${WORK_DIR}`] },
      { pid: 101, ppid: 100, comm: "bash", environment: [`CLAUDE_CONFIG_DIR=${WORK_DIR}`] },
      { pid: 102, ppid: 1, comm: "claude", environment: [`CLAUDE_CONFIG_DIR=${WORK_DIR}2`] },
      { pid: 103, ppid: 1, comm: "other", environment: ["HOME=/home/alex"], readable: false },
    ]);
    const probe = createIdentitySessionProbe("linux", { run: unusedRun, uid: () => LINUX_UID, ownPid: OWN_PID, procFs });
    expect(probe.sessionsOn(WORK_DIR)).toEqual([{ pid: 100, program: "claude" }]);
  });

  it("on macOS reads the user's processes with their environments through ps", () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const run: RunPort = {
      run: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: `  100     1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=${WORK_DIR}\n`, stderr: "" };
      },
    };
    const probe = createIdentitySessionProbe("darwin", { run, uid: () => MACOS_UID, ownPid: OWN_PID, procFs: fakeProc([]) });
    expect(probe.sessionsOn(WORK_DIR)).toEqual([{ pid: 100, program: "claude" }]);
    expect(calls).toEqual([{ command: "ps", args: ["-E", "-ww", "-U", String(MACOS_UID), "-o", "pid=,ppid=,command="] }]);
  });

  it("refuses to guess when ps cannot be read", () => {
    const run: RunPort = { run: () => ({ status: 1, stdout: "", stderr: "ps: not permitted" }) };
    const probe = createIdentitySessionProbe("darwin", { run, uid: () => MACOS_UID, ownPid: OWN_PID, procFs: fakeProc([]) });
    expect(() => probe.sessionsOn(WORK_DIR)).toThrow(/Could not read the process table/);
  });

  it("refuses on a platform where a process's environment cannot be read, rather than report no sessions", () => {
    const probe = createIdentitySessionProbe("win32", { run: unusedRun, uid: () => 0, ownPid: OWN_PID, procFs: fakeProc([]) });
    expect(() => probe.sessionsOn(WORK_DIR)).toThrow(CliError);
    expect(() => probe.sessionsOn(WORK_DIR)).toThrow(/win32/);
  });
});

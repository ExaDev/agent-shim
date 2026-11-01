import { describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { createIdentitySessionProbe, parseEnvironmentListing, type ProcessTableFs, type ProcRead } from "./identitySessions";
import type { RunPort } from "./launcher/ports";

const WORK_DIR = "/example/identities/work";
const OWN_PID = 900;
const LINUX_UID = 1000;
const MACOS_UID = 501;
const OTHER_UID = 0;

/** Maps a path to where it really is, as `realpath` does for a symlink; any other path is its own. */
function realpathOf(links: Readonly<Record<string, string>> = {}): (target: string) => string {
  return (target) => links[target] ?? target;
}

const noLinks = realpathOf();

describe("parseEnvironmentListing", () => {
  it("finds the processes whose environment names the directory, and names only the roots of each tree", () => {
    const listing = [
      `  100     1 /usr/local/bin/claude --resume HOME=/home/alex CLAUDE_CONFIG_DIR=${WORK_DIR} TERM=xterm`,
      `  101   100 /bin/zsh -c ls HOME=/home/alex CLAUDE_CONFIG_DIR=${WORK_DIR}`,
      `  102   101 /bin/ls HOME=/home/alex CLAUDE_CONFIG_DIR=${WORK_DIR}`,
      "  200     1 /usr/bin/vim HOME=/home/alex",
    ].join("\n");
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID, noLinks)).toEqual([{ pid: 100, program: "claude" }]);
  });

  it("does not take a directory whose name merely starts with the identity's", () => {
    const listing = `  100     1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=${WORK_DIR}2 TERM=xterm\n  101     1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=${WORK_DIR}-old`;
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID, noLinks)).toEqual([]);
  });

  it("matches the variable at the end of the line and with the command's own arguments before it", () => {
    const listing = `  100     1 /usr/bin/env CLAUDE_CONFIG_DIR=${WORK_DIR}`;
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID, noLinks)).toEqual([{ pid: 100, program: "env" }]);
  });

  it("takes the directory with a trailing slash, which names the same directory", () => {
    const listing = `  100     1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=${WORK_DIR}/ TERM=xterm\n  101     1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=${WORK_DIR}//`;
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID, noLinks)).toEqual([
      { pid: 100, program: "claude" },
      { pid: 101, program: "claude" },
    ]);
  });

  it("takes a spelling of the directory that reaches it through a symlink, from either side", () => {
    const links = realpathOf({ "/example/shortcut/work": WORK_DIR });
    const viaLink = `  100     1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=/example/shortcut/work TERM=xterm`;
    expect(parseEnvironmentListing(viaLink, WORK_DIR, OWN_PID, links)).toEqual([{ pid: 100, program: "claude" }]);
    const viaRealPath = `  100     1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=${WORK_DIR} TERM=xterm`;
    expect(parseEnvironmentListing(viaRealPath, "/example/shortcut/work", OWN_PID, links)).toEqual([{ pid: 100, program: "claude" }]);
  });

  it("takes a directory whose name holds a space, which splits the environment's words, when it is spelled as asked", () => {
    const spaced = "/example/with space/work";
    const listing = `  100     1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=${spaced} TERM=xterm`;
    expect(parseEnvironmentListing(listing, spaced, OWN_PID, noLinks)).toEqual([{ pid: 100, program: "claude" }]);
  });

  it("leaves out the process asking and the helper it started to ask with", () => {
    const listing = [`  900   800 node agent-shim CLAUDE_CONFIG_DIR=${WORK_DIR}`, `  901   900 ps -E -ww CLAUDE_CONFIG_DIR=${WORK_DIR}`].join("\n");
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID, noLinks)).toEqual([]);
  });

  it("reports the shell that started the asking process, because it holds the directory too", () => {
    const listing = [`  800     1 /bin/zsh CLAUDE_CONFIG_DIR=${WORK_DIR}`, `  900   800 node agent-shim CLAUDE_CONFIG_DIR=${WORK_DIR}`].join("\n");
    expect(parseEnvironmentListing(listing, WORK_DIR, OWN_PID, noLinks)).toEqual([{ pid: 800, program: "zsh" }]);
  });

  it("ignores lines that are not a process", () => {
    expect(parseEnvironmentListing(`\nnot a process line CLAUDE_CONFIG_DIR=${WORK_DIR}\n`, WORK_DIR, OWN_PID, noLinks)).toEqual([]);
  });
});

interface FakeProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly comm: string;
  readonly environment: readonly string[];
  /** Whether the environment can be read by this user. Default true. */
  readonly readable?: boolean;
  /** The user the process runs as. Default the probing user. */
  readonly uid?: number;
}

/** A fake `/proc`: a directory of process directories, each with an `environ` (NUL separated), a `stat`, a `status` and a `comm`. An unreadable environment answers as the kernel does for a process this user may not inspect. */
function fakeProc(processes: readonly FakeProcess[]): ProcessTableFs {
  const files = new Map<string, string>();
  const unreadable = new Set<string>();
  for (const proc of processes) {
    const dir = `/proc/${String(proc.pid)}`;
    if (proc.readable === false) {
      unreadable.add(`${dir}/environ`);
    } else {
      files.set(`${dir}/environ`, `${proc.environment.join("\u0000")}\u0000`);
    }
    files.set(`${dir}/stat`, `${String(proc.pid)} (${proc.comm}) S ${String(proc.ppid)} 1 1 0 -1`);
    const uid = proc.uid ?? LINUX_UID;
    files.set(`${dir}/status`, `Name:\t${proc.comm}\nUid:\t${String(uid)}\t${String(uid)}\t${String(uid)}\t${String(uid)}\n`);
    files.set(`${dir}/comm`, `${proc.comm}\n`);
  }
  return {
    readdir: (dir) => (dir === "/proc" ? [...processes.map((proc) => String(proc.pid)), "self", "cpuinfo"] : []),
    readFile: (file): ProcRead => {
      if (unreadable.has(file)) {
        return { kind: "unreadable" };
      }
      const text = files.get(file);
      return text === undefined ? { kind: "absent" } : { kind: "text", text };
    },
  };
}

const unusedRun: RunPort = {
  run: () => {
    throw new Error("a Linux probe must not run a command");
  },
};

function linuxProbe(processes: readonly FakeProcess[], links: Readonly<Record<string, string>> = {}) {
  return createIdentitySessionProbe("linux", { run: unusedRun, uid: () => LINUX_UID, ownPid: OWN_PID, procFs: fakeProc(processes), realpath: realpathOf(links) });
}

describe("createIdentitySessionProbe", () => {
  it("on Linux reads each process's own environment, so a directory with spaces or a lookalike name is exact", () => {
    const probe = linuxProbe([
      { pid: 100, ppid: 1, comm: "claude", environment: ["HOME=/home/alex", `CLAUDE_CONFIG_DIR=${WORK_DIR}`] },
      { pid: 101, ppid: 100, comm: "bash", environment: [`CLAUDE_CONFIG_DIR=${WORK_DIR}`] },
      { pid: 102, ppid: 1, comm: "claude", environment: [`CLAUDE_CONFIG_DIR=${WORK_DIR}2`] },
      { pid: 103, ppid: 1, comm: "other", environment: ["HOME=/home/alex"] },
    ]);
    expect(probe.sessionsOn(WORK_DIR)).toEqual([{ pid: 100, program: "claude" }]);
  });

  it("on Linux takes a trailing slash and a symlinked spelling of the directory", () => {
    const probe = linuxProbe(
      [
        { pid: 100, ppid: 1, comm: "claude", environment: [`CLAUDE_CONFIG_DIR=${WORK_DIR}/`] },
        { pid: 101, ppid: 1, comm: "claude", environment: ["CLAUDE_CONFIG_DIR=/example/shortcut/work"] },
      ],
      { "/example/shortcut/work": WORK_DIR },
    );
    expect(probe.sessionsOn(WORK_DIR)).toEqual([
      { pid: 100, program: "claude" },
      { pid: 101, program: "claude" },
    ]);
  });

  it("on Linux refuses, naming the process, when the environment of a process of the same user cannot be read, since it may be a session", () => {
    const probe = linuxProbe([
      { pid: 100, ppid: 1, comm: "claude", environment: [`CLAUDE_CONFIG_DIR=${WORK_DIR}`] },
      { pid: 103, ppid: 1, comm: "locked-down", environment: [], readable: false },
    ]);
    expect(() => probe.sessionsOn(WORK_DIR)).toThrow(CliError);
    expect(() => probe.sessionsOn(WORK_DIR)).toThrow(/pid 103 \(locked-down\)/);
  });

  it("on Linux does not mind an unreadable environment that belongs to another user, which cannot be a session on this user's directory", () => {
    const probe = linuxProbe([
      { pid: 100, ppid: 1, comm: "claude", environment: [`CLAUDE_CONFIG_DIR=${WORK_DIR}`] },
      { pid: 104, ppid: 1, comm: "daemon", environment: [], readable: false, uid: OTHER_UID },
    ]);
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
    const probe = createIdentitySessionProbe("darwin", { run, uid: () => MACOS_UID, ownPid: OWN_PID, procFs: fakeProc([]), realpath: noLinks });
    expect(probe.sessionsOn(WORK_DIR)).toEqual([{ pid: 100, program: "claude" }]);
    expect(calls).toEqual([{ command: "ps", args: ["-E", "-ww", "-U", String(MACOS_UID), "-o", "pid=,ppid=,command="] }]);
  });

  it("on macOS counts only the processes whose environment ps shows, since it prints none for one it cannot read", () => {
    const listing = [` 100 1 /usr/local/bin/claude CLAUDE_CONFIG_DIR=${WORK_DIR}`, " 300 1 /usr/libexec/some-agent", " 301 1 /Applications/Example.app/Contents/MacOS/Example"].join("\n");
    const run: RunPort = { run: () => ({ status: 0, stdout: `${listing}\n`, stderr: "" }) };
    const probe = createIdentitySessionProbe("darwin", { run, uid: () => MACOS_UID, ownPid: OWN_PID, procFs: fakeProc([]), realpath: noLinks });
    expect(probe.sessionsOn(WORK_DIR)).toEqual([{ pid: 100, program: "claude" }]);
  });

  it("refuses to guess when ps cannot be read", () => {
    const run: RunPort = { run: () => ({ status: 1, stdout: "", stderr: "ps: not permitted" }) };
    const probe = createIdentitySessionProbe("darwin", { run, uid: () => MACOS_UID, ownPid: OWN_PID, procFs: fakeProc([]), realpath: noLinks });
    expect(() => probe.sessionsOn(WORK_DIR)).toThrow(/Could not read the process table/);
  });

  it("refuses on a platform where a process's environment cannot be read, rather than report no sessions", () => {
    const probe = createIdentitySessionProbe("win32", { run: unusedRun, uid: () => OTHER_UID, ownPid: OWN_PID, procFs: fakeProc([]), realpath: noLinks });
    expect(() => probe.sessionsOn(WORK_DIR)).toThrow(CliError);
    expect(() => probe.sessionsOn(WORK_DIR)).toThrow(/win32/);
  });
});

import fs from "node:fs";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import type { Command } from "commander";

import { readGlobalConfig } from "../configProfiles";
import type { LayoutPaths } from "../paths";
import { realFarmFs, realIsProcessAlive, realSleepSync } from "../realPorts";
import {
  hashAllowlist,
  headroomAllowlist,
  listSessions,
  readAllProviders,
  readHeadroomState,
  type HeadroomFs,
  type HeadroomSession,
  type HeadroomState,
} from "./state";
import { resolveSupervisorConfig, runSupervisor, type SupervisorPorts } from "./supervisor";

/** One session-registry entry plus whether its launcher pid is still running. */
interface HeadroomSessionStatus extends HeadroomSession {
  readonly alive: boolean;
}

/** Everything `claude-use headroom status` reports, collected read-only: no process is started or stopped. */
export interface HeadroomStatus {
  readonly state: HeadroomState;
  readonly supervisorAlive: boolean;
  readonly headroomAlive: boolean;
  readonly sessions: readonly HeadroomSessionStatus[];
  /** The allowlist the daemon WOULD be started with now, from the current provider files. */
  readonly allowlist: readonly string[];
  /** True when that allowlist differs from the one the running daemon was started with, i.e. a drift restart is pending. */
  readonly allowlistDrifted: boolean;
  readonly logPath: string;
  readonly logExists: boolean;
}

/** Collects the read-only status of the headroom daemon: state, pid liveness, the session registry, and the allowlist as the current provider files would produce it. */
export function collectHeadroomStatus(
  fsPort: HeadroomFs,
  paths: LayoutPaths,
  isProcessAlive: (pid: number) => boolean,
): HeadroomStatus {
  const state = readHeadroomState(fsPort, paths.headroomStateFile) ?? {};
  const allowlist = headroomAllowlist(readAllProviders(fsPort, paths.providersDir).map((entry) => entry.provider));
  return {
    state,
    supervisorAlive: state.supervisorPid !== undefined && isProcessAlive(state.supervisorPid),
    headroomAlive: state.headroomPid !== undefined && isProcessAlive(state.headroomPid),
    sessions: listSessions(fsPort, paths.headroomSessionsDir).map((session) => ({
      ...session,
      alive: isProcessAlive(session.pid),
    })),
    allowlist,
    allowlistDrifted: state.allowlistHash !== undefined && state.allowlistHash !== hashAllowlist(allowlist),
    logPath: paths.headroomLogPath,
    logExists: fsPort.readFileUtf8(paths.headroomLogPath) !== undefined,
  };
}

/** Formats `claude-use headroom status`'s output, one line per array entry. */
export function formatHeadroomStatus(status: HeadroomStatus): string[] {
  const lines: string[] = [];
  if (status.state.supervisorPid === undefined) {
    lines.push("supervisor: not running (no state recorded)");
  } else {
    lines.push(
      `supervisor: pid ${String(status.state.supervisorPid)} (${status.supervisorAlive ? "alive" : "NOT running"})`,
    );
  }
  if (status.state.headroomPid === undefined || status.state.port === undefined) {
    lines.push("headroom: not running");
  } else {
    lines.push(
      `headroom: pid ${String(status.state.headroomPid)} (${status.headroomAlive ? "alive" : "NOT running"}), ` +
        `listening on 127.0.0.1:${String(status.state.port)}` +
        (status.state.version === undefined ? "" : `, ${status.state.version}`),
    );
  }
  const drift = status.allowlistDrifted ? " (DRIFTED: current provider files differ from the running daemon's allowlist; a restart is pending)" : "";
  lines.push(`allowlist: ${status.allowlist.join(", ")}${drift}`);
  if (status.sessions.length === 0) {
    lines.push("sessions: none");
  } else {
    const pids = status.sessions.map((session) => `${String(session.pid)}${session.alive ? "" : " (dead)"}`);
    lines.push(`sessions: ${String(status.sessions.length)} registered (${pids.join(", ")})`);
  }
  if (status.state.lastError !== undefined) {
    lines.push(`last error: ${status.state.lastError}`);
  }
  lines.push(`daemon log: ${status.logPath}${status.logExists ? "" : " (not created yet)"}`);
  return lines;
}

/** Binds a real loopback port and releases it again, giving headroom a port nothing else is listening on. */
async function realFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      // A listening TCP server's address is always the object form; the string form is for pipes and unix sockets only.
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port === 0) {
          reject(new Error("could not reserve a loopback port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

/** The pid of the headroom process this supervisor currently owns, so the exit hook below never orphans it. */
let supervisedHeadroomPid: number | undefined;

/** How long a stopped daemon gets to exit on SIGTERM before the supervisor escalates to SIGKILL: enough to drain an in-flight request, not enough to stall the loop. */
const STOP_GRACE_MS = 1500;

/** Per-attempt timeout on the readiness probe: a loopback request either answers quickly or the attempt has failed. */
const READY_FETCH_TIMEOUT_MS = 2000;

/** The real `SupervisorPorts`: real processes, ports, clock, filesystem, and network. */
function realSupervisorPorts(paths: LayoutPaths): SupervisorPorts {
  return {
    fs: realFarmFs,
    paths,
    ownPid: process.pid,
    now: () => Date.now(),
    sleep: realSleepSync,
    isProcessAlive: realIsProcessAlive,
    freePort: realFreePort,
    spawnHeadroom: (port, allowlist) => {
      fs.mkdirSync(paths.logsDir, { recursive: true });
      const logFd = fs.openSync(paths.headroomLogPath, "a");
      try {
        const child = spawn("headroom", ["proxy", "--host", "127.0.0.1", "--port", String(port)], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: { ...process.env, HEADROOM_ALLOWED_BASE_URLS: allowlist.join(",") },
        });
        child.unref();
        if (child.pid === undefined) {
          throw new Error("spawning headroom returned no pid");
        }
        supervisedHeadroomPid = child.pid;
        return child.pid;
      } finally {
        fs.closeSync(logFd);
      }
    },
    stopProcess: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already dead: the supervisor only ever stops pids it believes are running.
      }
      // Grace period, then force: a proxy mid-request deserves a chance to drain, but the supervisor must not wait on it forever.
      realSleepSync(STOP_GRACE_MS);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // It exited after SIGTERM, which is the good outcome.
      }
      if (supervisedHeadroomPid === pid) {
        supervisedHeadroomPid = undefined;
      }
    },
    ready: async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/readyz`, { signal: AbortSignal.timeout(READY_FETCH_TIMEOUT_MS) });
        return response.ok;
      } catch {
        return false;
      }
    },
    install: (spec) => {
      const result = spawnSync("uv", ["tool", "install", spec], { encoding: "utf8" });
      if (result.error !== undefined) {
        return { ok: false, error: `uv is not installed or not on PATH (${result.error.message})` };
      }
      if (result.stdout !== "") {
        fs.appendFileSync(paths.headroomLogPath, result.stdout);
      }
      if (result.stderr !== "") {
        fs.appendFileSync(paths.headroomLogPath, result.stderr);
      }
      return result.status === 0 ? { ok: true } : { ok: false, error: `uv tool install exited ${String(result.status)}` };
    },
    headroomVersion: () => {
      const result = spawnSync("headroom", ["--version"], { encoding: "utf8" });
      return result.status === 0 ? result.stdout.trim() : undefined;
    },
    log: (line) => {
      fs.mkdirSync(paths.logsDir, { recursive: true });
      fs.appendFileSync(paths.headroomLogPath, `${new Date().toISOString()} ${line}\n`);
    },
  };
}

/** Registers the `claude-use headroom` command tree and the hidden `__headroom-supervisor` internal subcommand. */
export function registerHeadroomCommand(program: Command, paths: LayoutPaths): void {
  const headroom = program.command("headroom").description("Inspect the headroom routing daemon.");

  headroom
    .command("status")
    .description("Report the headroom daemon's supervisor, process, port, sessions, and last error. Read-only.")
    .action(() => {
      for (const line of formatHeadroomStatus(collectHeadroomStatus(realFarmFs, paths, realIsProcessAlive))) {
        console.log(line);
      }
    });

  program
    .command("__headroom-supervisor", { hidden: true })
    .description("Internal: supervise the headroom daemon. Started by the launcher; never run by hand.")
    .allowUnknownOption()
    .action(async () => {
      const globalConfig = readGlobalConfig(paths);
      const config = resolveSupervisorConfig(globalConfig?.headroom ?? {});
      // If this supervisor dies without reaching its own shutdown path, take headroom with it rather than leaving an unsupervised daemon behind.
      process.on("exit", () => {
        if (supervisedHeadroomPid !== undefined) {
          try {
            process.kill(supervisedHeadroomPid, "SIGTERM");
          } catch {
            // Already gone.
          }
        }
      });
      const code = await runSupervisor(config, realSupervisorPorts(paths));
      process.exit(code);
    });
}

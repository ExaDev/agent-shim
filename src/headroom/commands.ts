import fs from "node:fs";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { readGlobalConfig } from "../configProfiles";
import type { LayoutPaths } from "../paths";
import { realFarmFs, realIsPortFree, realIsProcessRunning, realSleepSync } from "../realPorts";
import {
  createLeafCache,
  ensureCa,
  generateCa,
  HTTPS_PORT,
  MITM_INTERCEPT_HOST,
  realMitmCertStore,
  realMitmEffects,
  startMitmServer,
} from "./mitm";
import {
  hashAllowlist,
  listSessions,
  readHeadroomState,
  type HeadroomFs,
  type HeadroomSession,
  type HeadroomState,
} from "./state";
import { currentHeadroomAllowlist, resolveSupervisorConfig, runSupervisor, stopSupervisedProcess, type SupervisorPorts } from "./supervisor";

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
  /** Path to the MITM proxy's CA certificate, what OAuth launches point NODE_EXTRA_CA_CERTS at. */
  readonly caCertPath: string;
  readonly logPath: string;
  readonly logExists: boolean;
}

/** Collects the read-only status of the headroom daemon: state, pid liveness, the session registry, and the allowlist as the current provider files would produce it. */
export function collectHeadroomStatus(
  fsPort: HeadroomFs,
  paths: LayoutPaths,
  isRunning: (pid: number) => boolean,
): HeadroomStatus {
  const state = readHeadroomState(fsPort, paths.headroomStateFile) ?? {};
  const allowlist = currentHeadroomAllowlist(fsPort, paths);
  return {
    state,
    supervisorAlive: state.supervisorPid !== undefined && isRunning(state.supervisorPid),
    headroomAlive: state.headroomPid !== undefined && isRunning(state.headroomPid),
    sessions: listSessions(fsPort, paths.headroomSessionsDir).map((session) => ({
      ...session,
      alive: isRunning(session.pid),
    })),
    allowlist,
    allowlistDrifted: state.allowlistHash !== undefined && state.allowlistHash !== hashAllowlist(allowlist),
    caCertPath: paths.headroomCaCertFile,
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
  if (status.state.mitmPort === undefined) {
    lines.push("mitm proxy: not running");
  } else {
    lines.push(`mitm proxy: listening on 127.0.0.1:${String(status.state.mitmPort)}, CA ${status.caCertPath}`);
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

/**
 * The headroom processes this supervisor owns, by pid. Keeping the ChildProcess handles is what reaps the children: consuming the exit event is libuv's cue to waitpid, and a child nobody listens for is a child nobody reaps (the original zombie bug). The entry is removed on exit, so the map also names exactly what the exit hook below must not leave behind.
 */
const ownedHeadroom = new Map<number, ChildProcess>();

/**
 * Pids whose exit event has arrived: authoritative deadness, known the moment the child dies rather than at the next liveness poll, and regardless of what the not-yet-reaped remains still look like in the process table.
 */
const exitedHeadroom = new Set<number>();

/** Per-attempt timeout on the readiness probe: a loopback request either answers quickly or the attempt has failed. */
const READY_FETCH_TIMEOUT_MS = 2000;

/** Dead by exit event or by the zombie-aware table check, whichever says so first. */
function headroomPidRunning(pid: number): boolean {
  return !exitedHeadroom.has(pid) && realIsProcessRunning(pid);
}

/**
 * Environment for the supervised headroom proxy. `HEADROOM_HTTP2` defaults to `0`: headroom's HTTP/2 upstream pool multiplexes every request over shared keep-alive connections, and when a provider retires one (GOAWAY is routine load-balancer behaviour, not an error) every in-flight request on it dies at once; headroom retries exactly once, and that retry regularly lands on another dying connection from the same co-aged pool, which surfaces to Claude Code as "No response from API" after its full timeout budget. HTTP/1.1 gives each request its own connection, so a retirement can only kill the one request already being retried. An explicit `HEADROOM_HTTP2` in the parent environment wins, so the default can be overridden without editing claude-use once headroom fixes its pool management.
 */
export function headroomSpawnEnv(parentEnv: NodeJS.ProcessEnv, allowlist: readonly string[]): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    HEADROOM_ALLOWED_BASE_URLS: allowlist.join(","),
    HEADROOM_HTTP2: parentEnv.HEADROOM_HTTP2 ?? "0",
  };
}

/** The real `SupervisorPorts`: real processes, ports, clock, filesystem, and network. */
function realSupervisorPorts(paths: LayoutPaths): SupervisorPorts {
  return {
    fs: realFarmFs,
    paths,
    ownPid: process.pid,
    now: () => Date.now(),
    // A real timer, not the launcher's blocking Atomics.wait: the supervisor lives on its event loop, and the child's exit event can only be delivered while the loop turns.
    sleep: async (ms) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    },
    isRunning: headroomPidRunning,
    freePort: realFreePort,
    isPortFree: realIsPortFree,
    spawnHeadroom: (port, allowlist) => {
      fs.mkdirSync(paths.logsDir, { recursive: true });
      const logFd = fs.openSync(paths.headroomLogPath, "a");
      try {
        const child = spawn("headroom", ["proxy", "--host", "127.0.0.1", "--port", String(port)], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: headroomSpawnEnv(process.env, allowlist),
        });
        if (child.pid === undefined) {
          throw new Error("spawning headroom returned no pid");
        }
        const pid = child.pid;
        // Deliberately NOT unref'd: this supervisor needs the child's exit event (both the reaping and the crash signal), and a handle taken off the event loop stops delivering it. `detached: true` keeps headroom out of this process's process group so a supervisor crash does not signal it; the exit hook below still kills it on the orderly exit paths.
        ownedHeadroom.set(pid, child);
        child.once("exit", (code, signal) => {
          ownedHeadroom.delete(pid);
          exitedHeadroom.add(pid);
          fs.appendFileSync(paths.headroomLogPath, `${new Date().toISOString()} claude-use headroom supervisor: headroom exited (${signal ?? `code ${String(code)}`})\n`);
        });
        return pid;
      } finally {
        fs.closeSync(logFd);
      }
    },
    stopProcess: (pid) => {
      const outcome = stopSupervisedProcess(pid, {
        signal: (target, signal) => {
          process.kill(target, signal);
        },
        isRunning: headroomPidRunning,
        waitMs: realSleepSync,
        now: () => Date.now(),
      });
      if (outcome === "still-running") {
        fs.appendFileSync(
          paths.headroomLogPath,
          `${new Date().toISOString()} claude-use headroom supervisor: pid ${String(pid)} survived SIGKILL within its grace; it is stuck uninterruptibly\n`,
        );
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
    startMitm: async (preferredPort, headroomPort) => {
      // The CA is generated once on this machine's first headroom start and reused after: regenerating it would strand every child still pointing NODE_EXTRA_CA_CERTS at the old certificate.
      const ca = ensureCa(realMitmCertStore(paths), () => generateCa(new Date()));
      const leafFor = createLeafCache(ca, () => new Date());
      return await startMitmServer(
        {
          interceptHost: MITM_INTERCEPT_HOST,
          headroomPort,
          leafFor,
          upstream: { host: MITM_INTERCEPT_HOST, port: HTTPS_PORT, tls: true },
        },
        realMitmEffects(),
        preferredPort,
      );
    },
    log: (line) => {
      fs.mkdirSync(paths.logsDir, { recursive: true });
      fs.appendFileSync(paths.headroomLogPath, `${new Date().toISOString()} ${line}\n`);
    },
  };
}

/** Registers the `claude-use headroom` command tree and the hidden `__headroom-supervisor` internal subcommand. */
export function registerHeadroomCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const headroom = withExamples(program.command("headroom").description("Inspect the headroom routing daemon."), [
    "claude-use headroom status",
  ]);

  withExamples(
    headroom
      .command("status")
      .description("Report the headroom daemon's supervisor, process, port, sessions, and last error. Read-only.")
      .option("--json", "Print the status as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const status = collectHeadroomStatus(realFarmFs, paths, realIsProcessRunning);
        if (options.json === true) {
          printJson(status);
          return;
        }
        for (const line of formatHeadroomStatus(status)) {
          console.log(line);
        }
      }),
    ["claude-use headroom status", "claude-use headroom status --json"],
  );

  program
    .command("__headroom-supervisor", { hidden: true })
    .description("Internal: supervise the headroom daemon. Started by the launcher; never run by hand.")
    .allowUnknownOption()
    .action(async () => {
      const globalConfig = readGlobalConfig(paths);
      const config = resolveSupervisorConfig(globalConfig?.headroom ?? {});
      // If this supervisor exits without reaching its own shutdown path (idle or fatal), take every daemon it still owns with it rather than leaving an unsupervised proxy behind. SIGKILL, not the escalating stop: an exit hook is synchronous and already out of time.
      process.on("exit", () => {
        for (const pid of ownedHeadroom.keys()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      });
      // Signal death skips `exit` handlers entirely unless the signal itself is handled, so an unhandled SIGTERM would leave the daemon orphaned. Routing both signals through an orderly exit is what makes the hook above run for them.
      process.on("SIGTERM", () => {
        deps.exit(0);
      });
      process.on("SIGINT", () => {
        deps.exit(0);
      });
      const code = await runSupervisor(config, realSupervisorPorts(paths));
      deps.exit(code);
    });
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { InvalidArgumentError, type Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { readGlobalConfig } from "../configProfiles";
import { ConfigValidationError } from "../config/load";
import { CODEX_DEFAULT_IDLE_SHUTDOWN_MINUTES, isCodexProvider } from "../config/schema";
import { listSessions, removeSession, type HeadroomFs, type HeadroomSession } from "../headroom/state";
import { stopSupervisedProcess } from "../headroom/supervisor";
import type { CodexPort } from "../launcher/ports";
import { resolveClaudeHome, type LayoutPaths } from "../paths";
import { LegacyProviderFileError, loadProvider } from "../providers";
import {
  detachedDaemonSpawnOptions,
  realFarmFs,
  realFsPort,
  realIsPortFree,
  realIsProcessRunning,
  realSleepSync,
  selfInvocation,
  spawnDetachedSupervisor,
} from "../realPorts";
import { createUpstreamAgent, createUpstreamFetch } from "./agent";
import { createCodexAuthStore, type CodexAuthFs } from "./auth";
import { ensureCodex } from "./ensure";
import type { UsageSnapshot } from "./quota";
import { createCodexRoute, type CodexProviderLookup } from "./route";
import { createCodexServer } from "./server";
import { readCodexState, type CodexState } from "./state";
import { runCodexSupervisor, type CodexSupervisorPorts } from "./supervisor";
import { resolveCodexConfig } from "./translate";
import { realTimers } from "./upstream";

/** The Codex CLI's home: `CODEX_HOME` when set, as the Codex CLI itself reads it, otherwise `~/.codex`. */
export function codexHome(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const fromEnv = env.CODEX_HOME;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : path.join(home, ".codex");
}

/** Where the usage snapshot for a statusline is written: the canonical Claude Code home, which a statusline's `externalUsagePath` names. */
function usageSnapshotPath(): string {
  return path.join(resolveClaudeHome(), "codex-quota.json");
}

function appendLog(paths: LayoutPaths, line: string): void {
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.appendFileSync(paths.codexLogPath, `${new Date().toISOString()} ${line}\n`);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Owner read and write only: the auth file holds the Codex login's tokens. */
const PRIVATE_FILE_MODE = 0o600;

/** The real auth filesystem port. */
const realCodexAuthFs: CodexAuthFs = {
  read: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  },
  writePrivate: (filePath, contents) => {
    fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    // `mode` applies only when the file is created; a leftover temporary file from a crashed refresh keeps whatever mode it had.
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  },
  rename: (from, to) => {
    fs.renameSync(from, to);
  },
};

/** Looks up a codex provider for the route, reading the file on every request. */
function lookupCodexProvider(paths: LayoutPaths, name: string): CodexProviderLookup {
  let provider;
  try {
    provider = loadProvider(paths.providersDir, name, realFsPort);
  } catch (error) {
    if (error instanceof ConfigValidationError || error instanceof LegacyProviderFileError) {
      return { ok: false, status: 500, message: `provider ${name} is invalid: ${error.message}` };
    }
    throw error;
  }
  if (provider === undefined) {
    return { ok: false, status: 404, message: `no provider named "${name}"` };
  }
  if (!isCodexProvider(provider)) {
    return { ok: false, status: 404, message: `provider ${name} is not a codex provider` };
  }
  return { ok: true, config: resolveCodexConfig(provider.codex) };
}

/** Writes the usage snapshot atomically; a failure is logged and never fails the request that produced it. */
function writeUsageSnapshot(paths: LayoutPaths, snapshot: UsageSnapshot): void {
  const target = usageSnapshotPath();
  const temp = `${target}.${String(process.pid)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`);
    fs.renameSync(temp, target);
  } catch (error) {
    appendLog(paths, `codex worker: usage snapshot write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** How often the worker checks that its supervisor is still alive. */
const WORKER_PARENT_POLL_MS = 1_000;

/**
 * Runs the translation worker: the codex route behind its HTTP listener on 127.0.0.1:`port`. It exits when its supervisor is gone, because nothing else would ever stop it (the supervisor owns the idle shutdown), and a replacement supervisor would find the sticky port held.
 */
async function runWorker(paths: LayoutPaths, port: number, supervisorPid: number): Promise<void> {
  const log = (line: string): void => {
    appendLog(paths, `codex worker ${String(process.pid)}: ${line}`);
  };
  const agent = createUpstreamAgent();
  const upstreamFetch = createUpstreamFetch(agent);
  const auth = createCodexAuthStore(path.join(codexHome(process.env, os.homedir()), "auth.json"), {
    fs: realCodexAuthFs,
    fetch: upstreamFetch,
    now: () => new Date(),
    tempSuffix: `${String(process.pid)}.${randomUUID()}`,
  });
  const route = createCodexRoute({
    upstream: { fetch: upstreamFetch, auth, timers: realTimers, randomId: randomUUID },
    loadProvider: (name) => lookupCodexProvider(paths, name),
    writeUsageSnapshot: (snapshot) => {
      writeUsageSnapshot(paths, snapshot);
    },
    now: () => Date.now(),
    log,
  });
  const server = createCodexServer(route, log);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  log(`listening on 127.0.0.1:${String(port)}`);
  const watch = setInterval(() => {
    if (!realIsProcessRunning(supervisorPid)) {
      log(`supervisor pid ${String(supervisorPid)} is gone; exiting`);
      clearInterval(watch);
      server.close();
      void agent.close();
    }
  }, WORKER_PARENT_POLL_MS);
}

/** Binds a loopback port and releases it, giving the worker a port nothing else is listening on. */
async function realFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
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

/** The workers this supervisor owns, by pid: keeping the handles is what reaps them (see headroom's `ownedHeadroom`). */
const ownedWorkers = new Map<number, ChildProcess>();
/** Pids whose exit event has arrived: authoritative deadness, known the moment the worker dies. */
const exitedWorkers = new Set<number>();

function workerRunning(pid: number): boolean {
  return !exitedWorkers.has(pid) && realIsProcessRunning(pid);
}

/** Per-attempt timeout on the health probe. */
const READY_FETCH_TIMEOUT_MS = 2_000;

/** The real supervisor ports. */
function realCodexSupervisorPorts(paths: LayoutPaths): CodexSupervisorPorts {
  return {
    fs: realFarmFs,
    paths,
    ownPid: process.pid,
    now: () => Date.now(),
    sleep: async (ms) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    },
    isRunning: workerRunning,
    freePort: realFreePort,
    isPortFree: realIsPortFree,
    spawnWorker: (port) => {
      fs.mkdirSync(paths.logsDir, { recursive: true });
      const logFd = fs.openSync(paths.codexLogPath, "a");
      try {
        const invocation = selfInvocation(["__codex-worker", "--port", String(port), "--supervisor", String(process.pid)]);
        const child = spawn(invocation.command, invocation.args, detachedDaemonSpawnOptions(logFd, { ...process.env, CLAUDE_USE_HOME: paths.root }));
        if (child.pid === undefined) {
          throw new Error("spawning the codex worker returned no pid");
        }
        const pid = child.pid;
        // Not unref'd: the supervisor needs the exit event, both to reap the worker and to learn it crashed.
        ownedWorkers.set(pid, child);
        child.once("exit", (code, signal) => {
          ownedWorkers.delete(pid);
          exitedWorkers.add(pid);
          appendLog(paths, `claude-use codex supervisor: worker ${String(pid)} exited (${signal ?? `code ${String(code)}`})`);
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
        isRunning: workerRunning,
        waitMs: realSleepSync,
        now: () => Date.now(),
      });
      if (outcome === "still-running") {
        appendLog(paths, `claude-use codex supervisor: pid ${String(pid)} survived SIGKILL within its grace; it is stuck uninterruptibly`);
      }
    },
    ready: async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, { signal: AbortSignal.timeout(READY_FETCH_TIMEOUT_MS) });
        return response.ok;
      } catch {
        return false;
      }
    },
    log: (line) => {
      appendLog(paths, line);
    },
  };
}

/** The real `CodexPort` for one launch: `ensure` runs the lock-and-poll coordination and registers this launcher; `release` removes its registration. */
export function realCodexPort(paths: LayoutPaths): CodexPort {
  return {
    ensure: () =>
      ensureCodex({
        paths,
        launcherPid: process.pid,
        ports: {
          fs: realFarmFs,
          isRunning: realIsProcessRunning,
          now: () => Date.now(),
          sleep: realSleepSync,
          spawnSupervisor: (layout) => spawnDetachedSupervisor(layout, "__codex-supervisor", layout.codexLogPath),
        },
      }),
    release: () => {
      removeSession(realFarmFs, paths.codexSessionsDir, process.pid);
    },
  };
}

/** One session-registry entry plus whether its launcher is still running. */
interface CodexSessionStatus extends HeadroomSession {
  readonly alive: boolean;
}

/** Everything `claude-use codex status` reports, collected read-only. */
export interface CodexStatus {
  readonly state: CodexState;
  readonly supervisorAlive: boolean;
  readonly workerAlive: boolean;
  readonly sessions: readonly CodexSessionStatus[];
  readonly logPath: string;
  readonly logExists: boolean;
}

/** Collects the codex daemon's read-only status. */
export function collectCodexStatus(fsPort: HeadroomFs, paths: LayoutPaths, isRunning: (pid: number) => boolean): CodexStatus {
  const state = readCodexState(fsPort, paths.codexStateFile) ?? {};
  return {
    state,
    supervisorAlive: state.supervisorPid !== undefined && isRunning(state.supervisorPid),
    workerAlive: state.workerPid !== undefined && isRunning(state.workerPid),
    sessions: listSessions(fsPort, paths.codexSessionsDir).map((session) => ({ ...session, alive: isRunning(session.pid) })),
    logPath: paths.codexLogPath,
    logExists: fsPort.readFileUtf8(paths.codexLogPath) !== undefined,
  };
}

/** Formats `claude-use codex status`, one line per entry. */
export function formatCodexStatus(status: CodexStatus): string[] {
  const lines: string[] = [];
  lines.push(
    status.state.supervisorPid === undefined
      ? "supervisor: not running (no state recorded)"
      : `supervisor: pid ${String(status.state.supervisorPid)} (${status.supervisorAlive ? "alive" : "NOT running"})`,
  );
  lines.push(
    status.state.workerPid === undefined || status.state.port === undefined
      ? `worker: not running${status.state.lastPort === undefined ? "" : ` (next start on 127.0.0.1:${String(status.state.lastPort)})`}`
      : `worker: pid ${String(status.state.workerPid)} (${status.workerAlive ? "alive" : "NOT running"}), listening on 127.0.0.1:${String(status.state.port)}`,
  );
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

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return parsed;
}

/** Registers `claude-use codex status` and the hidden `__codex-supervisor` and `__codex-worker` internal subcommands. */
export function registerCodexCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const codex = withExamples(program.command("codex").description("Inspect the codex translation daemon that serves codex providers."), ["claude-use codex status"]);

  withExamples(
    codex
      .command("status")
      .description("Report the codex daemon's supervisor, worker, port, sessions, and last error. Read-only.")
      .option("--json", "Print the status as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const status = collectCodexStatus(realFarmFs, paths, realIsProcessRunning);
        if (options.json === true) {
          printJson(status);
          return;
        }
        for (const line of formatCodexStatus(status)) {
          console.log(line);
        }
      }),
    ["claude-use codex status", "claude-use codex status --json"],
  );

  program
    .command("__codex-supervisor", { hidden: true })
    .description("Internal: supervise the codex translation worker. Started by the launcher; never run by hand.")
    .allowUnknownOption()
    .action(async () => {
      const idleShutdownMinutes = readGlobalConfig(paths)?.codex?.idleShutdownMinutes ?? CODEX_DEFAULT_IDLE_SHUTDOWN_MINUTES;
      // An orderly exit takes every worker it still owns with it rather than leaving an unsupervised listener behind; SIGKILL, because an exit hook is synchronous and out of time.
      process.on("exit", () => {
        for (const pid of ownedWorkers.keys()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      });
      process.on("SIGTERM", () => {
        deps.exit(0);
      });
      process.on("SIGINT", () => {
        deps.exit(0);
      });
      deps.exit(await runCodexSupervisor(idleShutdownMinutes, realCodexSupervisorPorts(paths)));
    });

  program
    .command("__codex-worker", { hidden: true })
    .description("Internal: serve the codex translation listener. Started by the codex supervisor; never run by hand.")
    .requiredOption("--port <port>", "Loopback port to listen on.", parsePositiveInt)
    .requiredOption("--supervisor <pid>", "The supervising process; the worker exits once it is gone.", parsePositiveInt)
    .action(async (options: Readonly<{ port: number; supervisor: number }>) => {
      await runWorker(paths, options.port, options.supervisor);
    });
}

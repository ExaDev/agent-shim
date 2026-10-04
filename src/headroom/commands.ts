import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { HTTP_STATUS } from "../codex/http";
import { readGlobalConfig } from "../configProfilesStore";
import { realTrustBundleFs } from "../frontdoor/realFrontDoorPort";
import { resolveTrustBundle, type TrustBundle, type TrustBundleFs } from "../frontdoor/trust";
import { hashSettings, settingsArgs, settingsEnv, settingsOf, type HeadroomSettings } from "./settings";
import { parseInstalledCommit } from "./source";
import type { LayoutPaths } from "../paths";
import { realFarmFs, realHeadroomSocketTrust, realIsProcessRunning, realSleepSync } from "../realPorts";
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

/** Everything `agent-shim headroom status` reports, collected read-only: no process is started or stopped. */
export interface HeadroomStatus {
  readonly state: HeadroomState;
  readonly supervisorAlive: boolean;
  readonly headroomAlive: boolean;
  readonly sessions: readonly HeadroomSessionStatus[];
  /** The allowlist the daemon WOULD be started with now, from the current provider files. */
  readonly allowlist: readonly string[];
  /** True when that allowlist differs from the one the running daemon was started with, i.e. a drift restart is pending. */
  readonly allowlistDrifted: boolean;
  /** The token-saving settings the daemon WOULD be started with now, from the global config. */
  readonly settings: HeadroomSettings;
  /** True when those settings differ from the ones the running daemon was started with, i.e. a drift restart is pending. */
  readonly settingsDrifted: boolean;
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
  const settings = settingsOf(readGlobalConfig(paths)?.headroom ?? {});
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
    settings,
    settingsDrifted: state.settingsHash !== undefined && state.settingsHash !== hashSettings(settings),
    logPath: paths.headroomLogPath,
    logExists: fsPort.readFileUtf8(paths.headroomLogPath) !== undefined,
  };
}

/** Formats `agent-shim headroom status`'s output, one line per array entry. */
export function formatHeadroomStatus(status: HeadroomStatus): string[] {
  const lines: string[] = [];
  if (status.state.supervisorPid === undefined) {
    lines.push("supervisor: not running (no state recorded)");
  } else {
    lines.push(
      `supervisor: pid ${String(status.state.supervisorPid)} (${status.supervisorAlive ? "alive" : "NOT running"})`,
    );
  }
  if (status.state.headroomPid === undefined || status.state.socketPath === undefined) {
    lines.push("headroom: not running");
  } else {
    lines.push(
      `headroom: pid ${String(status.state.headroomPid)} (${status.headroomAlive ? "alive" : "NOT running"}), ` +
        `listening on unix socket ${status.state.socketPath}` +
        (status.state.version === undefined ? "" : `, ${status.state.version}`),
    );
  }
  const drift = status.allowlistDrifted ? " (DRIFTED: current provider files differ from the running daemon's allowlist; a restart is pending)" : "";
  lines.push(`allowlist: ${status.allowlist.join(", ")}${drift}`);
  const configured = Object.entries(status.settings).map(([name, value]) => `${name} ${String(value)}`);
  const settingsDrift = status.settingsDrifted ? " (DRIFTED: the configured settings differ from the running daemon's; a restart is pending)" : "";
  lines.push(`settings: ${configured.length === 0 ? "headroom defaults" : configured.join(", ")}${settingsDrift}`);
  if (status.sessions.length === 0) {
    lines.push("sessions: none");
  } else {
    const pids = status.sessions.map(
      (session) =>
        `${String(session.pid)}${session.alive ? "" : " (dead)"}` +
        (session.supervisorPid === status.state.supervisorPid ? "" : ` on superseded supervisor ${String(session.supervisorPid)}`),
    );
    lines.push(`sessions: ${String(status.sessions.length)} registered (${pids.join(", ")})`);
  }
  if (status.state.lastError !== undefined) {
    lines.push(`last error: ${status.state.lastError}`);
  }
  lines.push(`daemon log: ${status.logPath}${status.logExists ? "" : " (not created yet)"}`);
  return lines;
}

/**
 * The headroom processes this supervisor owns, by pid. Keeping the ChildProcess handles is what reaps the children: consuming the exit event is libuv's cue to waitpid, and a child nobody listens for is a child nobody reaps (the original zombie bug). The entry is removed on exit, so the map also names exactly what the exit hook below must not leave behind.
 */
const ownedHeadroom = new Map<number, ChildProcess>();

/**
 * Pids whose exit event has arrived: authoritative deadness, known the moment the child dies rather than at the next liveness poll, and regardless of what the not-yet-reaped remains still look like in the process table.
 */
const exitedHeadroom = new Set<number>();

/** Per-attempt timeout on the readiness probe: a request over the local socket either answers quickly or the attempt has failed. */
const READY_FETCH_TIMEOUT_MS = 2000;

/** Dead by exit event or by the zombie-aware table check, whichever says so first. */
function headroomPidRunning(pid: number): boolean {
  return !exitedHeadroom.has(pid) && realIsProcessRunning(pid);
}

/** Headroom's additive trust variable: one PEM file whose certificates headroom trusts on top of its default trust (the operating system's store plus certifi's bundle). */
const HEADROOM_CA_BUNDLE = "HEADROOM_CA_BUNDLE";

/**
 * The file headroom is pointed at through `HEADROOM_CA_BUNDLE`, or undefined when no front door has ever run on this root (no `caCertFile` exists, so there is no door certificate headroom could ever be presented). Headroom needs the door's CA because a transparent-interception deployment redirects the API host's address machine-wide: headroom's own dials to `api.anthropic.com` (an OAuth session's upstream, and its subscription tracking) then reach the door's transparent surface and its leaf, not the origin's public certificate. Every other dial headroom makes (the door's direct listener is plain HTTP; huggingface, pypi and the other public hosts are not intercepted) needs only its default trust, which the additive variable keeps. `inherited` is the parent environment's own `HEADROOM_CA_BUNDLE`, folded into the bundle exactly as `resolveTrustBundle` folds an inherited `NODE_EXTRA_CA_CERTS`, because headroom reads one file from the variable.
 */
export function resolveHeadroomTrustBundle(params: { readonly caCertFile: string; readonly bundlesDir: string; readonly inherited: string | undefined; readonly fs: TrustBundleFs }): TrustBundle | undefined {
  if (!params.fs.exists(params.caCertFile)) {
    return undefined;
  }
  return resolveTrustBundle({ ...params, variable: HEADROOM_CA_BUNDLE });
}

/**
 * Environment for the supervised headroom proxy. `HEADROOM_HTTP2` defaults to `0`: headroom's HTTP/2 upstream pool multiplexes every request over shared keep-alive connections, and when a provider retires one (GOAWAY is routine load-balancer behaviour, not an error) every in-flight request on it dies at once; headroom retries exactly once, and that retry regularly lands on another dying connection from the same co-aged pool, which surfaces to Claude Code as "No response from API" after its full timeout budget. HTTP/1.1 gives each request its own connection, so a retirement can only kill the one request already being retried. An explicit `HEADROOM_HTTP2` in the parent environment wins, so the default can be overridden without editing agent-shim once headroom fixes its pool management.
 *
 * `trustBundlePath`, when given, is the file `resolveHeadroomTrustBundle` chose, and becomes `HEADROOM_CA_BUNDLE`: a path, never certificate text, and an additive variable, never `SSL_CERT_FILE` or `REQUESTS_CA_BUNDLE`. Those two replace headroom's whole trust store (and switch off its operating-system store, which is where a corporate TLS-inspection root lives), so pointing them at the door's CA alone would make every public upstream untrusted.
 */
export function headroomSpawnEnv(parentEnv: NodeJS.ProcessEnv, allowlist: readonly string[], settings: Readonly<HeadroomSettings>, trustBundlePath?: string): NodeJS.ProcessEnv {
  // Headroom refuses `--uds` alongside a TCP address from its environment, so an ambient HEADROOM_HOST or HEADROOM_PORT (a shell set up for running headroom by hand) would stop the supervised daemon starting at all. The supervisor alone decides where the daemon listens.
  const inherited = { ...parentEnv };
  delete inherited.HEADROOM_HOST;
  delete inherited.HEADROOM_PORT;
  return {
    ...inherited,
    HEADROOM_ALLOWED_BASE_URLS: allowlist.join(","),
    HEADROOM_HTTP2: parentEnv.HEADROOM_HTTP2 ?? "0",
    // The bundle already holds any inherited HEADROOM_CA_BUNDLE's certificates, so replacing the variable loses nothing. An inherited SSL_CERT_FILE or REQUESTS_CA_BUNDLE passes through untouched and, by headroom's own precedence, still replaces everything: an explicit choice in the parent environment wins.
    ...(trustBundlePath === undefined ? {} : { [HEADROOM_CA_BUNDLE]: trustBundlePath }),
    ...settingsEnv(settings),
  };
}

/**
 * The `headroom proxy` arguments the supervisor starts the daemon with: the unix socket to serve on, `--no-rate-limit`, and the token-saving settings. Never `--host` or `--port`: the daemon binds no TCP listener, and headroom refuses `--uds` alongside either. The daemon's own limiter defaults to 60 requests a minute, which rejects a busy multi-session front door with 429 even though every caller is already the local user; the provider's own limits still apply upstream.
 */
export function headroomProxyArgs(socketPath: string, settings: Readonly<HeadroomSettings>): readonly string[] {
  return ["proxy", "--uds", socketPath, "--no-rate-limit", ...settingsArgs(settings)];
}

/** Asks the daemon's `/readyz` over its unix socket, answering whether it replied 200 (headroom's ready answer) inside the per-attempt timeout. */
async function readyOverSocket(socketPath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = http.get({ socketPath, path: "/readyz", timeout: READY_FETCH_TIMEOUT_MS }, (response) => {
      response.resume();
      resolve(response.statusCode === HTTP_STATUS.ok);
    });
    probe.on("timeout", () => {
      probe.destroy();
    });
    probe.on("error", () => {
      resolve(false);
    });
  });
}

/** The `uv tool` name headroom installs under, which is its distribution name. */
const HEADROOM_TOOL_NAME = "headroom-ai";

/**
 * The commit the `uv tool` install of headroom was built from, read from the `direct_url.json` in its dist-info, or undefined when `uv` cannot say, the tool is absent, or it was not installed from a git source.
 */
function readInstalledHeadroomCommit(): string | undefined {
  const toolDir = spawnSync("uv", ["tool", "dir"], { encoding: "utf8" });
  if (toolDir.status !== 0) {
    return undefined;
  }
  const libDir = path.join(toolDir.stdout.trim(), HEADROOM_TOOL_NAME, "lib");
  for (const python of realFarmFs.readdir(libDir)) {
    const sitePackages = path.join(libDir, python, "site-packages");
    for (const entry of realFarmFs.readdir(sitePackages)) {
      if (entry.startsWith("headroom_ai-") && entry.endsWith(".dist-info")) {
        const directUrl = realFarmFs.readFileUtf8(path.join(sitePackages, entry, "direct_url.json"));
        return directUrl === undefined ? undefined : parseInstalledCommit(directUrl);
      }
    }
  }
  return undefined;
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
    socketTrust: realHeadroomSocketTrust,
    readConfig: () => resolveSupervisorConfig(readGlobalConfig(paths)?.headroom ?? {}),
    spawnHeadroom: (socketPath, allowlist, settings) => {
      const trust = resolveHeadroomTrustBundle({ caCertFile: paths.frontdoorCaCertFile, bundlesDir: paths.frontdoorCaBundlesDir, inherited: process.env[HEADROOM_CA_BUNDLE], fs: realTrustBundleFs });
      fs.mkdirSync(paths.logsDir, { recursive: true });
      if (trust?.warning !== undefined) {
        fs.appendFileSync(paths.headroomLogPath, `${new Date().toISOString()} ${trust.warning}\n`);
      }
      const logFd = fs.openSync(paths.headroomLogPath, "a");
      try {
        const child = spawn("headroom", headroomProxyArgs(socketPath, settings), {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: headroomSpawnEnv(process.env, allowlist, settings, trust?.path),
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
          fs.appendFileSync(paths.headroomLogPath, `${new Date().toISOString()} agent-shim headroom supervisor: headroom exited (${signal ?? `code ${String(code)}`})\n`);
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
          `${new Date().toISOString()} agent-shim headroom supervisor: pid ${String(pid)} survived SIGKILL within its grace; it is stuck uninterruptibly\n`,
        );
      }
    },
    ready: readyOverSocket,
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
    installedCommit: readInstalledHeadroomCommit,
    log: (line) => {
      fs.mkdirSync(paths.logsDir, { recursive: true });
      fs.appendFileSync(paths.headroomLogPath, `${new Date().toISOString()} ${line}\n`);
    },
  };
}

/** Registers the `agent-shim headroom` command tree and the hidden `__headroom-supervisor` internal subcommand. */
export function registerHeadroomCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const headroom = withExamples(program.command("headroom").description("Inspect the headroom routing daemon."), [
    "agent-shim headroom status",
  ]);

  withExamples(
    headroom
      .command("status")
      .description("Report the headroom daemon's supervisor, process, socket, sessions, and last error. Read-only.")
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
    ["agent-shim headroom status", "agent-shim headroom status --json"],
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

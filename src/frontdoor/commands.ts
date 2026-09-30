import fs from "node:fs";
import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { readGlobalConfig } from "../configProfiles";
import { FRONTDOOR_DEFAULT_IDLE_SHUTDOWN_MINUTES } from "../config/schema";
import { createCodexRoutePorts } from "../codex/commands";
import { listSessions, removeSession, type HeadroomFs, type HeadroomSession } from "../headroom/state";
import type { FrontDoorPort } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { realFarmFs, realFsPort, realIsProcessRunning, realSleepSync, spawnDetachedSupervisor } from "../realPorts";
import { ensureFrontDoor } from "./ensure";
import { serveRouted, type PipelineDeps } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { readFrontDoorState, type FrontDoorState } from "./state";
import { runFrontDoorSupervisor, type FrontDoorSupervisorPorts } from "./supervisor";

function appendLog(paths: LayoutPaths, line: string): void {
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.appendFileSync(paths.frontdoorLogPath, `${new Date().toISOString()} ${line}\n`);
}

/**
 * The real supervisor ports. `startListener` is where the whole routing pipeline is assembled: the codex translation's real ports, the provider route resolver over them, the ordered pipeline, and the plain-HTTP listener that feeds it, all in this process.
 */
function realFrontDoorSupervisorPorts(paths: LayoutPaths): FrontDoorSupervisorPorts {
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
    isRunning: realIsProcessRunning,
    startListener: async (preferredPort) => {
      const log = (line: string): void => {
        appendLog(paths, `frontdoor ${String(process.pid)}: ${line}`);
      };
      // The listener's own port is only known once it has bound, but the route resolver needs it to name the address a headroom hop would forward back to. No request can arrive before the bind completes, so a closure over the late-filled value is exact, not a race.
      let ownPort = 0;
      // Built once for the process, not per request: the codex translation's upstream agent and auth store hold pooled connections and refresh state that must survive across requests.
      const codexPorts = createCodexRoutePorts(log);
      const resolveRoute = createProviderRouteResolver({ fs: realFsPort, providersDir: paths.providersDir, codexPorts, ownPort: () => ownPort });
      const deps: PipelineDeps = {
        resolveRoute,
        responseObservers: [],
        log,
      };
      const server = createFrontDoorServer(async (request) => {
        await serveRouted(request, deps);
      }, log);
      // A listener error after a successful bind (nothing else fails it) is fatal for the whole door: log it and let the process die so the next launch's ensure starts a replacement on the sticky port.
      server.on("error", (error: Error) => {
        appendLog(paths, `frontdoor ${String(process.pid)}: listener failed: ${error.message}; exiting`);
        process.exit(1);
      });
      return await listenFrontDoor(server, preferredPort, (port) => {
        ownPort = port;
      });
    },
    log: (line) => {
      appendLog(paths, line);
    },
  };
}

/** The real `FrontDoorPort` for one launch: `ensure` runs the lock-and-poll coordination and registers this launcher; `release` removes its registration. */
export function realFrontDoorPort(paths: LayoutPaths): FrontDoorPort {
  return {
    ensure: () =>
      ensureFrontDoor({
        paths,
        launcherPid: process.pid,
        ports: {
          fs: realFarmFs,
          isRunning: realIsProcessRunning,
          now: () => Date.now(),
          sleep: realSleepSync,
          spawnSupervisor: (layout) => spawnDetachedSupervisor(layout, "__frontdoor-supervisor", layout.frontdoorLogPath),
        },
      }),
    release: () => {
      removeSession(realFarmFs, paths.frontdoorSessionsDir, process.pid);
    },
  };
}

/** One session-registry entry plus whether its launcher is still running. */
interface FrontDoorSessionStatus extends HeadroomSession {
  readonly alive: boolean;
}

/** Everything `claude-use frontdoor status` reports, collected read-only: no process is started or stopped. */
export interface FrontDoorStatus {
  readonly state: FrontDoorState;
  readonly supervisorAlive: boolean;
  readonly sessions: readonly FrontDoorSessionStatus[];
  readonly logPath: string;
  readonly logExists: boolean;
}

/** Collects the front door's read-only status. */
export function collectFrontDoorStatus(fsPort: HeadroomFs, paths: LayoutPaths, isRunning: (pid: number) => boolean): FrontDoorStatus {
  const state = readFrontDoorState(fsPort, paths.frontdoorStateFile) ?? {};
  return {
    state,
    supervisorAlive: state.supervisorPid !== undefined && isRunning(state.supervisorPid),
    sessions: listSessions(fsPort, paths.frontdoorSessionsDir).map((session) => ({ ...session, alive: isRunning(session.pid) })),
    logPath: paths.frontdoorLogPath,
    logExists: fsPort.readFileUtf8(paths.frontdoorLogPath) !== undefined,
  };
}

/** Formats `claude-use frontdoor status`, one line per entry. */
export function formatFrontDoorStatus(status: FrontDoorStatus): string[] {
  const lines: string[] = [];
  if (status.state.supervisorPid === undefined) {
    lines.push("supervisor: not running");
  } else {
    lines.push(`supervisor: pid ${String(status.state.supervisorPid)} (${status.supervisorAlive ? "alive" : "NOT running"})`);
  }
  if (status.state.port === undefined) {
    lines.push(`front door: not listening${status.state.lastPort === undefined ? "" : ` (next start on 127.0.0.1:${String(status.state.lastPort)})`}`);
  } else {
    lines.push(`front door: listening on 127.0.0.1:${String(status.state.port)}, routing /providers/<name> requests`);
  }
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

/** Registers `claude-use frontdoor status` and the hidden `__frontdoor-supervisor` internal subcommand. */
export function registerFrontDoorCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const frontdoor = withExamples(program.command("frontdoor").description("Inspect the front-door daemon that routes every claude-use session."), [
    "claude-use frontdoor status",
  ]);

  withExamples(
    frontdoor
      .command("status")
      .description("Report the front door's supervisor, listener, sessions, and last error. Read-only.")
      .option("--json", "Print the status as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const status = collectFrontDoorStatus(realFarmFs, paths, realIsProcessRunning);
        if (options.json === true) {
          printJson(status);
          return;
        }
        for (const line of formatFrontDoorStatus(status)) {
          console.log(line);
        }
      }),
    ["claude-use frontdoor status", "claude-use frontdoor status --json"],
  );

  program
    .command("__frontdoor-supervisor", { hidden: true })
    .description("Internal: serve the front-door routing listener. Started by the launcher; never run by hand.")
    .allowUnknownOption()
    .action(async () => {
      const idleShutdownMinutes = readGlobalConfig(paths)?.frontdoor?.idleShutdownMinutes ?? FRONTDOOR_DEFAULT_IDLE_SHUTDOWN_MINUTES;
      // The listener is a server inside this process, so an orderly exit takes it with it: there is no child left behind to stop.
      process.on("SIGTERM", () => {
        deps.exit(0);
      });
      process.on("SIGINT", () => {
        deps.exit(0);
      });
      deps.exit(await runFrontDoorSupervisor(idleShutdownMinutes, realFrontDoorSupervisorPorts(paths)));
    });
}

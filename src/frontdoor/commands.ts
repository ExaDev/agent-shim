import fs from "node:fs";
import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { HTTP_STATUS } from "../codex/http";
import { readGlobalConfig } from "../configProfiles";
import { FRONTDOOR_DEFAULT_IDLE_SHUTDOWN_MINUTES } from "../config/schema";
import { createCodexRoutePorts } from "../codex/commands";
import { readHeadroomState, listSessions, removeSession, type HeadroomFs, type HeadroomSession } from "../headroom/state";
import type { FrontDoorPort } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { realFarmFs, realFsPort, realIsProcessRunning, realSleepSync, spawnDetachedSupervisor } from "../realPorts";
import {
  CONNECT_INTERCEPT_HOST,
  HTTPS_PORT,
  createLeafCache,
  ensureCa,
  generateCa,
  realConnectCertStore,
  realConnectEffects,
  startConnectServer,
} from "./connect";
import { ensureFrontDoor } from "./ensure";
import { serveRouted, type PipelineDeps } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { readFrontDoorState, type FrontDoorState } from "./state";
import { runFrontDoorSupervisor, type FrontDoorListenerHandle, type FrontDoorSupervisorPorts } from "./supervisor";

function appendLog(paths: LayoutPaths, line: string): void {
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.appendFileSync(paths.frontdoorLogPath, `${new Date().toISOString()} ${line}\n`);
}

/** The headroom daemon's loopback port, read live from its state on every routed request that needs the hop: the daemon can crash and restart on a different port while this door keeps listening, and the hop must follow it (and answer 502 while it is between restarts). */
function liveHeadroomPort(paths: LayoutPaths): number | undefined {
  return readHeadroomState(realFarmFs, paths.headroomStateFile)?.port;
}

/** Binds a front-door server on the preferred port (falling back to any free one) and hands back its close handle. */
async function bind(server: ReturnType<typeof createFrontDoorServer>, preferredPort: number | undefined): Promise<FrontDoorListenerHandle> {
  const handle = await listenFrontDoor(server, preferredPort, () => undefined);
  return { port: handle.port, close: handle.close };
}

/**
 * The real supervisor ports. The three listener starts are where the whole routing assembly is built: the codex translation's real ports, the provider route resolver over them, the ordered pipeline (with and without the headroom hop), the two long-lived listeners that feed it, and the CA the CONNECT surface terminates TLS with.
 */
function realFrontDoorSupervisorPorts(paths: LayoutPaths): FrontDoorSupervisorPorts {
  const log = (line: string): void => {
    appendLog(paths, `frontdoor ${String(process.pid)}: ${line}`);
  };
  // The direct listener's port is only known once it has bound, but the route resolver needs it to name the address a headroom hop forwards an in-process route back to. No request can arrive before the binds complete, so a closure over the late-filled value is exact, not a race.
  let directPort = 0;
  // Built once for the process, not per request: the codex translation's upstream agent and auth store hold pooled connections and refresh state that must survive across requests.
  const codexPorts = createCodexRoutePorts(log);
  const resolveRoute = createProviderRouteResolver({ fs: realFsPort, providersDir: paths.providersDir, codexPorts, directPort: () => directPort });

  const buildPipeline = (withHeadroomHop: boolean): PipelineDeps => ({
    resolveRoute,
    // The response middleware hook point: the usage-tracking work registers its observers here. The direct listener registers none, because its responses are consumed by headroom, not by the client; the entry the client sees is where observation belongs.
    responseObservers: [],
    ...(withHeadroomHop ? { headroom: { headroomPort: () => liveHeadroomPort(paths), log } } : {}),
    log,
  });

  const onListenerError = (name: string) => (error: Error): void => {
    appendLog(paths, `frontdoor ${String(process.pid)}: ${name} listener failed: ${error.message}; exiting`);
    process.exit(1);
  };

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
    startHttpListener: async (preferredPort) => {
      const server = createFrontDoorServer(async (request) => {
        await serveRouted(request, buildPipeline(true));
      }, log);
      server.on("error", onListenerError("front door"));
      return await bind(server, preferredPort);
    },
    startConnectListener: async (preferredPort) => {
      // The CA is generated once on this machine's first front-door start and reused after: regenerating it would strand every child still pointing NODE_EXTRA_CA_CERTS at the old certificate.
      const ca = ensureCa(realConnectCertStore(paths), () => generateCa(new Date()));
      const leafFor = createLeafCache(ca, () => new Date());
      const server = await startConnectServer(
        {
          interceptHost: CONNECT_INTERCEPT_HOST,
          serveRouted: (request, response) => {
            // The connect surface hands the pipeline the same request shape the plain listener builds: identified, middleware-run, routed, with the abort wired to the client going away.
            const abort = new AbortController();
            response.on("close", () => {
              if (!response.writableFinished) {
                abort.abort();
              }
            });
            void serveRouted({ method: request.method ?? "GET", url: request.url ?? "/", headers: request.headers, body: request, signal: abort.signal, response }, buildPipeline(true)).catch(
              (error: unknown) => {
                log(`connect request ${request.method ?? "?"} ${request.url ?? "?"} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
                if (!response.headersSent) {
                  response.writeHead(HTTP_STATUS.badGateway, { "Content-Type": "application/json" });
                  response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "internal error in the claude-use front door" } }));
                  return;
                }
                response.destroy();
              },
            );
          },
          leafFor,
          upstream: { host: CONNECT_INTERCEPT_HOST, port: HTTPS_PORT, tls: true },
        },
        realConnectEffects(),
        preferredPort,
      );
      return { port: server.port, close: server.close };
    },
    startDirectListener: async (preferredPort) => {
      const server = createFrontDoorServer(async (request) => {
        await serveRouted(request, buildPipeline(false));
      }, log);
      server.on("error", onListenerError("direct"));
      const handle = await listenFrontDoor(server, preferredPort, (port) => {
        directPort = port;
      });
      return { port: handle.port, close: handle.close };
    },
    log: (line) => {
      appendLog(paths, line);
    },
  };
}

/** The real `FrontDoorPort` for one launch: `ensure` runs the lock-and-poll coordination and registers this launcher; `release` removes its registration. */
export function realFrontDoorPort(paths: LayoutPaths): FrontDoorPort {
  return {
    ensure: () => {
      const up = ensureFrontDoor({
        paths,
        launcherPid: process.pid,
        ports: {
          fs: realFarmFs,
          isRunning: realIsProcessRunning,
          now: () => Date.now(),
          sleep: realSleepSync,
          spawnSupervisor: (layout) => spawnDetachedSupervisor(layout, "__frontdoor-supervisor", layout.frontdoorLogPath),
        },
      });
      return { port: up.port, connectPort: up.connectPort, caCertPath: paths.frontdoorCaCertFile };
    },
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
  /** The headroom daemon's port as the door's hop reads it live, when the daemon is serving. */
  readonly headroomPort: number | undefined;
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
    headroomPort: readHeadroomState(fsPort, paths.headroomStateFile)?.port,
    logPath: paths.frontdoorLogPath,
    logExists: fsPort.readFileUtf8(paths.frontdoorLogPath) !== undefined,
  };
}

/** Formats `claude-use frontdoor status`, one line per entry. */
export function formatFrontDoorStatus(status: FrontDoorStatus, caCertPath: string): string[] {
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
  if (status.state.connectPort === undefined) {
    lines.push(`connect surface: not listening${status.state.lastConnectPort === undefined ? "" : ` (next start on 127.0.0.1:${String(status.state.lastConnectPort)})`}`);
  } else {
    lines.push(`connect surface: listening on 127.0.0.1:${String(status.state.connectPort)}, CA ${caCertPath}`);
  }
  lines.push(
    status.headroomPort === undefined
      ? "headroom hop: the daemon is not serving (sessions asking for headroom fail until it is up)"
      : `headroom hop: daemon on 127.0.0.1:${String(status.headroomPort)}`,
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

/** Registers `claude-use frontdoor status` and the hidden `__frontdoor-supervisor` internal subcommand. */
export function registerFrontDoorCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const frontdoor = withExamples(program.command("frontdoor").description("Inspect the front-door daemon that routes every claude-use session."), [
    "claude-use frontdoor status",
  ]);

  withExamples(
    frontdoor
      .command("status")
      .description("Report the front door's supervisor, listeners, sessions, and last error. Read-only.")
      .option("--json", "Print the status as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const status = collectFrontDoorStatus(realFarmFs, paths, realIsProcessRunning);
        if (options.json === true) {
          printJson(status);
          return;
        }
        for (const line of formatFrontDoorStatus(status, paths.frontdoorCaCertFile)) {
          console.log(line);
        }
      }),
    ["claude-use frontdoor status", "claude-use frontdoor status --json"],
  );

  program
    .command("__frontdoor-supervisor", { hidden: true })
    .description("Internal: serve the front-door routing listeners. Started by the launcher; never run by hand.")
    .allowUnknownOption()
    .action(async () => {
      const idleShutdownMinutes = readGlobalConfig(paths)?.frontdoor?.idleShutdownMinutes ?? FRONTDOOR_DEFAULT_IDLE_SHUTDOWN_MINUTES;
      // The listeners are servers inside this process, so an orderly exit takes them with it: there is no child left behind to stop.
      process.on("SIGTERM", () => {
        deps.exit(0);
      });
      process.on("SIGINT", () => {
        deps.exit(0);
      });
      deps.exit(await runFrontDoorSupervisor(idleShutdownMinutes, realFrontDoorSupervisorPorts(paths)));
    });
}

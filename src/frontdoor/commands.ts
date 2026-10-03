import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { HTTP_STATUS } from "../codex/http";
import { readGlobalConfig } from "../configProfiles";
import { FRONTDOOR_DEFAULT_IDLE_SHUTDOWN_MINUTES } from "../config/schema";
import { createCodexRoutePorts } from "../codex/commands";
import { readHeadroomState, type HeadroomFs } from "../headroom/state";
import type { FrontDoorPort } from "../launcher/ports";
import type { LayoutPaths } from "../paths";
import { realFarmFs, realFsPort, realIsProcessRunning, realSleepSync, spawnDetachedSupervisor } from "../realPorts";
import { createDoorPipelines } from "./assembly";
import { isLiveCapability } from "./capability";
import {
  CONNECT_INTERCEPT_HOST,
  CONNECT_LIMITS,
  HTTPS_PORT,
  LOOPBACK_LEAF_NAMES,
  createLeafCache,
  ensureCa,
  generateCa,
  mintLeaf,
  realConnectCertStore,
  realConnectEffects,
  startConnectServer,
  type CaMaterial,
} from "./connect";
import { createCredentialCustody } from "./custody";
import { ensureFrontDoor } from "./ensure";
import { serveRouted } from "./pipeline";
import { probeFrontDoorSync } from "./probe";
import { createProviderRouteResolver } from "./providerRoute";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { resolveTrustBundle, type TrustBundleFs } from "./trust";
import { listFrontDoorSessions, liveSessionTokens, readFrontDoorState, removeFrontDoorSession, type FrontDoorSessionSummary, type FrontDoorState } from "./state";
import { runFrontDoorSupervisor, type FrontDoorSupervisorPorts } from "./supervisor";
import { createAccountReader } from "../usage/account";
import { createUsageMiddleware } from "../usage/middleware";
import { withQuotaRefresh } from "../usage/quotaRefresh";
import { createRealQuotaRefresher } from "../usage/realQuotaRefresher";
import { createUsageStore } from "../usage/store";

function appendLog(paths: LayoutPaths, line: string): void {
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.appendFileSync(paths.frontdoorLogPath, `${new Date().toISOString()} ${line}\n`);
}

/** The headroom daemon's loopback port, read live from its state on every routed request that needs the hop: the daemon can crash and restart on a different port while this door keeps listening, and the hop must follow it (and answer 502 while it is between restarts). */
function liveHeadroomPort(paths: LayoutPaths): number | undefined {
  return readHeadroomState(realFarmFs, paths.headroomStateFile)?.port;
}

/**
 * The real supervisor ports. The three listener starts are where the whole routing assembly is built: the codex translation's real ports, the provider route resolver over them, both pipelines (see `createDoorPipelines`), the three listeners that feed them, and the CA that signs both TLS-serving listeners' leaves.
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

  // One check for every listener that admits launches, read fresh on each call since launches come and go: the provider listener's and the CONNECT surface's routed paths (the capability header), and the CONNECT surface's own CONNECT requests (the proxy credential).
  const isLiveToken = (token: string): boolean => isLiveCapability(token, liveSessionTokens(realFarmFs, paths.frontdoorSessionsDir));

  // Usage tracking: one store per door process, its log segments named by this pid, written on a deferred turn so recording never sits in a response's path.
  const usageStore = createUsageStore({
    fs: realFarmFs,
    paths,
    pid: process.pid,
    now: () => Date.now(),
    readAccount: createAccountReader(realFarmFs, paths.identitiesDir),
    log,
  });
  // A provider whose quota only its own usage endpoint reports is refreshed after its requests are recorded, throttled by the quota's own resolution; the refresh runs detached from the request.
  const quotaRefresher = createRealQuotaRefresher({ paths, store: usageStore, log });
  const usageMiddleware = createUsageMiddleware({
    record: withQuotaRefresh(usageStore.record, quotaRefresher),
    defer: (task) => {
      setImmediate(task);
    },
    now: () => Date.now(),
    log,
  });

  const pipelines = createDoorPipelines({
    resolveRoute,
    isLiveToken,
    responseObservers: [usageMiddleware],
    now: () => Date.now(),
    headroomPort: () => liveHeadroomPort(paths),
    // The per-generation capability the direct listener demands: held only in this process's memory, so a loopback process that discovers the direct port still cannot use it.
    hopSecret: randomUUID(),
    custody: createCredentialCustody(() => randomUUID()),
    log,
  });

  // The CA is generated once on this machine's first front-door start and reused after: regenerating it would strand every child still pointing NODE_EXTRA_CA_CERTS at the old certificate. Loaded on first use by whichever listener starts first, and shared by both TLS-serving listeners.
  let ca: CaMaterial | undefined;
  const loadCa = (): CaMaterial => {
    ca ??= ensureCa(realConnectCertStore(paths), () => generateCa(new Date()));
    return ca;
  };

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
    startProviderListener: async (preferredPort) => {
      const authority = loadCa();
      const server = createFrontDoorServer(
        async (request) => {
          await serveRouted(request, pipelines.clientFacing);
        },
        log,
        mintLeaf(authority, LOOPBACK_LEAF_NAMES, new Date()),
      );
      const handle = await listenFrontDoor(server, { ...(preferredPort === undefined ? {} : { preferredPort }), ca: authority.certPem, onError: onListenerError("provider") });
      return { port: handle.port, close: handle.close };
    },
    startConnectListener: async (preferredPort) => {
      const leafFor = createLeafCache(loadCa(), () => new Date());
      const server = await startConnectServer(
        {
          interceptHost: CONNECT_INTERCEPT_HOST,
          serveRouted: (request, response) => {
            // The connect surface hands the pipeline the same request shape the provider listener builds: identified, admitted, middleware-run, routed, with the abort wired to the client going away.
            const abort = new AbortController();
            response.on("close", () => {
              if (!response.writableFinished) {
                abort.abort();
              }
            });
            void serveRouted({ method: request.method ?? "GET", url: request.url ?? "/", headers: request.headers, body: request, signal: abort.signal, response }, pipelines.clientFacing).catch(
              (error: unknown) => {
                log(`connect request ${request.method ?? "?"} ${request.url ?? "?"} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
                if (!response.headersSent) {
                  response.writeHead(HTTP_STATUS.badGateway, { "Content-Type": "application/json" });
                  response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "internal error in the agent-shim front door" } }));
                  return;
                }
                response.destroy();
              },
            );
          },
          leafFor,
          upstream: { host: CONNECT_INTERCEPT_HOST, port: HTTPS_PORT, tls: true },
          isLiveCapability: isLiveToken,
          limits: CONNECT_LIMITS,
        },
        realConnectEffects(),
        preferredPort,
      );
      return { port: server.port, close: server.close };
    },
    startDirectListener: async (preferredPort) => {
      const server = createFrontDoorServer(async (request) => {
        await serveRouted(request, pipelines.direct);
      }, log);
      const handle = await listenFrontDoor(server, {
        ...(preferredPort === undefined ? {} : { preferredPort }),
        onBound: (port) => {
          directPort = port;
        },
        onError: onListenerError("direct"),
      });
      return { port: handle.port, close: handle.close };
    },
    log: (line) => {
      appendLog(paths, line);
    },
  };
}

/** The real file effects for `resolveTrustBundle`. The bundle is public certificate material, so the atomic write's owner-only mode costs nothing: only this user's children read it. */
const realTrustBundleFs: TrustBundleFs = {
  readFileUtf8: (file) => fs.readFileSync(file, "utf8"),
  exists: (file) => fs.existsSync(file),
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
  writeFileAtomic: (file, contents) => {
    realFarmFs.writeFilePrivate(file, contents);
  },
};

/** The real `FrontDoorPort` for one launch: `ensure` runs the lock-and-poll coordination, authenticates the listener and registers this launcher; `release` removes its registration. */
export function realFrontDoorPort(paths: LayoutPaths): FrontDoorPort {
  return {
    ensure: (inheritedExtraCaCerts) => {
      const up = ensureFrontDoor({
        paths,
        launcherPid: process.pid,
        ports: {
          fs: realFarmFs,
          isRunning: realIsProcessRunning,
          now: () => Date.now(),
          sleep: realSleepSync,
          spawnSupervisor: (layout) => spawnDetachedSupervisor(layout, "__frontdoor-supervisor", layout.frontdoorLogPath),
          // Read fresh for each probe: a replacement supervisor may have regenerated an unparseable CA, and the probe must trust exactly what the serving door's leaf chains to.
          verifyListener: (port) => probeFrontDoorSync(port, fs.readFileSync(paths.frontdoorCaCertFile, "utf8")),
        },
      });
      const trust = resolveTrustBundle({ caCertFile: paths.frontdoorCaCertFile, bundlesDir: paths.frontdoorCaBundlesDir, inherited: inheritedExtraCaCerts, fs: realTrustBundleFs });
      return {
        port: up.port,
        connectPort: up.connectPort,
        trustBundlePath: trust.path,
        ...(trust.warning === undefined ? {} : { trustWarning: trust.warning }),
        sessionToken: up.token,
      };
    },
    release: () => {
      removeFrontDoorSession(realFarmFs, paths.frontdoorSessionsDir, process.pid);
    },
  };
}

/** One session-registry entry plus whether its launcher is still running. */
interface FrontDoorSessionStatus extends FrontDoorSessionSummary {
  readonly alive: boolean;
}

/** Everything `agent-shim frontdoor status` reports, collected read-only: no process is started or stopped. */
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
    sessions: listFrontDoorSessions(fsPort, paths.frontdoorSessionsDir).map((session) => ({ ...session, alive: isRunning(session.pid) })),
    headroomPort: readHeadroomState(fsPort, paths.headroomStateFile)?.port,
    logPath: paths.frontdoorLogPath,
    logExists: fsPort.readFileUtf8(paths.frontdoorLogPath) !== undefined,
  };
}

/** Formats `agent-shim frontdoor status`, one line per entry. */
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
    lines.push(`front door: listening on https://127.0.0.1:${String(status.state.port)}, routing /providers/<name> requests`);
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

/** Registers `agent-shim frontdoor status` and the hidden `__frontdoor-supervisor` internal subcommand. */
export function registerFrontDoorCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const frontdoor = withExamples(program.command("frontdoor").description("Inspect the front-door daemon that routes every agent-shim session."), [
    "agent-shim frontdoor status",
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
    ["agent-shim frontdoor status", "agent-shim frontdoor status --json"],
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

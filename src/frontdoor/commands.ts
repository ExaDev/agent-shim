import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { Command } from "commander";
import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { HTTP_STATUS } from "../codex/http";
import { readGlobalConfig } from "../configProfilesStore";
import { FRONTDOOR_DEFAULT_IDLE_SHUTDOWN_MINUTES } from "../config/schema";
import { createCodexRoutePorts } from "../codex/commands";
import type { LayoutPaths } from "../paths";
import { realFarmFs, realFsPort, realHeadroomSocketTrust, realIsProcessRunning, realCredentialPort } from "../realPorts";
import { realCredentialCacheEnv } from "../realCredentialCache";
import { createDoorPipelines } from "./assembly";
import { isLiveCapability } from "./capability";
import { captureFromEnv } from "./capture";
import { CONNECT_INTERCEPT_HOST, CONNECT_INTERCEPT_HOSTS, CONNECT_LIMITS, CONNECT_TAP_HOSTS, HTTPS_PORT, LOOPBACK_LEAF_NAMES, createLeafCache, ensureCa, generateCa, mintLeaf, realConnectCertStore, startConnectServer, type CaMaterial } from "./connect";
import { lateRcEventDial, lateRcStreamDial, realConnectEffects, realRcEventDial, realRcStreamDial, type RcDialTarget } from "./connectEffects";
import { createCredentialCustody } from "./custody";
import { collectCheckReport } from "../checkReport";
import { collectDoctorReport } from "../doctorReport";
import { listUsageSnapshots, readUsageSnapshot } from "../usage/read";import { createDoorApiNodeHandler } from "./controlApi";
import { createDoorEventHub, rcFanoutOnDoorHub } from "./eventHub";
import { createLaunchEventPublisher } from "./launchEvents";
import { serveRouted, type RouteResolution } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { MINTED_TOKEN_RANDOM_BYTES, registerRcCommand } from "./rcCommands";
import { createRcControlHandler } from "./rcControl";
import { createRcCredentialStore } from "./rcCredentialStore";
import { createRcClientPage } from "./rcClientPage";
import { createRcSelfHostSurface, rcSelfHostFromEnv } from "./rcSelfHost";
import { readRcSelfHostRecord } from "./rcSelfHostMint";
import { realRcWebFetch, rcWebFetchAllowsPrivateFromEnv } from "./rcWebFetch";
import { RC_IDLE_EXPIRY_MS, createRcSessionTracker, observingRoutedRoute } from "./rcSessions";
import { answerRcControlRequest, authenticateRcSessionMcpServer, endRcSession, getRcSessionContextUsage, getRcSessionMcpStatus, getRcSessionUsage, injectRcUserMessage, interruptRcSession, readRcSessionFile, reconnectRcSessionMcpServer, sendRcKeepAlive, setRcSessionModel, setRcSessionPermissionMode, submitRcSessionMcpOAuthCallbackUrl, suggestRcSessionFiles, teleportRcSession, type RcAnswerDecision, type RcContextUsageDetail, type RcPermissionMode, type RcReadFileOptions } from "./rcWrites";
import { RC_STREAM_BACKOFF_MS, createRcEventFanout, createRcStreamHub, type RcStreamHub } from "./rcStream";
import type { RoutedRequest } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { collectFrontDoorStatus, formatFrontDoorStatus, headroomSocketTarget } from "./status";
import { liveSessionTokens, writeFrontDoorSession } from "./state";
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

/**
 * Wraps the door's route resolver so every route it resolves observes its served exchanges through the Remote Control tracker: the bare `/v1/` pass-through an OAuth session's Remote Control calls ride is where the tracker sees the create, the heartbeats and the presence, and the wrapper is a no-op for any path the tracker does not take (it hands the response through untouched). The client stream attachment is re-poked once an observed exchange's response has settled, so a session becomes attached the moment its create completes, without any polling of the tracker's own.
 */
function rcObservingResolver(
  resolve: (request: RoutedRequest) => Promise<RouteResolution>,
  tracker: ReturnType<typeof createRcSessionTracker>,
  hub?: RcStreamHub,
): (request: RoutedRequest) => Promise<RouteResolution> {
  return async (request) => {
    const resolution = await resolve(request);
    return resolution.ok
      ? { ok: true, route: observingRoutedRoute(resolution.route, tracker, hub === undefined ? undefined : { onExchangeSettled: () => { hub.reconcile(); } }) }
      : resolution;
  };
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
  // The self-hosted Remote Control mode, decided at door start like the transparent surface and the capture are: the door is one process, so the mode is the door's own. When it is on, the door serves the CCR session family itself (see rcSelfHost.ts) and points its own client-half dials at its own transparent surface; the record the surface authenticates against is read fresh on every call, so a re-mint applies without a restart.
  const rcSelfHost = rcSelfHostFromEnv(process.env);
  // Built once for the process, not per request: the codex translation's upstream agent and auth store hold pooled connections and refresh state that must survive across requests.
  const codexPorts = createCodexRoutePorts(log, paths.chatgptSignInFile);

  // The CA is generated once on this machine's first front-door start and reused after: regenerating it would strand every child still pointing NODE_EXTRA_CA_CERTS at the old certificate. Loaded on first use by whichever listener starts first, and shared by both TLS-serving listeners.
  let ca: CaMaterial | undefined;
  const loadCa = (): CaMaterial => {
    ca ??= ensureCa(realConnectCertStore(paths), () => generateCa(new Date()));
    return ca;
  };

  // The transparent surface's port, known only once the connect listener has bound it. The self-hosted mode's client-half dials read it through `rcSelfHostDialTarget`, exactly the late-filled-closure pattern the direct port uses above: no dial can happen before the bind, because a tracked session needs traffic first and the traffic needs the surface.
  let transparentPort: number | undefined;
  let selfHostDialTarget: RcDialTarget | undefined;
  /** Where the door's own Remote Control client half dials when the self-hosted mode is on: the door's own transparent surface, presenting the API host's name so the traffic terminates exactly as the CLI's does. Undefined while the mode is off or the surface is not yet bound, in which case the dial keeps its default (the real host). */
  const rcSelfHostDialTarget = (): RcDialTarget | undefined => {
    if (!rcSelfHost || transparentPort === undefined) {
      return undefined;
    }
    selfHostDialTarget ??= { host: "127.0.0.1", port: transparentPort, servername: CONNECT_INTERCEPT_HOST, ca: [loadCa().certPem] };
    return selfHostDialTarget;
  };

  // The served CCR surface itself: one per door process, in memory only. Its route rides the resolver below (so its exchanges are observed by the tracker exactly as the real host's are), and its local answers ride the connect surface's config.
  const rcSelfHostSurface = rcSelfHost
    ? createRcSelfHostSurface({
        now: () => Date.now(),
        newUuid: randomUUID,
        randomToken: () => randomBytes(MINTED_TOKEN_RANDOM_BYTES).toString("base64url"),
        credentialRecord: () => readRcSelfHostRecord(realFarmFs, paths.frontdoorDir),
        webFetch: realRcWebFetch({ allowPrivate: rcWebFetchAllowsPrivateFromEnv(process.env) }),
        log,
      })
    : undefined;

  // The Remote Control session record: one per door process, in memory only, fed by every resolved route's served exchanges. Wrapping the resolver (rather than any one listener) is what lets whichever pipeline serves a `/v1/code/sessions` exchange observe it, and the wrapper is inert for every path outside the Remote Control prefix. The client credential and the stream's sequence cursor are the two parts that must outlive the process (a session outlives any one door generation, only client-half calls state the OAuth bearer, and a generation that lost the cursor would re-read the stream from its head), so both are persisted per session in one owner-only file and read back by whichever generation needs them.
  const rcCredentialStore = createRcCredentialStore(realFarmFs, paths.frontdoorRcCredentialsDir);
  const rcTracker = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS, credentialStore: rcCredentialStore });
  // The door's event backbone: one publisher/subscriber spine for every door-wide source, serving the typed API's `events.subscribe`. The Remote Control client read stream is its first publisher (through the wrap below, which moves nothing about how RC events flow) and the launch lifecycle is its first door-native one, fed by the supervisor's tick from the session registry.
  const doorEvents = createDoorEventHub();
  // The door's own client read stream attachment: one held stream per tracked session, fanned out to every subscriber (the typed API's subscription and `frontdoor rc watch`), with its envelopes filed with the tracker. The door plays one client because the CLI routes permission approvals only toward attached clients: with no stream held, an approval falls back to the CLI's own local prompt and never crosses the door. In the self-hosted mode the dial is resolved per call so it can name the door's own surface once that has bound. The supervisor's shutdown closes the hub as its last stop, which is what makes the final cursor save deterministic rather than left to a drop boundary the exit might never reach. The fan-out the hub is handed is the wrapped one, so every stream event reaches the fan-out's own subscribers exactly as before and the backbone beside it, source-tagged `rc`: that wrap is the whole of the RC stream becoming the backbone's first publisher.
  const rcFanout = rcFanoutOnDoorHub(createRcEventFanout(), doorEvents);
  const rcHub = createRcStreamHub({
    now: () => Date.now(),
    credentialOf: rcTracker.credentialOf,
    trackedSessions: () => rcTracker.list().map((session) => session.id),
    fileStreamEvent: rcTracker.fileStreamEvent,
    sequenceNumOf: rcTracker.sequenceNumOf,
    storedSequenceNumOf: rcCredentialStore.readCursor,
    saveSequenceNum: rcCredentialStore.writeCursor,
    dial: rcSelfHost ? lateRcStreamDial(rcSelfHostDialTarget) : realRcStreamDial(),
    fanout: rcFanout,
    newClientId: randomUUID,
    backoffMs: RC_STREAM_BACKOFF_MS,
    sleep: async (ms) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    },
    log: (line) => {
      appendLog(paths, `frontdoor ${String(process.pid)}: ${line}`);
    },
  });
  // This generation's control token, minted per door start and written owner-only: the value the door's control routes demand and only this user's CLI can read. A crashed door's stale file never authenticates, because the next generation mints a fresh one over it.
  const rcControlToken = randomUUID();
  const resolveRoute = rcObservingResolver(
    createProviderRouteResolver({
      fs: realFsPort,
      providersDir: paths.providersDir,
      codexPorts,
      directPort: () => directPort,
      // The same port (cache included) the launcher resolves a launch's provider with, so the credential the door attaches at the route and the one the launcher handed the child are the same resolution of the same block.
      env: process.env,
      credentials: { ...realCredentialPort, cache: realCredentialCacheEnv(paths) },
      ...(rcSelfHostSurface === undefined ? {} : { rcSelfHostRoute: rcSelfHostSurface.route }),
    }),
    rcTracker,
    rcHub,
  );

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
    headroomSocket: () => headroomSocketTarget(realFarmFs, realHeadroomSocketTrust, paths),
    // The per-generation capability the direct listener demands: held only in this process's memory, so a loopback process that discovers the direct port still cannot use it.
    hopSecret: randomUUID(),
    custody: createCredentialCustody(() => randomUUID()),
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
    startProviderListener: async (preferredPort) => {
      const authority = loadCa();
      // The write operations the control routes and the typed API both carry out: the door itself dials the real API host over its interception-proof agent, using the observed credential, which is why the CLI never dials the API directly. A confirmed write advances the session's sequence cursor through the tracker, so a stream resume continues after the door's own events too. In the self-hosted mode the dial's target is resolved per call so it names the door's own surface once that has bound.
      const rcDial = rcSelfHost ? lateRcEventDial(rcSelfHostDialTarget) : realRcEventDial();
      const rcInject = async (sessionId: string, text: string) =>
        await injectRcUserMessage({ credentialOf: rcTracker.credentialOf, noteSequenceNums: rcTracker.noteSequenceNums, dial: rcDial, newUuid: randomUUID }, sessionId, text);
      const rcAnswer = async (sessionId: string, requestId: string, decision: RcAnswerDecision) =>
        await answerRcControlRequest({ credentialOf: rcTracker.credentialOf, pendingOf: (id) => rcTracker.pendingOf(id), completePending: rcTracker.completePending, noteSequenceNums: rcTracker.noteSequenceNums, dial: rcDial }, sessionId, requestId, decision);
      const rcControlRequestDeps = { credentialOf: rcTracker.credentialOf, noteSequenceNums: rcTracker.noteSequenceNums, dial: rcDial, newUuid: randomUUID };
      const rcInterrupt = async (sessionId: string) => await interruptRcSession(rcControlRequestDeps, sessionId);
      const rcSetModel = async (sessionId: string, model: string) => await setRcSessionModel(rcControlRequestDeps, sessionId, model);
      const rcSetPermissionMode = async (sessionId: string, mode: RcPermissionMode) => await setRcSessionPermissionMode(rcControlRequestDeps, sessionId, mode);
      const rcEndSession = async (sessionId: string, reason: string | undefined) => await endRcSession(rcControlRequestDeps, sessionId, reason);
      const rcGetUsage = async (sessionId: string, skipBehaviors: boolean | undefined) => await getRcSessionUsage(rcControlRequestDeps, sessionId, skipBehaviors);
      const rcGetContextUsage = async (sessionId: string, detail: RcContextUsageDetail | undefined) => await getRcSessionContextUsage(rcControlRequestDeps, sessionId, detail);
      const rcReadFile = async (sessionId: string, filePath: string, options: RcReadFileOptions | undefined) => await readRcSessionFile(rcControlRequestDeps, sessionId, filePath, options);
      const rcFileSuggestions = async (sessionId: string, query: string) => await suggestRcSessionFiles(rcControlRequestDeps, sessionId, query);
      const rcKeepAlive = async (sessionId: string) => await sendRcKeepAlive(rcControlRequestDeps, sessionId);
      const rcMcpStatus = async (sessionId: string) => await getRcSessionMcpStatus(rcControlRequestDeps, sessionId);
      const rcMcpReconnect = async (sessionId: string, serverName: string) => await reconnectRcSessionMcpServer(rcControlRequestDeps, sessionId, serverName);
      const rcMcpAuthenticate = async (sessionId: string, serverName: string, redirectUri: string) => await authenticateRcSessionMcpServer(rcControlRequestDeps, sessionId, serverName, redirectUri);
      const rcMcpOAuthCallbackUrl = async (sessionId: string, serverName: string, callbackUrl: string) => await submitRcSessionMcpOAuthCallbackUrl(rcControlRequestDeps, sessionId, serverName, callbackUrl);
      const rcTeleport = async (sessionId: string, marker: string) => await teleportRcSession(rcControlRequestDeps, sessionId, marker);
      // The control-plane reads the typed API serves beside Remote Control, each one the same read-only collector the CLI's own verbs use, so the door's answer and `frontdoor status`'s can never disagree.
      const controlDeps = {
        usageSnapshots: () => listUsageSnapshots(realFarmFs, paths.usageSnapshotsDir),
        usageSnapshotOf: (identity: string) => readUsageSnapshot(realFarmFs, paths.usageSnapshotsDir, identity),
        now: () => Date.now(),
        frontDoorStatus: () => collectFrontDoorStatus(realFarmFs, realHeadroomSocketTrust, paths, realIsProcessRunning),
        checkReport: (target: string, identity?: string) => collectCheckReport({ paths, cwd: target, ...(identity === undefined ? {} : { identity }), env: process.env }),
        doctorReport: () => collectDoctorReport({ paths, env: process.env }),
      };
      // Written before the listener binds, so a listener that answers control requests is always one whose token exists; removed when this listener closes, so an idle-shut door leaves no token behind that a squatter on the port could be probed with.
      realFarmFs.mkdirp(paths.frontdoorDir);
      realFarmFs.writeFilePrivate(paths.frontdoorControlTokenFile, `${rcControlToken}\n`);
      const server = createFrontDoorServer(
        async (request) => {
          await serveRouted(request, pipelines.clientFacing);
        },
        log,
        mintLeaf(authority, LOOPBACK_LEAF_NAMES, new Date()),
        createRcControlHandler({ expectedToken: rcControlToken, list: rcTracker.list, statusOf: rcTracker.statusOf, pendingOf: rcTracker.pendingOf, inject: rcInject, answer: rcAnswer, interrupt: rcInterrupt, setModel: rcSetModel, setPermissionMode: rcSetPermissionMode, endSession: rcEndSession, getUsage: rcGetUsage, getContextUsage: rcGetContextUsage, readFile: rcReadFile, fileSuggestions: rcFileSuggestions, keepAlive: rcKeepAlive, mcpStatus: rcMcpStatus, mcpReconnect: rcMcpReconnect, mcpAuthenticate: rcMcpAuthenticate, mcpOAuthCallbackUrl: rcMcpOAuthCallbackUrl, teleport: rcTeleport }),
        [
          createDoorApiNodeHandler({
            expectedToken: rcControlToken,
            list: rcTracker.list,
            statusOf: rcTracker.statusOf,
            pendingOf: rcTracker.pendingOf,
            inject: rcInject,
            answer: rcAnswer,
            interrupt: rcInterrupt,
            setModel: rcSetModel,
            setPermissionMode: rcSetPermissionMode,
            endSession: rcEndSession,
            getUsage: rcGetUsage,
            getContextUsage: rcGetContextUsage,
            readFile: rcReadFile,
            fileSuggestions: rcFileSuggestions,
            keepAlive: rcKeepAlive,
            mcpStatus: rcMcpStatus,
            mcpReconnect: rcMcpReconnect,
            mcpAuthenticate: rcMcpAuthenticate,
            mcpOAuthCallbackUrl: rcMcpOAuthCallbackUrl,
            teleport: rcTeleport,
            fanout: rcFanout,
            ...controlDeps,
            events: doorEvents,
          }),
          // The self-hosted web client rides the same listener under the same per-generation token as the typed API it speaks: no extra process, no new trust surface.
          createRcClientPage(rcControlToken),
        ],
      );
      const handle = await listenFrontDoor(server, { ...(preferredPort === undefined ? {} : { preferredPort }), ca: authority.certPem, onError: onListenerError("provider") });
      return {
        port: handle.port,
        close: async () => {
          realFarmFs.removeRecursive(paths.frontdoorControlTokenFile);
          await handle.close();
        },
      };
    },
    startConnectListener: async (preferredPort) => {
      // The transparent surface exists only when something asked for it (AGENT_SHIM_TRANSPARENT_SURFACE naming the port an operating-system redirect sends the API host's address to): the door then mints its own registered session for redirect-arriving traffic, keyed by its own pid so the session lives exactly as long as the door does and the idle pruner never reaps it while the door serves.
      const wantedTransparentPort = process.env.AGENT_SHIM_TRANSPARENT_SURFACE === undefined ? undefined : Number(process.env.AGENT_SHIM_TRANSPARENT_SURFACE);
      const transparentCapability = wantedTransparentPort === undefined || Number.isNaN(wantedTransparentPort) ? undefined : randomUUID();
      if (transparentCapability !== undefined) {
        writeFrontDoorSession(realFarmFs, paths.frontdoorSessionsDir, { pid: process.pid, startedAt: Date.now(), token: transparentCapability });
      }
      const leafFor = createLeafCache(loadCa(), () => new Date());
      // Capture is a per-door diagnostic, decided by the environment of the launch that starts (or restarts) the door, because the door is one process serving every launch: a per-launch toggle would record some sessions and silently not others. The value is read here, at door start, so it never changes mid-process.
      const capture = captureFromEnv(process.env, paths.logsDir);
      if (capture !== undefined) {
        log(`capture enabled, recording CONNECT targets and piped exchanges to ${path.join(paths.logsDir, "frontdoor-capture.jsonl")}`);
      }
      if (rcSelfHostSurface !== undefined) {
        log("self-hosted Remote Control surface on: the door serves the CCR session family itself, and its own client-half dials its own transparent surface");
        if (wantedTransparentPort === undefined || Number.isNaN(wantedTransparentPort)) {
          log("self-hosted Remote Control surface: AGENT_SHIM_TRANSPARENT_SURFACE is not set, so nothing redirects the CLI's Remote Control traffic to this door and the door's own client half has no surface to dial; set it to the interception port the mode is deployed with");
        }
      }
      const server = await startConnectServer(
        {
          interceptHosts: CONNECT_INTERCEPT_HOSTS,
          tapHosts: CONNECT_TAP_HOSTS,
          routedHost: CONNECT_INTERCEPT_HOST,
          ...(rcSelfHostSurface === undefined ? {} : { localSurface: rcSelfHostSurface.local }),
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
          upstreamFor: (host) => ({ host, port: HTTPS_PORT, tls: true }),
          isLiveCapability: isLiveToken,
          ...(wantedTransparentPort === undefined || Number.isNaN(wantedTransparentPort) ? {} : { transparentPort: wantedTransparentPort, ...(transparentCapability === undefined ? {} : { transparentCapability }) }),
          limits: CONNECT_LIMITS,
          ...(capture === undefined ? {} : { capture }),
        },
        realConnectEffects(),
        preferredPort,
      );
      // The bound transparent port is what the self-hosted mode's client-half dials name; recorded the moment it exists, exactly when the direct port is.
      transparentPort = server.transparentPort;
      return {
        port: server.port,
        close: async () => {
          rcSelfHostSurface?.close();
          await server.close();
        },
      };
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
    closeRcStreamHub: rcHub.close,
    // The launch lifecycle publisher over the same backbone the typed API serves: the tick's registry facts go in here, and the door's own register, prune and end moments come out as source-tagged events.
    observeLaunchRegistry: createLaunchEventPublisher(doorEvents, () => Date.now()).observe,
    log: (line) => {
      appendLog(paths, line);
    },
  };
}

/** Registers `agent-shim frontdoor status`, the `frontdoor rc` verbs, and the hidden `__frontdoor-supervisor` internal subcommand. */
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
        const status = collectFrontDoorStatus(realFarmFs, realHeadroomSocketTrust, paths, realIsProcessRunning);
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


  // The whole `frontdoor rc` verb tree lives in its own module, registered here so the command layout reads in one place.
  registerRcCommand(frontdoor, paths);

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

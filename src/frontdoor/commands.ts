import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { Command } from "commander";
import { printJson, withExamples, type CommandDeps } from "../cli/commandDeps";
import { HTTP_STATUS } from "../codex/http";
import { readGlobalConfig } from "../configProfilesStore";
import { FRONTDOOR_DEFAULT_IDLE_SHUTDOWN_MINUTES, type Job } from "../config/schema";
import { parseDuration } from "../resolve/conditions";
import { collectCodexStatus, createCodexRoutePorts, runCodexLogout } from "../codex/commands";
import type { LayoutPaths } from "../paths";
import { realSessionFs } from "../agents/realFs";
import { collectSessionList, showSession } from "../agents/sessions";
import { listIdentities } from "../identityStore";
import { realFarmFs, realFsPort, realHeadroomSocketTrust, realIsProcessAlive, realIsProcessRunning, realRunningAmong, realCredentialPort, realOwnExecutablePath, selfInvocation, spawnDetachedSupervisor, spawnSelfDetached } from "../realPorts";
import { supervisedSessionOf, writeModelMove } from "../supervise/registry";
import { createTargetObservationStore } from "../selection/targetStore";
import { checkForUpdate } from "../update/commands";
import { identityExists, listAnchoredIdentities } from "../identityStore";
import { readJobs } from "../jobStore";
import { refreshStalePoolMembers } from "../launcher/poolRefresh";
import { ANTHROPIC_USAGE_FRESHNESS_MS } from "../usage/anthropicUsageRefresh";
import { loadPoolMembers } from "../usage/poolPick";
import { createRealAnthropicUsageRefresher } from "../usage/realAnthropicUsageProbe";
import { runChild } from "../usage/childRun";
import { createCatalogueKeeper } from "../catalogueKeeper";
import { CATALOGUE_REFRESH_TIMEOUT_MS, catalogueCachePath } from "../providerCatalogue";
import { createProviderCanonicaliser, loadProviderAliases } from "../providerAliases";
import { listProviders } from "../providersStore";
import { WINDOW_OPEN_TIMEOUT_MS } from "../usage/realWindowOpener";
import { runJobs } from "../usage/jobKeeper";
import { resolveJobIdentity } from "../usage/jobTarget";
import { machineTimeZone } from "../usage/anchor";
import { runWindowKeeper } from "../usage/windowKeeper";
import { realCredentialCacheEnv } from "../realCredentialCache";
import { createDoorPipelines } from "./assembly";
import { appendDoorLog } from "./doorLog";
import { retireOnSignals } from "./replacement";
import { createRoutingSettingReader } from "../headroom/routingSetting";
import { createHeadroomDecision } from "./headroomDecision";
import { isLiveCapability } from "./capability";
import { captureFromEnv } from "./capture";
import { CONNECT_INTERCEPT_HOST, CONNECT_INTERCEPT_HOSTS, CONNECT_LIMITS, CONNECT_TAP_HOSTS, HTTPS_PORT, LOOPBACK_LEAF_NAMES, createLeafCache, ensureCa, generateCa, mintLeaf, realConnectCertStore, startConnectServer, type CaMaterial } from "./connect";
import { lateRcEventDial, lateRcStreamDial, realConnectEffects, realRcEventDial, realRcStreamDial, type RcDialTarget } from "./connectEffects";
import { createCredentialCustody } from "./custody";
import { collectCheckReport } from "../checkReport";
import { collectDoctorReport } from "../doctorReport";
import { collectPoolPick } from "../poolPickReport";
import { resolveClaudeLaunch } from "../launchWiring";
import { readPools } from "../poolStore";
import { listUsageSnapshots, readUsageSnapshot } from "../usage/read";
import type { UsageSnapshot } from "../usage/schema";import { createDoorApiNodeHandler } from "./controlApi";
import { createDoorHealthPublisher } from "./doorHealthEvents";
import { createDoorEventHub, rcFanoutOnDoorHub } from "./eventHub";
import { USAGE_EVENT_SOURCE } from "./eventSchemas";
import { createQuotaExpiringPublisher } from "./quotaExpiringEvents";
import { createLaunchEventPublisher } from "./launchEvents";
import { serveRouted, type RouteResolution } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { readModels } from "../modelsStore";
import { realRestartFrontDoor } from "./realFrontDoorPort";
import { MINTED_TOKEN_RANDOM_BYTES, registerRcCommand } from "./rcCommands";
import { createRcControlHandler } from "./rcControl";
import { createRcCredentialStore } from "./rcCredentialStore";
import { createRcLiveUsage } from "./rcLiveUsage";
import { createRcClientPage } from "./rcClientPage";
import { createRcSelfHostSurface, rcSelfHostFromEnv } from "./rcSelfHost";
import { readRcSelfHostRecord } from "./rcSelfHostMint";
import { realRcWebFetch, rcWebFetchAllowsPrivateFromEnv } from "./rcWebFetch";
import { RC_IDLE_EXPIRY_MS, createRcSessionTracker, observingRoutedRoute } from "./rcSessions";
import { targetRefs } from "../models/targets";
import { answerRcControlRequest, authenticateRcSessionMcpServer, endRcSession, getRcSessionContextUsage, getRcSessionMcpStatus, getRcSessionUsage, injectRcUserMessage, interruptRcSession, readRcSessionFile, reconnectRcSessionMcpServer, sendRcKeepAlive, setRcSessionModel, setRcSessionPermissionMode, submitRcSessionMcpOAuthCallbackUrl, suggestRcSessionFiles, teleportRcSession, type RcAnswerDecision, type RcContextUsageDetail, type RcPermissionMode, type RcReadFileOptions } from "./rcWrites";
import { RC_STREAM_BACKOFF_MS, createRcEventFanout, createRcStreamHub, type RcStreamHub } from "./rcStream";
import type { RoutedRequest } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { DOOR_AWAIT_PID_ENV, DOOR_RESPAWN_GENERATION_ENV, DOOR_RESPAWN_MAX_GENERATIONS, DOOR_STALL_BOUND_MS, DOOR_WATCHDOG_CHECK_MS, startThreadWatchdog } from "./watchdog";
import { readFrontDoorListeners, realFrontDoorListenerProbes } from "./listenerReadings";
import { collectFrontDoorStatus, formatFrontDoorListeners, formatFrontDoorStatus, headroomSocketTarget } from "./status";
import { FRONT_DOOR_PROTOCOL, listFrontDoorSessions, liveSessionTokens, removeFrontDoorSession, writeFrontDoorSession, readFrontDoorSessionModels } from "./state";
import { declareThisProcessTheFrontDoor } from "./selfIdentity";
import { awaitPidExit, runFrontDoorSupervisor, watchedInstallEntry, type FrontDoorSupervisorPorts, type OwnExecutableStat } from "./supervisor";
import { createAccountReader } from "../usage/account";
import { createUsageMiddleware } from "../usage/middleware";
import { withQuotaRefresh } from "../usage/quotaRefresh";
import { createRealQuotaRefresher } from "../usage/realQuotaRefresher";
import { createUsageStore } from "../usage/store";
import type { UsageRecord } from "../usage/schema";

/** How a door's watchdog starts a replacement: this very executable running the supervisor subcommand, pinned to this door's state root exactly as `spawnDetachedSupervisor` pins it. Every environment value is a string, as the watchdog thread's `spawn` requires. */
/** The respawn generation this door was started as (`DOOR_RESPAWN_GENERATION_ENV`), or 0 for a door no watchdog started. Read once at startup so the env can be scrubbed before anything is served and the value handed to the supervisor ports explicitly. */
function readRespawnGeneration(): number {
  const generation = Number(process.env[DOOR_RESPAWN_GENERATION_ENV]);
  return Number.isInteger(generation) && generation > 0 ? generation : 0;
}

function respawnInvocation(paths: LayoutPaths): { readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> } {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...process.env, AGENT_SHIM_HOME: paths.root })) {
    env[name] = value;
  }
  return { ...selfInvocation(["__frontdoor-supervisor"]), env };
}

/**
 * Wraps the door's route resolver so every route it resolves observes its served exchanges through the Remote Control tracker: the bare `/v1/` pass-through an OAuth session's Remote Control calls ride is where the tracker sees the create, the heartbeats and the presence, and the wrapper is a no-op for any path the tracker does not take (it hands the response through untouched). The client stream attachment is re-poked once an observed exchange's response has settled, so a session becomes attached the moment its create completes, without any polling of the tracker's own. Only the route is wrapped: the rest of an ok resolution (above all the `request` a routing scan replayed, which is the only readable copy of a body the scan consumed) passes through untouched.
 */
export function rcObservingResolver(
  resolve: (request: RoutedRequest) => Promise<RouteResolution>,
  tracker: ReturnType<typeof createRcSessionTracker>,
  hub?: RcStreamHub,
): (request: RoutedRequest) => Promise<RouteResolution> {
  return async (request) => {
    const resolution = await resolve(request);
    return resolution.ok
      ? { ...resolution, route: observingRoutedRoute(resolution.route, tracker, hub === undefined ? undefined : { onExchangeSettled: () => { hub.reconcile(); } }) }
      : resolution;
  };
}

/**
 * The real turnover stat: the file identity of one installed entry, stat'd fresh on each call. Exported for its real-filesystem tests, which pin the symlink-following, the non-file refusal and the rename-install detection the supervisor's turnover depends on.
 */
export function realStatOwnExecutable(watchPath: string): () => OwnExecutableStat | undefined {
  return () => {
    // throwIfNoEntry, because an absent entry is the remove-then-link or deleted case the supervisor deliberately ignores rather than a crash.
    const st = fs.statSync(watchPath, { throwIfNoEntry: false });
    return st?.isFile() !== true ? undefined : { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  };
}

/**
 * The real supervisor ports. The three listener starts are where the whole routing assembly is built: the codex translation's real ports, the provider route resolver over them, both pipelines (see `createDoorPipelines`), the three listeners that feed them, and the CA that signs both TLS-serving listeners' leaves.
 */
/** `respawnGeneration` is the generation this door was started as (see `readRespawnGeneration`), threaded in because the env it came from is scrubbed before the supervisor's lazy `startWatchdog` closure would read it. */
function realFrontDoorSupervisorPorts(paths: LayoutPaths, respawnGeneration: number, retire: AbortSignal, trackTunnels: (count: () => number) => void): FrontDoorSupervisorPorts {
  const log = (line: string): void => {
    appendDoorLog(paths, `frontdoor ${String(process.pid)}: ${line}`);
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
  // The door's event backbone: one publisher/subscriber spine for every door-wide source, serving the typed API's `events.subscribe`. The Remote Control client read stream is its first publisher (through the wrap below, which moves nothing about how RC events flow) and the launch lifecycle is its first door-native one, fed by the supervisor's tick from the session registry; the usage source publishes every snapshot the store writes, the door health source the supervisor's own transitions, and the expiring-quota source the windows the supervisor's tick sees entering their final span (kept fresh by the usage source's own events, seeded from the snapshot directory).
  const doorEvents = createDoorEventHub();
  // The usage source's publisher, registered here so the store (created below) can hand it every snapshot it writes, and the expiring-quota checker that reads those same snapshots off the backbone rather than the disk.
  const usagePublisher = doorEvents.publisher(USAGE_EVENT_SOURCE);
  const quotaExpiring = createQuotaExpiringPublisher(doorEvents, { seed: listUsageSnapshots(realFarmFs, paths.usageSnapshotsDir), now: () => Date.now() });
  // The door health publisher, fed by the supervisor's own transitions.
  const doorHealth = createDoorHealthPublisher(doorEvents, () => Date.now(), process.pid);
  // The live quota state, the backbone's first door-native consumer: subscribed to the rc source before any stream can publish, so every rate_limit_event the held client stream files becomes the door's latest per-session rate-limit observation, the state the control plane's `usage.live` read serves beside its snapshot readers.
  const rcLiveUsage = createRcLiveUsage({ now: () => Date.now(), hub: doorEvents });
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
      appendDoorLog(paths, `frontdoor ${String(process.pid)}: ${line}`);
    },
  });
  // This generation's control token, minted per door start and written owner-only: the value the door's control routes demand and only this user's CLI can read. A crashed door's stale file never authenticates, because the next generation mints a fresh one over it.
  // The per-target observations a virtual model's selection ranks on: seeded from the usage log at door start, then kept live by every record the store writes below.
  const observations = createTargetObservationStore(realFarmFs, paths);
  // The routing layer's snapshot cache, kept fresh by the usage store's publish below: a route condition reading a target's quota sees the state this process last wrote without a file read, and a cold cache (a door just started) falls back to the snapshot on disk once before the store's next write makes it live.
  const routingSnapshots = new Map<string, UsageSnapshot>();
  const rcControlToken = randomUUID();
  const resolveRoute = rcObservingResolver(
    createProviderRouteResolver({
      // Read live so a models-block edit reaches the next request without a door restart.
      // The block this session launched with when its directory, profile or committed file added definitions of its own; otherwise the global block, read live so an edit applies to the next request with no relaunch.
      models: (session) => (session.sessionId === undefined ? undefined : readFrontDoorSessionModels(realFarmFs, paths.frontdoorSessionsDir, session.sessionId)) ?? readModels(paths),
      targets: () => targetRefs(paths),
      fs: realFsPort,
      providersDir: paths.providersDir,
      codexPorts,
      directPort: () => directPort,
      // The same port (cache included) the launcher resolves a launch's provider with, so the credential the door attaches at the route and the one the launcher handed the child are the same resolution of the same block.
      env: process.env,
      credentials: { ...realCredentialPort, cache: realCredentialCacheEnv(paths) },
      usageSnapshotOf: (identity) => (identity === undefined ? undefined : routingSnapshots.get(identity) ?? readUsageSnapshot(realFarmFs, paths.usageSnapshotsDir, identity)),
      // An `acct:` model member is served by relaunch: the door leaves a move request for the session's supervisor (found across every pool's registry, since the door does not know which pool launched the session) and answers the request with what is happening. A session nothing supervises gets the message naming the command to run instead.
      observations: (target) => observations.observation(target),
      accountMoves: (sessionId, to, model) => {
        if (supervisedSessionOf(realFarmFs, paths, sessionId, realIsProcessRunning) === undefined) {
          return false;
        }
        writeModelMove(realFarmFs, paths, { sessionId, to, model, at: new Date().toISOString() });
        return true;
      },
      ...(rcSelfHostSurface === undefined ? {} : { rcSelfHostRoute: rcSelfHostSurface.route }),
    }),
    rcTracker,
    rcHub,
  );

  // One check for every listener that admits launches, read fresh on each call since launches come and go: the provider listener's and the CONNECT surface's routed paths (the capability header), and the CONNECT surface's own CONNECT requests (the proxy credential).
  const isLiveToken = (token: string): boolean => isLiveCapability(token, liveSessionTokens(realFarmFs, paths.frontdoorSessionsDir));

  // Usage tracking: one store per door process, its log segments named by this pid, written on a deferred turn so recording never sits in a response's path. Every snapshot it writes is published on the backbone's usage source, the durable fact the expiring-quota checker and any quota consumer reads; the routing layer's snapshot cache rides the same publish, so a route condition reading a target's quota sees the state this process last wrote without a file read.
  const usageStore = createUsageStore({
    fs: realFarmFs,
    paths,
    pid: process.pid,
    now: () => Date.now(),
    readAccount: createAccountReader(realFarmFs, paths.identitiesDir),
    log,
    publish: (snapshot) => {
      routingSnapshots.set(snapshot.identity, snapshot);
      usagePublisher.publish(snapshot);
    },
    onRecord: (record) => {
      observations.observe(record);
    },
  });
  // A provider whose quota only its own usage endpoint reports is refreshed after its requests are recorded, throttled by the quota's own resolution; the refresh runs detached from the request.
  const quotaRefresher = createRealQuotaRefresher({ paths, store: usageStore, log });
  // A pool member that has made no request lately has no current quota for a launch to rank on, so the door asks the usage endpoint about stale members on the cadence at which a fresh answer could differ from the recorded one. The timer never keeps the process alive.
  const anthropicRefresher = createRealAnthropicUsageRefresher({ paths, store: usageStore, cwd: process.cwd(), spawnDaemon: spawnDetachedSupervisor, log });
  /** The timers of the work the door runs on its own account, so a drain can stop them. */
  const keeperTimers: NodeJS.Timeout[] = [];
  const everyFreshnessInterval = (tick: () => void): void => {
    const timer = setInterval(tick, ANTHROPIC_USAGE_FRESHNESS_MS);
    timer.unref();
    keeperTimers.push(timer);
  };
  everyFreshnessInterval(() => {
    // A configuration this door cannot read (a key from a newer agent-shim sharing the file) is logged each tick and never ends the process: every session routed through this door depends on it.
    try {
      const pools = readPools(paths);
      refreshStalePoolMembers({ poolNames: Object.keys(pools), pools, loadMembers: (identities) => loadPoolMembers(realFarmFs, paths, identities, Date.now()), refresher: anthropicRefresher }).catch((error: unknown) => {
        log(`pool usage refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      log(`pool usage refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  // The window keeper acts on each identity's anchors on the same cadence: a window opened up to one period late still resets at the hour the anchor names. One run at a time, so a slow opening never overlaps the next tick; the timer never keeps the process alive.
  // Each opening and each job runs in a child process of this executable, never in the door itself: a launch routed through the door probes it, and that probe cannot be answered by the process making it.
  const windowOpener = async (identity: string): Promise<void> => {
    await runChild({ paths, args: ["__open-window", identity], timeoutMs: WINDOW_OPEN_TIMEOUT_MS });
  };
  let keeperRunning = false;
  everyFreshnessInterval(() => {
    if (keeperRunning) {
      return;
    }
    keeperRunning = true;
    void runWindowKeeper({
      fs: realFarmFs,
      stampsFile: paths.usageAnchorsFile,
      nowMs: () => Date.now(),
      timeZone: machineTimeZone(),
      anchored: () => listAnchoredIdentities(paths),
      snapshot: (identity) => readUsageSnapshot(realFarmFs, paths.usageSnapshotsDir, identity),
      open: windowOpener,
      log,
    })
      .catch((error: unknown) => {
        log(`window keeper failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        keeperRunning = false;
      });
  });
  // The job keeper starts each job whose trigger has fired on the same cadence. A run can last as long as the job's timeout, so the tick only starts it; the set of running jobs outlives the tick so a job is never started again while it is still going.
  const jobRunner = async (name: string, identity: string, job: Job): Promise<void> => {
    await runChild({ paths, args: ["__run-job", name, identity], timeoutMs: parseDuration(job.timeout) });
  };
  const runningJobs = new Set<string>();
  everyFreshnessInterval(() => {
    try {
      runJobs({
        fs: realFarmFs,
        stampsFile: paths.usageJobsFile,
        nowMs: () => Date.now(),
        timeZone: machineTimeZone(),
        jobs: () => Object.entries(readJobs(paths)).map(([name, job]) => ({ name, job })),
        resolveIdentity: (target) => resolveJobIdentity({ paths, fs: realFarmFs, pools: readPools(paths), nowMs: Date.now(), identityExists: (name) => identityExists(paths, name) }, target),
        snapshot: (identity) => readUsageSnapshot(realFarmFs, paths.usageSnapshotsDir, identity),
        run: jobRunner,
        running: runningJobs,
        log,
      });
    } catch (error) {
      log(`job keeper failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  // A provider that opted into a model catalogue is fetched in a child process, never in the door, for the same reason the window opener is: the door's event loop answers every session. The first tick runs at start, so a new catalogue does not wait a period, and a fresh cache costs no request.
  const catalogueKeeper = createCatalogueKeeper({
    providers: () => listProviders(paths, (name, message) => { log(`catalogue keeper skipped provider ${name}: ${message}`); }).map((entry) => [entry.name, entry.provider] as const),
    readCache: (name) => realFsPort.readFileUtf8(catalogueCachePath(paths, name)),
    refresh: async (name) => {
      await runChild({ paths, args: ["__refresh-catalogue", name], timeoutMs: CATALOGUE_REFRESH_TIMEOUT_MS });
    },
    nowMs: () => Date.now(),
    log,
  });
  catalogueKeeper.tick();
  everyFreshnessInterval(catalogueKeeper.tick);
  const headroomDecision = createHeadroomDecision(createRoutingSettingReader(paths));
  // The door's per-target observations (latency, success, token mix), folded from every finished record: the selection engine's ranked and adaptive modes read them when a virtual model chooses a member. Seeded from the recent usage log so a restarted door does not start blind.
  const targetObservations = createTargetObservationStore(realFarmFs, paths);
  const recordUsage = (record: UsageRecord): void => {
    withQuotaRefresh(usageStore.record, quotaRefresher)(record);
    targetObservations.observe(record);
  };
  const usageMiddleware = createUsageMiddleware({
    // Each finished response also tells the per-session headroom decision when the session's cache was last touched and whether it read from it.
    record: (record, event) => {
      const { usage } = record;
      headroomDecision.observe({
        sessionId: record.sessionId,
        startedAtMs: Date.parse(record.at),
        viaHeadroom: record.viaHeadroom === true,
        lineage: event.lineage,
        endedAtMs: Date.parse(record.at) + record.durationMs,
        cache: usage === undefined ? undefined : { readTokens: usage.cacheReadInputTokens ?? 0, writtenTokens: usage.cacheCreationInputTokens ?? 0, uncachedTokens: usage.inputTokens ?? 0 },
      });
      recordUsage(record);
    },
    defer: (task) => {
      setImmediate(task);
    },
    now: () => Date.now(),
    log,
  });

  // The existence check is a stat, not a parse: it runs on every provider request.
  const canonicalProvider = createProviderCanonicaliser({
    defined: (name) => realFarmFs.lstat(path.join(paths.providersDir, `${name}.json`)) !== undefined,
    aliases: () => loadProviderAliases(paths.providerAliasesFile, realFsPort),
    log,
  });

  const pipelines = createDoorPipelines({
    resolveRoute,
    isLiveToken,
    canonicalProvider,
    responseObservers: [usageMiddleware],
    now: () => Date.now(),
    headroomSocket: () => headroomSocketTarget(realFarmFs, realHeadroomSocketTrust, paths),
    // The per-generation capability the direct listener demands: held only in this process's memory, so a loopback process that discovers the direct port still cannot use it.
    hopSecret: randomUUID(),
    headroomDecision,
    custody: createCredentialCustody(() => randomUUID()),
    log,
  });

  const onListenerError = (name: string) => (error: Error): void => {
    appendDoorLog(paths, `frontdoor ${String(process.pid)}: ${name} listener failed: ${error.message}; exiting`);
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
    runningAmong: realRunningAmong,
    // The turnover check's file identity, over the installed entry resolved once at door start: re-resolving per tick would re-run the PATH scan every second and could theoretically flip between two files, while the entry itself is fixed for as long as this door lives. The existence check prefers the agent-shim sibling only when it is really there (see watchedInstallEntry).
    statOwnExecutable: realStatOwnExecutable(watchedInstallEntry(realOwnExecutablePath(), (candidate) => fs.existsSync(candidate))),
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
      // The control-plane reads the typed API serves beside Remote Control, each one the same read-only collector the CLI's own verbs use, so the door's answer and `frontdoor status`'s can never disagree, plus the live rate-limit observations the event backbone files.
      const controlDeps = {
        list: rcTracker.list,
        liveRateLimits: rcLiveUsage.liveOf,
        latestRateLimit: rcLiveUsage.latestOf,
        usageSnapshots: () => listUsageSnapshots(realFarmFs, paths.usageSnapshotsDir),
        usageSnapshotOf: (identity: string) => readUsageSnapshot(realFarmFs, paths.usageSnapshotsDir, identity),
        now: () => Date.now(),
        frontDoorStatus: () => collectFrontDoorStatus(realFarmFs, realHeadroomSocketTrust, paths, realIsProcessRunning),
        checkReport: (target: string, identity?: string) => collectCheckReport({ paths, cwd: target, ...(identity === undefined ? {} : { identity }), env: process.env }),
        doctorReport: () => collectDoctorReport({ paths, env: process.env }),
        // The pool table is read per call, not captured here, so a pool created or removed after the door started is ranked or refused by its live name the same moment the CLI would see it.
        poolPick: (pool: string, directory: string) => {
          const pools = readPools(paths);
          return pools[pool] === undefined ? undefined : collectPoolPick({ paths, fs: realFsPort, usageFs: realFarmFs, poolName: pool, pools, directory, nowMs: Date.now() });
        },
        poolNames: () => Object.keys(readPools(paths)).sort(),
        // A read-only resolution of what a launch from one directory would do: the launcher's own decision with its effects left out, so a read never recovers or resyncs a farm, starts a daemon, records a pool pick or runs a credential command.
        resolveLaunch: (request: { readonly path: string; readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>> }) => resolveClaudeLaunch({ argv: request.argv, cwd: request.path, env: request.env, paths }),
        // The identities are read per call, like the pool table, so an identity added after the door started is listed the moment the CLI would see it.
        sessionList: (filters: { readonly identity?: string | undefined; readonly all?: boolean | undefined }) =>
          collectSessionList(realSessionFs, paths.identitiesDir, listIdentities(paths).map((entry) => entry.name), { ...(filters.identity === undefined ? {} : { identity: filters.identity }), ...(filters.all === undefined ? {} : { all: filters.all }) }),
        liveTasks: () => rcTracker.liveTasksOf(),
        sessionShow: (query: string, identity: string | undefined) => showSession(realSessionFs, paths.identitiesDir, listIdentities(paths).map((entry) => entry.name), query, identity),
      };
      // The lifecycle and Codex procedures: each the same function the CLI verb of that name runs. A restart replaces this very process, so it runs a detached copy of `frontdoor restart` (the restart's own wait for the old door to exit cannot run inside it), started only after the procedure's answer has been written.
      const lifecycleAndCodexDeps = {
        doorPid: process.pid,
        restartDoor: () => {
          spawnSelfDetached(paths, ["frontdoor", "restart"]);
        },
        checkForUpdate: async () => await checkForUpdate(paths),
        codexStatus: () => collectCodexStatus(realFarmFs, paths, realIsProcessRunning),
        codexLogout: async () => await runCodexLogout(paths),
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
            paths,
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
            ...lifecycleAndCodexDeps,
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
        // The control token is left in place: a successor writes its own over it as it starts, and this door no longer serves the routes that check it.
        drain: handle.drain,
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
      trackTunnels(server.openTunnels);
      return {
        port: server.port,
        close: async () => {
          rcSelfHostSurface?.close();
          await server.close();
        },
        drain: async () => {
          // The session the transparent surface minted for this door is no longer anything this door serves: the successor mints its own, and this one would hold its idle clock open.
          if (transparentCapability !== undefined) {
            removeFrontDoorSession(realFarmFs, paths.frontdoorSessionsDir, process.pid);
          }
          await server.drain();
          rcSelfHostSurface?.close();
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
      return { port: handle.port, close: handle.close, drain: handle.drain };
    },
    closeRcStreamHub: rcHub.close,
    startWatchdog: () =>
      startThreadWatchdog({
        stateFile: paths.frontdoorStateFile,
        ownPid: process.pid,
        boundMs: DOOR_STALL_BOUND_MS,
        checkEveryMs: DOOR_WATCHDOG_CHECK_MS,
        pauseWaitMs: DOOR_WATCHDOG_CHECK_MS,
        action: "kill-process",
        logFile: paths.frontdoorLogPath,
        respawn: respawnInvocation(paths),
        respawnGeneration,
        respawnMaxGeneration: DOOR_RESPAWN_MAX_GENERATIONS,
        startLockFile: paths.frontdoorLockFile,
      }),
    // The launch lifecycle publisher over the same backbone the typed API serves: the tick's registry facts go in here, and the door's own register, prune and end moments come out as source-tagged events.
    observeLaunchRegistry: createLaunchEventPublisher(doorEvents, () => Date.now()).observe,
    doorHealth,
    retire,
    stopBackgroundWork: () => {
      for (const timer of keeperTimers) {
        clearInterval(timer);
      }
    },
    checkQuotaExpiry: quotaExpiring.check,
    log: (line) => {
      appendDoorLog(paths, line);
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
        // Probed here, not in the collected status: the collection is read-only and shared with the door's own typed API, while this is the CLI asking the listeners themselves whether they accept.
        const listeners = readFrontDoorListeners(status.state, status.supervisorAlive, realFrontDoorListenerProbes(paths));
        if (options.json === true) {
          printJson({ ...status, listeners });
          return;
        }
        for (const line of [...formatFrontDoorStatus(status, paths.frontdoorCaCertFile), ...formatFrontDoorListeners(listeners)]) {
          console.log(line);
        }
      }),
    ["agent-shim frontdoor status", "agent-shim frontdoor status --json"],
  );

  withExamples(
    frontdoor
      .command("restart")
      .description(
        "Replace the serving front door with one started from the installed binary, in place: it binds the same ports, so running sessions reach it on their next request. The old door releases its addresses and keeps carrying the tunnels and responses already open until they end; the sessions it terminates reconnect to the new one. Does nothing when no door is serving.",
      )
      .option("--json", "Print the result as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const result = realRestartFrontDoor(paths, spawnDetachedSupervisor, "restart-command");
        if (options.json === true) {
          printJson(result);
          return;
        }
        console.log(result.action === "not-running" ? "no front door is serving; nothing to restart" : `front door restarted: pid ${String(result.previousPid)} -> ${String(result.pid)}`);
      }),
    ["agent-shim frontdoor restart", "agent-shim frontdoor restart --json"],
  );


  // The whole `frontdoor rc` verb tree lives in its own module, registered here so the command layout reads in one place.
  registerRcCommand(frontdoor, paths);

  program
    .command("__frontdoor-supervisor", { hidden: true })
    .description("Internal: serve the front-door routing listeners. Started by the launcher; never run by hand.")
    .allowUnknownOption()
    .action(async () => {
      const idleShutdownMinutes = readGlobalConfig(paths)?.frontdoor?.idleShutdownMinutes ?? FRONTDOOR_DEFAULT_IDLE_SHUTDOWN_MINUTES;
      // A door started by its watchdog's stall handling names the stalled door's pid and waits for it to be gone before binding (see `awaitPidExit`), and carries the respawn generation it was started as, so its own watchdog knows how much of the chain is left. Both are read here, before the ports are built, so the supervisor's lazy watchdog wiring never has to see the env again.
      const awaited = Number(process.env[DOOR_AWAIT_PID_ENV]);
      const respawnGeneration = readRespawnGeneration();
      // Not inherited by anything this door starts.
      Reflect.deleteProperty(process.env, DOOR_AWAIT_PID_ENV);
      Reflect.deleteProperty(process.env, DOOR_RESPAWN_GENERATION_ENV);
      const retire = new AbortController();
      // What the door can say about itself when it is told to exit: how many tunnels it carries, read from the connect surface once it is up (none before).
      let openTunnels = (): number => 0;
      const supervisorPorts = realFrontDoorSupervisorPorts(paths, respawnGeneration, retire.signal, (count) => {
        openTunnels = count;
      });
      const ownPid = process.pid;
      // Every way this process can end writes its reason to the log first, because the log is the only record that outlives it: a door that exits silently looks, from outside, like one that was never there.
      process.on("exit", (code) => {
        supervisorPorts.log(`frontdoor ${String(ownPid)}: exiting with code ${String(code)}`);
      });
      // The first signal starts a drain rather than an exit: the supervisor releases the listening addresses and stays up for what its listeners still carry (see `FrontDoorSupervisorPorts.retire`); a further signal exits at once.
      retireOnSignals(process, {
        doorPid: ownPid,
        log: supervisorPorts.log,
        retire: () => {
          retire.abort();
        },
        exit: deps.exit,
        facts: () => ({
          tunnels: openTunnels(),
          liveSessions: listFrontDoorSessions(realFarmFs, paths.frontdoorSessionsDir).filter((session) => session.pid !== ownPid && realIsProcessAlive(session.pid)).length,
          protocol: FRONT_DOOR_PROTOCOL,
          uptimeSeconds: Math.round(process.uptime()),
        }),
      });
      // A door started by its watchdog's stall handling names the stalled door's pid and waits for it to be gone before binding (see `awaitPidExit`), and carries the respawn generation it was started as, so its own watchdog knows how much of the chain is left.
      if (Number.isInteger(awaited) && awaited > 0) {
        const waitedMs = await awaitPidExit(awaited, supervisorPorts);
        supervisorPorts.log(`frontdoor ${String(ownPid)}: stalled door ${String(awaited)} released the sticky ports after ${String(waitedMs)}ms`);
      }
      // Declared before anything is served, so a launch the door plans for itself never asks `ps` or probes its own held event loop whether it is alive.
      declareThisProcessTheFrontDoor();
      deps.exit(await runFrontDoorSupervisor(idleShutdownMinutes, supervisorPorts));
    });
}

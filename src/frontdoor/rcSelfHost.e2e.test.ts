import http from "node:http";
import https from "node:https";
import net from "node:net";
import type tls from "node:tls";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";

import { createCodexRoutePorts } from "../codex/commands";
import { realFsPort } from "../realPorts";
import { resolveLayoutPaths } from "../paths";
import { fakeAsyncCredentials, followsLaunchFlag, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createDoorPipelines } from "./assembly";
import { createCredentialCustody } from "./custody";
import { CONNECT_INTERCEPT_HOST, CONNECT_INTERCEPT_HOSTS, CONNECT_TAP_HOSTS, createLeafCache, generateCa, startConnectServer, type CaMaterial } from "./connect";
import { lateRcEventDial, lateRcStreamDial, realConnectEffects, type RcDialTarget } from "./connectEffects";
import type { ConnectEffects } from "./connect";
import { createProviderRouteResolver } from "./providerRoute";
import { serveRouted } from "./pipeline";
import { RC_SESSION_EVENT_LOG_CAPACITY, createRcSessionEventLog, type RcSessionEventLog } from "./rcEventLog";
import { observingRoutedRoute, createRcSessionTracker, type RcSessionTracker } from "./rcSessions";
import { answerRcControlRequest, endRcSession, getRcSessionMcpStatus, getRcSessionUsage, injectRcUserMessage, sendRcKeepAlive } from "./rcWrites";
import { createRcSelfHostSurface, type RcSelfHostCredentialRecord } from "./rcSelfHost";
import { realRcWebFetch } from "./rcWebFetch";
import { createRcEventFanout, createRcStreamHub, type RcStreamHub } from "./rcStream";
import { connectHead, connectRedirected, connectThroughProxy, KEYGEN_TIMEOUT_MS, proxyAuthorizationFor, rawAttempt, requestOn, TEST_CAPABILITY } from "./connectTestWorld";

/**
 * The end-to-end proof of the self-hosted Remote Control mode, against the real assembly the door runs: the connect surface with its transparent listener, the real admission and pipeline, the route resolution that hands the Remote Control family to the served surface, the observation wrapper that feeds the tracker, and the door's own client half (the stream attachment and the inject and answer writes) dialling the door's own transparent surface exactly as the mode wires it. A fake CLI (a raw TLS client through the redirect, speaking the protocol the 2.1.289 rig pinned) creates, bridges, registers, streams and writes; the door's client half consumes and controls. No upstream exists anywhere in the world, which is the point: nothing leaves the machine.
 */

/** A launch the world treats as self-hosted (the launch check names it), so its CONNECT tunnels are the mode's whatever their requests present. */
const SELF_HOSTED_CAPABILITY = "e2e-self-hosted-launch";
/** A live launch that is not self-hosted: a native login's or a provider session's, whose traffic the mode must leave exactly as it would be with the mode off. */
const NATIVE_CAPABILITY = "e2e-native-launch";
/** Every capability the world's admission accepts as a live launch. */
const LIVE_CAPABILITIES: readonly string[] = [TEST_CAPABILITY, SELF_HOSTED_CAPABILITY, NATIVE_CAPABILITY];

/** The status the world's stand-in forwarding answers with, echoing the forwarded body: one the door itself never answers, so a forwarded request cannot be mistaken for a local answer. */
const FORWARDED_STATUS = 299;

/** A short fake bearer of the OAuth kind (kept short of the redaction filter's eight-character suffix on purpose). */
const MINTED_OAUTH_TOKEN = "sk-ant-oat1";
/** The id of the identity the fake launch runs as, recorded in its registry entry. */
const RIG_IDENTITY_ID = "rig-identity";
const RECORD: RcSelfHostCredentialRecord = { accessToken: MINTED_OAUTH_TOKEN, refreshToken: "selfhost-refresh", organizationUuid: "11111111-1111-4111-8111-111111111111", accountUuid: "22222222-2222-4222-8222-222222222222", identityId: "lab" };

/** How long the e2e waits for a stream frame or an attachment that arrives asynchronously: generous against scheduling noise, short against a hang. */
const SETTLE_TIMEOUT_MS = 5_000;

/** How long the wait helpers sleep between checks: loopback delivery is sub-millisecond, so this is generous rather than tuned. */
const WAIT_POLL_MS = 25;

/** How long the door's own attachment is given to establish itself before the writes that depend on it. */
const ATTACH_SETTLE_MS = 200;

/** How long a stream delivery is given to arrive before the assertions read the collected frames. */
const DELIVERY_SETTLE_MS = 150;

/** The width of a UUID's final hyphen-separated group, so minted test ids carry the shape the protocol validates. */
const UUID_TAIL_WIDTH = 12;

/** The redirect status the stand-in's first hop answers with, named because the shared enum stops at the statuses this door answers with. */
const HTTP_FOUND = 302;

/** The whole-case timeout: keygen dominates the first case, the exchanges the second, and both sit far under this. */
const TEST_TIMEOUT_MS = 30_000;

/** One collected SSE frame stream held open against the door's transparent surface. */
interface RawSse {
  /** Destroys the stream, the way a disconnected worker would. */
  readonly destroy: () => void;
  readonly frames: string[];
}

/**
 * Opens a stream half (the worker's or a client's) against the door's transparent surface the way the redirect delivers it: a TLS connection presenting the door's CA as trust and the API host's name as SNI, decoded by Node's own HTTP stack, collecting frames as they arrive without expecting the response to complete.
 */
function openStream(transparent: number, caPem: string, path: string, headers: Readonly<Record<string, string>>): RawSse {
  const frames: string[] = [];
  let buffer = "";
  const request = https.request({ host: "127.0.0.1", port: transparent, servername: CONNECT_INTERCEPT_HOST, ca: [caPem], method: "GET", path, headers: { accept: "text/event-stream", ...headers } }, (answered) => {
    answered.setEncoding("utf8");
    answered.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part !== "") {
          frames.push(part);
        }
      }
    });
  });
  request.once("error", () => {
    // A stream destroyed by the test surfaces here; the frames already collected are what the assertions read.
  });
  request.end();
  return { destroy: () => { request.destroy(); }, frames };
}

/** Waits until the predicate holds over the collected frames, or fails naming what arrived. */
async function waitForFrames(stream: RawSse, predicate: (frames: readonly string[]) => boolean): Promise<void> {
  await waitUntil(() => predicate(stream.frames));
}

/** Waits until the predicate holds, or fails naming how long it waited. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, WAIT_POLL_MS);
    });
  }
  throw new Error(`expected state never arrived within ${String(SETTLE_TIMEOUT_MS)} ms`);
}

/** The envelopes of a raw stream's event frames, in arrival order. */
function envelopesOf(stream: RawSse): { readonly envelope: Record<string, unknown>; readonly id: string }[] {
  return stream.frames
    .filter((frame) => frame.startsWith("event: client_event"))
    .map((frame) => ({ envelope: JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? "{}") as Record<string, unknown>, id: /^id: (.+)$/m.exec(frame)?.[1] ?? "" }));
}

/** One raw HTTP request text, content-length framed. */
function rawRequest(method: string, path: string, headers: Readonly<Record<string, string>>, body?: string): string {
  const text = body ?? "";
  const head = [`${method} ${path} HTTP/1.1`, "Host: api.anthropic.com", ...(Object.entries(headers).map(([name, value]) => `${name}: ${value}`)), ...(body === undefined ? [] : [`Content-Length: ${String(Buffer.byteLength(text))}`]), "Connection: close", "", ""].join("\r\n");
  return head + text;
}

/** A stand-in for the echo server unmatched piped paths would reach; only the isolation case's native-credential control sends one, and the pointer exists so a stray request fails loudly instead of dialling the network. */
let echoPort = 0;

/** The door generation the session event log stamps, a made-up UUID of the production shape. */
const SESSION_EVENTS_GENERATION = "00000000-0000-4000-8000-0000000000f1";

/** Every upstream dial the connect surface made, by kind: a piped forward, a relayed upgrade's TLS dial, or a blind tunnel's TCP dial. The isolation case asserts this stays empty for every call a self-hosted session makes, and its control proves a native credential still lands here. */
const upstreamDials: string[] = [];

/** Whether the world attributes a redirected connection's peer process to a self-hosted launch; a case about a native peer behind a redirect clears it and restores it. */
let redirectedPeerIsSelfHosted = true;

/** Where a tap's upstream dial lands while a case wants the tapped bytes: a loopback stand-in for the real host that records every byte it receives. Undefined, a tap's dial is refused like every other. */
let tapStandIn: { readonly port: number } | undefined;

describe("the self-hosted Remote Control mode end to end", () => {
  let ca: CaMaterial;
  let surface: ReturnType<typeof createRcSelfHostSurface>;
  let tracker: RcSessionTracker;
  /** The door's session event log, fed by the tracker exactly as the door wires it, so the all-sessions stream's view of a self-hosted session is asserted against the real assembly. */
  let sessionEvents: RcSessionEventLog;
  let hub: RcStreamHub;
  let connectHandle: Awaited<ReturnType<typeof startConnectServer>>;
  let transparentPort: number;
  let dialTarget: RcDialTarget | undefined;
  /** The door's own client-half write dial, resolved per call at the door's own surface, exactly the production wiring. */
  let writeDial: ReturnType<typeof lateRcEventDial>;
  /** The fan-out the door's held client stream publishes to, hoisted so a test can subscribe the way `frontdoor rc watch` does. */
  let fanout: ReturnType<typeof createRcEventFanout>;

  beforeAll(async () => {
    ca = generateCa(new Date());
    const echo = net.createServer((socket) => {
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => {
      echo.listen(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    echoPort = (echo.address() as { port: number }).port;

    surface = createRcSelfHostSurface({
      now: () => Date.now(),
      newUuid: randomUuidSequence(),
      randomToken: () => "random-token-material",
      credentialRecord: () => RECORD,
      // The real production fetch dial, with the private-address refusal lifted because this world's fetch targets are loopback stand-ins the test itself starts.
      webFetch: realRcWebFetch({ allowPrivate: true }),
      ownsLaunch: (capability) => capability === SELF_HOSTED_CAPABILITY,
      // A redirected connection's peer is a self-hosted session's unless a case says otherwise: every redirected connection in this world is the test's own, attributed by this switch.
      ownsPeer: async () => await Promise.resolve(redirectedPeerIsSelfHosted),
    });
    sessionEvents = createRcSessionEventLog({ generation: SESSION_EVENTS_GENERATION, capacity: RC_SESSION_EVENT_LOG_CAPACITY });
    tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: 45_000, onTransition: sessionEvents.append, onClose: sessionEvents.close });
    fanout = createRcEventFanout();
    /** The door's own client half dials the door's own transparent surface: the target is known only once the listener has bound, exactly the production wiring. */
    const resolveTarget = (): RcDialTarget | undefined => dialTarget;
    hub = createRcStreamHub({
      now: () => Date.now(),
      credentialOf: tracker.credentialOf,
      trackedSessions: () => tracker.list().map((session) => session.id),
      fileStreamEvent: tracker.fileStreamEvent,
      sequenceNumOf: tracker.sequenceNumOf,
      dial: lateRcStreamDial(resolveTarget),
      fanout,
      newClientId: randomUuidSequence(),
      backoffMs: 50,
      sleep: async (ms) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        });
      },
    });
    const resolver = createProviderRouteResolver({ log: () => undefined, now: () => 0, mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
      fs: realFsPort,
      providersDir: resolveLayoutPaths().providersDir,
      codexPorts: createCodexRoutePorts(() => undefined, resolveLayoutPaths().chatgptSignInFile),
      directPort: () => 0,
      env: {},
      credentials: fakeAsyncCredentials(),
      rcSelfHostRoute: surface.route,
      // The routed pass-through to the real API is recorded and refused here, like every other upstream dial in this world: a self-hosted session's request reaching it is a leak the dial record shows.
      observeAnthropicPassthrough: (request) => {
        upstreamDials.push(`routed ${request.method} ${request.url}`);
        throw new Error(`the e2e world dials no real host, and the routed pass-through was asked for ${request.url}`);
      },
    });
    const observingResolver = async (request: Parameters<typeof resolver>[0]) => {
      const resolution = await resolver(request);
      return resolution.ok ? { ok: true as const, route: observingRoutedRoute(resolution.route, tracker, { onExchangeSettled: () => { hub.reconcile(); } }) } : resolution;
    };
    const pipelines = createDoorPipelines({
      resolveRoute: observingResolver,
      canonicalProvider: (name) => name,
      isLiveToken: (token) => LIVE_CAPABILITIES.includes(token),
      // The fake CLI sends no identity header (a Remote Control call carries none), so the identity can only come from the launch the tunnel's capability belongs to.
      identityOfToken: (token) => (token === TEST_CAPABILITY ? RIG_IDENTITY_ID : undefined),
      launchOfToken: () => undefined,
      headroomDecision: followsLaunchFlag, responseObservers: [],
      now: () => Date.now(),
      headroomSocket: () => undefined,
      hopSecret: "test-hop-secret",
      custody: createCredentialCustody(randomUuidSequence()),
      log: () => undefined,
    });
    connectHandle = await startConnectServer(
      {
        interceptHosts: [...CONNECT_INTERCEPT_HOSTS],
        tapHosts: [...CONNECT_TAP_HOSTS],
        routedHost: CONNECT_INTERCEPT_HOST,
        localSurface: surface.local,
        serveRouted: (request, response) => {
          const abort = new AbortController();
          response.on("close", () => {
            if (!response.writableFinished) {
              abort.abort();
            }
          });
          void serveRouted({ method: request.method ?? "GET", url: request.url ?? "/", headers: request.headers, body: request, signal: abort.signal, response }, pipelines.clientFacing).catch(() => {
            if (!response.headersSent) {
              response.writeHead(HTTP_STATUS.badGateway);
              response.end();
            }
          });
        },
        leafFor: createLeafCache(ca, () => new Date()),
        upstreamFor: () => ({ host: "127.0.0.1", port: echoPort, tls: false }),
        isLiveCapability: (token) => LIVE_CAPABILITIES.includes(token),
        transparentPort: 0,
        transparentCapability: TEST_CAPABILITY,
        limits: { headDeadlineMs: 10_000, maxPendingHeads: 64, maxTunnels: 1024, revalidateMs: 1_000 },
      },
      recordingUpstreamDials(realConnectEffects()),
      { preferredPort: undefined },
    );
    transparentPort = connectHandle.transparentPort ?? 0;
    dialTarget = { host: "127.0.0.1", port: transparentPort, servername: CONNECT_INTERCEPT_HOST, ca: [ca.certPem] };
    writeDial = lateRcEventDial(() => dialTarget);
  }, KEYGEN_TIMEOUT_MS);

  afterAll(async () => {
    hub.close();
    surface.close();
    tracker.close();
    await connectHandle.close();
  });

  it("carries a whole session: create, bridge, register, stream, and the door's own client half consuming and controlling it", async () => {
    // The fake CLI: a redirected TLS client speaking the protocol the pinned CLI does.
    const createSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const created = await requestOn(createSocket, rawRequest("POST", "/v1/code/sessions", { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }, JSON.stringify({ title: "rig", bridge: {} })));
    expect(created.statusLine).toContain("200");
    const sessionId = (JSON.parse(created.body) as { session: { id: string } }).session.id;
    expect(sessionId.startsWith("cse_")).toBe(true);
    createSocket.destroy();

    // The tracker observed the create through the same wrapper the real door wraps every resolved route with, so the door's client half already holds the credential and the attachment follows.
    await waitUntil(() => tracker.list().some((session) => session.id === sessionId));
    expect(tracker.credentialOf(sessionId)?.authorization).toBe(`Bearer ${MINTED_OAUTH_TOKEN}`);

    const bridgeSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const bridged = await requestOn(bridgeSocket, rawRequest("POST", `/v1/code/sessions/${sessionId}/bridge`, { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json" }, "{}"));
    expect(bridged.statusLine).toContain("200");
    const bridge = JSON.parse(bridged.body) as { worker_jwt: string; expires_in: number; api_base_url: string; worker_epoch: number };
    expect(bridge.api_base_url).toBe("https://api.anthropic.com");
    expect(bridge.worker_epoch).toBe(1);
    bridgeSocket.destroy();

    const registerSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const putWorker = await requestOn(registerSocket, rawRequest("PUT", `/v1/code/sessions/${sessionId}/worker`, { Authorization: `Bearer ${bridge.worker_jwt}`, "Content-Type": "application/json" }, JSON.stringify({ worker_status: "idle", worker_epoch: 1, external_metadata: { pending_action: null, task_summary: null, model: "rig-model" } })));
    expect(putWorker.statusLine).toContain("200");
    registerSocket.destroy();

    // The worker holds its read stream open for the rest of the test.
    const workerStream = openStream(transparentPort, ca.certPem, `/v1/code/sessions/${sessionId}/worker/events/stream`, { Authorization: `Bearer ${bridge.worker_jwt}`, "anthropic-version": "2023-06-01" });
    // The door's own client half attaches through its dial of the door's own surface; the attachment's presence call and stream are both served by the surface under test.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ATTACH_SETTLE_MS);
    });
    hub.reconcile();

    // The door injects a prompt: the write goes to the door's own served surface, which delivers it to the worker exactly as the real service would.
    const sent = await injectRcUserMessage({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial: writeDial, newUuid: randomUuidSequence() }, sessionId, "run the rig check");
    expect(sent.ok).toBe(true);
    if (!sent.ok) {
      throw new Error(sent.message);
    }
    const injectedNum = sent.sequenceNums[0];
    await waitForFrames(workerStream, (frames) => frames.some((frame) => frame.includes(`"sequence_num":${String(injectedNum)}`)));
    const injected = envelopesOf(workerStream).find((event) => event.envelope.sequence_num === injectedNum);
    if (injected === undefined) {
      throw new Error(`no parsed envelope for ${String(injectedNum)}; frames: ${JSON.stringify(workerStream.frames)}`);
    }
    expect(injected.envelope.source).toBe("client");
    expect(((injected.envelope.payload as Record<string, unknown>).message as Record<string, unknown>).content).toBe("run the rig check");

    // The worker answers with an assistant event and a permission request, as the CLI's half does.
    const replySocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const reply = await requestOn(
      replySocket,
      rawRequest("POST", `/v1/code/sessions/${sessionId}/worker/events`, { Authorization: `Bearer ${bridge.worker_jwt}`, "Content-Type": "application/json" }, JSON.stringify({ worker_epoch: 1, events: [
        { payload: { type: "assistant", uuid: "reply-uuid", message: { role: "assistant", content: "rig check done" } } },
        { payload: { type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "make check" } } } },
      ] })),
    );
    expect(reply.statusLine).toContain("200");
    replySocket.destroy();

    // The door's held client stream received the assistant event, and the tracker holds the permission request as pending (the observed write is what files it, exactly as against the real host).
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DELIVERY_SETTLE_MS);
    });
    const pending = tracker.pendingOf(sessionId);
    expect(pending.map((request) => request.requestId)).toContain("req-1");
    expect(pending.find((request) => request.requestId === "req-1")?.type).toBe("can_use_tool");
    // The worker state the registration named is reported too, read from the field the CLI actually sends.
    expect(tracker.statusOf(sessionId)[0]?.workerState?.value).toBe("idle");
    // Self-hosted mode (the door is the service): the worker's registration carries no identity header, so the identity is the launch's, found through the capability the tunnel supplied, and the model is the registration metadata's.
    expect(tracker.statusOf(sessionId)[0]).toMatchObject({ identity: RIG_IDENTITY_ID, model: "rig-model" });

    // The door answers the request: the control_response write is served and delivered back to the worker.
    const answered = await answerRcControlRequest({ credentialOf: tracker.credentialOf, pendingOf: (id) => tracker.pendingOf(id), completePending: tracker.completePending, pendingToolInputOf: tracker.pendingToolInputOf, claimPending: tracker.claimPending, noteSequenceNums: tracker.noteSequenceNums, dial: writeDial }, sessionId, "req-1", { approve: true, message: undefined });
    expect(answered.ok).toBe(true);
    if (!answered.ok) {
      throw new Error(answered.message);
    }
    await waitForFrames(workerStream, (frames) => frames.some((frame) => frame.includes("control_response")));
    const response = envelopesOf(workerStream).find((event) => (event.envelope.payload as Record<string, unknown>).type === "control_response");
    expect(((response?.envelope.payload as Record<string, unknown>).response as Record<string, unknown>).request_id).toBe("req-1");
    expect(tracker.pendingOf(sessionId).map((request) => request.requestId)).not.toContain("req-1");

    // The all-sessions event stream sees the self-hosted session exactly as a session on the real service: the worker turning busy, then the session archived by its client.
    const mid = sessionEvents.head();
    const busySocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    expect((await requestOn(busySocket, rawRequest("PUT", `/v1/code/sessions/${sessionId}/worker`, { Authorization: `Bearer ${bridge.worker_jwt}`, "Content-Type": "application/json" }, JSON.stringify({ worker_status: "running", worker_epoch: 1 })))).statusLine).toContain("200");
    busySocket.destroy();
    workerStream.destroy();
    const archiveSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    expect((await requestOn(archiveSocket, rawRequest("POST", `/v1/code/sessions/${sessionId}/archive`, { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json" }, "{}"))).statusLine).toContain("200");
    archiveSocket.destroy();
    await waitUntil(() => !tracker.list().some((session) => session.id === sessionId));
    const whole = sessionEvents.read({ session: sessionId });
    if (whole.status !== "ok") {
      throw new Error(whole.message);
    }
    expect(whole.events.map(({ kind, ...rest }) => ({ kind, ...("state" in rest ? { state: rest.state } : {}), ...("requestId" in rest ? { requestId: rest.requestId } : {}), ...("reason" in rest ? { reason: rest.reason } : {}) }))).toEqual([
      { kind: "session-appeared" },
      { kind: "worker-state", state: "idle" },
      { kind: "pending-born", requestId: "req-1" },
      { kind: "pending-retired", requestId: "req-1", reason: "answered" },
      { kind: "worker-state", state: "running" },
      { kind: "session-ended", reason: "archived" },
    ]);
    // A resume after the cursor read before the turn replays exactly what followed it.
    const resumed = sessionEvents.read({ since: mid, session: sessionId });
    expect(resumed.status === "ok" ? resumed.events.map((event) => event.kind) : []).toEqual(["worker-state", "session-ended"]);
  }, TEST_TIMEOUT_MS);

  it("delivers the wider control-verb family to the worker through the door's own surface, and the worker's answers flow back on the held client stream", async () => {
    // The fake CLI worker: create, bridge, register, then hold its read stream open, exactly as the whole-session test stands the world up.
    const createSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const created = await requestOn(createSocket, rawRequest("POST", "/v1/code/sessions", { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }, JSON.stringify({ title: "verbs", bridge: {} })));
    expect(created.statusLine).toContain("200");
    const sessionId = (JSON.parse(created.body) as { session: { id: string } }).session.id;
    createSocket.destroy();
    await waitUntil(() => tracker.list().some((session) => session.id === sessionId));

    const bridgeSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const bridged = await requestOn(bridgeSocket, rawRequest("POST", `/v1/code/sessions/${sessionId}/bridge`, { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json" }, "{}"));
    const bridge = JSON.parse(bridged.body) as { worker_jwt: string };
    bridgeSocket.destroy();

    const registerSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const putWorker = await requestOn(registerSocket, rawRequest("PUT", `/v1/code/sessions/${sessionId}/worker`, { Authorization: `Bearer ${bridge.worker_jwt}`, "Content-Type": "application/json" }, JSON.stringify({ worker_status: "idle", worker_epoch: 1 })));
    expect(putWorker.statusLine).toContain("200");
    registerSocket.destroy();

    const workerStream = openStream(transparentPort, ca.certPem, `/v1/code/sessions/${sessionId}/worker/events/stream`, { Authorization: `Bearer ${bridge.worker_jwt}`, "anthropic-version": "2023-06-01" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ATTACH_SETTLE_MS);
    });
    hub.reconcile();

    /** The door's client-half operations dial the door's own surface, minting request ids from this sequence so the assertions name exactly what went out. */
    const mintedIds = randomUuidSequence();
    const opDeps = { credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial: writeDial, newUuid: mintedIds };

    // The keep-alive group: the bare payload, with no request envelope, arrives on the worker stream.
    const kept = await sendRcKeepAlive(opDeps, sessionId);
    expect(kept.ok).toBe(true);
    if (!kept.ok) {
      throw new Error(kept.message);
    }
    await waitForFrames(workerStream, (frames) => frames.some((frame) => frame.includes("keep_alive")));
    const keptEnvelope = envelopesOf(workerStream).find((event) => isPayloadRecord(event.envelope.payload) && event.envelope.payload.type === "keep_alive");
    expect(keptEnvelope?.envelope.payload).toMatchObject({ type: "keep_alive" });
    if (!isPayloadRecord(keptEnvelope?.envelope.payload)) {
      throw new Error("the worker stream delivered no keep-alive payload");
    }
    expect(typeof keptEnvelope.envelope.payload.server_received_wall_ms).toBe("number");

    // The query group: a get_usage control request carries the SDK's envelope, and the worker's control_response answer, echoing the minted id, reaches the door's held client stream and its fan-out.
    const received: { readonly envelope: Record<string, unknown> }[] = [];
    const detach = fanout.subscribe(sessionId, (event) => {
      received.push({ envelope: event.envelope });
    });
    const usageAsked = await getRcSessionUsage(opDeps, sessionId, true);
    expect(usageAsked.ok).toBe(true);
    if (!usageAsked.ok) {
      throw new Error(usageAsked.message);
    }
    const usageRequestId = usageAsked.requestId;
    if (usageRequestId === undefined) {
      throw new Error("the get-usage write surfaced no minted request id");
    }
    await waitForFrames(workerStream, (frames) => frames.some((frame) => frame.includes("get_usage")));
    const askedEnvelope = envelopesOf(workerStream).find((event) => isPayloadRecord(event.envelope.payload) && isPayloadRecord(event.envelope.payload.request) && event.envelope.payload.request.subtype === "get_usage");
    expect(askedEnvelope?.envelope.payload).toMatchObject({
      type: "control_request",
      request_id: usageRequestId,
      request: { subtype: "get_usage", skip_behaviors: true },
    });
    if (!isPayloadRecord(askedEnvelope?.envelope.payload)) {
      throw new Error("the worker stream delivered no get_usage payload");
    }
    expect(typeof askedEnvelope.envelope.payload.server_received_wall_ms).toBe("number");
    // The fake worker answers as the CLI's half does: a worker event write carrying the control_response that echoes the id.
    const answerSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const answered = await requestOn(
      answerSocket,
      rawRequest("POST", `/v1/code/sessions/${sessionId}/worker/events`, { Authorization: `Bearer ${bridge.worker_jwt}`, "Content-Type": "application/json" }, JSON.stringify({ worker_epoch: 1, events: [
        { payload: { type: "control_response", response: { subtype: "success", request_id: usageRequestId, response: { sessions: [] } } } },
      ] })),
    );
    expect(answered.statusLine).toContain("200");
    answerSocket.destroy();
    await waitUntil(() => received.some((event) => isPayloadRecord(event.envelope.payload) && event.envelope.payload.type === "control_response"));
    const answerPayload = received.find((event) => isPayloadRecord(event.envelope.payload) && event.envelope.payload.type === "control_response")?.envelope.payload;
    if (!isPayloadRecord(answerPayload)) {
      throw new Error("the held client stream delivered no control_response payload");
    }
    const answerResponse = isPayloadRecord(answerPayload.response) ? answerPayload.response : {};
    expect(answerResponse.request_id).toBe(usageRequestId);
    detach();

    // The mcp_* group and the session-end verb: one representative each, both delivered with their own fields intact.
    const mcpAsked = await getRcSessionMcpStatus(opDeps, sessionId);
    if (!mcpAsked.ok) {
      throw new Error(mcpAsked.message);
    }
    const ended = await endRcSession(opDeps, sessionId, "done for today");
    if (!ended.ok) {
      throw new Error(ended.message);
    }
    await waitForFrames(workerStream, (frames) => frames.some((frame) => frame.includes("end_session")));
    const mcpEnvelope = envelopesOf(workerStream).find((event) => isPayloadRecord(event.envelope.payload) && isPayloadRecord(event.envelope.payload.request) && event.envelope.payload.request.subtype === "mcp_status");
    expect(mcpEnvelope?.envelope.payload).toMatchObject({
      type: "control_request",
      request_id: mcpAsked.requestId,
      request: { subtype: "mcp_status" },
    });
    const endEnvelope = envelopesOf(workerStream).find((event) => isPayloadRecord(event.envelope.payload) && isPayloadRecord(event.envelope.payload.request) && event.envelope.payload.request.subtype === "end_session");
    expect(endEnvelope?.envelope.payload).toMatchObject({
      type: "control_request",
      request_id: ended.requestId,
      request: { subtype: "end_session", reason: "done for today" },
    });

    workerStream.destroy();
  }, TEST_TIMEOUT_MS);

  it("joins a second client to one conversation through the door: a prompt from the second client drives the first's worker, the reply and the approval flow to both, and the answer written from the second retires on the first", async () => {
    // The first attachment: create, bridge, register, then hold the worker stream open, the TUI-shaped half the conversation runs in.
    const createSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const created = await requestOn(createSocket, rawRequest("POST", "/v1/code/sessions", { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }, JSON.stringify({ title: "join", bridge: {} })));
    expect(created.statusLine).toContain("200");
    const firstSession = JSON.parse(created.body) as { session: { id: string; conversation_id: string } };
    expect(firstSession.session.conversation_id.startsWith("conv_")).toBe(true);
    createSocket.destroy();
    await waitUntil(() => tracker.list().some((session) => session.id === firstSession.session.id));

    const bridgeSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const bridged = await requestOn(bridgeSocket, rawRequest("POST", `/v1/code/sessions/${firstSession.session.id}/bridge`, { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json" }, "{}"));
    const firstBridge = JSON.parse(bridged.body) as { worker_jwt: string };
    bridgeSocket.destroy();
    const registerSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    expect((await requestOn(registerSocket, rawRequest("PUT", `/v1/code/sessions/${firstSession.session.id}/worker`, { Authorization: `Bearer ${firstBridge.worker_jwt}`, "Content-Type": "application/json" }, JSON.stringify({ worker_status: "idle", worker_epoch: 1 })))).statusLine).toContain("200");
    registerSocket.destroy();
    const workerOfFirst = openStream(transparentPort, ca.certPem, `/v1/code/sessions/${firstSession.session.id}/worker/events/stream`, { Authorization: `Bearer ${firstBridge.worker_jwt}`, "anthropic-version": "2023-06-01" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ATTACH_SETTLE_MS);
    });
    hub.reconcile();

    // The joining handshake: the second client's create names the first's conversation, the multi-TUI native shape over the door's own surface.
    const joinSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const joined = await requestOn(joinSocket, rawRequest("POST", "/v1/code/sessions", { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }, JSON.stringify({ title: "second client", bridge: {}, conversation: firstSession.session.conversation_id })));
    expect(joined.statusLine).toContain("200");
    const secondSession = (JSON.parse(joined.body) as { session: { id: string; conversation_id: string } }).session;
    expect(secondSession.conversation_id).toBe(firstSession.session.conversation_id);
    joinSocket.destroy();
    await waitUntil(() => tracker.list().some((session) => session.id === secondSession.id));
    const clientOfSecond = openStream(transparentPort, ca.certPem, `/v1/code/sessions/${secondSession.id}/events/stream`, { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "anthropic-version": "2023-06-01" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ATTACH_SETTLE_MS);
    });
    hub.reconcile();

    // A prompt from the second client: its client-half write numbers in the conversation's shared space and reaches the first attachment's worker (the live half that acts on it) and its own client stream alike.
    const promptSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const promptWrite = await requestOn(promptSocket, rawRequest("POST", `/v1/code/sessions/${secondSession.id}/events`, { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json" }, JSON.stringify({ events: [{ payload: { type: "user", uuid: "join-prompt", message: { role: "user", content: "prompt from the second client" } } }] })));
    expect(promptWrite.statusLine).toContain("200");
    promptSocket.destroy();
    const promptNum = Number((JSON.parse(promptWrite.body) as { results: { sequence_num: string }[] }).results[0]?.sequence_num);
    await waitForFrames(workerOfFirst, (frames) => frames.some((frame) => frame.includes(`"sequence_num":${String(promptNum)}`)));
    const promptOnWorker = envelopesOf(workerOfFirst).find((event) => event.envelope.sequence_num === promptNum);
    expect(promptOnWorker?.envelope.source).toBe("client");
    expect(((promptOnWorker?.envelope.payload as Record<string, unknown>).message as Record<string, unknown>).content).toBe("prompt from the second client");
    await waitForFrames(clientOfSecond, (frames) => frames.some((frame) => frame.includes(`"sequence_num":${String(promptNum)}`)));
    expect(envelopesOf(clientOfSecond).find((event) => event.envelope.sequence_num === promptNum)?.envelope.event_type).toBe("user");

    // The first attachment's worker replies and raises an approval: both reach the second client's stream, and neither returns to the worker's own.
    const replySocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const reply = await requestOn(
      replySocket,
      rawRequest("POST", `/v1/code/sessions/${firstSession.session.id}/worker/events`, { Authorization: `Bearer ${firstBridge.worker_jwt}`, "Content-Type": "application/json" }, JSON.stringify({ worker_epoch: 1, events: [
        { payload: { type: "assistant", uuid: "join-reply", message: { role: "assistant", content: "the reply both clients see" } } },
        { payload: { type: "control_request", request_id: "req-join-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "make join" } } } },
      ] })),
    );
    expect(reply.statusLine).toContain("200");
    replySocket.destroy();
    await waitForFrames(clientOfSecond, (frames) => frames.some((frame) => frame.includes("join-reply")) && frames.some((frame) => frame.includes("req-join-1")));
    expect(envelopesOf(workerOfFirst).some((event) => isPayloadRecord(event.envelope.payload) && event.envelope.payload.uuid === "join-reply")).toBe(false);
    // The door's held client stream filed the request, so the tracker holds it pending for the first session.
    await waitUntil(() => tracker.pendingOf(firstSession.session.id).some((request) => request.requestId === "req-join-1"));

    // The approval is answered from the second client: the control_response written through its session reaches the first's worker stream and retires the pending request on the first.
    const answerSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const answerWrite = await requestOn(
      answerSocket,
      rawRequest("POST", `/v1/code/sessions/${secondSession.id}/events`, { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json" }, JSON.stringify({ events: [{ payload: { type: "control_response", response: { subtype: "success", request_id: "req-join-1", response: { behavior: "allow" } } } }] })),
    );
    expect(answerWrite.statusLine).toContain("200");
    answerSocket.destroy();
    await waitForFrames(workerOfFirst, (frames) => frames.some((frame) => frame.includes("req-join-1") && frame.includes("control_response")));
    const answeredOnWorker = envelopesOf(workerOfFirst).find((event) => isPayloadRecord(event.envelope.payload) && event.envelope.payload.type === "control_response");
    expect(((answeredOnWorker?.envelope.payload as Record<string, unknown>).response as Record<string, unknown>).request_id).toBe("req-join-1");
    await waitForFrames(clientOfSecond, (frames) => frames.some((frame) => frame.includes("control_response")));
    await waitUntil(() => !tracker.pendingOf(firstSession.session.id).some((request) => request.requestId === "req-join-1"));

    workerOfFirst.destroy();
    clientOfSecond.destroy();
  }, TEST_TIMEOUT_MS);

  it("serves the activation neighbours through the transparent surface: the eval, the profile, and the control-plane refresh", async () => {
    const apiSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const evalAnswer = await requestOn(apiSocket, rawRequest("POST", "/api/eval/sdk-selfhost", { "Content-Type": "application/json" }, JSON.stringify({ attributes: {} })));
    expect(evalAnswer.statusLine).toContain("200");
    expect((JSON.parse(evalAnswer.body) as { features: Record<string, unknown> }).features.tengu_ccr_bridge).toEqual({ defaultValue: true });
    apiSocket.destroy();

    const profileSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const profile = await requestOn(profileSocket, rawRequest("GET", "/api/oauth/profile", { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}` }));
    expect(profile.statusLine).toContain("200");
    expect(JSON.parse(profile.body)).toMatchObject({ organization: { uuid: RECORD.organizationUuid } });
    profileSocket.destroy();

    // The control-plane host is parsed as HTTP in this mode (its tap stands down), and its refresh is answered with the minted pair.
    const oauthSocket = await connectRedirected(transparentPort, "platform.claude.com", ca.certPem);
    const refresh = await requestOn(oauthSocket, rawRequest("POST", "/v1/oauth/token", { "Content-Type": "application/json" }, JSON.stringify({ grant_type: "refresh_token", refresh_token: RECORD.refreshToken })));
    expect(refresh.statusLine).toContain("200");
    expect(JSON.parse(refresh.body)).toMatchObject({ access_token: MINTED_OAUTH_TOKEN, refresh_token: RECORD.refreshToken });
    oauthSocket.destroy();
  }, TEST_TIMEOUT_MS);

  /** A terminated session of the self-hosted launch on `host`, reached the two ways the mode's traffic arrives: by redirect (no capability, attributed by its peer) and through the launch's own CONNECT tunnel (attributed by its capability). */
  const openSelfHosted = async (via: "redirect" | "tunnel", host: string): Promise<tls.TLSSocket> =>
    via === "redirect" ? await connectRedirected(transparentPort, host, ca.certPem) : await connectThroughProxy(connectHandle.port, host, ca.certPem, SELF_HOSTED_CAPABILITY);

  it.each(["redirect", "tunnel"] as const)("reads a request target one way only over a %s: dot segments, a backslash and the absolute form reach the same answer as the plain path, a leading double slash is refused, and none is forwarded", async (via) => {
    upstreamDials.length = 0;
    const minted = { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}` };
    for (const target of ["/./v1/mcp_servers", "/a/../v1/mcp_servers", "/.%2e/v1/mcp_servers", "http://api.anthropic.com/v1/mcp_servers"]) {
      const socket = await openSelfHosted(via, CONNECT_INTERCEPT_HOST);
      const answered = await requestOn(socket, rawRequest("GET", target, minted));
      socket.destroy();
      expect(answered.statusLine, target).toContain(String(HTTP_STATUS.ok));
      expect(JSON.parse(answered.body), target).toEqual({ data: [], next_page: null });
    }
    // A path starting with two slashes would read as an authority to a reader that resolves it against a base, so it is refused instead of decided.
    for (const target of ["//v1/mcp_servers", "//api.anthropic.com/v1/mcp_servers"]) {
      const socket = await openSelfHosted(via, CONNECT_INTERCEPT_HOST);
      expect((await requestOn(socket, rawRequest("GET", target, minted))).statusLine, target).toContain(String(HTTP_STATUS.badRequest));
      socket.destroy();
    }
    // A backslash target is refused by the HTTP parser itself or read as a slash; either way nothing is forwarded.
    const backslash = await openSelfHosted(via, CONNECT_INTERCEPT_HOST);
    backslash.write(rawRequest("GET", "\\v1/mcp_servers", minted));
    await new Promise<void>((resolve) => {
      backslash.once("close", () => {
        resolve();
      });
      backslash.once("data", () => {
        backslash.destroy();
      });
    });
    expect(upstreamDials).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("answers every non-Remote-Control call a self-hosted session makes on this machine, forwarding none, while a native credential is still forwarded", async () => {
    upstreamDials.length = 0;
    const minted = { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "anthropic-beta": "oauth-2025-04-20" };
    const org = RECORD.organizationUuid;
    // The calls a 2.1.319 session sent upstream in self-hosted mode before this surface answered them (the lab capture behind issue #731), each with the answer the offline table gives it, then the control-plane host, whose terminated session the mode parses and answers the same way.
    const calls: readonly { readonly host: string; readonly path: string; readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly status: number; readonly body?: unknown }[] = [
      { host: CONNECT_INTERCEPT_HOST, method: "GET", path: "/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-5-5", headers: minted, status: HTTP_STATUS.ok, body: {} },
      { host: CONNECT_INTERCEPT_HOST, method: "GET", path: "/api/claude_code_penguin_mode", headers: minted, status: HTTP_STATUS.ok, body: { enabled: false, disabled_reason: "preference" } },
      { host: CONNECT_INTERCEPT_HOST, method: "GET", path: `/api/oauth/organizations/${org}/sync/github/auth`, headers: minted, status: HTTP_STATUS.ok, body: { is_authenticated: false } },
      { host: CONNECT_INTERCEPT_HOST, method: "GET", path: "/mcp-registry/v0/servers?version=latest&limit=100", headers: {}, status: HTTP_STATUS.ok, body: { servers: [], metadata: { count: 0 } } },
      { host: CONNECT_INTERCEPT_HOST, method: "GET", path: "/v1/mcp_servers?limit=1000&include_additional_installs=true", headers: minted, status: HTTP_STATUS.ok, body: { data: [], next_page: null } },
      { host: CONNECT_INTERCEPT_HOST, method: "GET", path: "/api/claude_code_grove", headers: minted, status: HTTP_STATUS.notFound },
      { host: CONNECT_INTERCEPT_HOST, method: "GET", path: "/api/frame/contract/latest", headers: minted, status: HTTP_STATUS.notFound },
      { host: CONNECT_INTERCEPT_HOST, method: "GET", path: `/api/oauth/organizations/${org}/referral/eligibility?campaign=claude_code_guest_pass`, headers: minted, status: HTTP_STATUS.notFound },
      { host: CONNECT_INTERCEPT_HOST, method: "POST", path: "/api/artifacts/mcp", headers: { ...minted, "Content-Type": "application/json" }, status: HTTP_STATUS.notFound },
      { host: "platform.claude.com", method: "GET", path: `/api/oauth/organizations/${org}/sync/github/auth`, headers: minted, status: HTTP_STATUS.ok, body: { is_authenticated: false } },
      { host: "platform.claude.com", method: "GET", path: "/api/anything/else", headers: minted, status: HTTP_STATUS.notFound },
    ];
    for (const via of ["redirect", "tunnel"] as const) {
      for (const call of calls) {
        const socket = await openSelfHosted(via, call.host);
        const answered = await requestOn(socket, rawRequest(call.method, call.path, call.headers, call.method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) : undefined));
        socket.destroy();
        expect(answered.statusLine, `${via} ${call.path}`).toContain(String(call.status));
        if (call.body !== undefined) {
          expect(JSON.parse(answered.body)).toEqual(call.body);
        }
      }
      // A websocket upgrade of the mode's (the artifacts sync socket presents its token as a subprotocol, not an Authorization header) is refused before any dial.
      const upgradeSocket = await openSelfHosted(via, CONNECT_INTERCEPT_HOST);
      const upgrade = await requestOn(upgradeSocket, rawRequest("GET", "/api/frame/sync?slug=s&vn=passive", { Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Protocol": "frame-sync.v1" }).replace("Connection: close", "Connection: Upgrade"));
      upgradeSocket.destroy();
      expect(upgrade.statusLine, via).toContain("404");
      expect(upstreamDials, via).toEqual([]);
    }

    // The control: a native launch's tunnel on the same host is forwarded exactly as with the mode off, which is what proves the recorder above could have gone red.
    const nativeSocket = await connectThroughProxy(connectHandle.port, CONNECT_INTERCEPT_HOST, ca.certPem, NATIVE_CAPABILITY);
    const native = await requestOn(nativeSocket, rawRequest("GET", "/api/claude_code_grove", { Authorization: "Bearer sk-ant-oat2" }));
    nativeSocket.destroy();
    expect(native.statusLine).toContain(String(FORWARDED_STATUS));
    expect(upstreamDials).toEqual(["forward GET /api/claude_code_grove"]);
  }, TEST_TIMEOUT_MS);

  it("decides by the launch a tunnel belongs to, never by the credential a request presents", async () => {
    upstreamDials.length = 0;
    // A self-hosted launch's request presenting a credential the door no longer mints (a re-mint since the session began) is still the mode's, through its own tunnel and through the redirect alike.
    const stale = { Authorization: "Bearer sk-ant-REDACTED" };
    const selfHostedTunnel = await connectThroughProxy(connectHandle.port, CONNECT_INTERCEPT_HOST, ca.certPem, SELF_HOSTED_CAPABILITY);
    expect((await requestOn(selfHostedTunnel, rawRequest("GET", "/api/claude_code_grove", stale))).statusLine).toContain(String(HTTP_STATUS.notFound));
    selfHostedTunnel.destroy();
    const redirected = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    expect((await requestOn(redirected, rawRequest("GET", "/v1/mcp_servers", stale))).statusLine).toContain(String(HTTP_STATUS.ok));
    redirected.destroy();
    expect(upstreamDials).toEqual([]);

    // A native launch's credential-less call on the API host reaches the real host exactly as sent; its control-plane session (its token refresh included) is the byte tap, covered by its own case.
    const nativeApi = await connectThroughProxy(connectHandle.port, CONNECT_INTERCEPT_HOST, ca.certPem, NATIVE_CAPABILITY);
    expect((await requestOn(nativeApi, rawRequest("GET", "/mcp-registry/v0/servers?limit=1", {}))).statusLine).toContain(String(FORWARDED_STATUS));
    nativeApi.destroy();
    expect(upstreamDials).toEqual(["forward GET /mcp-registry/v0/servers?limit=1"]);
  }, TEST_TIMEOUT_MS);

  it("forwards a native peer's redirected calls exactly as sent, its token refresh with its body intact, and answers a self-hosted peer's locally", async () => {
    upstreamDials.length = 0;
    const nativeRefreshBody = JSON.stringify({ grant_type: "refresh_token", refresh_token: "native-refresh-token", client_id: "native-client" });
    const received: Buffer[] = [];
    const standIn = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk);
      });
    });
    await new Promise<void>((resolve) => {
      standIn.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const standInAddress = standIn.address();
    if (standInAddress === null || typeof standInAddress === "string") {
      throw new Error("the stand-in reported no port");
    }
    redirectedPeerIsSelfHosted = false;
    tapStandIn = { port: standInAddress.port };
    try {
      // A native peer's control-plane session is the byte tap, as with the mode off: its token refresh reaches the (stand-in) real host exactly as the client sent it, body and all.
      const refreshSocket = await connectRedirected(transparentPort, "platform.claude.com", ca.certPem);
      const refreshRequest = rawRequest("POST", "/v1/oauth/token", { "Content-Type": "application/json" }, nativeRefreshBody);
      refreshSocket.write(refreshRequest);
      await waitUntil(() => Buffer.concat(received).toString("utf8") === refreshRequest);
      refreshSocket.destroy();
      const directorySocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
      expect((await requestOn(directorySocket, rawRequest("GET", "/mcp-registry/v0/servers", {}))).statusLine).toContain(String(FORWARDED_STATUS));
      directorySocket.destroy();
    } finally {
      redirectedPeerIsSelfHosted = true;
      tapStandIn = undefined;
      standIn.close();
    }
    expect(upstreamDials).toEqual(["tls platform.claude.com", "forward GET /mcp-registry/v0/servers"]);
    const selfHosted = await connectRedirected(transparentPort, "platform.claude.com", ca.certPem);
    const minted = await requestOn(selfHosted, rawRequest("POST", "/v1/oauth/token", { "Content-Type": "application/json" }, JSON.stringify({ grant_type: "refresh_token", refresh_token: RECORD.refreshToken })));
    selfHosted.destroy();
    expect(JSON.parse(minted.body)).toMatchObject({ access_token: MINTED_OAUTH_TOKEN });
    expect(upstreamDials).toHaveLength(2);
  }, TEST_TIMEOUT_MS);

  it("taps a native launch's control-plane session byte for byte, and parses only a self-hosted launch's", async () => {
    upstreamDials.length = 0;
    const native = await connectThroughProxy(connectHandle.port, "platform.claude.com", ca.certPem, NATIVE_CAPABILITY);
    native.write("GET /api/organizations HTTP/1.1\r\nHost: platform.claude.com\r\n\r\n");
    await waitUntil(() => upstreamDials.length > 0);
    native.destroy();
    // A tap dials the real host over TLS and pumps bytes; a parsed session would have forwarded the request.
    expect(upstreamDials).toEqual(["tls platform.claude.com"]);
    upstreamDials.length = 0;
    const selfHosted = await connectThroughProxy(connectHandle.port, "platform.claude.com", ca.certPem, SELF_HOSTED_CAPABILITY);
    expect((await requestOn(selfHosted, rawRequest("GET", "/api/organizations", {}))).statusLine).toContain(String(HTTP_STATUS.notFound));
    selfHosted.destroy();
    expect(upstreamDials).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("refuses every upgrade of a self-hosted session whatever it presents, and relays a native launch's", async () => {
    upstreamDials.length = 0;
    const upgradeHeaders = { Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" };
    const upgradeRequest = (headers: Readonly<Record<string, string>>): string => rawRequest("GET", "/api/frame/sync?slug=s", { ...upgradeHeaders, ...headers }).replace("Connection: close", "Connection: Upgrade");
    const presentations: readonly Readonly<Record<string, string>>[] = [{ Authorization: `Bearer ${MINTED_OAUTH_TOKEN}` }, { Authorization: "Bearer sk-ant-oat2" }, { "x-api-key": "sk-ant-api", "Sec-WebSocket-Protocol": `frame-sync.v1, ${MINTED_OAUTH_TOKEN}` }];
    for (const presented of presentations) {
      const socket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
      expect((await requestOn(socket, upgradeRequest(presented))).statusLine).toContain(String(HTTP_STATUS.notFound));
      socket.destroy();
    }
    expect(upstreamDials).toEqual([]);
    const native = await connectThroughProxy(connectHandle.port, CONNECT_INTERCEPT_HOST, ca.certPem, NATIVE_CAPABILITY);
    native.write(upgradeRequest({ Authorization: "Bearer sk-ant-oat2" }));
    await waitUntil(() => upstreamDials.length > 0);
    native.destroy();
    expect(upstreamDials).toEqual([`tls ${CONNECT_INTERCEPT_HOST}`]);
  }, TEST_TIMEOUT_MS);

  it("refuses a self-hosted launch's blind tunnel to any host the door does not serve, Anthropic's included, and tunnels a native launch's", async () => {
    upstreamDials.length = 0;
    for (const host of ["downloads.claude.ai", "mcp-proxy.anthropic.com", "statsig.anthropic.com", "raw.githubusercontent.com"]) {
      const attempt = rawAttempt(connectHandle.port, connectHead(host, [proxyAuthorizationFor(SELF_HOSTED_CAPABILITY)]));
      expect((await attempt.answer).split("\r\n")[0], host).toContain("403");
      attempt.socket.destroy();
    }
    expect(upstreamDials).toEqual([]);
    const native = rawAttempt(connectHandle.port, connectHead("downloads.claude.ai", [proxyAuthorizationFor(NATIVE_CAPABILITY)]));
    await waitUntil(() => upstreamDials.length > 0);
    native.socket.destroy();
    expect(upstreamDials).toEqual(["tcp downloads.claude.ai"]);
  }, TEST_TIMEOUT_MS);

  it("serves the worker's web-fetch proxy through the transparent surface with the door's own dial, redirect and all", async () => {
    // The fetch target: a loopback stand-in whose first hop redirects, so the whole walk (mount, auth, bounds check, redirect, read, answer) runs against real sockets.
    const standIn = http.createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(HTTP_FOUND, { location: "/final" });
        response.end();
        return;
      }
      response.writeHead(HTTP_STATUS.ok, { "content-type": "text/html" });
      response.end("<html><body>the rig stand-in page</body></html>");
    });
    await new Promise<void>((resolve) => {
      standIn.listen(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    const standInPort = (standIn.address() as { port: number }).port;

    const createSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const created = await requestOn(createSocket, rawRequest("POST", "/v1/code/sessions", { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json" }, JSON.stringify({ title: "webfetch", bridge: {} })));
    expect(created.statusLine).toContain("200");
    const sessionId = (JSON.parse(created.body) as { session: { id: string } }).session.id;
    createSocket.destroy();
    await waitUntil(() => tracker.list().some((session) => session.id === sessionId));

    const bridgeSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const bridged = await requestOn(bridgeSocket, rawRequest("POST", `/v1/code/sessions/${sessionId}/bridge`, { Authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "Content-Type": "application/json" }, "{}"));
    const bridge = JSON.parse(bridged.body) as { worker_jwt: string };
    bridgeSocket.destroy();

    // The request the 2.1.289 client sends: the worker JWT as its bearer, the protocol's version header, and one url in the body.
    const fetchSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const fetched = await requestOn(fetchSocket, rawRequest("POST", `/v1/code/sessions/${sessionId}/worker/web-fetch`, { Authorization: `Bearer ${bridge.worker_jwt}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }, JSON.stringify({ url: `http://127.0.0.1:${String(standInPort)}/start` })));
    expect(fetched.statusLine).toContain("200");
    expect(JSON.parse(fetched.body)).toEqual({ url: `http://127.0.0.1:${String(standInPort)}/start`, destination_url: `http://127.0.0.1:${String(standInPort)}/final`, text: "<html><body>the rig stand-in page</body></html>", content_type: "text/html" });
    fetchSocket.destroy();

    // The scheme gate is live in the same served path: a scheme the proxy does not dial is answered as the target refusal, never fetched.
    const refuseSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const refused = await requestOn(refuseSocket, rawRequest("POST", `/v1/code/sessions/${sessionId}/worker/web-fetch`, { Authorization: `Bearer ${bridge.worker_jwt}`, "Content-Type": "application/json" }, JSON.stringify({ url: "ftp://127.0.0.1/etc" })));
    expect(refused.statusLine).toContain("200");
    expect((JSON.parse(refused.body) as { error: { error_type: string } }).error.error_type).toBe("web_fetch_scheme");
    refuseSocket.destroy();

    // The persisted-record journey the released-code proof drives (ExaDev/agent-shim#264): the credential the tracker observed for the create is the whole header value, scheme word included, and replaying it verbatim authenticates the web proxy, while prefixing the scheme word onto it doubles the word and is refused naming exactly that.
    const observed = tracker.credentialOf(sessionId);
    if (observed?.authorization === undefined) {
      throw new Error("the tracker observed no OAuth-kind credential for the created session");
    }
    const persistedSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const persistedFetch = await requestOn(persistedSocket, rawRequest("POST", `/v1/code/sessions/${sessionId}/worker/web-fetch`, { Authorization: observed.authorization, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }, JSON.stringify({ url: `http://127.0.0.1:${String(standInPort)}/persisted` })));
    expect(persistedFetch.statusLine).toContain("200");
    expect(JSON.parse(persistedFetch.body)).toEqual({ url: `http://127.0.0.1:${String(standInPort)}/persisted`, destination_url: `http://127.0.0.1:${String(standInPort)}/persisted`, text: "<html><body>the rig stand-in page</body></html>", content_type: "text/html" });
    persistedSocket.destroy();
    const doubledSocket = await connectRedirected(transparentPort, CONNECT_INTERCEPT_HOST, ca.certPem);
    const doubled = await requestOn(doubledSocket, rawRequest("POST", `/v1/code/sessions/${sessionId}/worker/web-fetch`, { Authorization: `Bearer ${observed.authorization}`, "Content-Type": "application/json" }, JSON.stringify({ url: `http://127.0.0.1:${String(standInPort)}/never-fetched` })));
    expect(doubled.statusLine).toContain("401");
    expect((JSON.parse(doubled.body) as { error: { message: string } }).error.message).toContain("carried it twice");
    doubledSocket.destroy();

    await new Promise<void>((resolve) => {
      standIn.close(() => {
        resolve(undefined);
      });
      standIn.closeAllConnections();
    });
  }, TEST_TIMEOUT_MS);
});

/** Wraps the real connect effects so every upstream dial is recorded, and the two that would reach a real host by name (a relayed upgrade's TLS dial, a blind tunnel's TCP dial) are refused instead of made: nothing in this world may reach the network. */
function recordingUpstreamDials(effects: ConnectEffects): ConnectEffects {
  return {
    ...effects,
    // A forward is recorded and answered here, never dialled: the stand-in answers FORWARDED_STATUS with the body exactly as the forwarding would have sent it upstream.
    forwardHttp: (_target, request, response) => {
      upstreamDials.push(`forward ${request.method ?? "?"} ${request.url ?? "?"}`);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        const forwarded = Buffer.concat(chunks);
        response.writeHead(FORWARDED_STATUS, { "content-length": String(forwarded.length) });
        response.end(forwarded);
      });
    },
    connectTlsUpstream: async (host) => {
      upstreamDials.push(`tls ${host}`);
      const standIn = tapStandIn;
      if (standIn === undefined) {
        throw new Error(`the e2e world dials no real host, and ${host} was asked for`);
      }
      return await new Promise<net.Socket>((resolve) => {
        const socket = net.connect(standIn.port, "127.0.0.1", () => {
          resolve(socket);
        });
      });
    },
    connectTcp: async (host) => {
      upstreamDials.push(`tcp ${host}`);
      return Promise.reject(new Error(`the e2e world dials no real host, and ${host} was asked for`));
    },
  };
}

/** Whether one envelope's payload is a plain JSON object, the narrowing every payload assertion in the verbs test reads through. */
function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A uuid sequence unique per call, for stable ids in assertions. */
function randomUuidSequence(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(UUID_TAIL_WIDTH, "0")}`;
  };
}

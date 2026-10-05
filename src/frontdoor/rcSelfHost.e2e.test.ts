import https from "node:https";
import net from "node:net";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";

import { createCodexRoutePorts } from "../codex/commands";
import { realFsPort } from "../realPorts";
import { resolveLayoutPaths } from "../paths";
import { fakeCredentials } from "../test-helpers";
import { createDoorPipelines } from "./assembly";
import { createCredentialCustody } from "./custody";
import { CONNECT_INTERCEPT_HOST, CONNECT_INTERCEPT_HOSTS, CONNECT_TAP_HOSTS, createLeafCache, generateCa, startConnectServer, type CaMaterial } from "./connect";
import { lateRcEventDial, lateRcStreamDial, realConnectEffects, type RcDialTarget } from "./connectEffects";
import { createProviderRouteResolver } from "./providerRoute";
import { serveRouted } from "./pipeline";
import { observingRoutedRoute, createRcSessionTracker, answerRcControlRequest, injectRcUserMessage, type RcSessionTracker } from "./rcSessions";
import { createRcSelfHostSurface, type RcSelfHostCredentialRecord } from "./rcSelfHost";
import { createRcEventFanout, createRcStreamHub, type RcStreamHub } from "./rcStream";
import { connectRedirected, KEYGEN_TIMEOUT_MS, requestOn, TEST_CAPABILITY } from "./connectTestWorld";

/**
 * The end-to-end proof of the self-hosted Remote Control mode, against the real assembly the door runs: the connect surface with its transparent listener, the real admission and pipeline, the route resolution that hands the Remote Control family to the served surface, the observation wrapper that feeds the tracker, and the door's own client half (the stream attachment and the inject and answer writes) dialling the door's own transparent surface exactly as the mode wires it. A fake CLI (a raw TLS client through the redirect, speaking the protocol the 2.1.289 rig pinned) creates, bridges, registers, streams and writes; the door's client half consumes and controls. No upstream exists anywhere in the world, which is the point: nothing leaves the machine.
 */

/** A short fake bearer of the OAuth kind (kept short of the redaction filter's eight-character suffix on purpose). */
const MINTED_OAUTH_TOKEN = "sk-ant-oat1";
const RECORD: RcSelfHostCredentialRecord = { accessToken: MINTED_OAUTH_TOKEN, refreshToken: "selfhost-refresh", organizationUuid: "11111111-1111-4111-8111-111111111111", accountUuid: "22222222-2222-4222-8222-222222222222" };

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

/** A stand-in for the echo server unmatched piped paths would reach; the e2e never sends one, and the pointer exists so a stray request fails loudly instead of dialling the network. */
let echoPort = 0;

describe("the self-hosted Remote Control mode end to end", () => {
  let ca: CaMaterial;
  let surface: ReturnType<typeof createRcSelfHostSurface>;
  let tracker: RcSessionTracker;
  let hub: RcStreamHub;
  let connectHandle: Awaited<ReturnType<typeof startConnectServer>>;
  let transparentPort: number;
  let dialTarget: RcDialTarget | undefined;
  /** The door's own client-half write dial, resolved per call at the door's own surface, exactly the production wiring. */
  let writeDial: ReturnType<typeof lateRcEventDial>;

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
    });
    tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: 45_000 });
    const fanout = createRcEventFanout();
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
    const resolver = createProviderRouteResolver({
      fs: realFsPort,
      providersDir: resolveLayoutPaths().providersDir,
      codexPorts: createCodexRoutePorts(() => undefined, resolveLayoutPaths().chatgptSignInFile),
      directPort: () => 0,
      env: {},
      credentials: fakeCredentials(),
      rcSelfHostRoute: surface.route,
    });
    const observingResolver = async (request: Parameters<typeof resolver>[0]) => {
      const resolution = await resolver(request);
      return resolution.ok ? { ok: true as const, route: observingRoutedRoute(resolution.route, tracker, { onExchangeSettled: () => { hub.reconcile(); } }) } : resolution;
    };
    const pipelines = createDoorPipelines({
      resolveRoute: observingResolver,
      isLiveToken: (token) => token === TEST_CAPABILITY,
      responseObservers: [],
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
        isLiveCapability: (token) => token === TEST_CAPABILITY,
        transparentPort: 0,
        transparentCapability: TEST_CAPABILITY,
        limits: { headDeadlineMs: 10_000, maxPendingHeads: 64, maxTunnels: 1024, revalidateMs: 1_000 },
      },
      realConnectEffects(),
      undefined,
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
    const putWorker = await requestOn(registerSocket, rawRequest("PUT", `/v1/code/sessions/${sessionId}/worker`, { Authorization: `Bearer ${bridge.worker_jwt}`, "Content-Type": "application/json" }, JSON.stringify({ worker_status: "idle", worker_epoch: 1, external_metadata: { pending_action: null, task_summary: null } })));
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

    // The door answers the request: the control_response write is served and delivered back to the worker.
    const answered = await answerRcControlRequest({ credentialOf: tracker.credentialOf, pendingOf: (id) => tracker.pendingOf(id), completePending: tracker.completePending, noteSequenceNums: tracker.noteSequenceNums, dial: writeDial }, sessionId, "req-1", { approve: true, message: undefined });
    expect(answered.ok).toBe(true);
    if (!answered.ok) {
      throw new Error(answered.message);
    }
    await waitForFrames(workerStream, (frames) => frames.some((frame) => frame.includes("control_response")));
    const response = envelopesOf(workerStream).find((event) => (event.envelope.payload as Record<string, unknown>).type === "control_response");
    expect(((response?.envelope.payload as Record<string, unknown>).response as Record<string, unknown>).request_id).toBe("req-1");
    expect(tracker.pendingOf(sessionId).map((request) => request.requestId)).not.toContain("req-1");

    workerStream.destroy();
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
});

/** A uuid sequence unique per call, for stable ids in assertions. */
function randomUuidSequence(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(UUID_TAIL_WIDTH, "0")}`;
  };
}

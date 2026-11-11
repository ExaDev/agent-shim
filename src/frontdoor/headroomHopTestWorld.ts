import { randomUUID } from "node:crypto";
import { type HeadroomDecision } from "./headroomDecision";
import fs from "node:fs";
import http from "node:http";
import { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Agent } from "undici";
import { afterEach, beforeAll, beforeEach } from "vitest";
import type { CodexRoutePorts } from "../codex/route";
import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, fakeResponse, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { headroomSocketPath, type HeadroomSocketTarget } from "../headroom/socket";
import { writeHeadroomState } from "../headroom/state";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { realFarmFs, realHeadroomSocketTrust } from "../realPorts";
import { FAKE_HOME, fakeAsyncCredentials, fakeFs, followsLaunchFlag, launchOf, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createDoorPipelines } from "./assembly";
import { headroomSocketTarget } from "./status";
import { LOOPBACK_LEAF_NAMES, generateCa, mintLeaf, type CaMaterial, type LeafCert } from "./connect";
import { createCredentialCustody } from "./custody";
import type { ResponseObserver } from "./pipeline";
import { serveRouted } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { realCatalogueFetch } from "../realCatalogueRefresh";
import { createFrontDoorServer, listenFrontDoor } from "./server";

export const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
/** Enough time for the pure-JS 2048-bit keypairs this file generates once. */
export const KEYGEN_TIMEOUT_MS = 120_000;
/** This door generation's hop secret in these tests. */
export const HOP_SECRET = "hop-secret-for-tests";
/** A made-up provider credential: what must reach the provider's upstream and nothing in between. */
export const PROVIDER_TOKEN = "made-up-provider-token";
/** Made-up credentials a client presents at the door, which the route must replace with the provider file's own before anything leaves the machine. */
export const CLIENT_PRESENTED_BEARER = "client-presented-bearer";
export const CLIENT_PRESENTED_KEY = "client-presented-key";
export const SETTLE_MS = 50;
/** How long a routed request through the hop may take before the test calls it hung. */
export const HOP_ROUTED_TIMEOUT_MS = 5_000;
export const MESSAGES_BODY = JSON.stringify({ model: "claude-sonnet-4-5", stream: false, messages: [{ role: "user", content: "hi" }], metadata: { user_id: "user-a" } });
/** The pid the fake headroom's supervisor generation is recorded under, which names its socket. */
export const SUPERVISOR_PID = 4242;
/** The mode headroom creates its socket with. */
const HEADROOM_SOCKET_MODE = 0o600;
/** A socket directory mode every user can enter: what the door must refuse. */
export const WORLD_DIR_MODE = 0o755;
/** The server-sent events a streaming fake headroom answers with, sent one at a time. */
export const STREAM_EVENTS = ["event: message_start\ndata: {\"type\":\"message_start\"}\n\n", "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"] as const;
/** The per-launch capability token the door's client-facing listeners accept in these tests. */
export const LAUNCH_TOKEN = "launch-token-for-tests";
const TEXT_TURN = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.output_item.done", output_index: 0 },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 9, output_tokens: 2 } } },
];

/** One request the fake headroom received, body included. */
export interface HopSeen {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/**
 * The fake headroom: records each request it is handed, optionally holds it (so a test can act while the hop is live), then forwards it the way the real daemon does. Standing in for the real daemon is exactly this much: a forwarding hop keyed by the per-request base URL.
 */
export async function fakeHeadroom(options: { readonly hold?: () => Promise<void>; readonly responseHeaders?: http.OutgoingHttpHeaders } = {}): Promise<{ readonly seen: () => readonly HopSeen[]; readonly closedRequests: () => number; readonly close: () => Promise<void> }> {
  const requests: HopSeen[] = [];
  let closedRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      // The door's own readiness probe: answered like the daemon's health endpoint and not counted among the requests it was asked to compress.
      response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "healthy", ready: true }));
      return;
    }
    request.on("close", () => {
      closedRequests += 1;
    });
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: { ...request.headers }, body });
      void (options.hold?.() ?? Promise.resolve()).then(() => {
        if (options.responseHeaders !== undefined) {
      // Stands in for the direct pipeline's own head (which the real relay forwards verbatim): a test can put the door's internal model-choice header on it exactly as the direct pipeline would.
      forwardLikeHeadroom(request, response, body, options.responseHeaders);
    } else {
      forwardLikeHeadroom(request, response, body);
    }
      });
    });
  });
  await listenOnHeadroomSocket(server);
  return {
    seen: () => requests,
    closedRequests: () => closedRequests,
    close: async () => {
      await closeServer(server);
    },
  };
}

/** What the real daemon does with a request once its work is done: strip its own x-headroom-* controls and forward to the per-request base URL, or answer from its default upstream when none was named. Every other header, credentials included, goes on verbatim, which is what the custody design relies on. */
function forwardLikeHeadroom(request: http.IncomingMessage, response: http.ServerResponse, body: string, extraResponseHeaders: http.OutgoingHttpHeaders = {}): void {
  const base = request.headers["x-headroom-base-url"];
  if (base === undefined) {
    // No per-request upstream: the real daemon's default is Claude Code's API, which the test stands in for directly.
    response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json", ...extraResponseHeaders });
    response.end(JSON.stringify({ via: "default-upstream", body }));
    return;
  }
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!name.startsWith("x-headroom-")) {
      headers[name] = value;
    }
  }
  const forward = http.request(`${String(base)}${request.url ?? ""}`, { method: request.method, headers: { ...headers, host: new URL(String(base)).host } }, (upstream) => {
    response.writeHead(upstream.statusCode ?? HTTP_STATUS.badGateway, { ...upstream.headers, ...extraResponseHeaders });
    upstream.pipe(response);
  });
  forward.on("error", () => {
    response.writeHead(HTTP_STATUS.badGateway);
    response.end("forward failed");
  });
  forward.end(body);
}

const servers: http.Server[] = [];

export async function listen(server: http.Server): Promise<void> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

/**
 * A throwaway agent-shim root on the real filesystem, laid out exactly as the supervisor lays it out: the socket directory created mode 0700, and this generation's socket path inside it. Real, because the door's socket checks are `lstat`s of real paths, and the hop under test is the production one from state file to `socketPath`.
 */
export interface HeadroomHome {
  readonly paths: LayoutPaths;
  readonly socketPath: string;
  /** Records the daemon as serving on its socket, the way the supervisor does once `/readyz` has answered. */
  readonly recordServing: () => void;
  /** The production resolution the door runs on every hop: read the state file, then authenticate the socket it names. */
  readonly target: () => HeadroomSocketTarget | undefined;
}

export let home: HeadroomHome;
const homeRoots: string[] = [];

function makeHeadroomHome(): HeadroomHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "as-hop-"));
  homeRoots.push(root);
  const paths = buildLayoutPaths(root);
  realFarmFs.mkdirPrivate(paths.headroomSocketDir);
  const socketPath = headroomSocketPath(paths, SUPERVISOR_PID);
  return {
    paths,
    socketPath,
    recordServing: () => {
      writeHeadroomState(realFarmFs, paths.headroomStateFile, { supervisorPid: SUPERVISOR_PID, headroomPid: SUPERVISOR_PID + 1, socketPath });
    },
    target: () => headroomSocketTarget(realFarmFs, realHeadroomSocketTrust, paths),
  };
}

beforeEach(() => {
  home = makeHeadroomHome();
});

/** Serves `server` on this test's headroom socket and records it as the serving daemon. */
export async function listenOnHeadroomSocket(server: http.Server): Promise<void> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(home.socketPath, resolve);
  });
  // Node creates the socket under the process umask; headroom creates its own owner-only, and that is the socket the door is checked against.
  fs.chmodSync(home.socketPath, HEADROOM_SOCKET_MODE);
  home.recordServing();
}

export function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no TCP address");
  }
  return (address satisfies AddressInfo).port;
}

export async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve(undefined);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await closeServer(server);
    }),
  );
  for (const root of homeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The trust every request to the door's TLS provider listener is made with: agent-shim's CA alone, as a routed child's NODE_EXTRA_CA_CERTS gives it. */
let ca: CaMaterial;
let leaf: LeafCert;
export let trusting: Agent;

beforeAll(() => {
  ca = generateCa(new Date());
  leaf = mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date());
  trusting = new Agent({ connect: { ca: ca.certPem } });
}, KEYGEN_TIMEOUT_MS);

/**
 * The whole door assembly over a fake headroom, built from the production `createDoorPipelines`: the TLS provider listener (with the hop and launch admission) and the plain-HTTP direct listener (without the hop, admitting only the hop's own requests), sharing one resolver whose in-process routes name the direct address and one credential custody.
 */
export async function startDoor(options: { readonly record?: ReturnType<typeof mainLoopRoutesOfLiveSessions>; readonly files: Record<string, unknown>; readonly log?: (line: string) => void; readonly headroomDecision?: HeadroomDecision; readonly responseObservers?: readonly ResponseObserver[] }): Promise<{ readonly url: string; readonly close: () => Promise<void>; readonly directPort: () => number }> {
  const upstream = recordingFetch(() => fakeResponse({ events: TEXT_TURN }));
  const ports: Omit<CodexRoutePorts, "loadProvider"> = {
    upstreams: sameUpstreamForEveryLogin({ fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }),
    writeUsageSnapshot: () => undefined,
    now: () => 0,
    log: () => undefined,
  };
  let directPort = 0;
  const resolveRoute = createProviderRouteResolver({ log: () => undefined, now: () => 0, mainLoopRoutes: options.record ?? mainLoopRoutesOfLiveSessions(), catalogueFetch: realCatalogueFetch, fs: fakeFs(options.files), providersDir: PROVIDERS_DIR, codexPorts: ports, directPort: () => directPort, env: {}, credentials: fakeAsyncCredentials() });
  const log = options.log ?? ((): void => undefined);
  const pipelines = createDoorPipelines({
    resolveRoute,
    canonicalProvider: (name) => name,
    isLiveToken: (token) => token === LAUNCH_TOKEN,
    identityOfToken: () => undefined,
    launchOfToken: (token) => (token === LAUNCH_TOKEN ? launchOf(token) : undefined),
    headroomSocket: home.target,
    hopSecret: HOP_SECRET,
    custody: createCredentialCustody(() => randomUUID()),
    headroomDecision: options.headroomDecision ?? followsLaunchFlag, responseObservers: options.responseObservers ?? [],
    now: () => 0,
    log,
  });
  const direct = createFrontDoorServer(async (request) => {
    await serveRouted(request, pipelines.direct);
  }, log);
  const directHandle = await listenFrontDoor(direct);
  directPort = directHandle.port;
  const main = createFrontDoorServer(
    async (request) => {
      await serveRouted(request, pipelines.clientFacing);
    },
    log,
    leaf,
  );
  const mainHandle = await listenFrontDoor(main, { ca: ca.certPem });
  return {
    url: `https://127.0.0.1:${String(mainHandle.port)}`,
    close: async () => {
      await mainHandle.close();
      await directHandle.close();
    },
    directPort: () => directPort,
  };
}

/** A fake http provider upstream recording every request it receives, headers included. */
export async function fakeProviderUpstream(): Promise<{ readonly port: number; readonly seen: () => readonly HopSeen[] }> {
  const requests: HopSeen[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: { ...request.headers }, body });
      response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await listen(server);
  return { port: portOf(server), seen: () => requests };
}

/** An http provider file pointing at a local upstream, whose credential block carries the token the door must attach at the route. */
export function httpProvider(upstreamPort: number): Record<string, unknown> {
  return { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstreamPort)}`, credential: { sources: [{ literal: PROVIDER_TOKEN }] } };
}

/** An http provider whose routes send every sonnet request to the codex provider, which makes the routing layer read the request's body before it is served. */
export const ROUTER_TO_CODEX = { kind: "http", displayName: "Router", baseUrl: "http://127.0.0.1:9", credential: { sources: [{ literal: "router-token" }] }, routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*sonnet.*" } }, provider: "codex" }] };
export const codexProvider = { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } };

/** Lets the event loop turn once, so an unwanted background request would have landed in the recorder. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}


import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, fetch } from "undici";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CodexRoutePorts } from "../codex/route";
import { HTTP_STATUS } from "../codex/http";
import { fakeAuth, fakeResponse, recordingFetch } from "../codex/testing";
import { FAKE_HOME, fakeFs } from "../test-helpers";
import { createDoorPipelines } from "./assembly";
import { LOOPBACK_LEAF_NAMES, generateCa, mintLeaf, type CaMaterial, type LeafCert } from "./connect";
import { SEQUESTERED_CREDENTIAL, createCredentialCustody } from "./custody";
import { AUTH_HEADER, HEADROOM_FLAG_HEADER, HOP_ID_HEADER, HOP_SECRET_HEADER, IDENTITY_HEADER, SESSION_HEADER } from "./route";
import { serveRouted } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { createFrontDoorServer, listenFrontDoor } from "./server";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
/** Enough time for the pure-JS 2048-bit keypairs this file generates once. */
const KEYGEN_TIMEOUT_MS = 120_000;
/** This door generation's hop secret in these tests. */
const HOP_SECRET = "hop-secret-for-tests";
/** A made-up provider credential: what must reach the provider's upstream and nothing in between. */
const PROVIDER_TOKEN = "made-up-provider-token";
const SETTLE_MS = 50;
const MESSAGES_BODY = JSON.stringify({ model: "claude-sonnet-4-5", stream: false, messages: [{ role: "user", content: "hi" }], metadata: { user_id: "user-a" } });
/** The per-launch capability token the door's client-facing listeners accept in these tests. */
const LAUNCH_TOKEN = "launch-token-for-tests";
const TEXT_TURN = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.output_item.done", output_index: 0 },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 9, output_tokens: 2 } } },
];

/** One request the fake headroom received, body included. */
interface HopSeen {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/**
 * The fake headroom: records each request it is handed, optionally holds it (so a test can act while the hop is live), then forwards it the way the real daemon does. Standing in for the real daemon is exactly this much: a forwarding hop keyed by the per-request base URL.
 */
async function fakeHeadroom(options: { readonly hold?: () => Promise<void> } = {}): Promise<{ readonly seen: () => readonly HopSeen[]; readonly port: () => number; readonly closedRequests: () => number; readonly close: () => Promise<void> }> {
  const requests: HopSeen[] = [];
  let closedRequests = 0;
  const server = http.createServer((request, response) => {
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
        forwardLikeHeadroom(request, response, body);
      });
    });
  });
  await listen(server);
  return {
    seen: () => requests,
    port: () => portOf(server),
    closedRequests: () => closedRequests,
    close: async () => {
      await closeServer(server);
    },
  };
}

/** What the real daemon does with a request once its work is done: strip its own x-headroom-* controls and forward to the per-request base URL, or answer from its default upstream when none was named. Every other header, credentials included, goes on verbatim, which is what the custody design relies on. */
function forwardLikeHeadroom(request: http.IncomingMessage, response: http.ServerResponse, body: string): void {
  const base = request.headers["x-headroom-base-url"];
  if (base === undefined) {
    // No per-request upstream: the real daemon's default is Claude Code's API, which the test stands in for directly.
    response.writeHead(HTTP_STATUS.ok, { "content-type": "application/json" });
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
    response.writeHead(upstream.statusCode ?? HTTP_STATUS.badGateway, upstream.headers);
    upstream.pipe(response);
  });
  forward.on("error", () => {
    response.writeHead(HTTP_STATUS.badGateway);
    response.end("forward failed");
  });
  forward.end(body);
}

const servers: http.Server[] = [];

async function listen(server: http.Server): Promise<void> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no TCP address");
  }
  return (address satisfies AddressInfo).port;
}

async function closeServer(server: http.Server): Promise<void> {
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
});

/** The trust every request to the door's TLS provider listener is made with: agent-shim's CA alone, as a routed child's NODE_EXTRA_CA_CERTS gives it. */
let ca: CaMaterial;
let leaf: LeafCert;
let trusting: Agent;

beforeAll(() => {
  ca = generateCa(new Date());
  leaf = mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date());
  trusting = new Agent({ connect: { ca: ca.certPem } });
}, KEYGEN_TIMEOUT_MS);

/**
 * The whole door assembly over a fake headroom, built from the production `createDoorPipelines`: the TLS provider listener (with the hop and launch admission) and the plain-HTTP direct listener (without the hop, admitting only the hop's own requests), sharing one resolver whose in-process routes name the direct address and one credential custody.
 */
async function startDoor(options: { readonly files: Record<string, unknown>; readonly headroomPort: () => number | undefined; readonly log?: (line: string) => void }): Promise<{ readonly url: string; readonly close: () => Promise<void>; readonly directPort: () => number }> {
  const upstream = recordingFetch(() => fakeResponse({ events: TEXT_TURN }));
  const ports: Omit<CodexRoutePorts, "loadProvider"> = {
    upstream: { fetch: upstream.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" },
    writeUsageSnapshot: () => undefined,
    now: () => 0,
    log: () => undefined,
  };
  let directPort = 0;
  const resolveRoute = createProviderRouteResolver({ fs: fakeFs(options.files), providersDir: PROVIDERS_DIR, codexPorts: ports, directPort: () => directPort });
  const log = options.log ?? ((): void => undefined);
  const pipelines = createDoorPipelines({
    resolveRoute,
    isLiveToken: (token) => token === LAUNCH_TOKEN,
    headroomPort: options.headroomPort,
    hopSecret: HOP_SECRET,
    custody: createCredentialCustody(() => randomUUID()),
    responseObservers: [],
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
async function fakeProviderUpstream(): Promise<{ readonly port: number; readonly seen: () => readonly HopSeen[] }> {
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

/** An http provider file pointing at a local upstream. */
function httpProvider(upstreamPort: number): Record<string, unknown> {
  return { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstreamPort)}`, credential: { sources: [{ literal: "unused-here" }] } };
}

const codexProvider = { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } };

/** Lets the event loop turn once, so an unwanted background request would have landed in the recorder. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

describe("the headroom hop", () => {
  it("sits before the translator: headroom receives the Anthropic-shaped request, and the translator serves what headroom forwards back through the direct listener", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomPort: headroom.port });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting,
        method: "POST",
        headers: { "content-type": "application/json", [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN },
        body: MESSAGES_BODY,
      });
      if (response.status !== HTTP_STATUS.ok) {
        throw new Error(`door answered ${String(response.status)}: ${await response.text()}`);
      }
      const body = (await response.json()) as { readonly content?: readonly { readonly text?: string }[] };
      expect(body.content?.[0]?.text).toBe("Hello");
      // Exactly one headroom request, exactly one codex upstream call: the loop through the direct listener cannot double-apply anything.
      expect(headroom.seen()).toHaveLength(1);
      const seen = headroom.seen()[0];
      expect(seen?.url).toBe("/providers/codex/v1/messages");
      expect(JSON.parse(seen?.body ?? "{}")).toMatchObject({ model: "claude-sonnet-4-5" });
      expect(seen?.headers["x-headroom-base-url"]).toBe(`http://127.0.0.1:${String(door.directPort())}`);
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it("re-sets the project identity on the hop and forwards no session header to it, or beyond", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomPort: headroom.port });
    try {
      await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting,
        method: "POST",
        headers: { "content-type": "application/json", [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-1", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN, "x-headroom-project-id": "/repo" },
        body: MESSAGES_BODY,
      });
      const seen = headroom.seen()[0];
      expect(seen?.headers["x-headroom-project-id"]).toBe("/repo");
      expect(seen?.headers[IDENTITY_HEADER]).toBeUndefined();
      expect(seen?.headers[SESSION_HEADER]).toBeUndefined();
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it("answers 502 rather than bypassing headroom while the daemon is between restarts", async () => {
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomPort: () => undefined });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    } finally {
      await door.close();
    }
  });

  it("aborts the hop the moment the client disconnects, which is what cancels the daemon's request", async () => {
    // This headroom never answers: it holds the request open, so the only way the test ends is the client's abort unwinding the hop.
    const server = http.createServer(() => undefined);
    await listen(server);
    const holdingPort = portOf(server);
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomPort: () => holdingPort });
    try {
      const abort = new AbortController();
      const pending = fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY, signal: abort.signal });
      await new Promise((resolve) => {
        setTimeout(resolve, SETTLE_MS);
      });
      abort.abort();
      await pending.then(
        () => undefined,
        () => undefined,
      );
    } finally {
      await door.close();
      await closeServer(server);
    }
  });

  it("does not log the hop's own cancellation as a failure when the client disconnects", async () => {
    const server = http.createServer(() => undefined);
    await listen(server);
    const logged: string[] = [];
    const door = await startDoor({
      files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider },
      headroomPort: () => portOf(server),
      log: (line) => {
        logged.push(line);
      },
    });
    try {
      const abort = new AbortController();
      const pending = fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY, signal: abort.signal });
      await new Promise((resolve) => {
        setTimeout(resolve, SETTLE_MS);
      });
      abort.abort();
      await pending.then(
        () => undefined,
        () => undefined,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, SETTLE_MS);
      });
      expect(logged.filter((line) => line.includes("headroom hop"))).toEqual([]);
    } finally {
      await door.close();
      await closeServer(server);
    }
  });

  it("logs a hop that fails while the client is still waiting, naming the request and that no response had started", async () => {
    const dead = http.createServer();
    await listen(dead);
    const deadPort = portOf(dead);
    await closeServer(dead);
    const logged: string[] = [];
    const door = await startDoor({
      files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider },
      headroomPort: () => deadPort,
      log: (line) => {
        logged.push(line);
      },
    });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.badGateway);
      const failures = logged.filter((line) => line.includes("headroom hop"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("POST /providers/codex/v1/messages");
      expect(failures[0]).toContain("before the response started");
    } finally {
      await door.close();
    }
  });

  it("logs a daemon that drops the connection after it started answering, but not a client that went away", async () => {
    const dropping = http.createServer((_request, response) => {
      response.writeHead(HTTP_STATUS.ok, { "content-type": "text/event-stream", "transfer-encoding": "chunked" });
      response.write("event: ping\n\n");
      setTimeout(() => {
        response.destroy();
      }, SETTLE_MS);
    });
    await listen(dropping);
    const logged: string[] = [];
    const door = await startDoor({
      files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider },
      headroomPort: () => portOf(dropping),
      log: (line) => {
        logged.push(line);
      },
    });
    try {
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      await response.text().then(
        () => undefined,
        () => undefined,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, SETTLE_MS);
      });
      const failures = logged.filter((line) => line.includes("ended mid-stream"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("POST /providers/codex/v1/messages");
    } finally {
      await door.close();
      await closeServer(dropping);
    }
  });

  it("serves a headroom-ineligible or flag-less session directly, never through the hop", async () => {
    const headroom = await fakeHeadroom();
    const door = await startDoor({ files: { [`${PROVIDERS_DIR}/codex.json`]: codexProvider }, headroomPort: headroom.port });
    try {
      // No headroom flag header: the session never asked for the hop, so the door serves the route itself.
      const response = await fetch(`${door.url}/providers/codex/v1/messages`, {
        dispatcher: trusting, method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: LAUNCH_TOKEN }, body: MESSAGES_BODY });
      expect(response.status).toBe(HTTP_STATUS.ok);
      await settle();
      expect(headroom.seen()).toHaveLength(0);
    } finally {
      await door.close();
      await headroom.close();
    }
  });

  it(
    "keeps an http provider's credential away from headroom: headroom sees only placeholders and a hop id, and the provider's upstream receives the credential the client sent",
    async () => {
      const upstream = await fakeProviderUpstream();
      const headroom = await fakeHeadroom();
      const door = await startDoor({ files: { [`${PROVIDERS_DIR}/z.json`]: httpProvider(upstream.port) }, headroomPort: headroom.port });
      try {
        const base = { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN };
        const bearer = await fetch(`${door.url}/providers/z/v1/messages`, { dispatcher: trusting, method: "POST", headers: { ...base, authorization: `Bearer ${PROVIDER_TOKEN}` }, body: MESSAGES_BODY });
        expect(bearer.status).toBe(HTTP_STATUS.ok);
        const apiKey = await fetch(`${door.url}/providers/z/v1/messages`, { dispatcher: trusting, method: "POST", headers: { ...base, "x-api-key": PROVIDER_TOKEN }, body: MESSAGES_BODY });
        expect(apiKey.status).toBe(HTTP_STATUS.ok);

        const [bearerHop, apiKeyHop] = headroom.seen();
        expect(bearerHop?.headers.authorization).toBe(`Bearer ${SEQUESTERED_CREDENTIAL}`);
        expect(apiKeyHop?.headers["x-api-key"]).toBe(SEQUESTERED_CREDENTIAL);
        for (const seen of headroom.seen()) {
          expect(JSON.stringify(seen.headers)).not.toContain(PROVIDER_TOKEN);
          expect(seen.headers[HOP_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
        }
        expect(bearerHop?.headers[HOP_ID_HEADER]).not.toBe(apiKeyHop?.headers[HOP_ID_HEADER]);

        const [bearerUpstream, apiKeyUpstream] = upstream.seen();
        expect(bearerUpstream?.headers.authorization).toBe(`Bearer ${PROVIDER_TOKEN}`);
        expect(apiKeyUpstream?.headers["x-api-key"]).toBe(PROVIDER_TOKEN);
        expect(apiKeyUpstream?.headers.authorization).toBeUndefined();
        expect(bearerUpstream?.url).toBe("/v1/messages");
        // Nothing of the door's own machinery reaches the provider.
        for (const seen of upstream.seen()) {
          expect(seen.headers[HOP_ID_HEADER]).toBeUndefined();
          expect(seen.headers[HOP_SECRET_HEADER]).toBeUndefined();
          expect(JSON.stringify(seen.headers)).not.toContain(SEQUESTERED_CREDENTIAL);
        }
      } finally {
        await door.close();
        await headroom.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "admits on the direct listener only a live hop id for its own provider with this generation's secret, and never a reused one",
    async () => {
      const upstream = await fakeProviderUpstream();
      let releaseHop: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        releaseHop = resolve;
      });
      const headroom = await fakeHeadroom({ hold: async () => { await held; } });
      const door = await startDoor({ files: { [`${PROVIDERS_DIR}/z.json`]: httpProvider(upstream.port), [`${PROVIDERS_DIR}/other.json`]: httpProvider(upstream.port) }, headroomPort: headroom.port });
      const direct = async (path: string, headers: Readonly<Record<string, string>>): Promise<number> =>
        (await fetch(`http://127.0.0.1:${String(door.directPort())}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: MESSAGES_BODY })).status;
      try {
        const client = fetch(`${door.url}/providers/z/v1/messages`, {
          dispatcher: trusting,
          method: "POST",
          headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN, authorization: `Bearer ${PROVIDER_TOKEN}` },
          body: MESSAGES_BODY,
        });
        while (headroom.seen().length === 0) {
          await settle();
        }
        const hopId = String(headroom.seen()[0]?.headers[HOP_ID_HEADER]);

        // While the hop is live: an unknown id, the wrong secret, and the right id for another provider all fail before any route runs.
        expect(await direct("/providers/z/v1/messages", { [HOP_SECRET_HEADER]: HOP_SECRET, [HOP_ID_HEADER]: randomUUID() })).toBe(HTTP_STATUS.unauthorized);
        expect(await direct("/providers/z/v1/messages", { [HOP_SECRET_HEADER]: "not-this-generation", [HOP_ID_HEADER]: hopId })).toBe(HTTP_STATUS.unauthorized);
        expect(await direct("/providers/other/v1/messages", { [HOP_SECRET_HEADER]: HOP_SECRET, [HOP_ID_HEADER]: hopId })).toBe(HTTP_STATUS.unauthorized);
        expect(await direct("/providers/z/v1/messages", { [HOP_SECRET_HEADER]: HOP_SECRET })).toBe(HTTP_STATUS.unauthorized);
        expect(upstream.seen()).toHaveLength(0);

        releaseHop();
        expect((await client).status).toBe(HTTP_STATUS.ok);
        expect(upstream.seen()).toHaveLength(1);

        // The hop has ended: its id redeems nothing any more, even with the right secret and provider.
        expect(await direct("/providers/z/v1/messages", { [HOP_SECRET_HEADER]: HOP_SECRET, [HOP_ID_HEADER]: hopId })).toBe(HTTP_STATUS.unauthorized);
        expect(upstream.seen()).toHaveLength(1);
      } finally {
        releaseHop();
        await door.close();
        await headroom.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );

  it(
    "leaves an OAuth session's bearer untouched on the hop, since headroom forwards it straight to Claude Code's API and never back to the door",
    async () => {
      const headroom = await fakeHeadroom();
      const door = await startDoor({ files: {}, headroomPort: headroom.port });
      try {
        const response = await fetch(`${door.url}/v1/messages`, {
          dispatcher: trusting,
          method: "POST",
          headers: { "content-type": "application/json", [HEADROOM_FLAG_HEADER]: "1", [AUTH_HEADER]: LAUNCH_TOKEN, authorization: "Bearer made-up-oauth-token" },
          body: MESSAGES_BODY,
        });
        expect(response.status).toBe(HTTP_STATUS.ok);
        expect(headroom.seen()[0]?.headers.authorization).toBe("Bearer made-up-oauth-token");
        expect(headroom.seen()[0]?.headers[HOP_ID_HEADER]).toBeUndefined();
      } finally {
        await door.close();
        await headroom.close();
      }
    },
    KEYGEN_TIMEOUT_MS,
  );
});

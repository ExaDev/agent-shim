import http from "node:http";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { serveRouted } from "./pipeline";
import { RC_SELF_HOST_KEEPALIVE_MS, createRcSelfHostSurface, type RcSelfHostCredentialRecord, type RcWebSearchBackend } from "./rcSelfHost";
import { RC_WEB_FETCH_MAX_BYTES, type RcWebFetchOutcome, type RcWebFetcher } from "./rcWebFetch";
import { mintRcSelfHostCredential, readRcSelfHostRecord } from "./rcSelfHostMint";
import { createFakeFarmFs } from "../test-helpers";

/**
 * The self-hosted Remote Control surface's own semantics, driven over real loopback HTTP through the same `serveRouted` the door hands routes to: envelope shape, one sequence space per session, the two streams' delivery rules, resume, the epoch refusal, the local answers, and the minting's file shapes. The end-to-end assembly (door, tracker, client half, transparent surface) is `rcSelfHost.e2e.test.ts`'s.
 */

/** Where the fake clock starts: any fixed epoch instant, far enough from zero that a computed ISO date never surprises. */
const CLOCK_START_MS = 1_000_000;

/** The width of a UUID's final hyphen-separated group, so minted test ids carry the shape the protocol validates. */
const UUID_TAIL_WIDTH = 12;

/** How long a frame poll waits between checks: loopback delivery is sub-millisecond, so this is generous rather than tuned. */
const POLL_WAIT_MS = 10;

/** How long a stream delivery is given to arrive before the assertions read the collected frames. */
const DELIVERY_SETTLE_MS = 50;

/** The statuses the shared enum does not name, mirrored from the surface's own constants so the assertions read the status they mean. */
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** Headroom past the keepalive cadence for the timer's own tick, on the test timeout of the keepalive case: one whole extra cadence. */
const KEEPALIVE_TEST_TIMEOUT_MS = RC_SELF_HOST_KEEPALIVE_MS * 2;

/** How many times a frame poll re-checks before giving up: at the poll wait's cadence this is seconds of budget, far past loopback delivery. */
const FRAME_POLL_ATTEMPTS = 200;

/** Where the minting test's clock starts: any fixed epoch instant. */
const MINT_CLOCK_START_MS = 1_700_000_000_000;

/** The owner-only mode the minted files must carry, the same mode the credential store's own test asserts. */
const PRIVATE_FILE_MODE = 0o600;

/** The guard every parsed-answer narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short fake bearer of the OAuth kind: kept short of the redaction filter's eight-character suffix on purpose (see the repo's secret-filter notes). */
const MINTED_OAUTH_TOKEN = "sk-ant-oat1";
const REFRESH_TOKEN = "selfhost-refresh";
/** The fixed record the surface authenticates against, standing in for a mint. */
const RECORD: RcSelfHostCredentialRecord = { accessToken: MINTED_OAUTH_TOKEN, refreshToken: REFRESH_TOKEN, organizationUuid: "11111111-1111-4111-8111-111111111111", accountUuid: "22222222-2222-4222-8222-222222222222" };

/** A controllable clock, so retention and resume windows are reached without waiting. */
class FakeClock {
  private nowMs = CLOCK_START_MS;
  readonly now = (): number => this.nowMs;
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

interface TestWorld {
  readonly clock: FakeClock;
  readonly surface: ReturnType<typeof createRcSelfHostSurface>;
  readonly server: http.Server;
  readonly port: number;
  /** The URLs the injected fetch was asked for, in arrival order. */
  readonly fetchedUrls: string[];
  readonly close: () => Promise<void>;
}

/** The fixed outcome the injected fetch answers with unless a test overrides it: a stand-in fetched page. */
const FETCHED_PAGE: RcWebFetchOutcome = { kind: "fetched", url: "", destinationUrl: "", contentType: "text/html", text: "<html><body>the stand-in page</body></html>" };

/** Builds the surface behind a real loopback HTTP server wired through `serveRouted`, exactly the way the door serves a resolved route. Pass `null` for "no minted credential", and a fetch or search backend to control the web proxies' answers. */
async function makeWorld(record: RcSelfHostCredentialRecord | null = RECORD, options: Readonly<{ webFetch?: RcWebFetcher; webSearch?: RcWebSearchBackend }> = {}): Promise<TestWorld> {
  const held: RcSelfHostCredentialRecord | undefined = record ?? undefined;
  const clock = new FakeClock();
  const fetchedUrls: string[] = [];
  const webFetch: RcWebFetcher = options.webFetch ?? (async (url) => {
    fetchedUrls.push(url);
    return await Promise.resolve({ ...FETCHED_PAGE, url, destinationUrl: url });
  });
  const surface = createRcSelfHostSurface({
    now: clock.now,
    newUuid: (() => {
      let next = 0;
      return () => {
        next += 1;
        return `00000000-0000-4000-8000-${String(next).padStart(UUID_TAIL_WIDTH, "0")}`;
      };
    })(),
    randomToken: () => "random-token-material",
    credentialRecord: () => held,
    webFetch,
    ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
  });
  const server = http.createServer((request, response) => {
    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) {
        abort.abort();
      }
    });
    void serveRouted(
      { method: request.method ?? "GET", url: request.url ?? "/", headers: request.headers, body: request, signal: abort.signal, response },
      { resolveRoute: async () => await Promise.resolve({ ok: true, route: surface.route } as const), responseObservers: [], admit: () => ({ ok: true, headers: { ...request.headers } }), now: clock.now, log: () => undefined },
    ).catch(() => {
      if (!response.headersSent) {
        response.writeHead(HTTP_STATUS.internalServerError);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("expected a bound server");
  }
  return {
    clock,
    surface,
    server,
    port: address.port,
    fetchedUrls,
    close: async () => {
      surface.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    },
  };
}

/** One plain JSON answer from the surface. */
async function call(port: number, method: string, path: string, body?: unknown, headers: Readonly<Record<string, string>> = {}): Promise<{ readonly status: number; readonly body: string; readonly headers: http.IncomingHttpHeaders }> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { ...(text === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }), ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers });
        });
      },
    );
    request.once("error", reject);
    request.end(text ?? "");
  });
}

/** One open SSE stream, collecting whatever arrives frame by frame. */
class SseStream {
  readonly frames: string[] = [];
  // Assigned inside the promise executor, which TypeScript cannot see as definite and cannot prove non-readonly, hence the assertion.
  private server!: http.ClientRequest;
  private readonly opened: Promise<http.IncomingMessage>;
  constructor(port: number, path: string, headers: Readonly<Record<string, string>>) {
    this.opened = new Promise((resolve, reject) => {
      this.server = http.request({ host: "127.0.0.1", port, method: "GET", path, headers: { accept: "text/event-stream", ...headers } }, (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          const parts = chunk.split("\n\n");
          for (const part of parts) {
            if (part !== "") {
              this.frames.push(part);
            }
          }
        });
        resolve(response);
      });
      this.server.once("error", reject);
      this.server.end();
    });
  }

  readonly response = async (): Promise<http.IncomingMessage> => await this.opened;

  /** Waits until at least `count` event frames (keepalive comments excluded) have arrived. */
  readonly waitForEvents = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < FRAME_POLL_ATTEMPTS; attempt += 1) {
      if (this.frames.filter((frame) => frame.startsWith("event:")).length >= count) {
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POLL_WAIT_MS);
      });
    }
    throw new Error(`only ${String(this.frames.length)} frames arrived, waiting for ${String(count)} events`);
  };

  readonly close = (): void => {
    this.server.destroy();
  };
}

/** The parsed envelopes of a stream's event frames, in arrival order. */
function envelopesOf(stream: SseStream): { readonly envelope: Record<string, unknown>; readonly id: string }[] {
  return stream.frames
    .filter((frame) => frame.startsWith("event: client_event"))
    .map((frame) => {
      const id = /^id: (.+)$/m.exec(frame)?.[1] ?? "";
      const data = /^data: (.+)$/m.exec(frame)?.[1] ?? "{}";
      return { envelope: JSON.parse(data) as Record<string, unknown>, id };
    });
}

/** Creates one session and returns its id and minted worker credential. */
async function createSession(world: TestWorld): Promise<{ readonly id: string; readonly workerJwt: string }> {
  const created = await call(world.port, "POST", "/v1/code/sessions", { title: "test", bridge: {} }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
  expect(created.status).toBe(HTTP_STATUS.ok);
  const id = (JSON.parse(created.body) as { session: { id: string } }).session.id;
  expect(id.startsWith("cse_")).toBe(true);
  const bridged = await call(world.port, "POST", `/v1/code/sessions/${id}/bridge`, {}, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
  expect(bridged.status).toBe(HTTP_STATUS.ok);
  const bridge = JSON.parse(bridged.body) as { worker_jwt: string; expires_in: number; api_base_url: string; worker_epoch: number };
  expect(bridge.api_base_url).toBe("https://api.anthropic.com");
  expect(bridge.worker_epoch).toBe(1);
  expect(typeof bridge.expires_in).toBe("number");
  return { id, workerJwt: bridge.worker_jwt };
}

const worlds: TestWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.close();
  }
});

describe("the self-hosted Remote Control session family", () => {
  it("creates a session for the minted credential and refuses every other bearer", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const refused = await call(world.port, "POST", "/v1/code/sessions", { bridge: {} }, { authorization: "Bearer something-else" });
    expect(refused.status).toBe(HTTP_STATUS.unauthorized);
    const anonymous = await call(world.port, "POST", "/v1/code/sessions", { bridge: {} });
    expect(anonymous.status).toBe(HTTP_STATUS.unauthorized);
    const created = await call(world.port, "POST", "/v1/code/sessions", { title: "rig", bridge: {} }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
    expect(created.status).toBe(HTTP_STATUS.ok);
    const session = (JSON.parse(created.body) as { session: { id: string; title: string } }).session;
    expect(session.id.startsWith("cse_")).toBe(true);
    expect(session.title).toBe("rig");
  });

  it("refuses every authenticated call while no credential was minted", async () => {
    const world = await makeWorld(null);
    worlds.push(world);
    const created = await call(world.port, "POST", "/v1/code/sessions", { bridge: {} }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
    expect(created.status).toBe(HTTP_SERVICE_UNAVAILABLE);
  });

  it("serves worker operations only to the JWT its own bridge minted", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { id, workerJwt } = await createSession(world);
    const withOauth = await call(world.port, "PUT", `/v1/code/sessions/${id}/worker`, { worker_status: "running", worker_epoch: 1 }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
    expect(withOauth.status).toBe(HTTP_STATUS.unauthorized);
    const registered = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/register`, {}, { authorization: `Bearer ${workerJwt}` });
    expect(registered.status).toBe(HTTP_STATUS.ok);
    expect((JSON.parse(registered.body) as { worker_epoch: number }).worker_epoch).toBe(1);
    const state = await call(world.port, "PUT", `/v1/code/sessions/${id}/worker`, { worker_status: "running", worker_epoch: 1, external_metadata: { task_summary: null } }, { authorization: `Bearer ${workerJwt}` });
    expect(state.status).toBe(HTTP_STATUS.ok);
    const read = await call(world.port, "GET", `/v1/code/sessions/${id}/worker`, undefined, { authorization: `Bearer ${workerJwt}` });
    expect(read.status).toBe(HTTP_STATUS.ok);
    expect((JSON.parse(read.body) as { worker: { external_metadata: Record<string, unknown> } }).worker.external_metadata).toEqual({ task_summary: null });
    const beat = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/heartbeat`, { session_id: id, worker_epoch: 1, idle_seconds: 3 }, { authorization: `Bearer ${workerJwt}` });
    expect(beat.status).toBe(HTTP_STATUS.ok);
  });

  it("answers a stale worker epoch with the protocol's own conflict status and header", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { id, workerJwt } = await createSession(world);
    const stale = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/events`, { worker_epoch: 2, events: [{ payload: { type: "assistant" } }] }, { authorization: `Bearer ${workerJwt}` });
    expect(stale.status).toBe(HTTP_CONFLICT);
    expect(stale.headers["x-ccr-conflict-reason"]).toBe("epoch_stale");
  });

  it("numbers every event in one sequence space whatever half wrote it, and marks a repeated payload uuid duplicate", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { id, workerJwt } = await createSession(world);
    const workerWrite = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/events`, { worker_epoch: 1, events: [{ payload: { type: "assistant", uuid: "aaa" } }] }, { authorization: `Bearer ${workerJwt}` });
    expect(workerWrite.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(workerWrite.body)).toEqual({ results: [{ event_id: "aaa", sequence_num: "1" }] });
    const clientWrite = await call(world.port, "POST", `/v1/code/sessions/${id}/events`, { events: [{ payload: { type: "user", uuid: "bbb" } }] }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
    expect(clientWrite.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(clientWrite.body)).toEqual({ results: [{ sequence_num: "2", duplicate: false }] });
    const repeated = await call(world.port, "POST", `/v1/code/sessions/${id}/events`, { events: [{ payload: { type: "user", uuid: "bbb" } }] }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
    expect(JSON.parse(repeated.body)).toEqual({ results: [{ sequence_num: "3", duplicate: true }] });
  });

  it("refuses a batch that is not the protocol's shape", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { id, workerJwt } = await createSession(world);
    const empty = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/events`, { worker_epoch: 1, events: [] }, { authorization: `Bearer ${workerJwt}` });
    expect(empty.status).toBe(HTTP_STATUS.badRequest);
    const malformed = await call(world.port, "POST", `/v1/code/sessions/${id}/events`, { events: ["not an event"] }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
    expect(malformed.status).toBe(HTTP_STATUS.badRequest);
  });
});

describe("the self-hosted Remote Control streams", () => {
  it("delivers client events to the worker stream and every event to the client stream, never the worker its own", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { id, workerJwt } = await createSession(world);
    const workerStream = new SseStream(world.port, `/v1/code/sessions/${id}/worker/events/stream`, { authorization: `Bearer ${workerJwt}` });
    expect((await workerStream.response()).statusCode).toBe(HTTP_STATUS.ok);
    const clientStream = new SseStream(world.port, `/v1/code/sessions/${id}/events/stream`, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
    expect((await clientStream.response()).statusCode).toBe(HTTP_STATUS.ok);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DELIVERY_SETTLE_MS);
    });

    await call(world.port, "POST", `/v1/code/sessions/${id}/worker/events`, { worker_epoch: 1, events: [{ payload: { type: "assistant", uuid: "wa" } }] }, { authorization: `Bearer ${workerJwt}` });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DELIVERY_SETTLE_MS);
    });
    // The worker's own write reached the client stream and never its own.
    expect(envelopesOf(workerStream)).toEqual([]);
    expect(envelopesOf(clientStream).map((event) => event.envelope.source)).toEqual(["worker"]);

    await call(world.port, "POST", `/v1/code/sessions/${id}/events`, { events: [{ payload: { type: "user", uuid: "cu", message: { role: "user", content: "hello" } } }] }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
    await workerStream.waitForEvents(1);
    await clientStream.waitForEvents(2);
    const workerSeen = envelopesOf(workerStream);
    expect(workerSeen.map((event) => event.envelope.event_type)).toEqual(["user"]);
    expect(workerSeen[0]?.id).toBe("2");
    expect((workerSeen[0]?.envelope.payload as Record<string, unknown>).server_received_wall_ms).toBeTypeOf("number");
    const clientSeen = envelopesOf(clientStream);
    expect(clientSeen.map((event) => event.envelope.source)).toEqual(["worker", "client"]);
    workerStream.close();
    clientStream.close();
  });

  it("resumes a reconnected stream after the named cursor, on both halves", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { id, workerJwt } = await createSession(world);
    await call(world.port, "POST", `/v1/code/sessions/${id}/worker/events`, { worker_epoch: 1, events: [{ payload: { type: "assistant", uuid: "w1" } }, { payload: { type: "assistant", uuid: "w2" } }] }, { authorization: `Bearer ${workerJwt}` });
    await call(world.port, "POST", `/v1/code/sessions/${id}/events`, { events: [{ payload: { type: "user", uuid: "c1" } }] }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
    await call(world.port, "POST", `/v1/code/sessions/${id}/events`, { events: [{ payload: { type: "user", uuid: "c2" } }] }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });

    const resumedClient = new SseStream(world.port, `/v1/code/sessions/${id}/events/stream?from_sequence_num=2`, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "last-event-id": "2" });
    await resumedClient.waitForEvents(2);
    expect(envelopesOf(resumedClient).map((event) => event.id)).toEqual(["3", "4"]);
    resumedClient.close();

    const resumedWorker = new SseStream(world.port, `/v1/code/sessions/${id}/worker/events/stream?from_sequence_num=3`, { authorization: `Bearer ${workerJwt}`, "last-event-id": "3" });
    await resumedWorker.waitForEvents(1);
    expect(envelopesOf(resumedWorker).map((event) => event.id)).toEqual(["4"]);
    resumedWorker.close();
  });

  it("keeps a quiet stream alive with comment frames at the documented cadence", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { id, workerJwt } = await createSession(world);
    const stream = new SseStream(world.port, `/v1/code/sessions/${id}/worker/events/stream`, { authorization: `Bearer ${workerJwt}` });
    expect((await stream.response()).statusCode).toBe(HTTP_STATUS.ok);
    // The keepalive interval fires on wall-clock time and the cadence is the protocol's own (15 s), so the test waits one real interval plus a tick; anything shorter would not be testing the timer.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, RC_SELF_HOST_KEEPALIVE_MS + DELIVERY_SETTLE_MS);
    });
    expect(stream.frames.some((frame) => frame.startsWith(":"))).toBe(true);
    stream.close();
  }, KEEPALIVE_TEST_TIMEOUT_MS);
});

describe("the self-hosted local answers", () => {
  it("serves the feature eval, the profile, the telemetry no-ops and the OAuth refresh echo", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const serve = world.surface.local.serve;

    // The local surface's own answers are served straight onto a ServerResponse, so every path here is exercised through a bare server the same way the connect surface calls it.
    const bare = http.createServer((request, response) => {
      void serve("api.anthropic.com", request, response).then((matched) => {
        if (!matched) {
          response.writeHead(HTTP_STATUS.notFound);
          response.end();
        }
      });
    });
    await new Promise<void>((resolve) => {
      bare.listen(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    const barePort = (bare.address() as { port: number }).port;
    const get = async (path: string): Promise<{ readonly status: number; readonly body: string }> => await call(barePort, "GET", path);
    const evalAnswer = await call(barePort, "POST", "/api/eval/sdk-anything", { attributes: {} });
    expect(evalAnswer.status).toBe(HTTP_STATUS.ok);
    expect((JSON.parse(evalAnswer.body) as { features: Record<string, unknown> }).features.tengu_ccr_bridge).toEqual({ defaultValue: true });
    // The startup token validation: a 401 here (what piping it upstream would answer) tips the CLI straight into its login flow, as the live rig run showed.
    const validated = await call(barePort, "POST", "/api/oauth/validate", null, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}` });
    expect(validated.status).toBe(HTTP_STATUS.ok);
    const validation: unknown = JSON.parse(validated.body);
    expect(isRecord(validation) && Array.isArray(validation.scopes) && validation.scopes.includes("user:inference") && validation.scopes.includes("user:profile")).toBe(true);
    expect(isRecord(validation) && validation.expiresAt).toBeNull();
    expect((await get("/api/oauth/profile")).status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse((await get("/api/oauth/profile")).body)).toMatchObject({ organization: { uuid: RECORD.organizationUuid } });
    expect((await get("/api/claude_code/policy_limits")).status).toBe(HTTP_STATUS.ok);
    expect((await get("/api/hello")).status).toBe(HTTP_STATUS.ok);
    expect((await call(barePort, "POST", "/api/event_logging/v2/batch", [{ event_name: "x" }])).status).toBe(HTTP_STATUS.ok);
    expect(await call(barePort, "GET", "/v1/messages")).toMatchObject({ status: 404 });
    await new Promise<void>((resolve) => {
      bare.close(() => {
        resolve(undefined);
      });
      bare.closeAllConnections();
    });

    const oauthServer = http.createServer((request, response) => {
      void serve("platform.claude.com", request, response).then((matched) => {
        if (!matched) {
          response.writeHead(HTTP_STATUS.notFound);
          response.end();
        }
      });
    });
    await new Promise<void>((resolve) => {
      oauthServer.listen(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    const oauthPort = (oauthServer.address() as { port: number }).port;
    const refresh = await call(oauthPort, "POST", "/v1/oauth/token", { grant_type: "refresh_token", refresh_token: REFRESH_TOKEN });
    expect(refresh.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(refresh.body)).toMatchObject({ access_token: MINTED_OAUTH_TOKEN, refresh_token: REFRESH_TOKEN });
    const otherHost = await serve("api.anthropic.com", { method: "GET", url: "/api/nothing", headers: {} } as unknown as IncomingMessage, { writeHead: () => undefined, end: () => undefined } as unknown as http.ServerResponse);
    expect(otherHost).toBe(false);
    await new Promise<void>((resolve) => {
      oauthServer.close(() => {
        resolve(undefined);
      });
      oauthServer.closeAllConnections();
    });
  });
});

describe("the self-hosted Remote Control web proxies", () => {
  it("serves the worker web-fetch: one url in, the fetched facts out, to the worker JWT and the session's own credential alike", async () => {
    const world = await makeWorld();
    worlds.push(world);
    const { id, workerJwt } = await createSession(world);
    // The CLI's proxy client presents the login bearer when it holds no worker session url (the 2.1.289 shape the rig captured), so the minted credential serves these paths beside the bridge's own JWT.
    const withOauth = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/web-fetch`, { url: "https://example.com/oauth-shape" }, { authorization: `Bearer ${MINTED_OAUTH_TOKEN}`, "anthropic-version": "2023-06-01" });
    expect(withOauth.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(withOauth.body)).toEqual({ url: "https://example.com/oauth-shape", destination_url: "https://example.com/oauth-shape", text: FETCHED_PAGE.text, content_type: "text/html" });
    const stranger = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/web-fetch`, { url: "https://example.com/page" }, { authorization: "Bearer someone-else" });
    expect(stranger.status).toBe(HTTP_STATUS.unauthorized);
    expect(world.fetchedUrls).toEqual(["https://example.com/oauth-shape"]);
    const noUrl = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/web-fetch`, {}, { authorization: `Bearer ${workerJwt}` });
    expect(noUrl.status).toBe(HTTP_STATUS.badRequest);
    const answered = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/web-fetch`, { url: "https://example.com/page" }, { authorization: `Bearer ${workerJwt}`, "anthropic-version": "2023-06-01" });
    expect(answered.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(answered.body)).toEqual({ url: "https://example.com/page", destination_url: "https://example.com/page", text: FETCHED_PAGE.text, content_type: "text/html" });
    // The fetch was handed exactly the requests' urls, in order: the wiring between the served path and the injected fetch is what the assertion pair checks.
    expect(world.fetchedUrls).toEqual(["https://example.com/oauth-shape", "https://example.com/page"]);
  });

  it("answers a web-fetch refusal as a 200 error object, the shape the CLI surfaces as the tool's own failure", async () => {
    const world = await makeWorld(RECORD, { webFetch: async () => await Promise.resolve({ kind: "refused" as const, errorType: "web_fetch_private_address", errorMessage: "refused" }) });
    worlds.push(world);
    const { id, workerJwt } = await createSession(world);
    const refused = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/web-fetch`, { url: "http://192.168.1.5/" }, { authorization: `Bearer ${workerJwt}` });
    expect(refused.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(refused.body)).toEqual({ error: { error_type: "web_fetch_private_address", error_message: "refused" } });
  });

  it("refuses a fetched page whose framed answer escapes the CLI's reader cap", async () => {
    // NUL bytes each escape to six characters of JSON, so a body under the byte cap still frames past the reader cap the answer must fit.
    const world = await makeWorld(RECORD, { webFetch: async (url) => await Promise.resolve({ kind: "fetched" as const, url, destinationUrl: url, contentType: "text/plain", text: "\u0000".repeat(RC_WEB_FETCH_MAX_BYTES) }) });
    worlds.push(world);
    const { id, workerJwt } = await createSession(world);
    const answered = await call(world.port, "POST", `/v1/code/sessions/${id}/worker/web-fetch`, { url: "https://example.com/big" }, { authorization: `Bearer ${workerJwt}` });
    expect(answered.status).toBe(HTTP_STATUS.ok);
    const error = (JSON.parse(answered.body) as { error: { error_type: string } }).error;
    expect(error.error_type).toBe("web_fetch_too_large");
  });

  it("serves the worker web-search as a clear refusal while no backend is wired, and a backend's answers when one is", async () => {
    const bare = await makeWorld();
    worlds.push(bare);
    const first = await createSession(bare);
    const refused = await call(bare.port, "POST", `/v1/code/sessions/${first.id}/worker/web-search`, { query: "the rig proof" }, { authorization: `Bearer ${first.workerJwt}` });
    expect(refused.status).toBe(HTTP_STATUS.ok);
    const refusal = JSON.parse(refused.body) as { results: unknown[]; error: { error_type: string; error_message: string } };
    expect(refusal.results).toEqual([]);
    expect(refusal.error.error_type).toBe("web_search_unavailable");
    expect(refusal.error.error_message).toContain("without a search backend");
    const noQuery = await call(bare.port, "POST", `/v1/code/sessions/${first.id}/worker/web-search`, {}, { authorization: `Bearer ${first.workerJwt}` });
    expect(noQuery.status).toBe(HTTP_STATUS.badRequest);

    const seen: { query: string; allowedDomains?: readonly string[]; blockedDomains?: readonly string[]; searchProfile?: string }[] = [];
    const world = await makeWorld(RECORD, {
      webSearch: async (request) => {
        seen.push(request);
        return await Promise.resolve([{ title: "The Rig", url: "https://rig.example/probe", snippet: "a stand-in hit" }]);
      },
    });
    worlds.push(world);
    const second = await createSession(world);
    const answered = await call(world.port, "POST", `/v1/code/sessions/${second.id}/worker/web-search`, { query: "the rig proof", allowed_domains: ["example.com"], blocked_domains: ["tracker.io"], search_profile: "deep" }, { authorization: `Bearer ${second.workerJwt}` });
    expect(answered.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(answered.body)).toEqual({ results: [{ title: "The Rig", url: "https://rig.example/probe", snippet: "a stand-in hit" }] });
    expect(seen).toEqual([{ query: "the rig proof", allowedDomains: ["example.com"], blockedDomains: ["tracker.io"], searchProfile: "deep" }]);
    const refusedBackend = await makeWorld(RECORD, { webSearch: async () => await Promise.resolve({ errorType: "search_backend_down", errorMessage: "the backend refused" }) });
    worlds.push(refusedBackend);
    const third = await createSession(refusedBackend);
    const failure = await call(refusedBackend.port, "POST", `/v1/code/sessions/${third.id}/worker/web-search`, { query: "anything" }, { authorization: `Bearer ${third.workerJwt}` });
    expect(JSON.parse(failure.body)).toEqual({ results: [], error: { error_type: "search_backend_down", error_message: "the backend refused" } });
  });
});

describe("the self-hosted credential minting", () => {
  /** Builds the minting over a fake filesystem and returns the fs with the result. */
  const mint = (fs: ReturnType<typeof createFakeFarmFs>, options: Readonly<{ identity?: string; force?: boolean }> = {}) =>
    mintRcSelfHostCredential({
      fs,
      identitiesDir: "/state/identities",
      frontdoorDir: "/state/frontdoor",
      identity: options.identity ?? "rig",
      newUuid: (() => {
        let next = 0;
        return () => {
          next += 1;
          return `00000000-0000-4000-8000-${String(next).padStart(UUID_TAIL_WIDTH, "0")}`;
        };
      })(),
      randomToken: () => "randomtokenmaterial",
      force: options.force ?? false,
      now: () => MINT_CLOCK_START_MS,
    });

  it("writes the credential, the account block and the feature seed, and the door's record", () => {
    const fs = createFakeFarmFs();
    const result = mint(fs);
    expect(result.identity).toBe("rig");
    expect(result.replaced).toBe(false);
    const credentials = JSON.parse(fs.readFileUtf8("/state/identities/rig/.credentials.json") ?? "{}") as { claudeAiOauth: Record<string, unknown> };
    // The access token is never part of any result or log the minting returns; the file's shape is what the assertions read.
    expect(String(credentials.claudeAiOauth.accessToken).startsWith("sk-ant-oat")).toBe(true);
    expect(credentials.claudeAiOauth.expiresAt).toBeNull();
    expect(credentials.claudeAiOauth.scopes).toEqual(["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"]);
    expect(credentials.claudeAiOauth.subscriptionType).toBe("max");
    const claudeJson = JSON.parse(fs.readFileUtf8("/state/identities/rig/.claude.json") ?? "{}") as { oauthAccount: Record<string, unknown>; cachedGrowthBookFeatures: Record<string, boolean> };
    expect(claudeJson.oauthAccount.organizationUuid).toBe(result.organizationUuid);
    expect(claudeJson.cachedGrowthBookFeatures).toMatchObject({ tengu_ccr_bridge: true, tengu_bridge_repl_v2: true });
    const record = readRcSelfHostRecord(fs, "/state/frontdoor");
    expect(record?.accessToken).toBe(credentials.claudeAiOauth.accessToken);
    expect(fs.modeOf("/state/identities/rig/.credentials.json")).toBe(PRIVATE_FILE_MODE);
    expect(fs.modeOf("/state/frontdoor/rc-selfhost/credential.json")).toBe(PRIVATE_FILE_MODE);
  });

  it("merges into an existing .claude.json without disturbing its other keys", () => {
    const fs = createFakeFarmFs();
    fs.mkdirp("/state/identities/rig");
    fs.writeFileUtf8("/state/identities/rig/.claude.json", JSON.stringify({ projects: { "/work": { history: ["one"] } }, cachedGrowthBookFeatures: { unrelated_flag: true } }));
    mint(fs);
    const claudeJson = JSON.parse(fs.readFileUtf8("/state/identities/rig/.claude.json") ?? "{}") as Record<string, unknown>;
    expect((claudeJson.projects as Record<string, unknown>)["/work"]).toBeDefined();
    expect((claudeJson.cachedGrowthBookFeatures as Record<string, boolean>).unrelated_flag).toBe(true);
  });

  it("refuses to replace a real login, allows replacing its own previous mint, and forces when told", () => {
    const fs = createFakeFarmFs();
    fs.mkdirp("/state/identities/rig");
    fs.writeFileUtf8("/state/identities/rig/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat2", refreshToken: "r", expiresAt: null, scopes: ["user:profile"] } }));
    expect(() => mint(fs)).toThrow("already holds an OAuth credential");
    // A forced mint overwrites the foreign credential and records itself as the door's own.
    mint(fs, { force: true });
    expect(readRcSelfHostRecord(fs, "/state/frontdoor")?.accessToken).not.toBe("sk-ant-oat2");
    // Re-minting over this door's own previous mint needs no force.
    const again = mint(fs);
    expect(again.replaced).toBe(true);
    expect(() => mint(fs, { identity: "../escape" })).toThrow("not a valid identity name");
  });
});

import http from "node:http";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { isMessagesInferencePath } from "./messagesBodyLimit";
import { launchOfSession, send, startWorld, tokenOf, type World } from "./mainLoopRouteTestWorld";
import type { MainLoopRouteRecord } from "./mainLoopRoute";
import { AUTH_HEADER, PROVIDER_HEADER, SESSION_HEADER } from "./route";

const POST_CREATED = 201;
const GET_ACCEPTED = 202;
const HANG_TIMEOUT_MS = 4000;
/** Where a chunked body is split, inside its first member, so that the door sees two chunks. */
const CHUNK_SPLIT_BYTES = 20;
const TEST_TIMEOUT_MS = 30_000;
const PROBE_HEADER = "x-probe";
const PROBE_VALUE = "kept";

/** One request the stand-in provider server received, as the wire carried it. */
interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

const upstreams: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    upstreams.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }),
  );
});

/** A provider server that records every request exactly as received and answers a status of its own (201 to a POST, 202 to anything else), so a status the door made up shows. */
async function recordingUpstream(): Promise<{ readonly port: number; readonly received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      received.push({ method: incoming.method ?? "", url: incoming.url ?? "", headers: incoming.headers, body: Buffer.concat(chunks) });
      response.writeHead(incoming.method === "POST" ? POST_CREATED : GET_ACCEPTED, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "message", model: "served", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  upstreams.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the stand-in provider has no TCP address");
  return { port: address.port, received };
}

/** A path class the door sees, with the method and body each is sent with. */
interface PathClass {
  readonly label: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  /** The body, when the request has one: JSON that names a model for the Messages requests, other JSON for the rest. */
  readonly body?: string;
  /** Whether this is a POST to a Messages endpoint, whose model the door reads and may map. */
  readonly carriesModel: boolean;
  /** The path the provider is sent when the request names it in its own path (`/providers/<name>/...`), which goes there from every session; the provider's path is then not the request's. */
  readonly scopedTo?: { readonly provider: "z"; readonly forwarded: string };
  /** The Remote Control self-host paths, which no provider serves from any session: the door's own route answers them. */
  readonly selfHost?: true;
}

const MESSAGE_BODY = JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
const BATCH_BODY = JSON.stringify({ requests: [{ custom_id: "a", params: { model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] } }] });
const CANCEL_BODY = "{}";

const PATH_CLASSES: readonly PathClass[] = [
  { label: "POST /v1/messages", method: "POST", path: "/v1/messages", body: MESSAGE_BODY, carriesModel: true },
  { label: "POST /v1/messages with a query", method: "POST", path: "/v1/messages?beta=true", body: MESSAGE_BODY, carriesModel: true },
  { label: "POST count_tokens", method: "POST", path: "/v1/messages/count_tokens", body: MESSAGE_BODY, carriesModel: true },
  { label: "POST batches", method: "POST", path: "/v1/messages/batches", body: BATCH_BODY, carriesModel: false },
  { label: "POST a trailing slash", method: "POST", path: "/v1/messages/", body: BATCH_BODY, carriesModel: false },
  { label: "POST cancel a batch", method: "POST", path: "/v1/messages/batches/abc/cancel", body: CANCEL_BODY, carriesModel: false },
  { label: "GET batches", method: "GET", path: "/v1/messages/batches?limit=2", carriesModel: false },
  { label: "GET a batch", method: "GET", path: "/v1/messages/batches/abc", carriesModel: false },
  { label: "GET batch results", method: "GET", path: "/v1/messages/batches/abc/results", carriesModel: false },
  { label: "GET /v1/messages", method: "GET", path: "/v1/messages", carriesModel: false },
  { label: "GET /v1/models", method: "GET", path: "/v1/models", carriesModel: false },
  { label: "GET /v1/organizations", method: "GET", path: "/v1/organizations/o/usage", carriesModel: false },
  { label: "POST another API path", method: "POST", path: "/v1/files", body: CANCEL_BODY, carriesModel: false },
  { label: "GET a Remote Control self-host path", method: "GET", path: "/v1/code/sessions/abc", carriesModel: false, selfHost: true },
  { label: "POST a Remote Control self-host path", method: "POST", path: "/v1/sessions", body: CANCEL_BODY, carriesModel: false, selfHost: true },
  { label: "POST a scoped provider path", method: "POST", path: "/providers/z/v1/messages", body: MESSAGE_BODY, carriesModel: true, scopedTo: { provider: "z", forwarded: "/v1/messages" } },
  { label: "POST a scoped provider batch path", method: "POST", path: "/providers/z/v1/messages/batches", body: BATCH_BODY, carriesModel: false, scopedTo: { provider: "z", forwarded: "/v1/messages/batches" } },
  { label: "GET a scoped provider batch result", method: "GET", path: "/providers/z/v1/messages/batches/abc/results", carriesModel: false, scopedTo: { provider: "z", forwarded: "/v1/messages/batches/abc/results" } },
];

/** Where a session's requests go, and how it gets there. */
interface SessionKind {
  readonly label: string;
  /** What a request of this session reaches when it is on a Messages path: the provider stand-in, or the stand-in for the Anthropic route. */
  readonly reaches: "provider" | "anthropic";
  /** Whether the session was launched on the provider, whose every request goes there, whatever its path; any other session's goes where its context says only on a Messages path, and to the Anthropic route elsewhere. */
  readonly launched?: true;
  /** The requests that put the session in its context before the request under test, as the main loop does. */
  readonly establish: (world: World) => Promise<void>;
  readonly headers: Readonly<Record<string, string>>;
}

const MAIN = { "x-claude-code-request-class": "main" } as const;
const HELPER = { "x-claude-code-request-class": "auxiliary" } as const;
const noContext = async (): Promise<void> => {
  await Promise.resolve();
};
const bySendingModel = (model: string) => async (world: World): Promise<void> => {
  await send(world, { model, requestClass: "main" });
};
const spark = (port: number): unknown => ({ displayName: "spark", baseUrl: `http://127.0.0.1:${String(port)}`, credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "spark-main" } });

const SESSION_KINDS: readonly SessionKind[] = [
  { label: "no context", reaches: "anthropic", establish: noContext, headers: MAIN },
  { label: "no context, a helper", reaches: "anthropic", establish: noContext, headers: HELPER },
  { label: "provider context chosen by a qualified name", reaches: "provider", establish: bySendingModel("z/glm-5.3"), headers: MAIN },
  { label: "provider context chosen by a bare provider name", reaches: "provider", establish: bySendingModel("spark"), headers: MAIN },
  { label: "provider context, a helper", reaches: "provider", establish: bySendingModel("z/glm-5.3"), headers: HELPER },
  { label: "provider context chosen by a selector", reaches: "provider", establish: bySendingModel("auto/z/sonnet"), headers: MAIN },
  { label: "provider context chosen by a selector, a helper", reaches: "provider", establish: bySendingModel("auto/provider:z"), headers: HELPER },
  { label: "Anthropic context after anthropic/<model>", reaches: "anthropic", establish: bySendingModel("anthropic/claude-sonnet-5-5"), headers: MAIN },
  { label: "Anthropic context, a helper", reaches: "anthropic", establish: bySendingModel("anthropic/claude-sonnet-5-5"), headers: HELPER },
  { label: "a session launched on the provider", reaches: "provider", launched: true, establish: noContext, headers: { ...MAIN, [PROVIDER_HEADER]: "z" } },
];

/** One request sent as a session's child would send it, the body streamed so that it is framed by chunks as Claude Code frames it; resolves with the answer or "hung" when it does not come. */
async function sendAs(world: World, kind: SessionKind, pathClass: PathClass, chunked: boolean): Promise<{ readonly status: number; readonly text: string } | "hung"> {
  const headers: Record<string, string> = { ...kind.headers, [AUTH_HEADER]: tokenOf("s-1"), [SESSION_HEADER]: "s-1", [PROBE_HEADER]: PROBE_VALUE, ...(pathClass.body === undefined ? {} : { "content-type": "application/json" }) };
  const request = fetch(`${world.url}${pathClass.path}`, {
    method: pathClass.method,
    headers,
    ...(pathClass.body === undefined ? {} : chunked ? { body: Readable.toWeb(Readable.from([Buffer.from(pathClass.body.slice(0, CHUNK_SPLIT_BYTES)), Buffer.from(pathClass.body.slice(CHUNK_SPLIT_BYTES))])), duplex: "half" } : { body: pathClass.body }),
  }).then(async (response) => ({ status: response.status, text: await response.text() }));
  return await Promise.race([request, new Promise<"hung">((resolve) => {
    setTimeout(() => {
      resolve("hung");
    }, HANG_TIMEOUT_MS);
  })]);
}

/** The context a launch's main loop was last recorded on, which a request that chose no route must leave as it was. */
const contextOf = (record: MainLoopRouteRecord): unknown => record.routeOf(launchOfSession("s-1"));

/**
 * Every kind of request path the door sees, from every kind of session: the request is answered and is not an internal error, a request that goes to a provider reaches it exactly as it was sent (method, path and query, a header the client set, the bytes of the body, and the framing the client used), and a request that is no Messages POST moves no session's context. A request that reaches the provider is never made into a request the door invented, which a 500 is the sign of.
 */
describe.each(SESSION_KINDS)("a request of a session with $label", (kind) => {
  describe.each(PATH_CLASSES)("sends $label", (pathClass) => {
    const reaches = pathClass.selfHost === true ? "anthropic" : pathClass.scopedTo !== undefined || (kind.reaches === "provider" && (kind.launched === true || isMessagesInferencePath(new URL(pathClass.path, "http://127.0.0.1").pathname))) ? "provider" : "anthropic";
    for (const chunked of pathClass.body === undefined ? [false] : [false, true]) {
      it(`${chunked ? "chunked" : "with a length"}: it is answered, reaches ${reaches === "provider" ? "the provider unchanged" : "the Anthropic route"}, and leaves the context`, async () => {
        const upstream = await recordingUpstream();
        const record = mainLoopRoutesOfLiveSessions();
        const world = await startWorld(record);
        try {
          world.setProvider("z", { displayName: "Z", baseUrl: `http://127.0.0.1:${String(upstream.port)}`, credential: { sources: [{ literal: "z-token" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "z-main" } });
          world.setProvider("spark", spark(upstream.port));
          await kind.establish(world);
          const before = contextOf(record);
          const reachedBefore = upstream.received.length;
          const anthropicBefore = world.toAnthropic.length;
          const answered = await sendAs(world, kind, pathClass, chunked);
          expect(answered, "the request was never answered").not.toBe("hung");
          if (answered === "hung") return;
          expect(answered.status).not.toBe(HTTP_STATUS.internalServerError);
          if (reaches === "provider") {
            expect(upstream.received).toHaveLength(reachedBefore + 1);
            const seen = upstream.received[reachedBefore];
            expect(seen?.method).toBe(pathClass.method);
            expect(seen?.url).toBe(pathClass.scopedTo?.forwarded ?? pathClass.path);
            expect(seen?.headers[PROBE_HEADER]).toBe(PROBE_VALUE);
            if (!pathClass.carriesModel) {
              expect(seen?.body.toString("utf8")).toBe(pathClass.body ?? "");
              if (pathClass.body !== undefined) expect(chunked ? seen?.headers["transfer-encoding"] : seen?.headers["content-length"]).toBe(chunked ? "chunked" : String(Buffer.byteLength(pathClass.body)));
              expect(answered.status).toBe(pathClass.method === "POST" ? POST_CREATED : GET_ACCEPTED);
            } else {
              expect(answered.status).toBe(POST_CREATED);
            }
          } else {
            expect(upstream.received).toHaveLength(reachedBefore);
            expect(world.toAnthropic).toHaveLength(anthropicBefore + 1);
            expect(answered.status).toBe(HTTP_STATUS.badGateway);
          }
          if (!pathClass.carriesModel) expect(contextOf(record)).toEqual(before);
        } finally {
          await world.close();
        }
      }, TEST_TIMEOUT_MS);
    }
  });
});

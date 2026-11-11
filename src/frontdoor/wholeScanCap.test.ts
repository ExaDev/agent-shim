import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { fakeAuth, recordingFetch, sameUpstreamForEveryLogin } from "../codex/testing";
import { FAKE_HOME, admitLaunchToken, fakeAsyncCredentials, fakeFs, followsLaunchFlag, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { bodyTooLargeMessage } from "./messagesBodyLimit";
import { serveRouted } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { AUTH_HEADER, type RoutedRequest } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";

const PROVIDERS_DIR = `${FAKE_HOME}/.agent-shim/providers`;
const TOKEN = "launch-token-for-tests";
const CAP_BYTES = 4096;
const CHUNK_BYTES = 65_536;
const CHUNKS_PAST_CAP = 512;
const REQUEST_TOO_LARGE = "request_too_large";
const TOO_LARGE_STATUS = 413;
const OK = 200;

const closers: (() => Promise<void>)[] = [];

/** A provider's upstream that counts the bytes of every request body it is sent, and answers 200. */
async function countingUpstream(): Promise<{ readonly port: number; readonly received: () => number }> {
  let received = 0;
  const server = http.createServer((incoming, response) => {
    incoming.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    incoming.on("end", () => {
      response.writeHead(OK, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  closers.push(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  });
  return { port: (server.address() as AddressInfo).port, received: () => received };
}
afterEach(async () => {
  await Promise.all(closers.splice(0).map(async (close) => { await close(); }));
});

/** A door over the resolver with its Messages body limit injected small, for a provider with or without a model rewrite among its routes: the resolver's whole-body scans are what read the body, before any provider route could. */
async function door(withRoutes: boolean, upstreamPort: number): Promise<string> {
  const stub = recordingFetch(() => {
    throw new Error("no upstream call");
  });
  const spark = { displayName: "Spark", baseUrl: `http://127.0.0.1:${String(upstreamPort)}`, credential: { sources: [{ literal: "t" }] }, ...(withRoutes ? { routes: [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*" } }, provider: "other", model: "rewritten" }] } : {}) };
  const resolve = createProviderRouteResolver({
    fs: fakeFs({ [`${PROVIDERS_DIR}/spark.json`]: spark, [`${PROVIDERS_DIR}/other.json`]: { displayName: "Other", baseUrl: `http://127.0.0.1:${String(upstreamPort)}`, credential: { sources: [{ literal: "t" }] } } }),
    providersDir: PROVIDERS_DIR,
    codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: stub.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
    directPort: () => 1,
    env: {},
    credentials: fakeAsyncCredentials(),
    log: () => undefined,
    now: () => 0,
    mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
    messagesBodyLimitBytes: CAP_BYTES,
  });
  const server = createFrontDoorServer(
    async (pipelineRequest) => {
      await serveRouted(pipelineRequest, { resolveRoute: resolve, canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: admitLaunchToken(TOKEN), now: () => 0, log: () => undefined });
    },
    () => undefined,
  );
  const handle = await listenFrontDoor(server);
  closers.push(handle.close);
  return `http://127.0.0.1:${String(handle.port)}`;
}

interface Outcome {
  readonly status: number | undefined;
  readonly type: unknown;
  readonly message: unknown;
  readonly reset: boolean;
}

/** A field of the `error` object of an Anthropic-shaped answer. */
function errorField(parsed: unknown, field: string): unknown {
  return typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "object" && parsed.error !== null && field in parsed.error ? Reflect.get(parsed.error, field) : undefined;
}

/** Uploads a body of many chunks past the limit to the door over a real socket, and reports what the client saw. */
async function upload(url: string, path: string, declareLength: boolean): Promise<Outcome & { readonly sent: number }> {
  const head = '{"model":"claude-sonnet-5-5","pad":"';
  const request = http.request(`${url}/providers/spark${path}`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: TOKEN, ...(declareLength ? { "content-length": String(head.length + CHUNK_BYTES * CHUNKS_PAST_CAP) } : { "transfer-encoding": "chunked" }) } });
  let status: number | undefined;
  let body = "";
  let finished = false;
  let written = 0;
  const outcome = new Promise<Outcome & { readonly sent: number }>((resolve) => {
    const finish = (reset: boolean): void => {
      if (!finished) {
        finished = true;
        request.destroy();
        const parsed: unknown = body === "" ? undefined : JSON.parse(body);
        resolve({ sent: head.length + CHUNK_BYTES * written, status, message: errorField(parsed, "message"), type: errorField(parsed, "type"), reset: reset && status === undefined });
      }
    };
    request.on("response", (response) => {
      status = response.statusCode;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        finish(false);
      });
    });
    request.on("error", () => {
      finish(true);
    });
  });
  request.write(head);
  const chunk = " ".repeat(CHUNK_BYTES);
  const pump = (): void => {
    while (written < CHUNKS_PAST_CAP && !finished) {
      written += 1;
      if (!request.write(chunk)) {
        request.once("drain", pump);
        return;
      }
    }
    request.end();
  };
  pump();
  return await outcome;
}

/** The paths a Messages body is read whole on, and the paths a body past the Messages limit goes through unread: a file upload and a batch have documented limits far above it and no top-level model to resolve. */
const MESSAGES_PATHS = ["/v1/messages", "/v1/messages/count_tokens"] as const;
const OTHER_PATHS = ["/v1/files", "/v1/messages/batches"] as const;

describe("the resolver's whole-body scans read a Messages body under the limit", () => {
  it.each(MESSAGES_PATHS.flatMap((path) => [[path, false, false], [path, false, true], [path, true, false], [path, true, true]] as const))("answers %s (routes: %s, declared: %s) with a 413 the client reads, never buffering the body", async (path, withRoutes, declareLength) => {
    const upstream = await countingUpstream();
    const outcome = await upload(await door(withRoutes, upstream.port), path, declareLength);
    expect(outcome.reset).toBe(false);
    expect(outcome.status).toBe(TOO_LARGE_STATUS);
    expect(outcome.type).toBe(REQUEST_TOO_LARGE);
    // The one text every site that refuses an oversize Messages body gives: the provider, the limit in bytes and MiB, and what to do (the editing wrapper's own tests pin the same builder).
    expect(outcome.message).toBe(bodyTooLargeMessage(CAP_BYTES, "spark"));
    expect(upstream.received()).toBe(0);
  });
});

describe("a body past the Messages limit on a path that is not a Messages request", () => {
  it.each(OTHER_PATHS.flatMap((path) => [[path, false, false], [path, false, true], [path, true, false], [path, true, true]] as const))("goes through %s (routes: %s, declared: %s) to the provider whole, with no 413 and no read of it beyond its head", async (path, withRoutes, declareLength) => {
    const upstream = await countingUpstream();
    const outcome = await upload(await door(withRoutes, upstream.port), path, declareLength);
    expect(outcome.reset).toBe(false);
    expect(outcome.status).toBe(OK);
    expect(upstream.received()).toBe(outcome.sent);
  });
});

const DRAIN_CHUNKS = 400;
const DRAIN_CHUNK_BYTES = 1024;
const RESOLVER_CAP_BYTES = 2048;

/** A body of `CHUNKS` chunks that counts how many it has handed out, and whether anything has read it at all. */
function countedBody(): { readonly body: Readable; readonly handedOut: () => number } {
  let handed = 0;
  const body = new Readable({
    read() {
      if (handed >= DRAIN_CHUNKS) {
        this.push(null);
        return;
      }
      handed += 1;
      this.push(Buffer.alloc(DRAIN_CHUNK_BYTES, " "));
    },
  });
  return { body, handedOut: () => handed };
}

function resolverFor(): ReturnType<typeof createProviderRouteResolver> {
  const stub = recordingFetch(() => {
    throw new Error("no upstream call");
  });
  return createProviderRouteResolver({
    fs: fakeFs({ [`${PROVIDERS_DIR}/spark.json`]: { displayName: "Spark", baseUrl: "http://127.0.0.1:1", credential: { sources: [{ literal: "t" }] } } }),
    providersDir: PROVIDERS_DIR,
    codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: stub.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
    directPort: () => 1,
    env: {},
    credentials: fakeAsyncCredentials(),
    log: () => undefined,
    now: () => 0,
    mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
    messagesBodyLimitBytes: RESOLVER_CAP_BYTES,
  });
}

function requestWith(body: Readable, headers: Readonly<Record<string, string>> = {}): RoutedRequest {
  return { method: "POST", url: "/providers/spark/v1/messages", headers, body, signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined } };
}

describe("a body past the limit the resolver's scan reads", () => {
  it("is drained to its end after the 413, so a client still uploading is not left waiting on it", async () => {
    const { body, handedOut } = countedBody();
    const resolution = await resolverFor()(requestWith(body));
    expect(resolution.ok).toBe(false);
    expect(!resolution.ok && resolution.status).toBe(TOO_LARGE_STATUS);
    await new Promise<void>((resolve) => {
      body.once("end", resolve);
      if (body.readableEnded) {
        resolve();
      }
    });
    expect(handedOut()).toBe(DRAIN_CHUNKS);
  });

  it("is refused from its declared length before the resolver's scan reads any of it", async () => {
    let read = false;
    const body = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    const resolution = await resolverFor()(requestWith(body, { "content-length": String(RESOLVER_CAP_BYTES + 1) }));
    expect(!resolution.ok && resolution.status).toBe(TOO_LARGE_STATUS);
    expect(read).toBe(false);
  });
});

/** How many characters the model a bare provider name selects has beyond the name itself, enough to take a body at the limit past it. */
const LONG_MODEL_PADDING = 64;

describe("a body the name resolution rewrote to a longer model name", () => {
  const LONG_MODEL = `chosen-${"m".repeat(LONG_MODEL_PADDING)}`;

  /** A resolver over a plain provider and one whose bare name selects a model longer than the name, with a route that reads the whole body. */
  function longerNameResolver(): ReturnType<typeof createProviderRouteResolver> {
    const stub = recordingFetch(() => {
      throw new Error("no upstream call");
    });
    const credential = { sources: [{ literal: "t" }] };
    const routes = [{ when: { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: ".*" } }, provider: "spark", model: LONG_MODEL }];
    return createProviderRouteResolver({
      fs: fakeFs({
        [`${PROVIDERS_DIR}/spark.json`]: { displayName: "Spark", baseUrl: "http://127.0.0.1:1", credential, env: { ANTHROPIC_MODEL: LONG_MODEL }, routes },
        [`${PROVIDERS_DIR}/other.json`]: { displayName: "Other", baseUrl: "http://127.0.0.1:1", credential },
      }),
      providersDir: PROVIDERS_DIR,
      codexPorts: { upstreams: sameUpstreamForEveryLogin({ fetch: stub.fetch, auth: fakeAuth(), timers: { after: () => () => undefined }, randomId: () => "random" }), writeUsageSnapshot: () => undefined, now: () => 0, log: () => undefined },
      directPort: () => 1,
      env: {},
      credentials: fakeAsyncCredentials(),
      log: () => undefined,
      now: () => 0,
      mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
      messagesBodyLimitBytes: RESOLVER_CAP_BYTES,
    });
  }

  it("is refused with the 413 when the longer name takes it past the limit, not served and not a thrown error", async () => {
    const head = '{"model":"spark","pad":"';
    const tail = '"}';
    const text = `${head}${" ".repeat(RESOLVER_CAP_BYTES - head.length - tail.length)}${tail}`;
    expect(Buffer.byteLength(text)).toBe(RESOLVER_CAP_BYTES);
    const request: RoutedRequest = { ...requestWith(Readable.from([Buffer.from(text)])), url: "/providers/other/v1/messages" };
    const resolution = await longerNameResolver()(request);
    expect(resolution.ok).toBe(false);
    expect(!resolution.ok && resolution.status).toBe(TOO_LARGE_STATUS);
  });
});

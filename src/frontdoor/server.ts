import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";

import { HTTP_STATUS } from "../codex/http";
import type { LeafCert } from "./connect";
import type { PipelineRequest } from "./pipeline";

/** How long one health probe waits before giving up: a listener that just bound answers in milliseconds, so the bound only bites when the request path itself is broken. */
const HEALTH_TIMEOUT_MS = 2_000;

/** How long the start-up probe may retry before the listener counts as broken: the server has just bound and serves nothing else, so a probe that never answers means the request path itself is broken and the generation must fail loudly. */
const HEALTH_START_BUDGET_MS = 5_000;
const HEALTH_RETRY_MS = 50;

/** A front-door listener: plain HTTP for the direct listener only headroom reaches, HTTPS for the provider listener every provider session's child connects to. */
export type FrontDoorServer = http.Server | https.Server;

/**
 * A front-door listener: the transport a routed session's requests arrive on. It turns each Node request into a `PipelineRequest` (the raw request plus an abort signal that fires the moment the client goes away before the response finished) and hands it to the pipeline; the pipeline owns identification, admission, middleware and routing.
 *
 * With `tls`, the listener serves HTTPS with that leaf, which is how the provider listener authenticates itself to the child: the leaf is signed by claude-use's CA, whose key only the owning user can read, and the only CA the child trusts for a 127.0.0.1 certificate is that one (no public CA issues certificates for a loopback address), so a process that merely binds the port cannot complete a handshake the child accepts and never receives the request (credentials and capability included). Without `tls` it serves plain HTTP, which only the direct listener does: nothing that reaches it carries a real credential (see the credential custody).
 *
 * The disconnect is read from the response's `close` event, not the request's: the request emits `close` as soon as its body has been read, long before the response ends. `GET /healthz` is answered here, before the pipeline, because a readiness probe is not a routed session and carries no session headers or capability.
 */
export function createFrontDoorServer(pipeline: (request: PipelineRequest) => Promise<void>, log: (line: string) => void, tls?: LeafCert): FrontDoorServer {
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(HTTP_STATUS.ok, { "Content-Type": "text/plain" });
      response.end("ok");
      return;
    }
    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) {
        abort.abort();
      }
    });
    const handle = async (): Promise<void> => {
      await pipeline({ method: request.method ?? "GET", url: request.url ?? "/", headers: request.headers, body: request, signal: abort.signal, response });
      // A request the route never read (an unrouted target answered by the pipeline's own error) must still be drained, or a client mid-body waits on a response it cannot see.
      if (!request.readableEnded) {
        request.resume();
      }
    };
    handle().catch((error: unknown) => {
      log(`request ${request.method ?? "?"} ${request.url ?? "?"} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      if (!response.headersSent) {
        response.writeHead(HTTP_STATUS.internalServerError, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "internal error in the claude-use front door" } }));
      } else {
        response.destroy();
      }
    });
  };
  if (tls === undefined) {
    return http.createServer(handler);
  }
  const server = https.createServer({ key: tls.keyPem, cert: tls.certPem }, handler);
  // A failed handshake (a client that does not trust the CA, or speaks no TLS) is that client's problem, not the listener's: drop the connection and keep serving.
  server.on("tlsClientError", (_error: Error, socket) => {
    socket.destroy();
  });
  return server;
}

/**
 * Probes a listener's health endpoint once: the check the supervisor's start and the tests use to know the door is actually serving, not merely bound. With `ca`, the probe speaks HTTPS and accepts only a certificate chaining to that CA for 127.0.0.1, so a healthy answer also proves who is answering; without it, plain HTTP. No capability is ever sent: the health endpoint needs none.
 */
export async function frontDoorHealthy(port: number, ca?: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const onResponse = (response: IncomingMessage): void => {
      response.resume();
      resolve(response.statusCode === HTTP_STATUS.ok);
    };
    const options = { host: "127.0.0.1", port, path: "/healthz", agent: false, timeout: HEALTH_TIMEOUT_MS };
    const request = ca === undefined ? http.get(options, onResponse) : https.get({ ...options, ca: [ca] }, onResponse);
    request.on("timeout", () => {
      request.destroy();
    });
    request.on("error", () => {
      resolve(false);
    });
  });
}

/** How a listener is bound. */
interface ListenOptions {
  /** The sticky port to try first; any free port is used when it is taken or absent. */
  readonly preferredPort?: number;
  /** Receives the actual port the moment the bind succeeds, before the health probe. */
  readonly onBound?: (port: number) => void;
  /** The CA a TLS listener's leaf chains to, so its own start-up probe verifies the handshake a child will make; omitted for a plain-HTTP listener. */
  readonly ca?: string;
  /**
   * Called for any error the listener emits once it is bound and serving. Attached only after the bind has settled: a server emits the sticky port's EADDRINUSE as an ordinary `error` event, and a handler attached before the bind would treat the fallback the bind is about to make as fatal.
   */
  readonly onError?: (error: Error) => void;
}

/**
 * Binds the listener on `preferredPort` when it is free and any free port otherwise (bind, do not probe: check-then-bind races), probing its own health endpoint before resolving.
 */
export async function listenFrontDoor(server: FrontDoorServer, options: Readonly<ListenOptions> = {}): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
  const { preferredPort, ca } = options;
  const tryListen = async (port: number): Promise<number> =>
    await new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("error", onError);
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        // A listening TCP server's address is always the object form; the string form is for pipes and unix sockets only.
        const bound = typeof address === "object" && address !== null ? address.port : 0;
        if (bound === 0) {
          reject(new Error("could not bind a loopback port"));
          return;
        }
        resolve(bound);
      });
    });
  let bound: number;
  if (preferredPort !== undefined) {
    try {
      bound = await tryListen(preferredPort);
    } catch {
      // The sticky port was taken between generations; any free port will do, and the supervisor logs the move.
      bound = await tryListen(0);
    }
  } else {
    bound = await tryListen(0);
  }
  options.onBound?.(bound);
  if (options.onError !== undefined) {
    server.on("error", options.onError);
  }
  const deadline = Date.now() + HEALTH_START_BUDGET_MS;
  for (;;) {
    if (await frontDoorHealthy(bound, ca)) {
      return {
        port: bound,
        close: async () => {
          await new Promise<void>((resolve) => {
            server.close(() => {
              resolve(undefined);
            });
            server.closeAllConnections();
          });
        },
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(`the front door listener on 127.0.0.1:${String(bound)} did not answer its health probe`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, HEALTH_RETRY_MS);
    });
  }
}

/**
 * Iterates a forwarded response's body as typed chunks. Node types the async iteration of an `IncomingMessage` as `any`, so every consumer narrows here once rather than each carrying its own assertion.
 */
export async function* upstreamChunks(stream: IncomingMessage): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      yield Buffer.from(chunk, "utf8");
      continue;
    }
    if (chunk instanceof Uint8Array) {
      yield chunk;
    }
  }
}

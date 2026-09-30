import http from "node:http";

import { HTTP_STATUS } from "../codex/http";
import type { PipelineRequest } from "./pipeline";

/** How long one health probe waits before giving up: a listener that just bound answers in milliseconds, so the bound only bites when the request path itself is broken. */
const HEALTH_TIMEOUT_MS = 2_000;

/** How long the start-up probe may retry before the listener counts as broken: the server has just bound and serves nothing else, so a probe that never answers means the request path itself is broken and the generation must fail loudly. */
const HEALTH_START_BUDGET_MS = 5_000;
const HEALTH_RETRY_MS = 50;

/**
 * The front door's plain-HTTP listener: the transport every routed session whose base URL claude-use controls points at. It turns each Node request into a `PipelineRequest` (the raw request plus an abort signal that fires the moment the client goes away before the response finished) and hands it to the pipeline; the pipeline owns identification, middleware and routing.
 *
 * The disconnect is read from the response's `close` event, not the request's: the request emits `close` as soon as its body has been read, long before the response ends. `GET /healthz` is answered here, before the pipeline, because a readiness probe is not a routed session and carries no session headers.
 */
export function createFrontDoorServer(pipeline: (request: PipelineRequest) => Promise<void>, log: (line: string) => void): http.Server {
  return http.createServer((request, response) => {
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
  });
}

/** Probes the listener's health endpoint once: the check the supervisor's start and the tests use to know the door is actually serving, not merely bound. */
export async function frontDoorHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Binds the listener on `preferredPort` when it is free and any free port otherwise (bind, do not probe: check-then-bind races), probing its own health endpoint before resolving. `onBound` receives the actual port.
 */
export async function listenFrontDoor(
  server: http.Server,
  preferredPort: number | undefined,
  onBound: (port: number) => void,
): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
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
  onBound(bound);
  const deadline = Date.now() + HEALTH_START_BUDGET_MS;
  for (;;) {
    if (await frontDoorHealthy(bound)) {
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

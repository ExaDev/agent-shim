import http from "node:http";

import { HTTP_STATUS } from "./http";
import type { RouteRequest, RouteResponse } from "./route";

/** The largest request body the listener accepts. Claude Code's requests carry whole transcripts and inline images, so the bound is generous; it exists so one runaway request cannot exhaust the daemon's memory. 64 MiB. */
const CODEX_MAX_BODY_BYTES = 67_108_864;

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("request body chunk was not a Buffer");
    }
    size += chunk.length;
    if (size > CODEX_MAX_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeResponse(response: http.ServerResponse, routed: RouteResponse): Promise<void> {
  response.writeHead(routed.status, routed.headers);
  if (typeof routed.body === "string") {
    response.end(routed.body);
    return;
  }
  for await (const chunk of routed.body) {
    if (response.destroyed) {
      return;
    }
    // Backpressure: a slow client pauses the relay, and so the upstream read, instead of buffering the whole stream in memory.
    if (!response.write(chunk)) {
      await new Promise<void>((resolve) => {
        const settle = (): void => {
          response.off("drain", settle);
          response.off("close", settle);
          resolve();
        };
        response.once("drain", settle);
        response.once("close", settle);
      });
    }
  }
  response.end();
}

/**
 * The HTTP listener adapter: turns each Node request into a `RouteRequest`, writes the `RouteResponse` back (streaming chunks as they come, with backpressure), and aborts the route's signal when the client goes away before the response finished. That abort is what cancels the upstream call for a Claude Code session that was interrupted or killed mid-stream, instead of leaving the backend generating into nowhere.
 *
 * The disconnect is read from the response's `close` event, not the request's: the request emits `close` as soon as its body has been read, long before the response ends.
 */
export function createCodexServer(route: (request: RouteRequest) => Promise<RouteResponse>, log: (line: string) => void): http.Server {
  return http.createServer((request, response) => {
    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) {
        abort.abort();
      }
    });
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const handle = async (): Promise<void> => {
      let body: string;
      try {
        body = await readBody(request);
      } catch (error) {
        const tooLarge = error instanceof BodyTooLargeError;
        response.writeHead(tooLarge ? HTTP_STATUS.payloadTooLarge : HTTP_STATUS.badRequest, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: error instanceof Error ? error.message : String(error) } }));
        request.destroy();
        return;
      }
      const routed = await route({ method: request.method ?? "GET", path, body, signal: abort.signal });
      if (abort.signal.aborted) {
        return;
      }
      await writeResponse(response, routed);
    };
    handle().catch((error: unknown) => {
      log(`request ${request.method ?? "?"} ${path} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      if (!response.headersSent) {
        response.writeHead(HTTP_STATUS.internalServerError, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "internal error in the codex translation daemon" } }));
      } else {
        response.destroy();
      }
    });
  });
}

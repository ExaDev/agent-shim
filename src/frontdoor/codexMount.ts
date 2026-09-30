import { HTTP_STATUS } from "../codex/http";
import { createCodexRoute, type CodexRoutePorts, type RouteRequest, type RouteResponse } from "../codex/route";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";

/** The largest request body the translation accepts. Claude Code's requests carry whole transcripts and inline images, so the bound is generous; it exists so one runaway request cannot exhaust the front door's memory. 64 MiB. */
const CODEX_MAX_BODY_BYTES = 67_108_864;

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

async function readBody(request: RoutedRequest): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.body) {
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

/** Writes one translated response through the routed response: the head, then the body, chunk by chunk with backpressure, stopping early once the client is gone. */
async function writeRouteResponse(routed: RouteResponse, response: RoutedResponse, signal: AbortSignal): Promise<void> {
  response.start(routed.status, routed.headers);
  if (typeof routed.body === "string") {
    await response.write(routed.body);
    response.end();
    return;
  }
  for await (const chunk of routed.body) {
    if (signal.aborted) {
      return;
    }
    await response.write(chunk);
  }
  response.end();
}

/**
 * Mounts the codex translation route (the same `createCodexRoute` the old standalone daemon served) as one front-door route. This is an adapter, not a second implementation: it reads the request body whole (the translation validates the full JSON), hands the route its transport-neutral request, and streams the route's response back with backpressure.
 *
 * `upstreamBase` is this front door's own address with the provider's path prefix, which is what a headroom hop in front of this route is told to forward to; the headroom-before-translator ordering lives in the pipeline, never here.
 */
export function createCodexRouteMount(ports: CodexRoutePorts, upstreamBase: string, provider: string): FrontDoorRoute {
  const route = createCodexRoute(ports);
  return {
    name: `codex:${provider}`,
    headroomEligible: true,
    headroomUpstream: upstreamBase,
    serve: async (request, response) => {
      let body: string;
      try {
        body = await readBody(request);
      } catch (error) {
        const tooLarge = error instanceof BodyTooLargeError;
        response.start(tooLarge ? HTTP_STATUS.payloadTooLarge : HTTP_STATUS.badRequest, { "Content-Type": "application/json" });
        await response.write(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: error instanceof Error ? error.message : String(error) } }),
        );
        response.end();
        request.body.resume();
        return;
      }
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      const translated: RouteRequest = { method: request.method, path, body, signal: request.signal };
      const routed = await route(translated);
      if (request.signal.aborted) {
        return;
      }
      await writeRouteResponse(routed, response, request.signal);
    },
  };
}

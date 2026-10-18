import { HTTP_STATUS } from "../codex/http";
import type { RouteRequest, RouteResponse } from "../codex/route";
import { createAntigravityRoute, type AntigravityRoutePorts } from "../antigravity/route";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";

const ANTIGRAVITY_MAX_BODY_BYTES = 67_108_864; // 64 MiB bound

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
    if (size > ANTIGRAVITY_MAX_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

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
 * Mounts the Antigravity translation route as one front-door route.
 */
export function createAntigravityRouteMount(ports: AntigravityRoutePorts, upstreamBase: string, provider: string): FrontDoorRoute {
  const route = createAntigravityRoute(ports);
  return {
    name: `antigravity:${provider}`,
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
      // A tier alias the translator resolved to a concrete model is a choice among this provider's lineup: recorded before the head is written so the usage middleware sees it. The candidates never leave this provider, so the provider list is exactly it.
      if (routed.requestedModel !== undefined) {
        response.noteModelChoice?.({ requested: routed.requestedModel, providers: [provider] });
      }
      await writeRouteResponse(routed, response, request.signal);
    },
  };
}

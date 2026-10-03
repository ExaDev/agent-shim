import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { forwardableHeaders } from "./connect";
import { ExemptHttpAgent, ExemptTlsAgent } from "./connectEffects";
import type { FrontDoorRoute } from "./route";
import { upstreamChunks } from "./server";

/** Everything one pass-through forwards to. */
export interface PassthroughTarget {
  /** The upstream's base URL, without a trailing slash. Its path, when it has one (`https://api.z.ai/api/anthropic`), is part of what every forwarded request is addressed to. */
  readonly baseUrl: string;
  /**
   * The path prefix the front door added that the upstream must not see: `/providers/<name>` for a provider-scoped request, absent for a bare `/v1/` request from the connect surface. The upstream receives the request exactly as it would have arrived had the child pointed at its base URL directly, base path included.
   */
  readonly stripPrefix: string | undefined;
  /** What a headroom hop in front of this route is told to forward to: the door's direct listener, whose re-resolution of the path is what strips the provider prefix the upstream must not see. */
  readonly headroomUpstream: string | undefined;
}

/**
 * Joins an upstream response's headers into the single-value shape a routed response's head takes, minus the hop-by-hop set: this process re-frames both messages, so framing headers (`transfer-encoding`, `connection` and kin) belong to whichever connection carried them and must be regenerated, never copied. A repeated header becomes one comma-joined value, which is lossless for the JSON and SSE APIs routed here.
 */
function responseHeaders(headers: Readonly<http.IncomingHttpHeaders>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(forwardableHeaders(headers))) {
    if (value === undefined) {
      continue;
    }
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

/**
 * The pass-through route: streams a request to an Anthropic-compatible upstream and the response back, never buffering a body. This is what an `http` provider's sessions ride, and what a bare `/v1/` request on the connect surface reaches when its session did not ask for headroom.
 */
export function createPassthroughRoute(name: string, target: PassthroughTarget): FrontDoorRoute {
  const base = new URL(target.baseUrl);
  const tls = base.protocol === "https:";
  const basePath = base.pathname.replace(/\/+$/, "");
  // Keep-alive so a session reusing its connection gets its forwarded requests served over reused upstream connections too, the way a direct connection would.
  const agent = tls ? new ExemptTlsAgent() : new ExemptHttpAgent();
  return {
    name,
    headroomEligible: true,
    headroomUpstream: target.headroomUpstream,
    serve: async (request, response) => {
      const incoming = new URL(request.url, "http://127.0.0.1");
      const path = target.stripPrefix !== undefined && incoming.pathname.startsWith(target.stripPrefix) ? incoming.pathname.slice(target.stripPrefix.length) : incoming.pathname;
      const headers: Record<string, string | string[] | undefined> = forwardableHeaders(request.headers);
      // The client's Host named this door; the upstream must hear its own, or an API routing by virtual host would answer for the wrong one.
      delete headers.host;
      await new Promise<void>((resolve) => {
        const options: http.RequestOptions = {
          host: base.hostname,
          port: base.port === "" ? undefined : Number(base.port),
          method: request.method,
          path: `${basePath}${path}${incoming.search}`,
          headers,
          agent,
        };
        const onUpstreamResponse = (upstreamResponse: IncomingMessage): void => {
          response.start(upstreamResponse.statusCode ?? HTTP_STATUS.badGateway, responseHeaders(upstreamResponse.headers));
          // Headers go out before the first body byte: a streaming (SSE) response must reach the client as its chunks arrive, not when it completes.
          response.flush();
          const stream = async (): Promise<void> => {
            try {
              for await (const chunk of upstreamChunks(upstreamResponse)) {
                if (request.signal.aborted) {
                  return;
                }
                await response.write(chunk);
              }
              response.end();
            } catch {
              // The client went away mid-stream, or the upstream dropped the connection: either way the response is no longer salvageable.
              response.destroy();
            }
            resolve(undefined);
          };
          void stream();
        };
        const forward = tls ? https.request(options, onUpstreamResponse) : http.request(options, onUpstreamResponse);
        forward.on("error", (error: Error) => {
          if (!response.headersSent) {
            response.start(HTTP_STATUS.badGateway, { "Content-Type": "application/json" });
            void response
              .write(JSON.stringify({ type: "error", error: { type: "api_error", message: `upstream ${target.baseUrl} unreachable (${error.message})` } }))
              .then(() => {
                response.end();
              });
          } else {
            response.destroy();
          }
          resolve(undefined);
        });
        // The client going away aborts the forward, which is what cancels the upstream's request.
        request.signal.addEventListener("abort", () => {
          forward.destroy();
        });
        request.body.pipe(forward);
        request.body.on("error", () => {
          forward.destroy();
        });
      });
    },
  };
}

import * as http from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { forwardableHeaders } from "./connect";
import { HEADROOM_BASE_URL_HEADER, PROJECT_ID_HEADER, type RoutedRequest, type RoutedResponse } from "./route";
import { upstreamChunks } from "./server";

/** What one hop answers when it cannot serve: the daemon is between restarts, or unreachable. Answering with 502 (rather than bypassing headroom) is what keeps a launch that asked for compression from silently losing it. */
const HTTP_BAD_GATEWAY = HTTP_STATUS.badGateway;

/** Everything the headroom hop depends on, injected so the pipeline's ordering tests can point it at a scripted daemon. */
export interface HeadroomHopDeps {
  /**
   * The headroom daemon's loopback port, read per request rather than captured at start-up: the daemon can crash and restart on a different port while this door keeps listening, and the hop must follow it. Undefined while the daemon is down (the restart window).
   */
  readonly headroomPort: () => number | undefined;
  readonly log: (line: string) => void;
}

/** Joins an upstream response's headers into the single-value shape a routed response's head takes; a repeated header becomes one comma-joined value, which is lossless for the JSON and SSE APIs routed here. */
function singleValueHeaders(headers: Readonly<IncomingHttpHeaders>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

/**
 * Applies the headroom hop: forwards the request, still Anthropic-shaped, to the headroom daemon as a backend hop and streams its response back to the client. The hop ALWAYS sits before the route's own serving (a translator needs the request headroom has compressed, never the reverse), which is why this runs in the pipeline and not inside any route.
 *
 * `upstream` is what headroom is told to forward to once it has done its work (its per-request base URL header): the route's own upstream for a pass-through route, or this door's direct listener for an in-process translator. Undefined leaves headroom's default upstream (Claude Code's API) in charge, which is exactly what an OAuth session wants. The session's project identity is re-set here, and only here: the identity step stripped it from everything that leaves the machine, and headroom is the one consumer that needs it.
 */
export async function applyHeadroomHop(request: RoutedRequest, response: RoutedResponse, upstream: string | undefined, deps: HeadroomHopDeps): Promise<void> {
  const port = deps.headroomPort();
  if (port === undefined) {
    response.start(HTTP_BAD_GATEWAY, { "Content-Type": "application/json" });
    await response.write(JSON.stringify({ type: "error", error: { type: "api_error", message: "claude-use front door: the headroom daemon is restarting" } }));
    response.end();
    return;
  }
  const headers: Record<string, string | string[] | undefined> = forwardableHeaders(request.headers);
  // Set only by the door, never inherited: which upstream headroom forwards to is this route's own declaration, and any inbound copy of the header was already stripped at the identity step, so nothing a client sends can redirect the daemon behind the door's back.
  if (upstream !== undefined) {
    headers[HEADROOM_BASE_URL_HEADER] = upstream;
  }
  if (request.session.projectId !== undefined) {
    headers[PROJECT_ID_HEADER] = request.session.projectId;
  }
  await new Promise<void>((resolve) => {
    const onUpstreamResponse = (upstreamResponse: IncomingMessage): void => {
      response.start(upstreamResponse.statusCode ?? HTTP_BAD_GATEWAY, singleValueHeaders(upstreamResponse.headers));
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
          // The client went away mid-stream, or the daemon dropped the connection: either way the response is no longer salvageable.
          response.destroy();
        }
        resolve(undefined);
      };
      void stream();
    };
    const hop = http.request({ host: "127.0.0.1", port, method: request.method, path: request.url, headers }, onUpstreamResponse);
    hop.on("error", (error: Error) => {
      deps.log(`front door: headroom hop to 127.0.0.1:${String(port)} failed: ${error.message}`);
      if (!response.headersSent) {
        response.start(HTTP_BAD_GATEWAY, { "Content-Type": "application/json" });
        void response
          .write(JSON.stringify({ type: "error", error: { type: "api_error", message: `claude-use front door: the headroom daemon is unreachable (${error.message})` } }))
          .then(() => {
            response.end();
          });
      } else {
        response.destroy();
      }
      resolve(undefined);
    });
    // The client going away aborts the hop, which is what cancels the daemon's request (and, one hop later, the upstream's).
    request.signal.addEventListener("abort", () => {
      hop.destroy();
    });
    request.body.pipe(hop);
    request.body.on("error", () => {
      hop.destroy();
    });
  });
}

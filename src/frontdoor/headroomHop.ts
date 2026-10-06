import * as http from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import type { HeadroomSocketTarget } from "../headroom/socket";
import { forwardableHeaders } from "./connect";
import type { CredentialCustody } from "./custody";
import { HEADROOM_BASE_URL_HEADER, HOP_ID_HEADER, HOP_SECRET_HEADER, PROJECT_ID_HEADER, PROVIDER_HEADER, SESSION_ATTRIBUTION_HEADER, parseProviderPath, type RoutedRequest, type RoutedResponse } from "./route";
import { upstreamChunks } from "./server";

/** What one hop answers when it cannot serve: the daemon is between restarts, unreachable, or its socket failed authentication. Answering with 502 (rather than bypassing headroom) is what keeps a launch that asked for compression from silently losing it. */
const HTTP_BAD_GATEWAY = HTTP_STATUS.badGateway;

/** Everything the headroom hop depends on, injected so the pipeline's ordering tests can point it at a scripted daemon. */
export interface HeadroomHopDeps {
  /**
   * The headroom daemon's unix socket, authenticated (see `verifyHeadroomSocket`) and read per request rather than captured at start-up: a new supervisor generation serves on a new path while this door keeps listening, and the hop must follow it. Undefined while the daemon is down (the restart window); a refusal names why the socket recorded in state must not be dialled. There is no TCP address to fall back to: the hop reaches headroom over this socket or not at all.
   */
  readonly headroomSocket: () => HeadroomSocketTarget | undefined;
  /**
   * The per-generation secret the direct listener requires on what the hop forwards back. Headroom passes non-x-headroom headers through untouched, so the secret survives the round trip and arrives where this process can check it, while no loopback process outside this door ever holds it.
   */
  readonly hopSecret: string;
  /** Holds a provider session's real credentials while its request crosses headroom; the direct listener redeems them by the hop id. */
  readonly custody: CredentialCustody;
  readonly log: (line: string) => void;
}

/**
 * Joins an upstream response's headers into the single-value shape a routed response's head takes, minus the hop-by-hop set: this process re-frames both messages, so framing headers (`transfer-encoding`, `connection` and kin) belong to whichever connection carried them and must be regenerated, never copied. A repeated header becomes one comma-joined value, which is lossless for the JSON and SSE APIs routed here.
 */
function responseHeaders(headers: Readonly<IncomingHttpHeaders>): Record<string, string> {
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
 * Applies the headroom hop: forwards the request, still Anthropic-shaped, to the headroom daemon as a backend hop and streams its response back to the client. The hop ALWAYS sits before the route's own serving (a translator needs the request headroom has compressed, never the reverse), which is why this runs in the pipeline and not inside any route.
 *
 * `upstream` is what headroom is told to forward to once it has done its work (its per-request base URL header). When it is set it is always this door's direct listener (every provider route declares exactly that), and the provider credential is then taken into custody for the hop: headroom receives placeholders and a hop id, and the direct listener restores the real headers when headroom forwards the request back. Neither headroom nor anything that binds a port on that plain-HTTP round trip ever holds the credential. Undefined leaves headroom's default upstream (Claude Code's API) in charge, which is exactly what an OAuth session wants, and the OAuth bearer then passes through untouched: headroom forwards it straight to that API, never back here, and uses it for its subscription tracking. The session's project identity, provider name and attribution id are re-set here, and only here: the identity step stripped them from everything that leaves the machine, and headroom is the one consumer that needs them.
 */
export async function applyHeadroomHop(request: RoutedRequest, response: RoutedResponse, upstream: string | undefined, deps: HeadroomHopDeps): Promise<void> {
  const target = deps.headroomSocket();
  if (target === undefined) {
    await answerBadGateway(response, "agent-shim front door: the headroom daemon is restarting");
    return;
  }
  if (target.refused !== undefined) {
    deps.log(`front door: refusing the headroom hop (${request.method} ${new URL(request.url, "http://127.0.0.1").pathname}): ${target.refused}`);
    await answerBadGateway(response, `agent-shim front door: refusing to send this request to headroom: ${target.refused}`);
    return;
  }
  const { socketPath } = target;
  let headers: Record<string, string | string[] | undefined> = forwardableHeaders(request.headers);
  let hopId: string | undefined;
  // Set only by the door, never inherited: which upstream headroom forwards to is this route's own declaration, and any inbound copy of the header was already stripped at the identity step, so nothing a client sends can redirect the daemon behind the door's back.
  if (upstream !== undefined) {
    const provider = parseProviderPath(new URL(request.url, "http://127.0.0.1").pathname)?.provider ?? request.session.provider;
    if (provider === undefined) {
      // Only a provider route names an upstream, and a provider route is only ever resolved from a provider-scoped path or a session that names its provider; reaching here means that invariant broke, and forwarding the credential to headroom unsequestered is exactly what must never happen.
      throw new Error(`headroom hop for ${request.url} names an upstream but no provider`);
    }
    const sequestered = deps.custody.sequester(headers, provider);
    hopId = sequestered.hopId;
    headers = sequestered.headers;
    headers[HOP_ID_HEADER] = hopId;
    headers[HEADROOM_BASE_URL_HEADER] = upstream;
  }
  if (request.session.provider !== undefined) {
    // Re-set only by the door, like the project identity beside it: the identity step stripped the inbound copy, and the direct listener needs the name back to resolve the provider a bare API path belongs to once headroom has forwarded the request home.
    headers[PROVIDER_HEADER] = request.session.provider;
  }
  if (request.session.projectId !== undefined) {
    headers[PROJECT_ID_HEADER] = request.session.projectId;
  }
  if (request.session.sessionId !== undefined) {
    headers[SESSION_ATTRIBUTION_HEADER] = request.session.sessionId;
  }
  headers[HOP_SECRET_HEADER] = deps.hopSecret;
  try {
    await forwardThroughHeadroom(request, response, { socketPath, headers, log: deps.log });
  } finally {
    // The hop is over (answered, failed, or abandoned by the client): its custody id stops redeeming, so a copy of it seen anywhere along the way is worthless from here on.
    if (hopId !== undefined) {
      deps.custody.release(hopId);
    }
  }
}

/** Answers one hop with a 502 in the Anthropic error shape, before anything was sent to headroom. */
async function answerBadGateway(response: RoutedResponse, message: string): Promise<void> {
  response.start(HTTP_BAD_GATEWAY, { "Content-Type": "application/json" });
  await response.write(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
  response.end();
}

/**
 * The hop's own agent, with keep-alive off: the headroom daemon closes idle keep-alive connections well inside any pooling window (observed against the live daemon, which dropped a connection inside a fifteen-second idle), and Node's global agent keeps such sockets pooled, so the first hop after an idle gap rode a dead connection and the door answered it "socket hang up", one sporadic 502 at a time. A fresh local connection per hop costs nothing, and a streaming response holds its socket for the stream's own life regardless of pooling.
 */
const HOP_AGENT = new http.Agent({ keepAlive: false });

/** Streams one request to headroom and its response back to the client, resolving once the response has ended, failed, or been abandoned. */
async function forwardThroughHeadroom(
  request: RoutedRequest,
  response: RoutedResponse,
  target: { readonly socketPath: string; readonly headers: Readonly<Record<string, string | string[] | undefined>>; readonly log: (line: string) => void },
): Promise<void> {
  const { socketPath, headers } = target;
  await new Promise<void>((resolve) => {
    const onUpstreamResponse = (upstreamResponse: IncomingMessage): void => {
      response.start(upstreamResponse.statusCode ?? HTTP_BAD_GATEWAY, responseHeaders(upstreamResponse.headers));
      // Headers go out before the first body byte: a streaming (SSE) response must reach the client as its chunks arrive, not when it completes.
      response.flush();
      const stream = async (): Promise<void> => {
        try {
          for await (const chunk of upstreamChunks(upstreamResponse)) {
            if (request.signal.aborted) {
              break;
            }
            await response.write(chunk);
          }
          if (!request.signal.aborted) {
            response.end();
          }
        } catch (error) {
          // The client went away mid-stream, or the daemon dropped the connection: either way the response is no longer salvageable. Only the second is a fault worth a log line, and the client having gone is told apart by its own abort signal.
          if (!request.signal.aborted) {
            target.log(`front door: headroom hop to ${socketPath} ended mid-stream (${request.method} ${new URL(request.url, "http://127.0.0.1").pathname}): ${error instanceof Error ? error.message : String(error)}`);
          }
          response.destroy();
        }
        resolve(undefined);
      };
      void stream();
    };
    // `socketPath` is the whole address: no host or port is given, so nothing listening on a TCP port can ever receive this request.
    const hop = http.request({ socketPath, method: request.method, path: request.url, headers, agent: HOP_AGENT }, onUpstreamResponse);
    hop.on("error", (error: Error) => {
      // Which request and which phase decide whether this is a daemon that closed on a request it had accepted (mid-stream), one that was never reachable (before the response started), or neither: the line carries both, with the error's own code, so a recurring failure can be told apart without reproducing it.
      const phase = response.headersSent ? "mid-stream" : "before the response started";
      const code = "code" in error && typeof error.code === "string" ? ` ${error.code}` : "";
      target.log(`front door: headroom hop to ${socketPath} failed (${request.method} ${new URL(request.url, "http://127.0.0.1").pathname}, ${phase}): ${error.message}${code}`);
      if (!response.headersSent) {
        response.start(HTTP_BAD_GATEWAY, { "Content-Type": "application/json" });
        void response
          .write(JSON.stringify({ type: "error", error: { type: "api_error", message: `agent-shim front door: the headroom daemon is unreachable (${error.message})` } }))
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

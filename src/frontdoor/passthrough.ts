import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { displayBaseUrl } from "../baseUrlDisplay";
import { couldNotConnectMessage } from "../providerReachability";
import { forwardableHeaders } from "./connect";
import { ExemptHttpAgent, ExemptTlsAgent } from "./connectEffects";
import { quotaRefusalHeaders } from "../usage/unifiedRefusal";
import type { FrontDoorRoute } from "./route";
import { upstreamChunks } from "./server";
import { dialHostOf } from "../baseUrlDial";

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
  /** What the upstream is called in what the client and the log are told (`provider spark`, `the Anthropic API`). */
  readonly subject: string;
  /** How long opening a connection to the upstream may take before the request is answered as one that could not connect, instead of waiting out the operating system's own connect timeout. Bounds the connect only: once the connection is open, the upstream may take as long as it needs to answer. */
  readonly connectTimeoutMs: number;
  /** Told the line the client was answered with, each time a request could not open its connection; the caller decides how often it reaches the log. */
  readonly couldNotConnect: (line: string) => void;
}

/**
 * Arms the connect bound on one forwarded request: unless its socket has connected within `timeoutMs` of the request being made, the request is destroyed and `giveUp` is told a `no connection within <n>ms` error. The clock starts at the request, not at the socket, so an agent that is still dialling (a reserved-port dial settles before it hands the socket over) is bounded as well; a pooled socket arrives connected and stops it at once.
 *
 * `giveUp` is called directly rather than left to the request's own `error` event, because a request destroyed before any socket was assigned emits nothing until a socket arrives, which for an unanswered dial is the operating system's own connect timeout. The request may still emit `error` afterwards (when the dial settles), so whatever `giveUp` does must also tolerate that later event. Returns a reader of whether the connection opened, which tells a failure to connect from one after it.
 */
export function armConnectDeadline(forward: http.ClientRequest, timeoutMs: number, giveUp: (error: Error) => void): { readonly connected: () => boolean } {
  let connected = false;
  const deadline = setTimeout(() => {
    const error = new Error(`no connection within ${String(timeoutMs)}ms`);
    forward.destroy(error);
    giveUp(error);
  }, timeoutMs);
  const opened = (): void => {
    connected = true;
    clearTimeout(deadline);
  };
  forward.once("socket", (socket) => {
    if (socket.connecting) {
      socket.once("connect", opened);
    } else {
      opened();
    }
  });
  forward.once("close", () => {
    clearTimeout(deadline);
  });
  return { connected: () => connected };
}

/** The status an upstream answers a spent quota or a rate limit with. */
const TOO_MANY_REQUESTS = 429;

/** The most of a refusal's body held to read what it says. Error bodies are a line or two, so a body past this is no refusal worth translating and is streamed on as it is. */
const REFUSAL_BODY_LIMIT_BYTES = 16_384;

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

/** The door's own keep-alive agents, which dial from its reserved source ports through its lookup. */
function exemptAgentFor(tls: boolean): http.Agent {
  return tls ? new ExemptTlsAgent() : new ExemptHttpAgent();
}

/**
 * The pass-through route: streams a request to an Anthropic-compatible upstream and the response back, never buffering a body. This is what an `http` provider's sessions ride, and what a bare `/v1/` request on the connect surface reaches when its session did not ask for headroom. `agentFor` makes the route's keep-alive agent for its upstream's protocol: the door's own agents, or a stand-in under test.
 */
export function createPassthroughRoute(name: string, target: PassthroughTarget, agentFor: (tls: boolean) => http.Agent = exemptAgentFor): FrontDoorRoute {
  const base = new URL(target.baseUrl);
  const tls = base.protocol === "https:";
  const basePath = base.pathname.replace(/\/+$/, "");
  // Keep-alive so a session reusing its connection gets its forwarded requests served over reused upstream connections too, the way a direct connection would.
  const agent = agentFor(tls);
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
          host: dialHostOf(base),
          port: base.port === "" ? undefined : Number(base.port),
          method: request.method,
          path: `${basePath}${path}${incoming.search}`,
          headers,
          agent,
        };
        const onUpstreamResponse = (upstreamResponse: IncomingMessage): void => {
          const status = upstreamResponse.statusCode ?? HTTP_STATUS.badGateway;
          const head = responseHeaders(upstreamResponse.headers);
          const chunks = upstreamChunks(upstreamResponse);
          const stream = async (): Promise<void> => {
            try {
              // A 429 is the one response held back before its head goes out: an error body is small, and what it says (a spent quota, which window, when it lifts) decides whether the head is translated into the real API's form. Every other response, a stream above all, starts as soon as its head is known.
              const held: Uint8Array[] = [];
              let finished = false;
              if (status === TOO_MANY_REQUESTS) {
                let heldBytes = 0;
                while (heldBytes <= REFUSAL_BODY_LIMIT_BYTES) {
                  const next = await chunks.next();
                  if (next.done === true) {
                    finished = true;
                    break;
                  }
                  held.push(next.value);
                  heldBytes += next.value.length;
                }
              }
              const translated = finished ? quotaRefusalHeaders({ status, headers: head, body: Buffer.concat(held), nowMs: Date.now() }) : undefined;
              response.start(status, { ...head, ...translated });
              // Headers go out before the first body byte: a streaming (SSE) response must reach the client as its chunks arrive, not when it completes.
              response.flush();
              for (const chunk of held) {
                await response.write(chunk);
              }
              if (!finished) {
                for await (const chunk of chunks) {
                  if (request.signal.aborted) {
                    return;
                  }
                  await response.write(chunk);
                }
              }
              response.end();
            } catch {
              // The client went away mid-stream, or the upstream dropped the connection: either way the response is no longer salvageable.
              if (response.headersSent) {
                response.destroy();
              } else {
                response.start(HTTP_STATUS.badGateway, { "Content-Type": "application/json" });
                await response.write(JSON.stringify({ type: "error", error: { type: "api_error", message: `${target.subject} at ${displayBaseUrl(target.baseUrl)} dropped the connection` } }));
                response.end();
              }
            }
            resolve(undefined);
          };
          void stream();
        };
        const forward = tls ? https.request(options, onUpstreamResponse) : http.request(options, onUpstreamResponse);
        // The forward fails at most once as far as the client is concerned: a connect bound that gave up may be followed by the request's own error when its dial finally settles.
        let failed = false;
        const fail = (error: Error, connected: boolean): void => {
          if (failed) {
            return;
          }
          failed = true;
          if (!response.headersSent) {
            const message = connected ? `${target.subject} at ${displayBaseUrl(target.baseUrl)} dropped the connection before answering: ${error.message}` : couldNotConnectMessage(target.subject, target.baseUrl, error.message);
            if (!connected) {
              target.couldNotConnect(message);
            }
            response.start(HTTP_STATUS.badGateway, { "Content-Type": "application/json" });
            void response
              .write(JSON.stringify({ type: "error", error: { type: "api_error", message } }))
              .then(() => {
                response.end();
              });
          } else {
            response.destroy();
          }
          resolve(undefined);
        };
        const connection = armConnectDeadline(forward, target.connectTimeoutMs, (error) => {
          fail(error, false);
        });
        forward.on("error", (error: Error) => {
          fail(error, connection.connected());
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

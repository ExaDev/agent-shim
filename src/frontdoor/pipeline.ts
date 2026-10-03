import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { applyHeadroomHop, type HeadroomHopDeps } from "./headroomHop";
import { identifyRequest, type FrontDoorRoute, type RoutedRequest, type RoutedResponse, type SessionIdentity } from "./route";

/** What one routed response looked like as it started back to the client: the typed event response middleware observes. */
export interface RoutedResponseEvent {
  readonly session: SessionIdentity;
  /** The route that served the response. */
  readonly route: string;
  /** The request's method. */
  readonly method: string;
  /** The request target's path, without its query string. */
  readonly path: string;
  /** When the pipeline received the request, in epoch milliseconds from the injected clock. */
  readonly receivedAt: number;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** How a routed response's body finished: written to the end, or cut short (the client went away, or the route destroyed the response after an upstream failure). */
export type ResponseOutcome = "completed" | "aborted";

/**
 * Follows one response's body as the client receives it. `chunk` sees each chunk after it has been handed to the client's socket, so observing never holds a byte back; `end` is called exactly once, when the body has finished either way. Like the observer that returned it, a body observer that throws is logged and dropped for the rest of that response, never allowed to break it.
 */
export interface ResponseBodyObserver {
  readonly chunk: (chunk: Uint8Array) => void;
  readonly end: (outcome: ResponseOutcome) => void;
}

/**
 * Response middleware: called once per routed response, in registration order, once the route's response head is known and before any of it is written to the client. It returns a body observer when it wants to follow the body, or undefined when the head was all it needed. Observing must be side-effect-only: an observer that throws is logged and skipped, never allowed to break routing, and an observer must not block the response.
 *
 * Usage tracking registers here (see `src/usage/middleware.ts`): the head carries the rate-limit headers, and the body carries the token usage.
 */
export type ResponseObserver = (event: RoutedResponseEvent) => ResponseBodyObserver | undefined;

/** The outcome of resolving a request's target to a route. */
export type RouteResolution =
  | { readonly ok: true; readonly route: FrontDoorRoute }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** Everything the ordered pipeline depends on, injected so it runs against fakes in tests. */
export interface PipelineDeps {
  /** Resolves the route a request's target names, reading whatever configuration the route needs. */
  readonly resolveRoute: (request: RoutedRequest) => Promise<RouteResolution>;
  /** The response middleware chain, run in order at each response head. This is where usage capture registers. */
  readonly responseObservers: readonly ResponseObserver[];
  /**
   * The headroom hop, applied BEFORE a route whose declaration admits it whenever the session's launch resolved headroom on: headroom needs the Anthropic-shaped request, so it always sits in front of a translator, never behind one. Omitted by a listener that serves routes directly (the direct listener headroom forwards an in-process route back to), or when no headroom is wired.
   */
  readonly headroom?: HeadroomHopDeps;
  /** The clock response middleware times requests by, in epoch milliseconds. */
  readonly now: () => number;
  readonly log: (line: string) => void;
  /**
   * The listener's admission step, run after identification and before anything is routed: it decides whether the request may be routed at all and with which headers. A client-facing listener admits a request carrying the per-launch capability of a live registered session, unchanged; the direct listener admits only what this process's own headroom hop sent back (the generation's hop secret plus a live custody id for the provider the path names) and swaps the hop's placeholder credentials for the real ones. A refused request is answered 401 without ever reaching a route, so a loopback process that never launched through agent-shim cannot spend a session's credentials or quota.
   */
  readonly admit: (request: AdmissionRequest) => Admission;
}

/** What the admission step sees of one request. */
interface AdmissionRequest {
  /** The request target exactly as received. */
  readonly url: string;
  /** Every header as received, internal ones included: the capability and hop headers live here. */
  readonly headers: Readonly<IncomingHttpHeaders>;
  /** The headers the identity step judged forwardable, internal ones stripped. */
  readonly forwardable: Readonly<IncomingHttpHeaders>;
}

/** The admission step's verdict: route with these headers, or refuse with this message. */
type Admission = { readonly ok: true; readonly headers: IncomingHttpHeaders } | { readonly ok: false; readonly message: string };

/** One request as a transport hands it to the pipeline, before anything has been identified or routed. */
export interface PipelineRequest {
  readonly method: string;
  /** The request target exactly as received, path and query together. */
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  /** The request's body stream. */
  readonly body: IncomingMessage;
  /** Aborted the moment the client goes away. */
  readonly signal: AbortSignal;
  readonly response: ServerResponse;
}

/** The Anthropic error type for an HTTP status, so Claude Code classifies a front-door failure the way it would one from the real API. */
function errorTypeFor(status: number): string {
  switch (status) {
    case HTTP_STATUS.badRequest:
      return "invalid_request_error";
    case HTTP_STATUS.unauthorized:
      return "authentication_error";
    case HTTP_STATUS.forbidden:
      return "permission_error";
    case HTTP_STATUS.notFound:
      return "not_found_error";
    case HTTP_STATUS.tooManyRequests:
      return "rate_limit_error";
    default:
      return "api_error";
  }
}

function errorBody(status: number, message: string): string {
  return JSON.stringify({ type: "error", error: { type: errorTypeFor(status), message } });
}

/** What the response middleware learns about the request a routed response answers. */
interface ObservedRequest {
  readonly method: string;
  /** The request target's path, without its query string. */
  readonly path: string;
  readonly receivedAt: number;
}

/** The request target's path without its query string: the query is the client's business, and middleware has no use for it. */
function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** Describes a thrown value for the door's log. */
function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the response half a route writes through. The head is what runs the response middleware: `start` invokes every observer, in order, with the session, the request and the route's name before a byte reaches the client, and keeps the body observers they return. Each body chunk reaches those observers only after it has been handed to the client's socket, and their `end` runs once when the response ends, is destroyed, or the client goes away first, so following the body never holds a byte back and never misses how it finished. Body writes apply backpressure by waiting for the socket to drain, and resolve without writing once the client is gone, so a route streaming to a dead client finishes promptly rather than filling a buffer.
 */
export function createRoutedResponse(
  response: ServerResponse,
  context: { readonly deps: PipelineDeps; readonly session: SessionIdentity; readonly route: string; readonly request: ObservedRequest },
): RoutedResponse {
  const { deps, session, route, request } = context;
  let headersSent = false;
  let bodyObservers: ResponseBodyObserver[] = [];
  let finished = false;
  const observeBody = (call: (observer: ResponseBodyObserver) => void): void => {
    bodyObservers = bodyObservers.filter((observer) => {
      try {
        call(observer);
        return true;
      } catch (error) {
        // Middleware must observe, never break routing: a throwing body observer is a bug in the observer, reported and dropped for the rest of this response.
        deps.log(`front door: response body observer threw for ${route}: ${describeThrown(error)}`);
        return false;
      }
    });
  };
  const finish = (outcome: ResponseOutcome): void => {
    if (finished) {
      return;
    }
    finished = true;
    observeBody((observer) => {
      observer.end(outcome);
    });
    bodyObservers = [];
  };
  // A client that goes away before the route ends the response leaves the route returning early without calling end or destroy, so the socket's close is what tells the body observers the body was cut short.
  response.once("close", () => {
    finish(response.writableFinished ? "completed" : "aborted");
  });
  const settle = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        response.off("drain", done);
        response.off("close", done);
        resolve();
      };
      response.once("drain", done);
      response.once("close", done);
    });
  };

  return {
    get headersSent(): boolean {
      return headersSent;
    },
    start: (status, headers) => {
      for (const observe of deps.responseObservers) {
        try {
          const body = observe({ session, route, method: request.method, path: request.path, receivedAt: request.receivedAt, status, headers });
          if (body !== undefined) {
            bodyObservers.push(body);
          }
        } catch (error) {
          // Middleware must observe, never break routing: a throwing observer is a bug in the observer, reported and dropped.
          deps.log(`front door: response observer threw for ${route}: ${describeThrown(error)}`);
        }
      }
      response.writeHead(status, headers);
      headersSent = true;
    },
    flush: () => {
      response.flushHeaders();
    },
    write: async (chunk) => {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      const accepted = response.write(chunk);
      // Observed only once the socket has the chunk: what the client receives is never waiting on middleware.
      if (bodyObservers.length > 0) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        observeBody((observer) => {
          observer.chunk(bytes);
        });
      }
      if (!accepted) {
        await settle();
      }
    },
    end: () => {
      // Ending a response whose client already went away delivers nothing more: the body was cut short whatever the route thinks.
      const outcome = response.destroyed ? "aborted" : "completed";
      response.end();
      finish(outcome);
    },
    destroy: () => {
      response.destroy();
      finish("aborted");
    },
  };
}

/**
 * The ordered pipeline every routed session's request runs through: identify the session (splitting the launcher-injected headers out of what may leave the machine), then route, with the response middleware running at each response head. A route that cannot be resolved is answered as an Anthropic-shaped error, and the observers see that error like any other response, since quota and rate-limit state lives in exactly those.
 */
export async function serveRouted(request: PipelineRequest, deps: PipelineDeps): Promise<void> {
  const observed: ObservedRequest = { method: request.method, path: pathOf(request.url), receivedAt: deps.now() };
  const identified = identifyRequest(request.headers);
  const admission = deps.admit({ url: request.url, headers: request.headers, forwardable: identified.forwardableHeaders });
  if (!admission.ok) {
    const response = createRoutedResponse(request.response, { deps, session: identified.session, route: "(unauthorized)", request: observed });
    response.start(HTTP_STATUS.unauthorized, { "Content-Type": "application/json" });
    await response.write(errorBody(HTTP_STATUS.unauthorized, admission.message));
    response.end();
    return;
  }
  const routed: RoutedRequest = {
    method: request.method,
    url: request.url,
    headers: admission.headers,
    body: request.body,
    signal: request.signal,
    session: identified.session,
  };
  const resolution = await deps.resolveRoute(routed);
  if (!resolution.ok) {
    const response = createRoutedResponse(request.response, { deps, session: identified.session, route: "(unrouted)", request: observed });
    response.start(resolution.status, { "Content-Type": "application/json" });
    await response.write(errorBody(resolution.status, resolution.message));
    response.end();
    return;
  }
  const response = createRoutedResponse(request.response, { deps, session: identified.session, route: resolution.route.name, request: observed });
  try {
    if (identified.session.headroom && resolution.route.headroomEligible && deps.headroom !== undefined) {
      // The ordering the whole design turns on: headroom first, on the Anthropic-shaped request, then the route (a translator receives what headroom compressed). A route that opts out, or a listener that serves routes directly, falls through to serving.
      await applyHeadroomHop(routed, response, resolution.route.headroomUpstream, deps.headroom);
    } else {
      await resolution.route.serve(routed, response);
    }
  } catch (error) {
    if (request.signal.aborted) {
      return;
    }
    deps.log(`front door: route ${resolution.route.name} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    if (!response.headersSent) {
      response.start(HTTP_STATUS.internalServerError, { "Content-Type": "application/json" });
      await response.write(errorBody(HTTP_STATUS.internalServerError, "internal error in the agent-shim front door"));
      response.end();
      return;
    }
    response.destroy();
  }
}

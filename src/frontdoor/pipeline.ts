import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { applyHeadroomHop, type HeadroomHopDeps } from "./headroomHop";
import { identifyRequest, type FrontDoorRoute, type RoutedRequest, type RoutedResponse, type SessionIdentity } from "./route";

/** What one routed response looked like as it started back to the client: the typed event response middleware observes. */
export interface RoutedResponseEvent {
  readonly session: SessionIdentity;
  /** The route that served the response. */
  readonly route: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Response middleware: called once per routed response, in registration order, once the route's response head is known and before any of it is written to the client. Observing must be side-effect-only: an observer that throws is logged and skipped, never allowed to break routing, and an observer must not block the response.
 *
 * This is the hook point the usage tracking work (its own issue) registers quota and usage capture at. The front door itself registers none.
 */
export type ResponseObserver = (event: RoutedResponseEvent) => void;

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
  readonly log: (line: string) => void;
  /**
   * The listener's admission step, run after identification and before anything is routed: it decides whether the request may be routed at all and with which headers. A client-facing listener admits a request carrying the per-launch capability of a live registered session, unchanged; the direct listener admits only what this process's own headroom hop sent back (the generation's hop secret plus a live custody id for the provider the path names) and swaps the hop's placeholder credentials for the real ones. A refused request is answered 401 without ever reaching a route, so a loopback process that never launched through claude-use cannot spend a session's credentials or quota.
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

/**
 * Builds the response half a route writes through. The head is what runs the response middleware: `start` invokes every observer, in order, with the session and the route's name before a byte reaches the client. Body writes apply backpressure by waiting for the socket to drain, and resolve without writing once the client is gone, so a route streaming to a dead client finishes promptly rather than filling a buffer.
 */
export function createRoutedResponse(response: ServerResponse, context: { readonly deps: PipelineDeps; readonly session: SessionIdentity; readonly route: string }): RoutedResponse {
  const { deps, session, route } = context;
  let headersSent = false;
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
          observe({ session, route, status, headers });
        } catch (error) {
          // Middleware must observe, never break routing: a throwing observer is a bug in the observer, reported and dropped.
          deps.log(`front door: response observer threw for ${route}: ${error instanceof Error ? error.message : String(error)}`);
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
      if (!response.write(chunk)) {
        await settle();
      }
    },
    end: () => {
      response.end();
    },
    destroy: () => {
      response.destroy();
    },
  };
}

/**
 * The ordered pipeline every routed session's request runs through: identify the session (splitting the launcher-injected headers out of what may leave the machine), then route, with the response middleware running at each response head. A route that cannot be resolved is answered as an Anthropic-shaped error, and the observers see that error like any other response, since quota and rate-limit state lives in exactly those.
 */
export async function serveRouted(request: PipelineRequest, deps: PipelineDeps): Promise<void> {
  const identified = identifyRequest(request.headers);
  const admission = deps.admit({ url: request.url, headers: request.headers, forwardable: identified.forwardableHeaders });
  if (!admission.ok) {
    const response = createRoutedResponse(request.response, { deps, session: identified.session, route: "(unauthorized)" });
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
    const response = createRoutedResponse(request.response, { deps, session: identified.session, route: "(unrouted)" });
    response.start(resolution.status, { "Content-Type": "application/json" });
    await response.write(errorBody(resolution.status, resolution.message));
    response.end();
    return;
  }
  const response = createRoutedResponse(request.response, { deps, session: identified.session, route: resolution.route.name });
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
      await response.write(errorBody(HTTP_STATUS.internalServerError, "internal error in the claude-use front door"));
      response.end();
      return;
    }
    response.destroy();
  }
}

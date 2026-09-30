import { HTTP_STATUS } from "./http";
import type { ResolvedCodexConfig } from "./translate";
import { CountTokensRequestSchema, MessagesRequestSchema } from "./anthropic";
import { CodexErrorEnvelopeSchema, codexEvents, type CodexErrorDetail, type ResponsesUsage } from "./events";
import { buildUsageSnapshot, quotaHeaders, retryAfterSeconds, unifiedQuotaHeaders, type UsageSnapshot } from "./quota";
import { createRelay, renderSseFrame, type AnthropicMessageResponse } from "./relay";
import { translateRequest } from "./translate";
import { callCodex, sessionIdFor, type CodexUpstreamPorts } from "./upstream";
import type { UpstreamResponse } from "./upstreamPort";

/** One request as the route sees it: transport-neutral, so the same route can sit behind this daemon's own listener or be mounted in a front-door proxy. */
export interface RouteRequest {
  readonly method: string;
  /** The URL path, without the query string. */
  readonly path: string;
  readonly body: string;
  /** Aborted when the client goes away; the route aborts its upstream call with it. */
  readonly signal: AbortSignal;
}

/** One response: a status, headers, and either a whole body or a stream of chunks the transport writes as they come. */
export interface RouteResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | AsyncIterable<string>;
}

/** The outcome of looking up the codex provider a request's path names. */
export type CodexProviderLookup =
  | { readonly ok: true; readonly config: ResolvedCodexConfig }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** Everything the route depends on. */
export interface CodexRoutePorts {
  readonly upstream: CodexUpstreamPorts;
  /** Loads the named provider's translation settings, read per request so an edited provider file applies to the next request with no restart. */
  readonly loadProvider: (name: string) => CodexProviderLookup;
  /** Persists the usage snapshot a statusline reads. Failures are the port's to report; they never fail the request. */
  readonly writeUsageSnapshot: (snapshot: UsageSnapshot) => void;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/** The path prefix every provider-scoped endpoint sits under: a codex provider's base URL is the daemon's address plus `/providers/<name>`, so one daemon serves any number of codex providers, each with its own translation settings. */
const CODEX_PROVIDER_PATH_PREFIX = "/providers/";

/** The base URL a codex provider's sessions are pointed at. */
export function codexProviderBaseUrl(port: number, provider: string): string {
  return `http://127.0.0.1:${String(port)}${CODEX_PROVIDER_PATH_PREFIX}${encodeURIComponent(provider)}`;
}

/** The Anthropic error type for an HTTP status, so Claude Code classifies the failure the way it would one from the real API. */
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

function errorResponse(status: number, message: string, headers: Readonly<Record<string, string>> = {}): RouteResponse {
  return { status, headers: { "Content-Type": "application/json", ...headers }, body: errorBody(status, message) };
}

function errorFrame(status: number, message: string): string {
  return `event: error\ndata: ${errorBody(status, message)}\n\n`;
}

/** How much of a refused upstream response's body is echoed back to the client and kept in the log. */
const UPSTREAM_DETAIL_CHARS = 2000;
const UPSTREAM_LOG_DETAIL_CHARS = 300;

/** Characters per token in the count estimate: the backend has no counting endpoint, and a rough estimate is all Claude Code's compaction heuristics need from this call. */
const CHARS_PER_TOKEN = 4;

/** Splits `/providers/<name>/<rest>` into the provider name and the rest, or undefined for any other path. */
function providerPath(path: string): { readonly provider: string; readonly rest: string } | undefined {
  if (!path.startsWith(CODEX_PROVIDER_PATH_PREFIX)) {
    return undefined;
  }
  const tail = path.slice(CODEX_PROVIDER_PATH_PREFIX.length);
  const slash = tail.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  return { provider: decodeURIComponent(tail.slice(0, slash)), rest: tail.slice(slash) };
}

function parseJson(body: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
  try {
    const value: unknown = JSON.parse(body);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: `request body is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The codex translation route: `POST /providers/<name>/v1/messages` translates an Anthropic Messages request onto the Codex backend and the response back, streaming or not; `POST /providers/<name>/v1/messages/count_tokens` answers with an estimate; `GET /healthz` answers `ok`. Every other request is an Anthropic-shaped error.
 */
export function createCodexRoute(ports: CodexRoutePorts): (request: RouteRequest) => Promise<RouteResponse> {
  const handleMessages = async (request: RouteRequest, config: ResolvedCodexConfig, raw: unknown): Promise<RouteResponse> => {
    const parsed = MessagesRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(HTTP_STATUS.badRequest, `not an Anthropic Messages request: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    const body = parsed.data;
    const requestedModel = body.model ?? "";
    const { request: upstreamRequest, toolNames } = translateRequest(body, config);
    const started = ports.now();
    const elapsed = (): string => `${String(ports.now() - started)}ms`;

    let upstream: UpstreamResponse;
    try {
      upstream = await callCodex(ports.upstream, upstreamRequest, sessionIdFor(body.metadata?.user_id, ports.upstream.randomId), request.signal);
    } catch (error) {
      if (request.signal.aborted) {
        return errorResponse(HTTP_STATUS.clientClosedRequest, "client disconnected");
      }
      ports.log(`${upstreamRequest.model} upstream fetch failed after ${elapsed()}: ${describeError(error)}`);
      return errorResponse(HTTP_STATUS.badGateway, `codex backend unreachable: ${describeError(error)}`);
    }

    const snapshot = (quotaError: CodexErrorDetail | undefined): void => {
      const built = buildUsageSnapshot(upstream.headers, quotaError, ports.now());
      if (built !== undefined) {
        ports.writeUsageSnapshot(built);
      }
    };

    if (!upstream.ok || upstream.body === null) {
      const detail = (await upstream.text()).slice(0, UPSTREAM_DETAIL_CHARS);
      let quotaError: CodexErrorDetail | undefined;
      try {
        const envelope = CodexErrorEnvelopeSchema.safeParse(JSON.parse(detail));
        quotaError = envelope.success ? envelope.data.error : undefined;
      } catch {
        // Not the quota envelope: the header-derived quota still applies.
      }
      const rejected = upstream.status === HTTP_STATUS.tooManyRequests;
      const retryAfter = rejected ? retryAfterSeconds(upstream.headers, quotaError) : undefined;
      ports.log(`${upstreamRequest.model} upstream ${String(upstream.status)} ${elapsed()}: ${detail.slice(0, UPSTREAM_LOG_DETAIL_CHARS)}`);
      snapshot(quotaError);
      return errorResponse(upstream.ok ? HTTP_STATUS.badGateway : upstream.status, `codex backend: ${detail}`, {
        ...quotaHeaders(upstream.headers),
        ...unifiedQuotaHeaders(upstream.headers, rejected, quotaError),
        ...(retryAfter === undefined ? {} : { "retry-after": String(retryAfter) }),
      });
    }
    snapshot(undefined);

    const relay = createRelay({ requestedModel, toolNames, fallbackId: () => `msg_${ports.upstream.randomId()}` });
    const upstreamBody = upstream.body;
    const quota = { ...quotaHeaders(upstream.headers), ...unifiedQuotaHeaders(upstream.headers, false, undefined) };
    const logCompleted = (message: AnthropicMessageResponse, usage: ResponsesUsage | undefined): void => {
      ports.log(
        `${upstreamRequest.model} ok ${elapsed()} effort=${upstreamRequest.reasoning?.effort ?? "none"} stop=${message.stop_reason} ` +
          `in=${String(usage?.input_tokens ?? 0)} cached=${String(usage?.input_tokens_details?.cached_tokens ?? 0)} ` +
          `cache_write=${String(usage?.input_tokens_details?.cache_write_tokens ?? 0)} out=${String(usage?.output_tokens ?? 0)}`,
      );
    };

    if (body.stream === true) {
      const frames = async function* (): AsyncGenerator<string> {
        try {
          for await (const event of codexEvents(upstreamBody)) {
            const step = relay.push(event);
            for (const frame of step.frames) {
              yield renderSseFrame(frame);
            }
            if (step.completed !== undefined) {
              logCompleted(step.completed.message, step.completed.usage);
              return;
            }
            if (step.failed !== undefined) {
              ports.log(`${upstreamRequest.model} stream error: ${step.failed.message}`);
              yield errorFrame(HTTP_STATUS.internalServerError, step.failed.message);
              return;
            }
          }
          ports.log(`${upstreamRequest.model} stream ended without completing after ${elapsed()}`);
          yield errorFrame(HTTP_STATUS.badGateway, "codex backend stream ended without completing");
        } catch (error) {
          if (request.signal.aborted) {
            return;
          }
          ports.log(`${upstreamRequest.model} stream relay failed: ${describeError(error)}`);
          yield errorFrame(HTTP_STATUS.badGateway, `stream relay failed: ${describeError(error)}`);
        }
      };
      return {
        status: HTTP_STATUS.ok,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...quota },
        body: frames(),
      };
    }

    try {
      for await (const event of codexEvents(upstreamBody)) {
        const step = relay.push(event);
        if (step.completed !== undefined) {
          logCompleted(step.completed.message, step.completed.usage);
          return { status: HTTP_STATUS.ok, headers: { "Content-Type": "application/json", ...quota }, body: JSON.stringify(step.completed.message) };
        }
        if (step.failed !== undefined) {
          ports.log(`${upstreamRequest.model} stream error: ${step.failed.message}`);
          return errorResponse(HTTP_STATUS.internalServerError, step.failed.message);
        }
      }
    } catch (error) {
      if (request.signal.aborted) {
        return errorResponse(HTTP_STATUS.clientClosedRequest, "client disconnected");
      }
      ports.log(`${upstreamRequest.model} stream relay failed: ${describeError(error)}`);
      return errorResponse(HTTP_STATUS.badGateway, `stream relay failed: ${describeError(error)}`);
    }
    ports.log(`${upstreamRequest.model} stream ended without completing after ${elapsed()}`);
    return errorResponse(HTTP_STATUS.badGateway, "codex backend stream ended without completing");
  };

  const handleCountTokens = (raw: unknown): RouteResponse => {
    const parsed = CountTokensRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(HTTP_STATUS.badRequest, "not a count_tokens request");
    }
    const text = JSON.stringify({ system: parsed.data.system, messages: parsed.data.messages, tools: parsed.data.tools });
    return { status: HTTP_STATUS.ok, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input_tokens: Math.ceil(text.length / CHARS_PER_TOKEN) }) };
  };

  return async (request) => {
    if (request.method === "GET" && request.path === "/healthz") {
      return { status: HTTP_STATUS.ok, headers: { "Content-Type": "text/plain" }, body: "ok" };
    }
    if (request.method !== "POST") {
      return errorResponse(HTTP_STATUS.methodNotAllowed, `unsupported ${request.method} ${request.path}`);
    }
    const scoped = providerPath(request.path);
    if (scoped === undefined || (scoped.rest !== "/v1/messages" && scoped.rest !== "/v1/messages/count_tokens")) {
      return errorResponse(HTTP_STATUS.notFound, `no such endpoint: ${request.path}`);
    }
    const provider = ports.loadProvider(scoped.provider);
    if (!provider.ok) {
      return errorResponse(provider.status, provider.message);
    }
    const json = parseJson(request.body);
    if (!json.ok) {
      return errorResponse(HTTP_STATUS.badRequest, json.message);
    }
    return scoped.rest === "/v1/messages" ? await handleMessages(request, provider.config, json.value) : handleCountTokens(json.value);
  };
}

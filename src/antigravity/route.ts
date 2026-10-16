import { randomUUID } from "node:crypto";
import { parseProviderPath } from "../frontdoor/route";
import { HTTP_STATUS } from "../codex/http";
import { MessagesRequestSchema } from "../codex/anthropic";
import { createAntigravityRelay, renderSseFrame } from "./relay";
import { translateRequest, type ResolvedAntigravityConfig } from "./translate";
import { callCloudAntigravity, AntigravityUpstreamError } from "./cloudUpstream";
import { callLocalAntigravity } from "./localUpstream";
import type { AcpConnection } from "./localUpstream";
import { antigravityQuotaExhaustion, parseRetryAfterSeconds, unifiedAntigravityQuotaHeaders, type AntigravityExhaustion, type AntigravityQuotaMap } from "./quota";
import type { GeminiGenerateContentResponseChunk } from "./geminiSchema";
import type { RouteRequest, RouteResponse } from "../codex/route";

interface AntigravityProviderLookup {
  readonly ok: true;
  readonly config: ResolvedAntigravityConfig;
  readonly token: string;
  readonly credentialTarget?: "bearer" | "apiKey";
}

interface AntigravityProviderLookupFailure {
  readonly ok: false;
  readonly status: number;
  readonly message: string;
}

type AntigravityProviderResolution = AntigravityProviderLookup | AntigravityProviderLookupFailure;

export interface AntigravityRoutePorts {
  readonly loadProvider: (name: string) => AntigravityProviderResolution;
  readonly fallbackId?: () => string;
  readonly fetchFn?: typeof fetch;
  readonly localConnector?: (config: ResolvedAntigravityConfig, signal: AbortSignal) => AcpConnection;
  readonly now?: () => number;
  readonly quotaSource?: () => AntigravityQuotaMap | undefined;
}

const MS_PER_SECOND = 1000;

/** What a spent window says to the person: which limit was reached and when it lifts, in place of the backend's own error text, which names neither. */
function exhaustedMessage(exhaustion: AntigravityExhaustion): string {
  const window = exhaustion.window === "five_hour" ? "5-hour" : "weekly";
  return `Antigravity ${window} limit reached; it resets at ${new Date(exhaustion.resetSec * MS_PER_SECOND).toISOString()}.`;
}

export function createAntigravityRoute(ports: AntigravityRoutePorts): (request: RouteRequest) => Promise<RouteResponse> {
  const fallbackId = ports.fallbackId ?? (() => randomUUID());

  return async (request: RouteRequest): Promise<RouteResponse> => {
    await Promise.resolve();
    if (request.method !== "POST") {
      return {
        status: HTTP_STATUS.badRequest,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "only POST is supported" } }),
      };
    }

    const providerName = parseProviderPath(request.path)?.provider;
    if (providerName === undefined) {
      return {
        status: HTTP_STATUS.notFound,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no provider specified in path" } }),
      };
    }

    const lookup = ports.loadProvider(providerName);
    if (!lookup.ok) {
      return {
        status: lookup.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: lookup.message } }),
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(request.body);
    } catch {
      return {
        status: HTTP_STATUS.badRequest,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "malformed JSON body" } }),
      };
    }

    const parsed = MessagesRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        status: HTTP_STATUS.badRequest,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
        }),
      };
    }

    const { config, token, credentialTarget } = lookup;
    const requestedModel = parsed.data.model ?? config.defaultModel;
    const nowMs = ports.now?.() ?? Date.now();
    const translated = translateRequest(parsed.data, config, { quota: ports.quotaSource?.(), nowMs });
    const relay = createAntigravityRelay({
      requestedModel,
      toolNames: translated.toolNames,
      fallbackId,
    });

    const upstreamChunks =
      config.mode === "local"
        ? callLocalAntigravity({
            config,
            model: translated.model,
            request: translated.request,
            signal: request.signal,
            connector: ports.localConnector,
          })
        : callCloudAntigravity(
            {
              config,
              model: translated.model,
              request: translated.request,
              token,
              credentialTarget,
              signal: request.signal,
            },
            ports.fetchFn,
          );

    const iterator = upstreamChunks[Symbol.asyncIterator]();
    let firstResult: IteratorResult<GeminiGenerateContentResponseChunk>;
    try {
      firstResult = await iterator.next();
    } catch (error) {
      if (error instanceof AntigravityUpstreamError) {
        const is429 = error.status === HTTP_STATUS.tooManyRequests;
        const quota = ports.quotaSource?.();
        const quotaHeaders = unifiedAntigravityQuotaHeaders({ quota, rejected: is429, nowMs, model: translated.model });
        // A spent window supplies its own retry-after (the time until it resets); otherwise the backend's hint stands.
        const retryAfter = is429 && quotaHeaders["retry-after"] === undefined ? parseRetryAfterSeconds(error.retryAfter) : undefined;
        const exhaustion = is429 ? antigravityQuotaExhaustion(quota, translated.model, nowMs) : undefined;
        const errorType = is429 ? "rate_limit_error" : "api_error";
        return {
          status: error.status,
          headers: {
            "Content-Type": "application/json",
            ...quotaHeaders,
            ...(retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {}),
          },
          body: JSON.stringify({ type: "error", error: { type: errorType, message: exhaustion === undefined ? error.message : exhaustedMessage(exhaustion) } }),
        };
      }
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        status: HTTP_STATUS.badGateway,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "error", error: { type: "api_error", message: errMsg } }),
      };
    }

    const quotaHeaders = unifiedAntigravityQuotaHeaders({
      quota: ports.quotaSource?.(),
      rejected: false,
      nowMs,
      model: translated.model,
    });

    const stream = async function* () {
      try {
        if (firstResult.done !== true) {
          const step = relay.pushChunk(firstResult.value);
          for (const frame of step.frames) {
            yield renderSseFrame(frame);
          }
          if (!step.done) {
            for (;;) {
              if (request.signal.aborted) {
                break;
              }
              const nextResult = await iterator.next();
              if (nextResult.done === true) {
                break;
              }
              const nextStep = relay.pushChunk(nextResult.value);
              for (const frame of nextStep.frames) {
                yield renderSseFrame(frame);
              }
              if (nextStep.done) {
                break;
              }
            }
          }
        }

        const finalStep = relay.finish();
        for (const frame of finalStep.frames) {
          yield renderSseFrame(frame);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          const errMsg = error instanceof Error ? error.message : String(error);
          yield renderSseFrame({
            event: "error",
            data: { type: "error", error: { type: "api_error", message: errMsg } },
          });
        }
      }
    };

    return {
      status: HTTP_STATUS.ok,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...quotaHeaders,
      },
      body: stream(),
    };
  };
}

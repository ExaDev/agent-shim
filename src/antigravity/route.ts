import { randomUUID } from "node:crypto";
import { parseProviderPath } from "../frontdoor/route";
import { HTTP_STATUS } from "../codex/http";
import { MessagesRequestSchema } from "../codex/anthropic";
import { createAntigravityRelay, renderSseFrame, type SseFrame } from "./relay";
import { relaxRejectedRecursiveProperty } from "./recursiveSchema";
import { translateRequest, type ResolvedAntigravityConfig } from "./translate";
import { callCloudAntigravity, AntigravityUpstreamError } from "./cloudUpstream";
import { callLocalAntigravity } from "./localUpstream";
import type { AcpConnection } from "./localUpstream";
import { antigravityQuotaExhaustion, parseQuotaExhaustion, parseRetryAfterSeconds, quotaWithExhaustions, unifiedAntigravityQuotaHeaders, type AntigravityExhaustion, type AntigravityQuotaMap } from "./quota";
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
  readonly loadProvider: (name: string) => Promise<AntigravityProviderResolution>;
  readonly fallbackId?: () => string;
  readonly fetchFn?: typeof fetch;
  readonly localConnector?: (config: ResolvedAntigravityConfig, signal: AbortSignal) => AcpConnection;
  readonly now?: () => number;
  readonly quotaSource?: () => AntigravityQuotaMap | undefined;
  /** The sessions' last routing choices, shared by every mounting of this route. A caller that mounts the route per request (the front door's resolver) supplies one map per provider, so a session keeps its model across the remounts; without it the route keeps its own, which lives only as long as one mounting. */
  readonly lastRouted?: Map<string, string>;
  /** The models the backend has answered with a spent allowance, each with the instant (epoch milliseconds) it lifts, shared like `lastRouted`: the quota summary does not measure every model's allowance (Gemini 4 Argon's is absent on some plans), so the backend's own refusal is what says a model is spent, and routing then leaves it until the instant given. */
  readonly exhaustedModels?: Map<string, number>;
}

const MS_PER_SECOND = 1000;

/** How many sessions' last routing choices the route remembers; the oldest is dropped first, so a forgotten session is merely routed afresh by preference on its next request. */
const ROUTING_MEMORY_SESSIONS = 256;
/** Bound retries when an upstream reports a sequence of distinct recursive properties. */
const MAX_SCHEMA_RETRIES = 16;

/** What a spent window says to the person: which limit was reached and when it lifts, in place of the backend's own error text, which names neither. */
function exhaustedMessage(exhaustion: AntigravityExhaustion): string {
  const window = exhaustion.window === "five_hour" ? "5-hour" : "weekly";
  return `Antigravity ${window} limit reached; it resets at ${new Date(exhaustion.resetSec * MS_PER_SECOND).toISOString()}.`;
}

export function createAntigravityRoute(ports: AntigravityRoutePorts): (request: RouteRequest) => Promise<RouteResponse> {
  const fallbackId = ports.fallbackId ?? (() => randomUUID());
  const lastRouted = ports.lastRouted ?? new Map<string, string>();
  const exhaustedModels = ports.exhaustedModels ?? new Map<string, number>();
  // The account's measured buckets with every model the backend has refused as spent marked spent until it lifts; a lifted one is forgotten.
  const liveQuota = (nowMs: number): AntigravityQuotaMap | undefined => {
    for (const [model, resetAtMs] of exhaustedModels) {
      if (resetAtMs <= nowMs) {
        exhaustedModels.delete(model);
      }
    }
    return quotaWithExhaustions(ports.quotaSource?.(), exhaustedModels, nowMs);
  };

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

    const lookup = await ports.loadProvider(providerName);
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
    // `metadata.user_id` is stable for one Claude Code session; a request without one belongs to no session and is routed afresh every time.
    const sessionKey = parsed.data.metadata?.user_id === undefined ? undefined : `${parsed.data.metadata.user_id}\u0000${parsed.data.model ?? ""}`;
    const routeRequest = (): ReturnType<typeof translateRequest> => {
      const routed = translateRequest(parsed.data, config, { quota: liveQuota(nowMs), nowMs, previous: sessionKey === undefined ? undefined : lastRouted.get(sessionKey) });
      if (sessionKey !== undefined) {
        lastRouted.delete(sessionKey);
        lastRouted.set(sessionKey, routed.model);
        if (lastRouted.size > ROUTING_MEMORY_SESSIONS) {
          const oldest = lastRouted.keys().next();
          if (oldest.done !== true) {
            lastRouted.delete(oldest.value);
          }
        }
      }
      return routed;
    };
    let translated = routeRequest();
    // A model the backend refuses as spent is left and the request routed again, to a model not yet tried: the set is finite and each model is tried once, so this ends with an answer or the last refusal.
    const tried = new Set<string>();
    let iterator: AsyncIterator<GeminiGenerateContentResponseChunk>;
    let firstResult: IteratorResult<GeminiGenerateContentResponseChunk>;
    let schemaRetries = 0;
    for (;;) {
      tried.add(translated.model);
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
      iterator = upstreamChunks[Symbol.asyncIterator]();
      try {
        firstResult = await iterator.next();
        break;
      } catch (error) {
        if (error instanceof AntigravityUpstreamError) {
          if (error.status === HTTP_STATUS.badRequest && schemaRetries < MAX_SCHEMA_RETRIES) {
            const repaired = relaxRejectedRecursiveProperty(translated.request, error.body);
            if (repaired !== undefined) {
              schemaRetries += 1;
              translated = { ...translated, request: repaired };
              continue;
            }
          }
          const is429 = error.status === HTTP_STATUS.tooManyRequests;
          const learned = is429 ? parseQuotaExhaustion(error.body, nowMs) : undefined;
          if (learned !== undefined) {
            exhaustedModels.set(learned.model, learned.resetAtMs);
            const next = routeRequest();
            if (!tried.has(next.model)) {
              translated = next;
              continue;
            }
          }
          const quota = liveQuota(nowMs);
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
    }
    const relay = createAntigravityRelay({
      // The frame carries the model that actually served the request, as the real API echoes the concrete model behind an alias: a usage record read from the response then attributes quota to the backend model, not the tier alias the session typed.
      servedModel: translated.model,
      toolNames: translated.toolNames,
      fallbackId,
    });

    const quotaHeaders = unifiedAntigravityQuotaHeaders({
      quota: liveQuota(nowMs),
      rejected: false,
      nowMs,
      model: translated.model,
    });

    const frames = async function* (): AsyncGenerator<SseFrame> {
      try {
        if (firstResult.done !== true) {
          const step = relay.pushChunk(firstResult.value);
          for (const frame of step.frames) {
            yield frame;
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
                yield frame;
              }
              if (nextStep.done) {
                break;
              }
            }
          }
        }

        const finalStep = relay.finish();
        for (const frame of finalStep.frames) {
          yield frame;
        }
      } catch (error) {
        if (!request.signal.aborted) {
          const errMsg = error instanceof Error ? error.message : String(error);
          yield { event: "error", data: { type: "error", error: { type: "api_error", message: errMsg } } };
        }
      }
    };

    // The tier alias the session asked for, whenever the translation resolved it to a different model: the front door's mount turns it into the model choice the usage record keeps.
    const served = requestedModel !== translated.model ? { requestedModel } : {};

    // Only a request that asks for a stream gets one, as the Messages API answers; anything else (the auto mode classifier's side query, for one) is answered with the one message the frames add up to, which a client reads as JSON.
    if (parsed.data.stream === true) {
      const rendered = async function* (): AsyncGenerator<string> {
        for await (const frame of frames()) {
          yield renderSseFrame(frame);
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
        body: rendered(),
        ...served,
      };
    }

    for await (const frame of frames()) {
      if (frame.event === "error") {
        return { status: HTTP_STATUS.badGateway, headers: { "Content-Type": "application/json" }, body: JSON.stringify(frame.data) };
      }
    }
    return { status: HTTP_STATUS.ok, headers: { "Content-Type": "application/json", ...quotaHeaders }, body: JSON.stringify(relay.message()), ...served };
  };
}

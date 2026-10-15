import { randomUUID } from "node:crypto";
import { parseProviderPath } from "../frontdoor/route";
import { HTTP_STATUS } from "../codex/http";
import { MessagesRequestSchema } from "../codex/anthropic";
import { createAntigravityRelay, renderSseFrame } from "./relay";
import { translateRequest, type ResolvedAntigravityConfig } from "./translate";
import { callCloudAntigravity } from "./cloudUpstream";
import { callLocalAntigravity } from "./localUpstream";
import type { AcpConnection } from "./localUpstream";
import type { RouteRequest, RouteResponse } from "../codex/route";

export interface AntigravityProviderLookup {
  readonly ok: true;
  readonly config: ResolvedAntigravityConfig;
  readonly token: string;
  readonly credentialTarget?: "bearer" | "apiKey";
}

export interface AntigravityProviderLookupFailure {
  readonly ok: false;
  readonly status: number;
  readonly message: string;
}

export type AntigravityProviderResolution = AntigravityProviderLookup | AntigravityProviderLookupFailure;

export interface AntigravityRoutePorts {
  readonly loadProvider: (name: string) => AntigravityProviderResolution;
  readonly fallbackId?: () => string;
  readonly fetchFn?: typeof fetch;
  readonly localConnector?: (config: ResolvedAntigravityConfig, signal: AbortSignal) => AcpConnection;
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
    const translated = translateRequest(parsed.data, config);
    const relay = createAntigravityRelay({
      requestedModel: parsed.data.model ?? config.defaultModel,
      toolNames: translated.toolNames,
      fallbackId,
    });

    const stream = async function* () {
      try {
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

        for await (const chunk of upstreamChunks) {
          if (request.signal.aborted) {
            break;
          }
          const step = relay.pushChunk(chunk);
          for (const frame of step.frames) {
            yield renderSseFrame(frame);
          }
          if (step.done) {
            break;
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
      },
      body: stream(),
    };
  };
}

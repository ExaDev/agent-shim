import { randomUUID } from "node:crypto";

import type { ResolvedAntigravityConfig } from "./translate";
import type { GeminiGenerateContentRequest, GeminiGenerateContentResponseChunk } from "./geminiSchema";

export const CCPA_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const CCPA_DEFAULT_PROJECT_ID = "aicode-consumers";
export const CCPA_USER_AGENT =
  "antigravity/cli/1.3.5 (aidev_client; os_type=darwin; arch=arm64; cl=998863838; auth_method=consumer)";

function isCcpaEndpoint(endpoint: string): boolean {
  return endpoint.includes("cloudcode-pa.googleapis.com");
}

export interface CloudUpstreamParams {
  readonly config: ResolvedAntigravityConfig;
  readonly model: string;
  readonly request: GeminiGenerateContentRequest;
  readonly token: string;
  readonly credentialTarget?: "bearer" | "apiKey";
  readonly signal: AbortSignal;
}

/** Formats the target upstream URL based on provider settings. */
export function buildCloudUrl(config: ResolvedAntigravityConfig, model: string): string {
  const { cloud } = config;
  if (cloud.projectId !== undefined && cloud.location !== undefined) {
    const base = cloud.endpoint ?? `https://${cloud.location}-aiplatform.googleapis.com`;
    return `${base}/v1/projects/${cloud.projectId}/locations/${cloud.location}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  }
  const base = cloud.endpoint ?? CCPA_ENDPOINT;
  if (isCcpaEndpoint(base)) {
    return `${base}/v1internal:streamGenerateContent?alt=sse`;
  }
  return `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

/** Prepares headers for Google Cloud Code / Gemini / Vertex AI. */
export function buildCloudHeaders(
  token: string,
  credentialTarget?: "bearer" | "apiKey",
  endpoint?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const target = credentialTarget ?? "bearer";
  if (target === "apiKey") {
    headers["x-goog-api-key"] = token;
  } else {
    headers.Authorization = `Bearer ${token}`;
  }
  const base = endpoint ?? CCPA_ENDPOINT;
  if (isCcpaEndpoint(base)) {
    headers["User-Agent"] = CCPA_USER_AGENT;
  }
  return headers;
}

/** Formats the request body according to the target API (CCPA wrapper vs standard Gemini). */
export function buildCloudRequestBody(params: CloudUpstreamParams): string {
  const base = params.config.cloud.endpoint ?? CCPA_ENDPOINT;
  if (isCcpaEndpoint(base)) {
    return JSON.stringify({
      project: params.config.cloud.projectId ?? CCPA_DEFAULT_PROJECT_ID,
      requestId: `agent/${randomUUID()}/${String(Date.now())}/1`,
      request: params.request,
      model: params.model,
      userAgent: "antigravity",
    });
  }
  return JSON.stringify(params.request);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGeminiChunk(value: unknown): value is GeminiGenerateContentResponseChunk {
  return isRecord(value);
}

export class AntigravityUpstreamError extends Error {
  readonly status: number;
  readonly retryAfter?: string | null;

  constructor(status: number, message: string, retryAfter?: string | null) {
    super(`Google Antigravity API error (${String(status)}): ${message}`);
    this.name = "AntigravityUpstreamError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * Performs a streaming call to Google Cloud Code / Gemini / Vertex AI and yields parsed response chunks.
 */
export async function* callCloudAntigravity(
  params: CloudUpstreamParams,
  fetchFn: typeof fetch = fetch,
): AsyncIterable<GeminiGenerateContentResponseChunk> {
  const url = buildCloudUrl(params.config, params.model);
  const headers = buildCloudHeaders(params.token, params.credentialTarget, params.config.cloud.endpoint);
  const body = buildCloudRequestBody(params);

  const response = await fetchFn(url, {
    method: "POST",
    headers,
    body,
    signal: params.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    const retryAfter = response.headers.get("retry-after");
    throw new AntigravityUpstreamError(response.status, errorText, retryAfter);
  }

  if (response.body === null) {
    return;
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const sseDataPrefix = "data:";

  for await (const rawChunk of response.body) {
    const chunk = rawChunk instanceof Uint8Array ? rawChunk : Buffer.from(String(rawChunk));
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(sseDataPrefix)) {
        const jsonStr = trimmed.slice(sseDataPrefix.length).trim();
        if (jsonStr.length > 0) {
          try {
            const parsed: unknown = JSON.parse(jsonStr);
            if (isRecord(parsed)) {
              const unwrapped = isRecord(parsed.response) ? parsed.response : parsed;
              if (isGeminiChunk(unwrapped)) {
                yield unwrapped;
              }
            }
          } catch {
            // Ignore partial or unparseable SSE heartbeats
          }
        }
      }
    }
  }
}

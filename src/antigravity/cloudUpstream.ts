import type { ResolvedAntigravityConfig } from "./translate";
import type { GeminiGenerateContentRequest, GeminiGenerateContentResponseChunk } from "./geminiSchema";

export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";

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
  const base = cloud.endpoint ?? GEMINI_API_BASE_URL;
  return `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

/** Prepares headers for Google Gemini or Vertex AI. */
export function buildCloudHeaders(token: string, credentialTarget?: "bearer" | "apiKey"): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (credentialTarget === "apiKey") {
    headers["x-goog-api-key"] = token;
  } else {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
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
 * Performs a streaming call to Google Gemini / Vertex AI and yields parsed response chunks.
 */
export async function* callCloudAntigravity(
  params: CloudUpstreamParams,
  fetchFn: typeof fetch = fetch,
): AsyncIterable<GeminiGenerateContentResponseChunk> {
  const url = buildCloudUrl(params.config, params.model);
  const headers = buildCloudHeaders(params.token, params.credentialTarget);

  const response = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(params.request),
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
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              yield parsed;
            }
          } catch {
            // Ignore partial or unparseable SSE heartbeats
          }
        }
      }
    }
  }
}

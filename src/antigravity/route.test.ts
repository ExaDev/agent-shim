import { describe, expect, it } from "vitest";
import { HTTP_STATUS } from "../codex/http";
import { createAntigravityRoute } from "./route";
import { resolveAntigravityConfig, type ResolvedAntigravityConfig } from "./translate";

const DEFAULT_CLOUD_CONFIG: ResolvedAntigravityConfig = resolveAntigravityConfig({
  mode: "cloud",
  cloud: {
    endpoint: "https://generativelanguage.googleapis.com",
  },
});

const DEFAULT_LOCAL_CONFIG: ResolvedAntigravityConfig = resolveAntigravityConfig({
  mode: "local",
  local: {
    command: ["antigravity-acp"],
  },
});

const TEST_NOW_MS = 1_700_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collectStream(stream: Readonly<AsyncIterable<string>>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of stream) {
    parts.push(chunk);
  }
  return parts.join("");
}

describe("createAntigravityRoute", () => {
  it("rejects non-POST requests with 400", async () => {
    const route = createAntigravityRoute({
      loadProvider: () => ({ ok: false, status: 404, message: "not used" }),
    });

    const res = await route({
      method: "GET",
      path: "/providers/ag/v1/messages",
      body: "",
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.badRequest);
    expect(JSON.parse(res.body as string)).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "only POST is supported" },
    });
  });

  it("returns 404 when path does not contain provider name", async () => {
    const route = createAntigravityRoute({
      loadProvider: () => ({ ok: false, status: 404, message: "not used" }),
    });

    const res = await route({
      method: "POST",
      path: "/v1/messages",
      body: "{}",
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.notFound);
    expect(JSON.parse(res.body as string)).toEqual({
      type: "error",
      error: { type: "not_found_error", message: "no provider specified in path" },
    });
  });

  it("returns lookup failure status when provider not found", async () => {
    const route = createAntigravityRoute({
      loadProvider: (name) => ({
        ok: false,
        status: HTTP_STATUS.notFound,
        message: `unknown provider: ${name}`,
      }),
    });

    const res = await route({
      method: "POST",
      path: "/providers/unknown/v1/messages",
      body: "{}",
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.notFound);
    expect(JSON.parse(res.body as string)).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "unknown provider: unknown" },
    });
  });

  it("returns 400 on malformed JSON body", async () => {
    const route = createAntigravityRoute({
      loadProvider: () => ({
        ok: true,
        config: DEFAULT_CLOUD_CONFIG,
        token: "key-123",
      }),
    });

    const res = await route({
      method: "POST",
      path: "/providers/ag/v1/messages",
      body: "not json",
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.badRequest);
    expect(JSON.parse(res.body as string)).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "malformed JSON body" },
    });
  });

  it("returns 400 on schema validation failure", async () => {
    const route = createAntigravityRoute({
      loadProvider: () => ({
        ok: true,
        config: DEFAULT_CLOUD_CONFIG,
        token: "key-123",
      }),
    });

    const res = await route({
      method: "POST",
      path: "/providers/ag/v1/messages",
      body: JSON.stringify({ invalid: true }),
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.badRequest);
    expect(JSON.parse(res.body as string)).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });

  it("streams Anthropic SSE responses for cloud endpoints", async () => {
    const geminiSse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello from Gemini!"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":5,"totalTokenCount":20}}\n\n',
    ].join("");

    const mockFetch: typeof fetch = async (url, init) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      expect(urlStr).toContain("generativelanguage.googleapis.com");
      expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-api-key");
      return await Promise.resolve(
        new Response(geminiSse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    };

    const route = createAntigravityRoute({
      loadProvider: () => ({
        ok: true,
        config: DEFAULT_CLOUD_CONFIG,
        token: "test-api-key",
        credentialTarget: "apiKey",
      }),
      fetchFn: mockFetch,
    });

    const res = await route({
      method: "POST",
      path: "/providers/ag/v1/messages",
      body: JSON.stringify({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
      }),
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.ok);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");

    const fullStream = await collectStream(res.body as AsyncIterable<string>);
    expect(fullStream).toContain("event: message_start");
    expect(fullStream).toContain("event: content_block_start");
    expect(fullStream).toContain("event: content_block_delta");
    expect(fullStream).toContain("Hello from Gemini!");
    expect(fullStream).toContain("event: content_block_stop");
    expect(fullStream).toContain("event: message_delta");
    expect(fullStream).toContain('"stop_reason":"end_turn"');
    expect(fullStream).toContain("event: message_stop");
  });

  it("streams Anthropic SSE responses for local ACP daemon", async () => {
    const fakeConnector = () => {
      return {
        send: () => undefined,
        lines: (async function* () {
          await Promise.resolve();
          yield JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "sess-1" } });
          yield JSON.stringify({
            jsonrpc: "2.0",
            method: "agent/messageChunk",
            params: {
              chunk: {
                candidates: [{ content: { parts: [{ text: "Hello from local ACP!" }] } }],
              },
            },
          });
          yield JSON.stringify({
            jsonrpc: "2.0",
            method: "agent/messageChunk",
            params: {
              chunk: {
                candidates: [{ finishReason: "STOP" }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
              },
            },
          });
        })(),
        close: () => undefined,
      };
    };

    const route = createAntigravityRoute({
      loadProvider: () => ({
        ok: true,
        config: DEFAULT_LOCAL_CONFIG,
        token: "",
      }),
      localConnector: fakeConnector,
    });

    const res = await route({
      method: "POST",
      path: "/providers/ag-local/v1/messages",
      body: JSON.stringify({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi local" }],
      }),
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.ok);
    const fullStream = await collectStream(res.body as AsyncIterable<string>);
    expect(fullStream).toContain("event: message_start");
    expect(fullStream).toContain("Hello from local ACP!");
    expect(fullStream).toContain("event: message_stop");
  });

  it("returns error response with status code when upstream rejects", async () => {
    const mockFetch: typeof fetch = async () => {
      return await Promise.resolve(new Response("Unauthorized", { status: 401 }));
    };

    const route = createAntigravityRoute({
      loadProvider: () => ({
        ok: true,
        config: DEFAULT_CLOUD_CONFIG,
        token: "bad-key",
      }),
      fetchFn: mockFetch,
    });

    const res = await route({
      method: "POST",
      path: "/providers/ag/v1/messages",
      body: JSON.stringify({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
      }),
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.unauthorized);
    expect(res.headers["Content-Type"]).toBe("application/json");
    const body: unknown = typeof res.body === "string" ? JSON.parse(res.body) : null;
    const errMsg = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" ? body.error.message : "";
    expect(errMsg).toContain("Google Antigravity API error (401)");
  });

  it("returns 429 with unified rate-limit headers on quota exhaustion", async () => {
    const mockFetch: typeof fetch = async () => {
      return await Promise.resolve(
        new Response("Resource has been exhausted (e.g. check quota)", {
          status: HTTP_STATUS.tooManyRequests,
          headers: { "retry-after": "45" },
        }),
      );
    };

    const route = createAntigravityRoute({
      loadProvider: () => ({
        ok: true,
        config: DEFAULT_CLOUD_CONFIG,
        token: "key",
      }),
      fetchFn: mockFetch,
    });

    const res = await route({
      method: "POST",
      path: "/providers/ag/v1/messages",
      body: JSON.stringify({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
      }),
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.tooManyRequests);
    expect(res.headers["anthropic-ratelimit-unified-status"]).toBe("rejected");
    expect(res.headers["anthropic-ratelimit-unified-5h-utilization"]).toBe("100");
    expect(res.headers["anthropic-ratelimit-unified-7d-utilization"]).toBe("100");
    expect(res.headers["retry-after"]).toBe("45");
    const body: unknown = typeof res.body === "string" ? JSON.parse(res.body) : null;
    const errType = isRecord(body) && isRecord(body.error) && typeof body.error.type === "string" ? body.error.type : "";
    expect(errType).toBe("rate_limit_error");
  });

  it("attaches local ACP quota headers when quotaSource is provided", async () => {
    const fakeConnector = () => {
      return {
        send: () => undefined,
        lines: (async function* () {
          await Promise.resolve();
          yield JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              delta: { text: "Hello with quota!" },
              finishReason: "STOP",
            },
          });
        })(),
        close: () => undefined,
      };
    };

    const route = createAntigravityRoute({
      loadProvider: () => ({
        ok: true,
        config: DEFAULT_LOCAL_CONFIG,
        token: "",
      }),
      localConnector: fakeConnector,
      quotaSource: () => ({
        "3p-5h": { remaining_fraction: 0.8, reset_in_seconds: 3600 },
        "3p-weekly": { remaining_fraction: 0.95, reset_in_seconds: 86400 },
      }),
      now: () => TEST_NOW_MS,
    });

    const res = await route({
      method: "POST",
      path: "/providers/ag-local/v1/messages",
      body: JSON.stringify({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
      }),
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.ok);
    expect(res.headers["anthropic-ratelimit-unified-status"]).toBe("allowed");
    expect(res.headers["anthropic-ratelimit-unified-5h-utilization"]).toBe("20");
    expect(res.headers["anthropic-ratelimit-unified-7d-utilization"]).toBe("5");
  });
});

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
const FIVE_HOURS_SEC = 18_000;
const SEVEN_DAYS_SEC = 604_800;
/** How many seconds a request may take between the quota being read and the response being built. */
const SLACK_SEC = 30;

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
      loadProvider: async () => await Promise.resolve({ ok: false, status: 404, message: "not used" }),
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
      loadProvider: async () => await Promise.resolve({ ok: false, status: 404, message: "not used" }),
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
      loadProvider: async (name) => await Promise.resolve({
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
      loadProvider: async () => await Promise.resolve({
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
      loadProvider: async () => await Promise.resolve({
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
      loadProvider: async () => await Promise.resolve({
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
        stream: true,
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
      loadProvider: async () => await Promise.resolve({
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
        stream: true,
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

  it("answers a request that does not ask for a stream with one JSON message, as the Messages API does, so a client such as auto mode's classifier finds its usage", async () => {
    const geminiSse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"allow"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"bash_exec","args":{"command":"ls"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":5,"totalTokenCount":20}}\n\n',
    ].join("");
    const route = createAntigravityRoute({
      loadProvider: async () => await Promise.resolve({ ok: true, config: DEFAULT_CLOUD_CONFIG, token: "test-api-key", credentialTarget: "apiKey" }),
      fetchFn: async () => await Promise.resolve(new Response(geminiSse, { status: 200, headers: { "Content-Type": "text/event-stream" } })),
    });

    const res = await route({
      method: "POST",
      path: "/providers/ag/v1/messages",
      body: JSON.stringify({ model: "claude-3-7-sonnet-20250219", max_tokens: 1024, tools: [{ name: "bash_exec", description: "Runs a command", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "Hi" }] }),
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.ok);
    expect(res.headers["Content-Type"]).toBe("application/json");
    const message: unknown = JSON.parse(res.body as string);
    expect(message).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "allow" }, { type: "tool_use", name: "bash_exec", input: { command: "ls" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 15, output_tokens: 5 },
    });
  });

  it("returns error response with status code when upstream rejects", async () => {
    const mockFetch: typeof fetch = async () => {
      return await Promise.resolve(new Response("Unauthorized", { status: 401 }));
    };

    const route = createAntigravityRoute({
      loadProvider: async () => await Promise.resolve({
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

  const rejectedByBackend: typeof fetch = async () =>
    await Promise.resolve(new Response("Resource has been exhausted (e.g. check quota)", { status: HTTP_STATUS.tooManyRequests, headers: { "retry-after": "45" } }));

  // One candidate per tier, so these requests have no other family to be routed to and what is asserted is the translation of the model's own quota.
  const SINGLE_CANDIDATE_CONFIG = resolveAntigravityConfig({ mode: "cloud", cloud: { endpoint: "https://generativelanguage.googleapis.com" }, models: { haiku: "gemini-3.8-flash-low" } });
  const askFromClaudeCode = async (quotaSource?: () => Record<string, { remaining_fraction: number; reset_in_seconds: number }>) =>
    await createAntigravityRoute({
      loadProvider: async () => await Promise.resolve({ ok: true, config: SINGLE_CANDIDATE_CONFIG, token: "key" }),
      fetchFn: rejectedByBackend,
      ...(quotaSource === undefined ? {} : { quotaSource }),
    })({
      method: "POST",
      path: "/providers/ag/v1/messages",
      // A Claude model name the door translates to a Gemini model: the quota must be that of the model the request spends.
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1024, messages: [{ role: "user", content: "Hi" }] }),
      signal: new AbortController().signal,
    });

  const errorOf = (res: { body?: unknown }): Record<string, unknown> => {
    const body: unknown = typeof res.body === "string" ? JSON.parse(res.body) : null;
    return isRecord(body) && isRecord(body.error) ? body.error : {};
  };

  it("answers a 429 on a spent window with that window's claim, reset and a non-retryable rejection, drawn from the translated model's buckets", async () => {
    const res = await askFromClaudeCode(() => ({
      // The Gemini buckets the translated request spends: the 5-hour one is spent.
      "gemini-5h": { remaining_fraction: 0, reset_in_seconds: FIVE_HOURS_SEC },
      "gemini-weekly": { remaining_fraction: 0.7, reset_in_seconds: SEVEN_DAYS_SEC },
      // The third-party buckets the Claude model name alone would have selected: unspent, and must not decide the answer.
      "3p-5h": { remaining_fraction: 0.9, reset_in_seconds: 60 },
    }));

    expect(res.status).toBe(HTTP_STATUS.tooManyRequests);
    expect(res.headers["anthropic-ratelimit-unified-status"]).toBe("rejected");
    expect(res.headers["anthropic-ratelimit-unified-representative-claim"]).toBe("five_hour");
    expect(res.headers["x-should-retry"]).toBe("false");
    // The time until the 5-hour window resets (give or take the seconds the request took), not the backend's 45-second hint.
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(FIVE_HOURS_SEC - SLACK_SEC);
    expect(errorOf(res).type).toBe("rate_limit_error");
    expect(errorOf(res).message).toMatch(/^Antigravity 5-hour limit reached; it resets at /);
  });

  it("sends a request to the next family when the shipped candidate's window is spent, and keeps the session there", async () => {
    const urls: string[] = [];
    const recordingBackend: typeof fetch = async (input) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return await Promise.resolve(new Response("Resource has been exhausted (e.g. check quota)", { status: HTTP_STATUS.tooManyRequests }));
    };
    let quota: Record<string, { remaining_fraction: number; reset_in_seconds: number }> = { "gemini-5h": { remaining_fraction: 0, reset_in_seconds: FIVE_HOURS_SEC } };
    const route = createAntigravityRoute({ loadProvider: async () => await Promise.resolve({ ok: true, config: DEFAULT_CLOUD_CONFIG, token: "key" }), fetchFn: recordingBackend, quotaSource: () => quota });
    const ask = async (): Promise<unknown> =>
      await route({ method: "POST", path: "/providers/ag/v1/messages", body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1024, metadata: { user_id: "session-1" }, messages: [{ role: "user", content: "Hi" }] }), signal: new AbortController().signal });
    await ask();
    quota = {};
    await ask();
    expect(urls[0]).toContain("gemini-4-argon-low");
    // The Gemini window has lifted, yet the session stays on the model it is on, so its prompt cache is not thrown away.
    expect(urls[1]).toContain("gemini-4-argon-low");
  });

  it("keeps a session on its model across remountings when the caller shares the routing memory, as the front door's per-request mounting does", async () => {
    const urls: string[] = [];
    const recordingBackend: typeof fetch = async (input) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return await Promise.resolve(new Response("Resource has been exhausted (e.g. check quota)", { status: HTTP_STATUS.tooManyRequests }));
    };
    let quota: Record<string, { remaining_fraction: number; reset_in_seconds: number }> = { "gemini-5h": { remaining_fraction: 0, reset_in_seconds: FIVE_HOURS_SEC } };
    // One map held by the caller, handed to each mounting: the resolver builds the route afresh per request, and without the shared memory every remount forgets where the session was.
    const lastRouted = new Map<string, string>();
    const mount = (): ReturnType<typeof createAntigravityRoute> =>
      createAntigravityRoute({ loadProvider: async () => await Promise.resolve({ ok: true, config: DEFAULT_CLOUD_CONFIG, token: "key" }), fetchFn: recordingBackend, quotaSource: () => quota, lastRouted });
    const ask = async (): Promise<void> => {
      await mount()({ method: "POST", path: "/providers/ag/v1/messages", body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1024, metadata: { user_id: "session-1" }, messages: [{ role: "user", content: "hi" }] }), signal: new AbortController().signal });
    };
    await ask();
    quota = {};
    await ask();
    expect(urls[0]).toContain("gemini-4-argon-low");
    expect(urls[1]).toContain("gemini-4-argon-low");
  });

  it("answers a 429 no bucket explains as a plain throttle: the backend's retry hint and no claim on a window", async () => {
    const res = await askFromClaudeCode();

    expect(res.status).toBe(HTTP_STATUS.tooManyRequests);
    expect(res.headers["retry-after"]).toBe("45");
    expect(res.headers["anthropic-ratelimit-unified-status"]).toBeUndefined();
    expect(res.headers["x-should-retry"]).toBeUndefined();
    expect(errorOf(res).type).toBe("rate_limit_error");
  });

  it("attaches local ACP quota headers from the translated model's buckets when quotaSource is provided", async () => {
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
      loadProvider: async () => await Promise.resolve({
        ok: true,
        config: DEFAULT_LOCAL_CONFIG,
        token: "",
      }),
      localConnector: fakeConnector,
      quotaSource: () => ({
        "gemini-5h": { remaining_fraction: 0.8, reset_in_seconds: 3600 },
        "gemini-weekly": { remaining_fraction: 0.95, reset_in_seconds: 86400 },
      }),
      now: () => TEST_NOW_MS,
    });

    const res = await route({
      method: "POST",
      path: "/providers/ag-local/v1/messages",
      body: JSON.stringify({
        model: "gemini-3.8-flash-medium",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
      }),
      signal: new AbortController().signal,
    });

    expect(res.status).toBe(HTTP_STATUS.ok);
    expect(res.headers["anthropic-ratelimit-unified-status"]).toBe("allowed");
    expect(res.headers["anthropic-ratelimit-unified-5h-utilization"]).toBe("0.200");
    expect(res.headers["anthropic-ratelimit-unified-7d-utilization"]).toBe("0.050");
  });
});

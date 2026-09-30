import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "./http";
import type { UsageSnapshot } from "./quota";
import { codexProviderBaseUrl, createCodexRoute, type CodexProviderLookup, type RouteRequest } from "./route";
import { CODEX_TOOL_NAME_LIMIT, resolveCodexConfig } from "./translate";
import { sessionIdFor } from "./upstream";
import type { UpstreamResponse } from "./upstreamPort";
import {
  collectBody,
  FAKE_ACCESS_TOKEN,
  FAKE_REFRESHED_ACCESS_TOKEN,
  fakeAuth,
  fakeResponse,
  manualTimers,
  parseAnthropicSse,
  recordingFetch,
  type RecordedCall,
} from "./testing";

const MESSAGES_PATH = "/providers/codex/v1/messages";
const COUNT_PATH = "/providers/codex/v1/messages/count_tokens";
const NOW = 1_800_000_000_000;
const DAEMON_PORT = 4100;
const MS_PER_SECOND = 1000;
const COUNTED_CHARS = 400;

/** A successful text turn as the backend streams it, including a reasoning item the relay must skip. */
const TEXT_TURN = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
  { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "thinking" },
  { type: "response.output_item.done", output_index: 0 },
  { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1" } },
  { type: "response.output_text.delta", output_index: 1, delta: "Hello" },
  { type: "response.output_text.delta", output_index: 1, delta: ", world" },
  { type: "response.output_item.done", output_index: 1 },
  {
    type: "response.completed",
    response: { id: "resp_1", status: "completed", usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 60 } } },
  },
];

/** A tool-call turn. */
function toolTurn(name: string): unknown[] {
  return [
    { type: "response.created", response: { id: "resp_2" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"command":' },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '"ls"}' },
    { type: "response.output_item.done", output_index: 0 },
    { type: "response.completed", response: { id: "resp_2", status: "completed", usage: { input_tokens: 10, output_tokens: 3 } } },
  ];
}

interface Harness {
  readonly route: ReturnType<typeof createCodexRoute>;
  readonly fetch: ReturnType<typeof recordingFetch>;
  readonly auth: ReturnType<typeof fakeAuth>;
  readonly snapshots: UsageSnapshot[];
  readonly logs: string[];
}

function harness(respond: (call: RecordedCall, index: number) => UpstreamResponse | Promise<UpstreamResponse>, lookup?: (name: string) => CodexProviderLookup): Harness {
  const fetch = recordingFetch(respond);
  const auth = fakeAuth();
  const snapshots: UsageSnapshot[] = [];
  const logs: string[] = [];
  let ids = 0;
  const route = createCodexRoute({
    upstream: { fetch: fetch.fetch, auth, timers: manualTimers(), randomId: () => `random-${String((ids += 1))}` },
    loadProvider: lookup ?? (() => ({ ok: true, config: resolveCodexConfig(undefined) })),
    writeUsageSnapshot: (snapshot) => {
      snapshots.push(snapshot);
    },
    now: () => NOW,
    log: (line) => {
      logs.push(line);
    },
  });
  return { route, fetch, auth, snapshots, logs };
}

function post(path: string, body: unknown, signal: AbortSignal = new AbortController().signal): RouteRequest {
  return { method: "POST", path, body: JSON.stringify(body), signal };
}

function upstreamBody(call: RecordedCall | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(call?.init.body ?? "null");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("upstream body was not an object");
  }
  return Object.fromEntries(Object.entries(parsed));
}

describe("codex route: streaming", () => {
  it("relays a text turn as Anthropic SSE, skipping reasoning, with cache-aware usage", async () => {
    const { route, fetch } = harness(() => fakeResponse({ events: TEXT_TURN, headers: { "x-codex-primary-used-percent": "12" } }));
    const response = await route(post(MESSAGES_PATH, { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "Hi" }], stream: true }));
    expect(response.status).toBe(HTTP_STATUS.ok);
    expect(response.headers["Content-Type"]).toBe("text/event-stream");
    expect(response.headers["x-codex-primary-used-percent"]).toBe("12");
    const events = parseAnthropicSse(await collectBody(response.body));
    expect(events.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]?.data).toMatchObject({ message: { id: "resp_1", model: "claude-sonnet-4-5", role: "assistant" } });
    expect(events[1]?.data).toEqual({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    expect(events[2]?.data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
    expect(events[5]?.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 60, output_tokens: 7 },
    });
    expect(upstreamBody(fetch.calls[0])).toMatchObject({ model: "gpt-5.6-terra", stream: true });
  });

  it("relays a tool call with the original long tool name restored", async () => {
    const longName = `mcp__${"x".repeat(CODEX_TOOL_NAME_LIMIT)}`;
    let shortName = "";
    const { route } = harness((call) => {
      const tools: unknown = upstreamBody(call).tools;
      const first: unknown = Array.isArray(tools) ? tools.at(0) : undefined;
      shortName = typeof first === "object" && first !== null && "name" in first && typeof first.name === "string" ? first.name : "";
      return fakeResponse({ events: toolTurn(shortName) });
    });
    const response = await route(post(MESSAGES_PATH, { messages: [{ role: "user", content: "go" }], tools: [{ name: longName, input_schema: { type: "object" } }], stream: true }));
    const events = parseAnthropicSse(await collectBody(response.body));
    expect(shortName).not.toBe(longName);
    expect(events[1]?.data).toEqual({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: longName, input: {} } });
    expect(events[2]?.data).toEqual({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } });
    expect(events.find((event) => event.event === "message_delta")?.data).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });

  it("reports an incomplete response as max_tokens", async () => {
    const events = [{ type: "response.created", response: {} }, { type: "response.completed", response: { status: "incomplete" } }];
    const { route } = harness(() => fakeResponse({ events }));
    const response = await route(post(MESSAGES_PATH, { messages: [], stream: true }));
    const relayed = parseAnthropicSse(await collectBody(response.body));
    expect(relayed.find((event) => event.event === "message_delta")?.data).toMatchObject({ delta: { stop_reason: "max_tokens" } });
  });

  it("turns a backend stream failure into an SSE error event", async () => {
    const { route } = harness(() => fakeResponse({ events: [{ type: "response.created", response: {} }, { type: "response.failed", response: { error: { message: "overloaded" } } }] }));
    const response = await route(post(MESSAGES_PATH, { messages: [], stream: true }));
    const relayed = parseAnthropicSse(await collectBody(response.body));
    expect(relayed.at(-1)).toEqual({ event: "error", data: { type: "error", error: { type: "api_error", message: "overloaded" } } });
  });

  it("reports a stream that ends without completing", async () => {
    const { route, logs } = harness(() => fakeResponse({ events: [{ type: "response.created", response: {} }] }));
    const response = await route(post(MESSAGES_PATH, { messages: [], stream: true }));
    const relayed = parseAnthropicSse(await collectBody(response.body));
    expect(relayed.at(-1)?.event).toBe("error");
    expect(JSON.stringify(relayed.at(-1)?.data)).toContain("ended without completing");
    expect(logs.some((line) => line.includes("ended without completing"))).toBe(true);
  });
});

describe("codex route: single response", () => {
  it("aggregates the stream into one Anthropic message", async () => {
    const { route } = harness(() => fakeResponse({ events: TEXT_TURN }));
    const response = await route(post(MESSAGES_PATH, { model: "claude-opus-4-7", messages: [{ role: "user", content: "Hi" }] }));
    expect(response.status).toBe(HTTP_STATUS.ok);
    expect(JSON.parse(await collectBody(response.body))).toEqual({
      id: "resp_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "Hello, world" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 60, output_tokens: 7 },
    });
  });

  it("parses tool arguments, and keeps a truncated one as an empty object", async () => {
    const truncated = [
      { type: "response.created", response: {} },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c", name: "Bash" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"comm' },
      { type: "response.completed", response: {} },
    ];
    const whole = await harness(() => fakeResponse({ events: toolTurn("Bash") })).route(post(MESSAGES_PATH, { messages: [] }));
    expect(JSON.parse(await collectBody(whole.body))).toMatchObject({ content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" });
    const cut = await harness(() => fakeResponse({ events: truncated })).route(post(MESSAGES_PATH, { messages: [] }));
    expect(JSON.parse(await collectBody(cut.body))).toMatchObject({ content: [{ type: "tool_use", input: {} }] });
  });

  it("answers an empty completion with one empty text block", async () => {
    const { route } = harness(() => fakeResponse({ events: [{ type: "response.completed", response: {} }] }));
    const response = await route(post(MESSAGES_PATH, { messages: [] }));
    expect(JSON.parse(await collectBody(response.body))).toMatchObject({ content: [{ type: "text", text: "" }] });
  });

  it("answers a backend stream failure with a 500 error", async () => {
    const { route } = harness(() => fakeResponse({ events: [{ type: "error", message: "boom" }] }));
    const response = await route(post(MESSAGES_PATH, { messages: [] }));
    expect(response.status).toBe(HTTP_STATUS.internalServerError);
    expect(JSON.parse(await collectBody(response.body))).toEqual({ type: "error", error: { type: "api_error", message: "boom" } });
  });
});

describe("codex route: upstream request", () => {
  it("sends the auth headers, and a session_id derived per session from metadata.user_id", async () => {
    const { route, fetch } = harness(() => fakeResponse({ events: TEXT_TURN }));
    await route(post(MESSAGES_PATH, { messages: [], metadata: { user_id: "session-a" } }));
    await route(post(MESSAGES_PATH, { messages: [], metadata: { user_id: "session-a" } }));
    await route(post(MESSAGES_PATH, { messages: [], metadata: { user_id: "session-b" } }));
    const sessionIds = fetch.calls.map((call) => call.init.headers.session_id);
    expect(sessionIds[0]).toBe(sessionIdFor("session-a", () => "unused"));
    expect(sessionIds[1]).toBe(sessionIds[0]);
    expect(sessionIds[2]).not.toBe(sessionIds[0]);
    expect(sessionIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sessionIds[0]).not.toContain("session-a");
    expect(fetch.calls[0]?.init.headers).toMatchObject({
      Authorization: `Bearer ${FAKE_ACCESS_TOKEN}`,
      "chatgpt-account-id": "fake-account",
      Accept: "text/event-stream",
      originator: "codex_cli_rs",
    });
    expect(upstreamBody(fetch.calls[0]).prompt_cache_key).toBe("session-a");
  });

  it("gives a request with no user id a fresh session id of its own", async () => {
    const { route, fetch } = harness(() => fakeResponse({ events: TEXT_TURN }));
    await route(post(MESSAGES_PATH, { messages: [] }));
    await route(post(MESSAGES_PATH, { messages: [] }));
    expect(fetch.calls.map((call) => call.init.headers.session_id)).toEqual(["random-1", "random-2"]);
  });

  it("refreshes once on a 401 and resends with the new token", async () => {
    const { route, fetch, auth } = harness((_call, index) => (index === 0 ? fakeResponse({ status: HTTP_STATUS.unauthorized, text: "expired" }) : fakeResponse({ events: TEXT_TURN })));
    const response = await route(post(MESSAGES_PATH, { messages: [] }));
    expect(response.status).toBe(HTTP_STATUS.ok);
    expect(auth.refreshed).toEqual([FAKE_ACCESS_TOKEN]);
    expect(fetch.calls[1]?.init.headers.Authorization).toBe(`Bearer ${FAKE_REFRESHED_ACCESS_TOKEN}`);
  });

  it("uses the named provider's translation settings", async () => {
    const lookups: string[] = [];
    const { route, fetch } = harness(
      () => fakeResponse({ events: TEXT_TURN }),
      (name) => {
        lookups.push(name);
        return { ok: true, config: resolveCodexConfig({ models: { sonnet: "gpt-custom" }, effort: "high" }) };
      },
    );
    await route(post("/providers/work%20codex/v1/messages", { model: "claude-sonnet-4-5", messages: [] }));
    expect(lookups).toEqual(["work codex"]);
    expect(upstreamBody(fetch.calls[0])).toMatchObject({ model: "gpt-custom", reasoning: { effort: "high" } });
    expect(codexProviderBaseUrl(DAEMON_PORT, "work codex")).toBe(`http://127.0.0.1:${String(DAEMON_PORT)}/providers/work%20codex`);
  });
});

describe("codex route: refusals and quota", () => {
  it("maps a 429 to the Anthropic rate-limit surface with retry-after and a usage snapshot", async () => {
    const resetAt = 1_800_003_600;
    const { route, snapshots } = harness(() =>
      fakeResponse({
        status: HTTP_STATUS.tooManyRequests,
        headers: { "x-codex-primary-reset-at": String(resetAt), "x-codex-secondary-window-minutes": "300", "x-codex-secondary-used-percent": "80", "x-codex-secondary-reset-at": String(resetAt - 1) },
        text: JSON.stringify({ error: { message: "usage limit", resets_in_seconds: 12.5 } }),
      }),
    );
    const response = await route(post(MESSAGES_PATH, { messages: [] }));
    expect(response.status).toBe(HTTP_STATUS.tooManyRequests);
    expect(response.headers).toMatchObject({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-7d-utilization": "100",
      "anthropic-ratelimit-unified-7d-reset": String(resetAt),
      "anthropic-ratelimit-unified-5h-utilization": "80",
      "anthropic-ratelimit-unified-reset": String(resetAt - 1),
      "retry-after": "13",
      "x-codex-primary-reset-at": String(resetAt),
    });
    const body: unknown = JSON.parse(await collectBody(response.body));
    expect(body).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
    expect(snapshots).toEqual([
      {
        updated_at: new Date(NOW).toISOString(),
        seven_day: { used_percentage: 100, resets_at: new Date(resetAt * MS_PER_SECOND).toISOString() },
        five_hour: { used_percentage: 80, resets_at: new Date((resetAt - 1) * MS_PER_SECOND).toISOString() },
      },
    ]);
  });

  it("answers an unreachable backend with a 502 naming the failure", async () => {
    const { route } = harness(() => {
      throw new TypeError("fetch failed");
    });
    const response = await route(post(MESSAGES_PATH, { messages: [] }));
    expect(response.status).toBe(HTTP_STATUS.badGateway);
    expect(await collectBody(response.body)).toContain("fetch failed");
  });

  it.each([
    [{ method: "GET", path: "/healthz" }, HTTP_STATUS.ok],
    [{ method: "GET", path: MESSAGES_PATH }, HTTP_STATUS.methodNotAllowed],
    [{ method: "POST", path: "/v1/messages" }, HTTP_STATUS.notFound],
    [{ method: "POST", path: "/providers/codex/v1/other" }, HTTP_STATUS.notFound],
  ])("routes %j to %i", async (request, status) => {
    const { route, fetch } = harness(() => fakeResponse({ events: TEXT_TURN }));
    const response = await route({ ...request, body: "{}", signal: new AbortController().signal });
    expect(response.status).toBe(status);
    expect(fetch.calls).toEqual([]);
  });

  it("refuses an unknown provider, invalid JSON and a malformed request without calling upstream", async () => {
    const unknown = harness(() => fakeResponse({ events: TEXT_TURN }), () => ({ ok: false, status: HTTP_STATUS.notFound, message: "no provider named x" }));
    expect((await unknown.route(post(MESSAGES_PATH, { messages: [] }))).status).toBe(HTTP_STATUS.notFound);
    const { route, fetch } = harness(() => fakeResponse({ events: TEXT_TURN }));
    expect((await route({ method: "POST", path: MESSAGES_PATH, body: "{bad", signal: new AbortController().signal })).status).toBe(HTTP_STATUS.badRequest);
    const malformed = await route(post(MESSAGES_PATH, { messages: "nope" }));
    expect(malformed.status).toBe(HTTP_STATUS.badRequest);
    expect(await collectBody(malformed.body)).toContain("messages");
    expect(fetch.calls).toEqual([]);
  });

  it("estimates count_tokens locally", async () => {
    const { route, fetch } = harness(() => fakeResponse({ events: TEXT_TURN }));
    const response = await route(post(COUNT_PATH, { messages: [{ role: "user", content: "x".repeat(COUNTED_CHARS) }] }));
    const body: unknown = JSON.parse(await collectBody(response.body));
    expect(body).toMatchObject({ input_tokens: expect.any(Number) as unknown });
    expect(fetch.calls).toEqual([]);
  });
});

describe("codex route: client disconnect", () => {
  it("passes the client's signal to the upstream call, so a disconnect aborts it", async () => {
    const client = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    let markFetched: () => void = () => undefined;
    const fetched = new Promise<void>((resolve) => {
      markFetched = resolve;
    });
    const { route } = harness(
      async (call) =>
        await new Promise<UpstreamResponse>((_resolve, reject) => {
          upstreamSignal = call.init.signal;
          call.init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
          markFetched();
        }),
    );
    const pending = route(post(MESSAGES_PATH, { messages: [], stream: true }, client.signal));
    await fetched;
    expect(upstreamSignal?.aborted).toBe(false);
    client.abort();
    const response = await pending;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(HTTP_STATUS.clientClosedRequest);
  });

  it("stops relaying without an error frame when the client goes away mid-stream", async () => {
    const client = new AbortController();
    const encoder = new TextEncoder();
    async function* body(): AsyncGenerator<Uint8Array> {
      yield encoder.encode(`data: ${JSON.stringify({ type: "response.created", response: {} })}\n\n`);
      client.abort();
      await Promise.resolve();
      throw new DOMException("aborted", "AbortError");
    }
    const { route } = harness(() => ({ ...fakeResponse({}), body: body() }));
    const response = await route(post(MESSAGES_PATH, { messages: [], stream: true }, client.signal));
    const relayed = parseAnthropicSse(await collectBody(response.body));
    expect(relayed.map((event) => event.event)).toEqual(["message_start"]);
  });
});

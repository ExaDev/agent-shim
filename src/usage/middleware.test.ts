import * as zlib from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import type { ResponseBodyObserver, ResponseOutcome, RoutedResponseEvent } from "../frontdoor/pipeline";
import { ANTHROPIC_PROVIDER, createUsageMiddleware } from "./middleware";
import { USAGE_SCHEMA_VERSION, UsageRecordSchema, type UsageRecord } from "./schema";

const RECEIVED_AT = Date.parse("2026-01-15T12:00:00.000Z");
const UTF8_LEAD_BYTE_OF_I_DIAERESIS = 0xc3;
const JSON_SPLIT_OFFSET = 30;
const GZIP_HEADER_LENGTH = 10;
const BAD_GATEWAY_STATUS = 502;
const HEAD_DELAY_MS = 120;
const BODY_DELAY_MS = 800;
const OK_STATUS = 200;
const RATE_LIMITED_STATUS = 429;
const SECRET_PROMPT = "the user's confidential prompt text";
const SECRET_REPLY = "the model's confidential reply text";
const BEARER_TOKEN = "sk-ant-REDACTED";
const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8" };
const JSON_HEADERS = { "content-type": "application/json" };

function event(overrides: Partial<RoutedResponseEvent> = {}): RoutedResponseEvent {
  return {
    session: { identity: "work", sessionId: "session-1", provider: undefined, headroom: false, projectId: undefined },
    route: "passthrough",
    method: "POST",
    path: "/v1/messages",
    receivedAt: RECEIVED_AT,
    status: OK_STATUS,
    headers: SSE_HEADERS,
    ...overrides,
  };
}

function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

const STREAM_BODY = [
  sse("message_start", { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-test", content: [], usage: { input_tokens: 25, cache_read_input_tokens: 4 } } }),
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: SECRET_REPLY } }),
  sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }),
  sse("message_stop", { type: "message_stop" }),
].join("");

const EXPECTED_STREAM_USAGE = { inputTokens: 25, cacheReadInputTokens: 4, outputTokens: 42 };

interface Harness {
  readonly records: UsageRecord[];
  readonly logged: string[];
  readonly deferred: (() => void)[];
  readonly clock: { nowMs: number };
  readonly observe: ReturnType<typeof createUsageMiddleware>;
  /** Runs the work the middleware deferred to a later turn. */
  readonly flush: () => void;
  /** Waits for the work an asynchronous decompressor deferred, then runs it. */
  readonly settle: () => Promise<void>;
}

function harness(options: { readonly record?: (record: UsageRecord) => void } = {}): Harness {
  const records: UsageRecord[] = [];
  const logged: string[] = [];
  const deferred: (() => void)[] = [];
  const clock = { nowMs: RECEIVED_AT };
  const observe = createUsageMiddleware({
    record:
      options.record ??
      ((record) => {
        records.push(record);
      }),
    defer: (task) => {
      deferred.push(task);
    },
    now: () => clock.nowMs,
    log: (line) => {
      logged.push(line);
    },
  });
  const flush = (): void => {
    for (const task of deferred.splice(0)) {
      task();
    }
  };
  return {
    records,
    logged,
    deferred,
    clock,
    observe,
    flush,
    settle: async () => {
      await vi.waitFor(() => {
        expect(deferred).toHaveLength(1);
      });
      flush();
    },
  };
}

/** Starts observing a response the way the pipeline does: the head arrives `HEAD_DELAY_MS` after the request. */
function begin(h: Harness, routed: RoutedResponseEvent): ResponseBodyObserver {
  h.clock.nowMs = routed.receivedAt + HEAD_DELAY_MS;
  const body = h.observe(routed);
  if (body === undefined) {
    throw new Error("expected the middleware to follow this response's body");
  }
  return body;
}

function finishBody(h: Harness, body: ResponseBodyObserver, outcome: ResponseOutcome = "completed"): void {
  h.clock.nowMs = RECEIVED_AT + BODY_DELAY_MS;
  body.end(outcome);
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function singleRecord(h: Harness): UsageRecord {
  const [record] = h.records;
  if (record === undefined || h.records.length !== 1) {
    throw new Error(`expected exactly one record, found ${String(h.records.length)}`);
  }
  return record;
}

describe("createUsageMiddleware", () => {
  it("records a completed streamed response's head, model and token usage after its body ends", () => {
    const h = harness();
    const body = begin(h, event());

    body.chunk(bytes(STREAM_BODY));
    finishBody(h, body);
    expect(h.records).toEqual([]);
    h.flush();

    expect(singleRecord(h)).toEqual({
      schemaVersion: USAGE_SCHEMA_VERSION,
      at: new Date(RECEIVED_AT).toISOString(),
      identity: "work",
      provider: ANTHROPIC_PROVIDER,
      sessionId: "session-1",
      route: "passthrough",
      method: "POST",
      endpoint: "/v1/messages",
      model: "claude-sonnet-test",
      status: OK_STATUS,
      latencyMs: HEAD_DELAY_MS,
      durationMs: BODY_DELAY_MS,
      outcome: "completed",
      usage: EXPECTED_STREAM_USAGE,
    });
  });

  it("scans a stream split at arbitrary byte boundaries, including inside a multi-byte character", () => {
    const h = harness();
    const body = begin(h, event());
    const encoded = bytes(STREAM_BODY.replace(SECRET_REPLY, "naïve café reply"));
    const split = encoded.indexOf(UTF8_LEAD_BYTE_OF_I_DIAERESIS) + 1;

    body.chunk(encoded.subarray(0, split));
    body.chunk(encoded.subarray(split));
    finishBody(h, body);
    h.flush();

    expect(singleRecord(h).usage).toEqual(EXPECTED_STREAM_USAGE);
    expect(singleRecord(h).model).toBe("claude-sonnet-test");
  });

  it("records an aborted response with what was scanned before the body was cut short", () => {
    const h = harness();
    const body = begin(h, event());
    const [messageStart] = STREAM_BODY.split("event: content_block_delta");

    body.chunk(bytes(messageStart ?? ""));
    finishBody(h, body, "aborted");
    h.flush();

    const record = singleRecord(h);
    expect(record.outcome).toBe("aborted");
    expect(record.model).toBe("claude-sonnet-test");
    expect(record.usage).toEqual({ inputTokens: 25, cacheReadInputTokens: 4 });
    expect(record.durationMs).toBe(BODY_DELAY_MS);
  });

  it("scans a JSON body, ignoring a usage object nested in the content", () => {
    const h = harness();
    const body = begin(h, event({ headers: JSON_HEADERS }));
    const json = JSON.stringify({
      id: "msg_1",
      model: "claude-json-test",
      content: [{ type: "text", text: SECRET_REPLY, usage: { input_tokens: 999 } }],
      usage: { input_tokens: 11, output_tokens: 6 },
    });

    body.chunk(bytes(json.slice(0, JSON_SPLIT_OFFSET)));
    body.chunk(bytes(json.slice(JSON_SPLIT_OFFSET)));
    finishBody(h, body);
    h.flush();

    const record = singleRecord(h);
    expect(record.model).toBe("claude-json-test");
    expect(record.usage).toEqual({ inputTokens: 11, outputTokens: 6 });
  });

  it("matches the content type and encoding header names whatever case they arrive in", () => {
    const h = harness();
    const body = begin(h, event({ headers: { "Content-Type": "Application/JSON", "Request-Id": "req-abc" } }));

    body.chunk(bytes(JSON.stringify({ model: "claude-json-test", usage: { input_tokens: 1 } })));
    finishBody(h, body);
    h.flush();

    expect(singleRecord(h)).toMatchObject({ model: "claude-json-test", usage: { inputTokens: 1 }, requestId: "req-abc" });
  });

  describe("compressed bodies", () => {
    it("scans a gzip body from a decompressed copy, in any chunking", async () => {
      const h = harness();
      const body = begin(h, event({ headers: { ...SSE_HEADERS, "content-encoding": "gzip" } }));
      const compressed = zlib.gzipSync(STREAM_BODY);
      const middle = Math.floor(compressed.length / 2);

      body.chunk(compressed.subarray(0, middle));
      body.chunk(compressed.subarray(middle));
      finishBody(h, body);
      await h.settle();

      const record = singleRecord(h);
      expect(record.model).toBe("claude-sonnet-test");
      expect(record.usage).toEqual(EXPECTED_STREAM_USAGE);
      expect(record.outcome).toBe("completed");
    });

    it("scans deflate and brotli bodies too", async () => {
      for (const [encoding, compress] of [
        ["deflate", zlib.deflateSync],
        ["br", zlib.brotliCompressSync],
      ] as const) {
        const h = harness();
        const body = begin(h, event({ headers: { ...JSON_HEADERS, "content-encoding": encoding } }));

        body.chunk(compress(bytes(JSON.stringify({ model: "claude-json-test", usage: { output_tokens: 9 } }))));
        finishBody(h, body);
        await h.settle();

        expect(singleRecord(h).usage).toEqual({ outputTokens: 9 });
      }
    });

    it("records a gzip body cut short as aborted without waiting for bytes that will never come", () => {
      const h = harness();
      const body = begin(h, event({ headers: { ...SSE_HEADERS, "content-encoding": "gzip" } }));

      body.chunk(zlib.gzipSync(STREAM_BODY).subarray(0, GZIP_HEADER_LENGTH));
      finishBody(h, body, "aborted");
      h.flush();

      expect(singleRecord(h).outcome).toBe("aborted");
    });

    it("still records a request whose compressed body is corrupt, without usage, and logs the failure", async () => {
      const h = harness();
      const body = begin(h, event({ headers: { ...SSE_HEADERS, "content-encoding": "gzip" } }));

      body.chunk(bytes("this is not gzip data at all"));
      finishBody(h, body);
      await h.settle();

      const record = singleRecord(h);
      expect(record.status).toBe(OK_STATUS);
      expect(record.usage).toBeUndefined();
      expect(record.model).toBeUndefined();
      expect(h.logged.some((line) => line.startsWith("usage: could not decompress the body of passthrough"))).toBe(true);
    });

    it("records a body in a coding it cannot read, without usage", () => {
      const h = harness();
      const body = begin(h, event({ headers: { ...SSE_HEADERS, "content-encoding": "zstd" } }));

      body.chunk(bytes(STREAM_BODY));
      finishBody(h, body);
      h.flush();

      const record = singleRecord(h);
      expect(record.usage).toBeUndefined();
      expect(record.model).toBeUndefined();
      expect(record.status).toBe(OK_STATUS);
    });
  });

  it("records a response whose body carries no usage (an HTML error page) from its head alone", () => {
    const h = harness();
    const body = begin(h, event({ status: BAD_GATEWAY_STATUS, headers: { "content-type": "text/html" } }));

    body.chunk(bytes(`<html>${SECRET_REPLY}</html>`));
    finishBody(h, body);
    h.flush();

    const record = singleRecord(h);
    expect(record.status).toBe(BAD_GATEWAY_STATUS);
    expect(record.usage).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain(SECRET_REPLY);
  });

  describe("provider and endpoint", () => {
    it("records a bare API path under the anthropic provider", () => {
      const h = harness();
      finishBody(h, begin(h, event({ path: "/v1/messages" })));
      h.flush();

      expect(singleRecord(h)).toMatchObject({ provider: ANTHROPIC_PROVIDER, endpoint: "/v1/messages" });
    });

    it("records a provider-scoped path under that provider with the prefix stripped", () => {
      const h = harness();
      finishBody(h, begin(h, event({ path: "/providers/z/v1/messages" })));
      h.flush();

      expect(singleRecord(h)).toMatchObject({ provider: "z", endpoint: "/v1/messages" });
    });

    it("omits identity, session and project when the launch resolved none, and records the project when it did", () => {
      const anonymous = harness();
      finishBody(anonymous, begin(anonymous, event({ session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined } })));
      anonymous.flush();
      const scoped = harness();
      finishBody(scoped, begin(scoped, event({ session: { identity: "work", sessionId: "s", provider: undefined, headroom: true, projectId: "repo-root" } })));
      scoped.flush();

      const bare = singleRecord(anonymous);
      expect(bare.identity).toBeUndefined();
      expect(bare.sessionId).toBeUndefined();
      expect(bare.project).toBeUndefined();
      expect(singleRecord(scoped)).toMatchObject({ identity: "work", sessionId: "s", project: "repo-root" });
    });

    it("never reports a negative latency or duration when the clock steps backwards", () => {
      const h = harness();
      const body = begin(h, event());
      h.clock.nowMs = RECEIVED_AT - HEAD_DELAY_MS;
      body.end("completed");
      h.flush();

      expect(singleRecord(h)).toMatchObject({ durationMs: 0 });
    });
  });

  describe("rate limits", () => {
    it("keeps only the quota headers and classifies a refused response", () => {
      const h = harness();
      const rateLimited = event({
        status: RATE_LIMITED_STATUS,
        headers: {
          ...JSON_HEADERS,
          "retry-after": "30",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": "1768478400",
          authorization: `Bearer ${BEARER_TOKEN}`,
          "set-cookie": `session=${BEARER_TOKEN}`,
          "request-id": "req-429",
        },
      });
      const body = begin(h, rateLimited);

      body.chunk(bytes(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: SECRET_REPLY } })));
      finishBody(h, body);
      h.flush();

      const record = singleRecord(h);
      expect(record.rateLimitHeaders).toEqual({
        "retry-after": "30",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": "1768478400",
      });
      expect(record.limit).toMatchObject({ kind: "quota-exhausted", retryAfterSeconds: 30 });
      expect(record.requestId).toBe("req-429");
      expect(JSON.stringify(record)).not.toContain(BEARER_TOKEN);
      expect(JSON.stringify(record)).not.toContain(SECRET_REPLY);
    });

    it("classifies a plain rate limit from the error type in a streamed error event", () => {
      const h = harness();
      const body = begin(h, event({ status: RATE_LIMITED_STATUS }));

      body.chunk(bytes(sse("error", { type: "error", error: { type: "rate_limit_error", message: "slow down" } })));
      finishBody(h, body);
      h.flush();

      expect(singleRecord(h).limit).toMatchObject({ kind: "rate-limited" });
    });
  });

  describe("what is never stored", () => {
    it("keeps no prompt, reply, tool input or credential in the record, whatever the response carried", () => {
      const h = harness();
      const body = begin(
        h,
        event({ headers: { ...SSE_HEADERS, authorization: `Bearer ${BEARER_TOKEN}`, "x-api-key": BEARER_TOKEN, "request-id": "req-1" } }),
      );
      const toolStream = [
        STREAM_BODY,
        sse("content_block_delta", { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: `{"cmd":"${SECRET_PROMPT}"}` } }),
      ].join("");

      body.chunk(bytes(toolStream));
      finishBody(h, body);
      h.flush();

      const serialised = JSON.stringify(singleRecord(h));
      for (const secret of [SECRET_PROMPT, SECRET_REPLY, BEARER_TOKEN]) {
        expect(serialised).not.toContain(secret);
      }
      expect(UsageRecordSchema.safeParse(singleRecord(h)).success).toBe(true);
    });
  });

  describe("routes the door answered itself", () => {
    it.each(["(unauthorized)", "(unrouted)"])("does not follow or record %s", (route) => {
      const h = harness();

      expect(h.observe(event({ route, status: 401 }))).toBeUndefined();
      h.flush();

      expect(h.records).toEqual([]);
      expect(h.deferred).toEqual([]);
    });
  });

  describe("failures never reach the request", () => {
    it("catches and logs a store failure instead of throwing", () => {
      const h = harness({
        record: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      });
      const body = begin(h, event({ path: "/v1/messages" }));

      body.chunk(bytes(STREAM_BODY));
      finishBody(h, body);

      expect(() => {
        h.flush();
      }).not.toThrow();
      expect(h.logged).toEqual([`usage: could not record POST /v1/messages (${String(OK_STATUS)}): ENOSPC: no space left on device`]);
    });

    it("does not record from inside the body observer, only on the deferred turn", () => {
      const record = vi.fn<(record: UsageRecord) => void>();
      const h = harness({ record });
      const body = begin(h, event());

      body.chunk(bytes(STREAM_BODY));
      finishBody(h, body);

      expect(record).not.toHaveBeenCalled();
      h.flush();
      expect(record).toHaveBeenCalledTimes(1);
    });
  });
});

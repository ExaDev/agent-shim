import { describe, expect, it } from "vitest";

import { createJsonScanner, createSseScanner, type BodyScanner, type ScanResult } from "./scan";

const MODEL = "claude-sonnet-5-5";
const INPUT_TOKENS = 25;
const CACHE_CREATION_TOKENS = 7;
const CACHE_READ_TOKENS = 11;
const PLACEHOLDER_OUTPUT_TOKENS = 1;
const FINAL_OUTPUT_TOKENS = 342;

function sse(event: string | undefined, data: unknown): string {
  return `${event === undefined ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

const MESSAGE_START = sse("message_start", {
  type: "message_start",
  message: {
    id: "msg_1",
    model: MODEL,
    content: [],
    usage: { input_tokens: INPUT_TOKENS, cache_creation_input_tokens: CACHE_CREATION_TOKENS, cache_read_input_tokens: CACHE_READ_TOKENS, output_tokens: PLACEHOLDER_OUTPUT_TOKENS },
  },
});
const CONTENT_DELTA = sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello \"world\"" } });
const MESSAGE_DELTA = sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: FINAL_OUTPUT_TOKENS } });
const STREAM = [MESSAGE_START, sse("ping", { type: "ping" }), CONTENT_DELTA, MESSAGE_DELTA, sse("message_stop", { type: "message_stop" })].join("");

const SSE_CHUNK_SIZES = [1, 2, MESSAGE_START.length - 1, MESSAGE_START.length, Math.floor(STREAM.length / 2), STREAM.length];

const FULL_USAGE = { inputTokens: INPUT_TOKENS, outputTokens: FINAL_OUTPUT_TOKENS, cacheCreationInputTokens: CACHE_CREATION_TOKENS, cacheReadInputTokens: CACHE_READ_TOKENS };

function scan(scanner: BodyScanner, chunks: readonly string[]): ScanResult {
  for (const chunk of chunks) {
    scanner.push(chunk);
  }
  return scanner.result();
}

function chunksOf(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

describe("createSseScanner", () => {
  it("reads the model and input usage from message_start and the cumulative output from message_delta", () => {
    expect(scan(createSseScanner(), [STREAM])).toEqual({ model: MODEL, usage: FULL_USAGE, error: undefined });
  });

  it("finds the same result however the stream is split into chunks", () => {
    for (const size of SSE_CHUNK_SIZES) {
      expect(scan(createSseScanner(), chunksOf(STREAM, size))).toEqual({ model: MODEL, usage: FULL_USAGE, error: undefined });
    }
  });

  it("splits events on a chunk boundary inside the blank-line separator", () => {
    const boundary = MESSAGE_START.length - 1;
    expect(scan(createSseScanner(), [STREAM.slice(0, boundary), STREAM.slice(boundary)]).usage).toEqual(FULL_USAGE);
  });

  it("accepts CRLF line endings", () => {
    expect(scan(createSseScanner(), [STREAM.replaceAll("\n", "\r\n")])).toEqual({ model: MODEL, usage: FULL_USAGE, error: undefined });
  });

  it("recognises metadata events by their leading type when no event line is sent", () => {
    const bare = [sse(undefined, JSON.parse(MESSAGE_START.split("data: ")[1] ?? "")), sse(undefined, { type: "content_block_delta", delta: { text: "x" } }), sse(undefined, { type: "message_delta", usage: { output_tokens: FINAL_OUTPUT_TOKENS } })].join("");
    expect(scan(createSseScanner(), chunksOf(bare, 1))).toEqual({ model: MODEL, usage: FULL_USAGE, error: undefined });
  });

  it("never lets content-event data change the result", () => {
    const poisoned = sse("content_block_delta", { type: "message_delta", usage: { output_tokens: 999_999 }, model: "poison" });
    expect(scan(createSseScanner(), [MESSAGE_START, poisoned, MESSAGE_DELTA])).toEqual({ model: MODEL, usage: FULL_USAGE, error: undefined });
  });

  it("lets a later count replace an earlier one and keeps counts only the earlier event reported", () => {
    const result = scan(createSseScanner(), [MESSAGE_START, MESSAGE_DELTA]);
    expect(result.usage?.outputTokens).toBe(FINAL_OUTPUT_TOKENS);
    expect(result.usage?.inputTokens).toBe(INPUT_TOKENS);
  });

  it("reads an error event's type and message, and stringifies a numeric code", () => {
    const typed = scan(createSseScanner(), [sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })]);
    expect(typed.error).toEqual({ type: "overloaded_error", message: "Overloaded" });
    const coded = scan(createSseScanner(), [sse("error", { type: "error", error: { code: 1308, message: "Usage limit reached" } })]);
    expect(coded.error).toEqual({ code: "1308", message: "Usage limit reached" });
  });

  it("dispatches a final event whose blank line never arrived", () => {
    const truncated = MESSAGE_START + MESSAGE_DELTA.trimEnd();
    expect(scan(createSseScanner(), [truncated]).usage).toEqual(FULL_USAGE);
  });

  it("reports nothing for an empty stream or a stream of content only", () => {
    expect(scan(createSseScanner(), [])).toEqual({ model: undefined, usage: undefined, error: undefined });
    expect(scan(createSseScanner(), [CONTENT_DELTA])).toEqual({ model: undefined, usage: undefined, error: undefined });
  });

  it("ignores a data payload that is not JSON", () => {
    expect(scan(createSseScanner(), ["event: message_start\ndata: {not json\n\n"])).toEqual({ model: undefined, usage: undefined, error: undefined });
  });

  it("ignores a usage object whose counts are invalid", () => {
    const bad = sse("message_delta", { type: "message_delta", usage: { output_tokens: -1 } });
    expect(scan(createSseScanner(), [bad]).usage).toBeUndefined();
  });
});

describe("createJsonScanner", () => {
  const BODY = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text: "he said \"usage\": {\"input_tokens\": 1}, \\ done" }],
    stop_reason: "end_turn",
    usage: { input_tokens: INPUT_TOKENS, output_tokens: FINAL_OUTPUT_TOKENS, cache_creation_input_tokens: CACHE_CREATION_TOKENS, cache_read_input_tokens: CACHE_READ_TOKENS, service_tier: "standard" },
  };

  it("reads the top-level model and usage, ignoring unknown usage fields", () => {
    expect(scan(createJsonScanner(), [JSON.stringify(BODY)])).toEqual({ model: MODEL, usage: FULL_USAGE, error: undefined });
  });

  it("is not fooled by usage-like text inside content or a nested usage key", () => {
    const nested = { content: [{ type: "tool_use", input: { usage: { input_tokens: 999_999 }, model: "poison" } }], model: MODEL, usage: { input_tokens: INPUT_TOKENS } };
    expect(scan(createJsonScanner(), [JSON.stringify(nested)])).toEqual({ model: MODEL, usage: { inputTokens: INPUT_TOKENS }, error: undefined });
  });

  it("finds the same result however the body is split into chunks", () => {
    const text = JSON.stringify(BODY);
    for (const size of [1, 2, Math.floor(text.length / 2) - 1, text.length]) {
      expect(scan(createJsonScanner(), chunksOf(text, size))).toEqual({ model: MODEL, usage: FULL_USAGE, error: undefined });
    }
  });

  it("reads usage placed before the content", () => {
    const reordered = { usage: { output_tokens: FINAL_OUTPUT_TOKENS }, content: [{ type: "text", text: "}{,\"" }], model: MODEL };
    expect(scan(createJsonScanner(), [JSON.stringify(reordered)])).toEqual({ model: MODEL, usage: { outputTokens: FINAL_OUTPUT_TOKENS }, error: undefined });
  });

  it("reads an Anthropic error body", () => {
    const body = { type: "error", error: { type: "rate_limit_error", message: "Slow down" }, request_id: "req_1" };
    expect(scan(createJsonScanner(), [JSON.stringify(body)])).toEqual({ model: undefined, usage: undefined, error: { type: "rate_limit_error", message: "Slow down" } });
  });

  it("reads a z.ai style error body with a numeric code", () => {
    const body = { error: { code: 1310, message: "Weekly Limit Exhausted" } };
    expect(scan(createJsonScanner(), [JSON.stringify(body)]).error).toEqual({ code: "1310", message: "Weekly Limit Exhausted" });
  });

  it("tolerates whitespace and pretty printing", () => {
    expect(scan(createJsonScanner(), [JSON.stringify(BODY, undefined, 2)])).toEqual({ model: MODEL, usage: FULL_USAGE, error: undefined });
  });

  it("reports nothing for an empty or non-object body, and keeps only the values completed before a body is cut short", () => {
    const nothing = { model: undefined, usage: undefined, error: undefined };
    expect(scan(createJsonScanner(), [])).toEqual(nothing);
    expect(scan(createJsonScanner(), ["[1,2,3]"])).toEqual(nothing);
    expect(scan(createJsonScanner(), ['{"model": "claude-sonnet-5-5", "usage": {"input_tok'])).toEqual({ model: MODEL, usage: undefined, error: undefined });
  });

  it("ignores a usage object whose counts are invalid", () => {
    expect(scan(createJsonScanner(), ['{"usage":{"input_tokens":"many"}}']).usage).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { toolCallSignatureOf } from "./signatures";

import { createAntigravityRelay, renderSseFrame } from "./relay";

const THREE_FRAMES = 3;

describe("createAntigravityRelay", () => {
  it("relays text streaming chunks to Anthropic SSE frames", () => {
    let idCounter = 1;
    const relay = createAntigravityRelay({
      servedModel: "claude-sonnet-4-5",
      toolNames: new Map(),
      fallbackId: () => `msg_${String(idCounter++)}`,
    });

    // Chunk 1: text delta
    const step1 = relay.pushChunk({
      candidates: [
        {
          content: { parts: [{ text: "Hello" }] },
        },
      ],
      usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 5 },
    });

    expect(step1.done).toBe(false);
    expect(step1.frames).toHaveLength(THREE_FRAMES);
    expect(step1.frames[0]).toEqual({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    });
    expect(step1.frames[1]).toEqual({
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    });
    expect(step1.frames[2]).toEqual({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    });

    // Chunk 2: more text and STOP finishReason
    const step2 = relay.pushChunk({
      candidates: [
        {
          content: { parts: [{ text: " world!" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 15, cachedContentTokenCount: 9, candidatesTokenCount: 8 },
    });

    expect(step2.done).toBe(true);
    expect(step2.frames[0]).toEqual({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world!" } },
    });
    expect(step2.frames[1]).toEqual({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    });
    expect(step2.frames[2]).toEqual({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 6,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 9,
          output_tokens: 8,
        },
      },
    });
    expect(step2.frames[3]).toEqual({
      event: "message_stop",
      data: { type: "message_stop" },
    });
  });

  it("relays tool call chunks and restores shortened tool names", () => {
    let idCounter = 1;
    const toolNames = new Map<string, string>([["bash_exec", "bash-exec"]]);
    const relay = createAntigravityRelay({
      servedModel: "claude-sonnet-4-5",
      toolNames,
      fallbackId: () => `id_${String(idCounter++)}`,
    });

    const step = relay.pushChunk({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "bash_exec",
                  args: { command: "echo hi" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });

    expect(step.done).toBe(true);
    // Find tool_use content_block_start
    const startFrame = step.frames.find((f) => f.event === "content_block_start");
    expect(startFrame).toBeDefined();
    expect(startFrame?.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "id_2",
        name: "bash-exec",
        input: {},
      },
    });

    // A signed function call remembers its signature against the minted tool_use id, the one field Claude Code round-trips.
    const signed = relay.pushChunk({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "bash_exec", args: { command: "echo hi" } },
                thoughtSignature: "sig-abc",
              },
            ],
          },
        },
      ],
    });
    const signedStart = signed.frames.find((f) => f.event === "content_block_start");
    expect(signedStart?.data).toMatchObject({ content_block: { type: "tool_use" } });
    const emitted: unknown = signedStart !== undefined && "content_block" in signedStart.data ? signedStart.data.content_block : undefined;
    const emittedId = typeof emitted === "object" && emitted !== null && "id" in emitted && typeof emitted.id === "string" ? emitted.id : undefined;
    expect(emittedId).toBeDefined();
    if (emittedId !== undefined) {
      expect(toolCallSignatureOf(emittedId)).toBe("sig-abc");
    }

    // Verify stop_reason is tool_use
    const deltaFrame = step.frames.find((f) => f.event === "message_delta");
    expect(deltaFrame?.data).toMatchObject({
      delta: { stop_reason: "tool_use" },
    });
  });

  it("renders SSE wire format", () => {
    const rendered = renderSseFrame({
      event: "ping",
      data: { ok: true },
    });
    expect(rendered).toBe('event: ping\ndata: {"ok":true}\n\n');
  });
});

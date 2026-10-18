import type { GeminiGenerateContentResponseChunk } from "./geminiSchema";
import { rememberToolCallSignature } from "./signatures";

export interface SseFrame {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export function renderSseFrame(frame: SseFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

interface AnthropicUsage {
  readonly input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly output_tokens: number;
}

export interface RelayParams {
  /** The model that actually serves the request (a tier alias already translated to its concrete backend model), echoed in `message_start` exactly as the real API echoes the concrete model behind an alias, so a usage record read from the stream attributes quota to the backend model. */
  readonly servedModel: string;
  readonly toolNames: ReadonlyMap<string, string>;
  readonly fallbackId: () => string;
}

type StopReason = "end_turn" | "tool_use" | "max_tokens";

export interface RelayStep {
  readonly frames: readonly SseFrame[];
  readonly done: boolean;
}

/**
 * State machine translating Gemini stream chunks into Anthropic SSE frames.
 */
export function createAntigravityRelay(params: RelayParams): {
  readonly pushChunk: (chunk: GeminiGenerateContentResponseChunk) => RelayStep;
  readonly finish: () => RelayStep;
} {
  const messageId = params.fallbackId();
  let started = false;
  let activeBlockType: "text" | "tool_use" | undefined;
  let currentBlockIndex = -1;
  let sawToolUse = false;
  let finished = false;
  let usage: AnthropicUsage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };

  const frames: SseFrame[] = [];

  const ensureStarted = (): void => {
    if (!started) {
      started = true;
      frames.push({
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: params.servedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      });
    }
  };

  const closeActiveBlock = (): void => {
    if (activeBlockType !== undefined && currentBlockIndex >= 0) {
      frames.push({
        event: "content_block_stop",
        data: {
          type: "content_block_stop",
          index: currentBlockIndex,
        },
      });
      activeBlockType = undefined;
    }
  };

  const pushChunk = (chunk: GeminiGenerateContentResponseChunk): RelayStep => {
    frames.length = 0;
    ensureStarted();

    if (chunk.usageMetadata !== undefined) {
      // Gemini's promptTokenCount includes the content its implicit cache served, while Anthropic's input_tokens excludes cache reads, so the cached count comes off the prompt total and lands in cache_read_input_tokens.
      const cached = chunk.usageMetadata.cachedContentTokenCount ?? 0;
      const promptTotal = chunk.usageMetadata.promptTokenCount ?? usage.input_tokens + cached;
      usage = {
        input_tokens: Math.max(0, promptTotal - cached),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cached,
        output_tokens: chunk.usageMetadata.candidatesTokenCount ?? usage.output_tokens,
      };
    }

    const candidate = chunk.candidates?.[0];
    if (candidate?.content?.parts !== undefined) {
      for (const part of candidate.content.parts) {
        if ("text" in part && typeof part.text === "string" && (part.thoughtSignature === undefined || part.text.length > 0)) {
          if (activeBlockType !== "text") {
            closeActiveBlock();
            currentBlockIndex += 1;
            activeBlockType = "text";
            frames.push({
              event: "content_block_start",
              data: {
                type: "content_block_start",
                index: currentBlockIndex,
                content_block: { type: "text", text: "" },
              },
            });
          }
          frames.push({
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: currentBlockIndex,
              delta: { type: "text_delta", text: part.text },
            },
          });
        } else if ("functionCall" in part && part.functionCall !== undefined) {
          sawToolUse = true;
          closeActiveBlock();
          currentBlockIndex += 1;
          activeBlockType = "tool_use";
          const callName = part.functionCall.name;
          const originalName = params.toolNames.get(callName) ?? callName;
          const callId = params.fallbackId();
          if (typeof part.thoughtSignature === "string") {
            // The backend requires this signature echoed back with the call next turn, and the tool_use id is the one field that survives the round trip through Claude Code.
            rememberToolCallSignature(callId, part.thoughtSignature);
          }

          frames.push({
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: currentBlockIndex,
              content_block: {
                type: "tool_use",
                id: callId,
                name: originalName,
                input: {},
              },
            },
          });

          const argsJson = JSON.stringify(part.functionCall.args);
          frames.push({
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: currentBlockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: argsJson,
              },
            },
          });

          closeActiveBlock();
        }
      }
    }

    if (candidate?.finishReason !== undefined) {
      const stopReason: StopReason = sawToolUse
        ? "tool_use"
        : candidate.finishReason === "MAX_TOKENS"
        ? "max_tokens"
        : "end_turn";

      closeActiveBlock();
      frames.push({
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage,
        },
      });
      frames.push({
        event: "message_stop",
        data: { type: "message_stop" },
      });
      finished = true;
    }

    return { frames: [...frames], done: finished };
  };

  const finish = (): RelayStep => {
    frames.length = 0;
    if (!finished) {
      ensureStarted();
      closeActiveBlock();
      const stopReason: StopReason = sawToolUse ? "tool_use" : "end_turn";
      frames.push({
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage,
        },
      });
      frames.push({
        event: "message_stop",
        data: { type: "message_stop" },
      });
      finished = true;
    }
    return { frames: [...frames], done: true };
  };

  return { pushChunk, finish };
}

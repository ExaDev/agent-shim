import type { CodexEvent, ResponsesUsage } from "./events";

/** Anthropic's usage block. `input_tokens` counts only the uncached part of the prompt; cache reads and writes are separate fields, and Claude Code totals all three. */
interface AnthropicUsage {
  readonly input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly output_tokens: number;
}

/**
 * Converts Responses API usage to Anthropic's. The Responses API counts `input_tokens` as the whole prompt with the cached portion broken out in `input_tokens_details`; Anthropic counts `input_tokens` as only the uncached part. Subtracting keeps the split and stops Claude Code double-counting the total.
 */
function anthropicUsage(usage: ResponsesUsage | null | undefined): AnthropicUsage {
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const written = usage?.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage?.input_tokens ?? 0) - cached - written),
    cache_creation_input_tokens: written,
    cache_read_input_tokens: cached,
    output_tokens: usage?.output_tokens ?? 0,
  };
}

/** One Anthropic server-sent event: its name and its JSON data. */
export interface SseFrame {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Renders a frame in the SSE wire format. */
export function renderSseFrame(frame: SseFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

type StopReason = "end_turn" | "tool_use" | "max_tokens";

/** An Anthropic content block as the relay aggregates it. */
type AggregatedBlock =
  | { readonly type: "text"; text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; json: string };

/** The complete Anthropic message, as a non-streaming response carries it. */
export interface AnthropicMessageResponse {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: readonly Readonly<Record<string, unknown>>[];
  readonly stop_reason: StopReason;
  readonly stop_sequence: null;
  readonly usage: AnthropicUsage;
}

/** What one event did to the relay: frames to send in order, then optionally the end of the response. */
export interface RelayStep {
  readonly frames: readonly SseFrame[];
  /** Present on the event that finishes the response successfully. */
  readonly completed?: { readonly message: AnthropicMessageResponse; readonly usage: ResponsesUsage | undefined };
  /** Present on an event that ends the response with a backend error. */
  readonly failed?: { readonly message: string };
}

/** Parses a tool call's accumulated arguments. Truncated or malformed arguments become an empty object so the agent loop keeps going instead of failing the turn. */
function parseToolArguments(json: string): unknown {
  if (json === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed;
  } catch {
    return {};
  }
}

function wireBlock(block: AggregatedBlock): Record<string, unknown> {
  return block.type === "text" ? { type: "text", text: "" } : { type: "tool_use", id: block.id, name: block.name, input: {} };
}

function finalBlock(block: AggregatedBlock): Record<string, unknown> {
  return block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "tool_use", id: block.id, name: block.name, input: parseToolArguments(block.json) };
}

/** The message for a backend stream failure that carries none of its own. */
const STREAM_ERROR = "codex backend stream error";

/** Inputs to `createRelay`. */
export interface RelayParams {
  /** The model Claude Code asked for, echoed back so it sees the name it requested. */
  readonly requestedModel: string;
  /** Shortened tool names to the originals Claude Code dispatches on. */
  readonly toolNames: ReadonlyMap<string, string>;
  /** Supplies a message id when the backend sends none. */
  readonly fallbackId: () => string;
}

/**
 * The response half of the translation: a pure state machine fed one Codex stream event at a time, producing the Anthropic stream frames for it and, on completion, the aggregated message a non-streaming response returns. Reasoning items and every other output type are skipped; text and function calls become text and tool_use blocks, indexed in the order the backend opened them.
 */
export function createRelay(params: RelayParams): { readonly push: (event: CodexEvent) => RelayStep } {
  /** Backend output index to Anthropic block index; undefined for an item the relay skips. */
  const blockByOutput = new Map<number, number>();
  const blocks: AggregatedBlock[] = [];
  let messageId: string | undefined;
  let sawToolUse = false;

  const block = (outputIndex: number): { index: number; block: AggregatedBlock } | undefined => {
    const index = blockByOutput.get(outputIndex);
    const found = index === undefined ? undefined : blocks[index];
    return index === undefined || found === undefined ? undefined : { index, block: found };
  };

  const push = (event: CodexEvent): RelayStep => {
    switch (event.type) {
      case "response.created": {
        messageId = event.response?.id ?? params.fallbackId();
        return {
          frames: [
            {
              event: "message_start",
              data: {
                type: "message_start",
                message: {
                  id: messageId,
                  type: "message",
                  role: "assistant",
                  model: params.requestedModel,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              },
            },
          ],
        };
      }
      case "response.output_item.added": {
        const { item } = event;
        let opened: AggregatedBlock;
        if (item.type === "message") {
          opened = { type: "text", text: "" };
        } else if (item.type === "function_call") {
          sawToolUse = true;
          const name = item.name ?? "";
          opened = { type: "tool_use", id: item.call_id ?? item.id ?? params.fallbackId(), name: params.toolNames.get(name) ?? name, json: "" };
        } else {
          return { frames: [] };
        }
        const index = blocks.length;
        blocks.push(opened);
        blockByOutput.set(event.output_index, index);
        return { frames: [{ event: "content_block_start", data: { type: "content_block_start", index, content_block: wireBlock(opened) } }] };
      }
      case "response.output_text.delta": {
        const target = block(event.output_index);
        if (target?.block.type !== "text") {
          return { frames: [] };
        }
        target.block.text += event.delta;
        return {
          frames: [{ event: "content_block_delta", data: { type: "content_block_delta", index: target.index, delta: { type: "text_delta", text: event.delta } } }],
        };
      }
      case "response.function_call_arguments.delta": {
        const target = block(event.output_index);
        if (target?.block.type !== "tool_use") {
          return { frames: [] };
        }
        target.block.json += event.delta;
        return {
          frames: [
            { event: "content_block_delta", data: { type: "content_block_delta", index: target.index, delta: { type: "input_json_delta", partial_json: event.delta } } },
          ],
        };
      }
      case "response.output_item.done": {
        const target = block(event.output_index);
        return target === undefined ? { frames: [] } : { frames: [{ event: "content_block_stop", data: { type: "content_block_stop", index: target.index } }] };
      }
      case "response.completed": {
        const usage = event.response?.usage ?? undefined;
        const stopReason: StopReason = sawToolUse ? "tool_use" : event.response?.status === "incomplete" ? "max_tokens" : "end_turn";
        const converted = anthropicUsage(usage);
        const content = blocks.map(finalBlock);
        return {
          frames: [
            { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: converted } },
            { event: "message_stop", data: { type: "message_stop" } },
          ],
          completed: {
            message: {
              id: event.response?.id ?? messageId ?? params.fallbackId(),
              type: "message",
              role: "assistant",
              model: params.requestedModel,
              content: content.length === 0 ? [{ type: "text", text: "" }] : content,
              stop_reason: stopReason,
              stop_sequence: null,
              usage: converted,
            },
            usage,
          },
        };
      }
      case "response.failed":
        return { frames: [], failed: { message: event.response?.error?.message ?? STREAM_ERROR } };
      case "error":
        return { frames: [], failed: { message: event.message ?? STREAM_ERROR } };
      default:
        return event satisfies never;
    }
  };

  return { push };
}

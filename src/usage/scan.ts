import { z } from "zod";

import type { ErrorInfo } from "./rateLimit";
import type { TokenUsage } from "./schema";

/**
 * Incremental scanners that pull usage metadata out of a response body as it streams past, without ever holding the body: the model, the `usage` token counts, and an error's type, code and message. Content (text deltas, tool input, message content) is skipped character by character and never accumulated, so memory stays bounded by the metadata itself whatever the response's size.
 */

/** What a scan found. */
export interface ScanResult {
  readonly model: string | undefined;
  readonly usage: TokenUsage | undefined;
  readonly error: ErrorInfo | undefined;
}

/** A body scanner: fed decoded text in arrival order, read once the body has ended. */
export interface BodyScanner {
  readonly push: (text: string) => void;
  readonly result: () => ScanResult;
}

/** Anthropic's `usage` object, as the Messages API and every Anthropic-compatible route here report it. Unknown fields (server tool counts, service tier) are ignored. */
const AnthropicUsageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
});

/** An error body's `error` object: Anthropic's `{ type, message }`, z.ai's `{ code, message }` (code a string or number). */
const ErrorObjectSchema = z.looseObject({
  type: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
});

/** Folds one `usage` object into the running counts: a later report of a count replaces the earlier one, because the stream's `message_delta` reports cumulative totals. */
function mergeUsage(current: TokenUsage | undefined, raw: unknown): TokenUsage | undefined {
  const parsed = AnthropicUsageSchema.safeParse(raw);
  if (!parsed.success) {
    return current;
  }
  const usage = parsed.data;
  const merged: TokenUsage = {
    ...current,
    ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage.cache_creation_input_tokens === "number" ? { cacheCreationInputTokens: usage.cache_creation_input_tokens } : {}),
    ...(typeof usage.cache_read_input_tokens === "number" ? { cacheReadInputTokens: usage.cache_read_input_tokens } : {}),
  };
  return Object.keys(merged).length === 0 ? current : merged;
}

function errorInfo(raw: unknown): ErrorInfo | undefined {
  const parsed = ErrorObjectSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const { type, code, message } = parsed.data;
  return {
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code: String(code) }),
    ...(message === undefined ? {} : { message }),
  };
}

/** Whether a value is a plain JSON object, narrowed so its fields can be read with `in`. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a captured JSON fragment, or undefined when it is not JSON (a body cut short mid-value). */
function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

/** The server-sent events whose data carries metadata: the opening message (model and input usage), the closing delta (cumulative usage), and an error. Every other event (content blocks and their deltas, pings) is skipped unread. */
const METADATA_EVENTS = new Set(["message_start", "message_delta", "error"]);

/** The leading `"type"` of an event's data, which Anthropic always writes first: lets a stream without `event:` lines still skip content events after reading only their opening bytes. */
const LEADING_TYPE = /^\s*\{\s*"type"\s*:\s*"([^"]*)"/;

/**
 * Scans an Anthropic-format server-sent-events stream. Lines are split as they arrive, across chunk boundaries anywhere; an `event:` line names the event its `data:` lines belong to, and only metadata events' data is accumulated. A data line whose event is not named is held only until its leading `"type"` shows whether it is a metadata event, so content is never accumulated beyond those opening bytes.
 */
export function createSseScanner(): BodyScanner {
  let model: string | undefined;
  let usage: TokenUsage | undefined;
  let error: ErrorInfo | undefined;
  /** The current event's name, from its `event:` line. */
  let eventName: string | undefined;
  /** The unfinished line being accumulated, when it may matter. */
  let line = "";
  /** Whether the rest of the current line is being skipped unread. */
  let skipping = false;
  /** The current event's accumulated data. */
  let data: string[] = [];

  const dispatch = (): void => {
    if (data.length > 0) {
      const payload = parseJson(data.join("\n"));
      if (isObject(payload)) {
        const type = typeof payload.type === "string" ? payload.type : undefined;
        if (type === "message_start" && isObject(payload.message)) {
          if (typeof payload.message.model === "string") {
            model = payload.message.model;
          }
          usage = mergeUsage(usage, payload.message.usage);
        } else if (type === "message_delta") {
          usage = mergeUsage(usage, payload.usage);
        } else if (type === "error") {
          error = errorInfo(payload.error) ?? error;
        }
      }
    }
    eventName = undefined;
    data = [];
  };

  /** Decides whether a line in progress is worth keeping, from as much of it as has arrived. */
  const worthKeeping = (partial: string): boolean | undefined => {
    if (!partial.startsWith("data:")) {
      // Field lines other than data are short (`event:`, `id:`, `retry:`), and an `event:` line is what decides the data that follows.
      return true;
    }
    if (eventName !== undefined) {
      return METADATA_EVENTS.has(eventName);
    }
    const leading = LEADING_TYPE.exec(partial.slice("data:".length));
    if (leading?.[1] !== undefined) {
      return METADATA_EVENTS.has(leading[1]);
    }
    // Not decidable yet: hold the opening bytes until the type has arrived.
    return undefined;
  };

  const completeLine = (complete: string): void => {
    const text = complete.endsWith("\r") ? complete.slice(0, -1) : complete;
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith("event:")) {
      eventName = text.slice("event:".length).trim();
      return;
    }
    if (text.startsWith("data:")) {
      const value = text.slice("data:".length);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  };

  return {
    push: (text) => {
      let start = 0;
      for (;;) {
        const newline = text.indexOf("\n", start);
        const piece = newline === -1 ? text.slice(start) : text.slice(start, newline);
        if (!skipping) {
          line += piece;
          if (worthKeeping(line) === false) {
            // A content event's data: drop what was held and skip the rest of the line unread.
            line = "";
            skipping = true;
          }
        }
        if (newline === -1) {
          return;
        }
        if (!skipping) {
          completeLine(line);
        }
        line = "";
        skipping = false;
        start = newline + 1;
      }
    },
    result: () => {
      // A stream that ended without its final blank line still dispatches its last event.
      if (!skipping && line !== "") {
        completeLine(line);
        line = "";
      }
      dispatch();
      return { model, usage, error };
    },
  };
}

/** The top-level keys of a JSON response body that carry metadata. Everything else (`content` above all) is skipped without being accumulated. */
const METADATA_KEYS = new Set(["model", "usage", "error"]);

/**
 * Scans a JSON response body (a non-streaming Messages response, or an error body) for its top-level `model`, `usage` and `error`, capturing only those values' text. A small state machine tracks nesting and strings, so a `usage` key nested inside content is never mistaken for the top-level one, and content is walked past without being kept.
 */
export function createJsonScanner(): BodyScanner {
  const captured = new Map<string, string>();
  let depth = 0;
  let inString = false;
  let escaped = false;
  /** Whether the string being read is a top-level key. */
  let readingKey = false;
  /** Whether the next string at the top level is a key (just after `{` or `,`). */
  let expectKey = false;
  let key = "";
  /** The top-level key whose value is being captured, and its text so far. */
  let capturing: string | undefined;
  let capture = "";
  /** Whether a top-level value is underway, for the key just read. */
  let inValue = false;
  let currentKey = "";

  const endValue = (): void => {
    if (capturing !== undefined) {
      captured.set(capturing, capture.trim());
    }
    capturing = undefined;
    capture = "";
    inValue = false;
  };

  const step = (char: string): void => {
    if (capturing !== undefined && !(depth === 1 && !inString && (char === "," || char === "}"))) {
      capture += char;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        if (readingKey) {
          readingKey = false;
          currentKey = key;
        }
        return;
      }
      if (readingKey) {
        key += char;
      }
      return;
    }
    switch (char) {
      case '"':
        inString = true;
        if (depth === 1 && expectKey) {
          readingKey = true;
          expectKey = false;
          key = "";
        }
        return;
      case "{":
      case "[":
        depth += 1;
        if (depth === 1 && char === "{") {
          expectKey = true;
        }
        return;
      case "}":
      case "]":
        if (depth === 1) {
          endValue();
        }
        depth -= 1;
        return;
      case ":":
        if (depth === 1 && !inValue) {
          inValue = true;
          if (METADATA_KEYS.has(currentKey)) {
            capturing = currentKey;
            capture = "";
          }
        }
        return;
      case ",":
        if (depth === 1) {
          endValue();
          expectKey = true;
        }
        return;
      default:
        return;
    }
  };

  return {
    push: (text) => {
      for (const char of text) {
        step(char);
      }
    },
    result: () => {
      const model = parseJson(captured.get("model") ?? "");
      const usageRaw = parseJson(captured.get("usage") ?? "");
      const errorRaw = parseJson(captured.get("error") ?? "");
      return {
        model: typeof model === "string" ? model : undefined,
        usage: mergeUsage(undefined, usageRaw),
        error: errorInfo(errorRaw),
      };
    },
  };
}

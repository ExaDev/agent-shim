import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingHttpHeaders } from "node:http";

/**
 * An opt-in diagnostic tap on the front door's CONNECT surface, for answering "what is this client actually saying to whom" against one's own machine: which hosts every launch dials, and the method, path, redacted headers and redacted body excerpts of each request the terminated session pipes to the real upstream (the non-`/v1/` paths, where Claude Code's own Remote Control streaming and OAuth refreshes live). Routed `/v1/` requests are deliberately not captured: the routed pipeline already records their usage, and duplicating it here would double the sensitive surface for no new information.
 *
 * Every credential-shaped value is redacted before it is written: header values whose name matches the secret pattern, JSON object fields whose key matches it, and bearer/API-key/JWT-shaped substrings anywhere in a body. What survives is the protocol shape, which is what diagnosing a channel needs; the tokens, which it must never need. A capture write that fails brings the front door down with it, the same deal `appendLog` already makes: a diagnostics path that silently stops capturing is worse than a door that restarts loudly.
 */

/** Header names whose values never reach the capture file: anything a client or server uses to carry a credential. */
const SECRET_HEADER_NAME = /authorization|cookie|token|secret|credential|api[-_]key/i;

/** JSON object keys whose values never reach the capture file. Deliberately narrower than the header pattern: a key like `session_id` is protocol shape, not a credential, and redacting it would hide exactly what a capture exists to reveal. */
const SECRET_JSON_KEY = /token|secret|password|credential|authorization|api[-_]key/i;

/** Credential-shaped substrings redacted wherever they appear in a body, keyed by what they are: an Anthropic API key, a bearer credential, and a JWT (which every OAuth access token in this ecosystem is). */
const SECRET_BODY_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g, replacement: "<redacted>" },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "Bearer <redacted>" },
  { pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/g, replacement: "<redacted>" },
];

/**
 * How much of any one chunk is logged. A chunk excerpt only has to identify what the traffic is and carry the first frames of a stream, and 8 KiB is already the head budget this surface applies elsewhere (`MAX_CONNECT_HEAD_BYTES`), so one budget serves both notions of "a diagnostic excerpt".
 */
export const CHUNK_LOG_CAP_BYTES = 8192;

/**
 * How many body bytes each direction of one request may log in total. Enough to hold a full Remote Control handshake and a long run of its frames, while bounding the file against an unbounded SSE stream that could otherwise grow it without limit. Bytes past the cap are counted, never stored.
 */
export const STREAM_LOG_CAP_BYTES = 262_144;

/** The capture file's mode: bodies pass through redaction, but a file that exists to record traffic shape stays owner-only anyway. */
const CAPTURE_FILE_MODE = 0o600;

/** The request facts a capture sees, shaped so both a real `IncomingMessage` and a test's plain object satisfy it. */
interface CapturedRequestShape {
  readonly method?: string;
  readonly url?: string;
  readonly headers: IncomingHttpHeaders;
}

/** The callbacks one piped request's forwarding drives, all optional callers except, so a fake or a partial observer fits the same seam. */
export interface PassthroughObserver {
  readonly onRequestChunk: (chunk: Buffer) => void;
  readonly onResponse: (status: number, headers: IncomingHttpHeaders) => void;
  readonly onResponseChunk: (chunk: Buffer) => void;
  readonly onEnd: () => void;
}

/** The tap the connect surface drives. `undefined` everywhere means "not capturing"; one object covers the whole door process. */
export interface ConnectCapture {
  /** Records one authenticated CONNECT target: the host and port only, since a blind tunnel's bytes are unreadable by construction. */
  readonly connect: (target: { readonly host: string; readonly port: number }, intercepted: boolean) => void;
  /** Records one non-routed request's head and returns the observer its forwarding drives, so the capture correlates every later chunk with the request it belongs to. */
  readonly observePassthrough: (request: CapturedRequestShape) => PassthroughObserver;
  /** Records one HTTP upgrade request arriving on a terminated session. The surface destroys the socket afterwards either way, with or without a capture, matching Node's own no-listener behaviour exactly. */
  readonly upgrade: (request: CapturedRequestShape) => void;
}

/** Replaces every header value whose name looks like a credential with a marker, keeping every other header verbatim. Returns a fresh object. */
export function redactHeaders(headers: Readonly<IncomingHttpHeaders>): IncomingHttpHeaders {
  const result: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = value !== undefined && SECRET_HEADER_NAME.test(name) ? "<redacted>" : value;
  }
  return result;
}

/** Redacts credential-shaped substrings in arbitrary text: the body of a non-JSON payload, and the fallback for anything JSON parsing cannot see into. */
function redactText(text: string): string {
  return SECRET_BODY_PATTERNS.reduce((accumulated, { pattern, replacement }) => accumulated.replace(pattern, replacement), text);
}

/** Redacts a parsed JSON value: recursively through objects and arrays, replacing the value of every credential-named key and pattern-matching every string inside. */
function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactJsonValue);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET_JSON_KEY.test(key) ? "<redacted>" : redactJsonValue(entry)]));
  }
  return value;
}

/**
 * Redacts one body excerpt for the capture file. A body that parses as JSON is redacted structurally (key-named credentials go even when their shape matches no pattern); anything else gets the substring patterns, which still catch the bearer and JWT forms an OAuth refresh or a Remote Control frame carries. Invalid UTF-8 decodes with replacement characters, which is fine: the excerpt exists to be read, not to be re-encoded.
 */
export function redactBody(chunk: Readonly<Buffer>): string {
  const text = chunk.toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(redactJsonValue(parsed));
  } catch {
    return redactText(text);
  }
}

/**
 * Builds the file-backed capture: one JSON object per line, appended to `file` (conventionally `logs/frontdoor-capture.jsonl`), never read back by the door itself. The directory is created up front rather than per record, so a capture started against a fresh state root cannot race its own first append.
 */
export function createFileCapture(file: string, now: () => Date = () => new Date()): ConnectCapture {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let nextId = 0;
  const append = (record: Record<string, unknown>): void => {
    fs.appendFileSync(file, `${JSON.stringify({ ts: now().toISOString(), ...record })}\n`, { mode: CAPTURE_FILE_MODE });
  };

  return {
    connect: (target, intercepted) => {
      append({ kind: "connect", host: target.host, port: target.port, intercepted });
    },
    upgrade: (request) => {
      append({ kind: "upgrade", method: request.method ?? "?", url: request.url ?? "?", headers: redactHeaders(request.headers) });
    },
    observePassthrough: (request) => {
      nextId += 1;
      const id = nextId;
      append({ kind: "request", id, method: request.method ?? "?", url: request.url ?? "?", headers: redactHeaders(request.headers) });
      const logged = { request: 0, response: 0 };
      const sequences = { request: 0, response: 0 };
      const chunk = (direction: "request" | "response", incoming: Readonly<Buffer>): void => {
        sequences[direction] += 1;
        const budget = STREAM_LOG_CAP_BYTES - logged[direction];
        if (budget <= 0) {
          return;
        }
        const excerpt = incoming.subarray(0, Math.min(CHUNK_LOG_CAP_BYTES, budget));
        logged[direction] += excerpt.length;
        append({
          kind: `${direction}-chunk`,
          id,
          seq: sequences[direction],
          bytes: incoming.length,
          stored: excerpt.length,
          truncated: excerpt.length < incoming.length,
          body: redactBody(excerpt),
        });
      };
      return {
        onRequestChunk: (incoming) => {
          chunk("request", incoming);
        },
        onResponse: (status, headers) => {
          append({ kind: "response", id, status, headers: redactHeaders(headers) });
        },
        onResponseChunk: (incoming) => {
          chunk("response", incoming);
        },
        onEnd: () => {
          append({ kind: "end", id, requestBytesCapped: logged.request >= STREAM_LOG_CAP_BYTES, responseBytesCapped: logged.response >= STREAM_LOG_CAP_BYTES });
        },
      };
    },
  };
}

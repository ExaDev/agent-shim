import * as zlib from "node:zlib";

import { captureRecordSchema, decodeChunk, type CaptureRecord } from "./rc-capture-record";

/**
 * The pure half of `scripts/decode-http-capture.mts`: turns the RC rig's SNI proxy capture (`scripts/rc-capture-record.ts` defines its records) back into the HTTP/1.1 exchanges each connection carried, with chunked transfer framing removed and compressed bodies decoded, so a protocol's request and response bodies can be read offline.
 *
 * A connection's two byte streams are rebuilt from its records, then requests and responses are read in lockstep, which is exact for HTTP/1.1 over a keep-alive connection that does not pipeline. A `101` response ends the lockstep: whatever follows is the upgraded protocol's frames, which this decoder does not read. A message the capture ends in the middle of is returned with `complete: false` instead of being dropped, and a trailing partial message head is ignored.
 */
export interface HttpMessage {
  /** The request line or the status line, as sent. */
  readonly startLine: string;
  /** Header names lower-cased, values trimmed, in wire order. */
  readonly headers: readonly (readonly [name: string, value: string])[];
  /** The body after transfer decoding (chunked framing removed) and before content decoding. */
  readonly body: Buffer;
  /** False when the capture ends before the message's body does. */
  readonly complete: boolean;
}

export interface HttpExchange {
  readonly conn: number;
  readonly host: string;
  readonly request: HttpMessage;
  /** Undefined when the capture holds no response for this request. */
  readonly response: HttpMessage | undefined;
  /** True when the response was `101 Switching Protocols`. */
  readonly upgraded: boolean;
}

/** Header names whose values are credentials, printed as `<redacted>`. */
const REDACTED_HEADERS: ReadonlySet<string> = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);

/** JSON object keys whose string values are credentials: OAuth token responses, API keys and the like. */
const SECRET_KEY_PATTERN = /token|secret|password|credential|api[_-]?key|authorization/i;

/** Longest string a shape keeps verbatim: short strings in a JSON body are enum-like discriminators (`"type": "text"`) and worth reading, longer ones are identifiers or prose. */
const SHAPE_LITERAL_MAX_CHARS = 24;

const CRLF = "\r\n";
const HEAD_END = "\r\n\r\n";
const STATUS_SWITCHING_PROTOCOLS = 101;
const STATUS_NO_CONTENT = 204;
const STATUS_NOT_MODIFIED = 304;
const FIRST_FINAL_STATUS = 200;
const HEX_RADIX = 16;

/** Parses a capture file's text, one record per line, rejecting any line that is not a current-format record (an older capture lacks `conn` and `enc`) rather than guessing at its bytes. */
export function parseCapture(text: string): CaptureRecord[] {
  const records: CaptureRecord[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line === "") {
      continue;
    }
    const parsed = captureRecordSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`capture line ${String(index + 1)} is not a lossless-format record (a capture from before the format carried conn and enc cannot be decoded): invalid fields ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
    }
    records.push(parsed.data);
  }
  return records;
}

interface ConnectionStreams {
  readonly host: string;
  readonly client: Buffer;
  readonly server: Buffer;
}

/** Rebuilds each connection's two byte streams from the interleaved records. */
function connectionStreams(records: readonly CaptureRecord[]): Map<number, ConnectionStreams> {
  const parts = new Map<number, { host: string; client: Buffer[]; server: Buffer[] }>();
  for (const record of records) {
    let entry = parts.get(record.conn);
    if (entry === undefined) {
      entry = { host: record.host, client: [], server: [] };
      parts.set(record.conn, entry);
    }
    (record.dir === "client_to_server" ? entry.client : entry.server).push(decodeChunk(record));
  }
  return new Map([...parts].map(([conn, entry]) => [conn, { host: entry.host, client: Buffer.concat(entry.client), server: Buffer.concat(entry.server) }]));
}

interface Head {
  readonly startLine: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly end: number;
}

/** Reads one message head starting at `offset`, or undefined when the stream ends before the head does. */
function readHead(stream: Buffer, offset: number): Head | undefined {
  const headEnd = stream.indexOf(HEAD_END, offset);
  if (headEnd < 0) {
    return undefined;
  }
  const [startLine = "", ...headerLines] = stream.toString("latin1", offset, headEnd).split(CRLF);
  const headers = headerLines.map((line): readonly [string, string] => {
    const colon = line.indexOf(":");
    if (colon < 0) {
      throw new Error(`malformed header line without a colon: ${JSON.stringify(line)}`);
    }
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  });
  return { startLine, headers, end: headEnd + HEAD_END.length };
}

function headerValue(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  return headers.find(([headerName]) => headerName === name)?.[1];
}

type Framing = { readonly kind: "none" } | { readonly kind: "length"; readonly bytes: number } | { readonly kind: "chunked" } | { readonly kind: "until-close" };

interface Body {
  readonly body: Buffer;
  readonly end: number;
  readonly complete: boolean;
}

function framingOf(headers: readonly (readonly [string, string])[], absent: Framing): Framing {
  if (headerValue(headers, "transfer-encoding")?.toLowerCase().includes("chunked") === true) {
    return { kind: "chunked" };
  }
  const length = headerValue(headers, "content-length");
  return length === undefined ? absent : { kind: "length", bytes: Number(length) };
}

/** Reads a chunked body: size line, data, CRLF per chunk, then the last chunk and its trailers. */
function readChunked(stream: Buffer, offset: number): Body {
  const pieces: Buffer[] = [];
  let position = offset;
  for (;;) {
    const sizeEnd = stream.indexOf(CRLF, position);
    if (sizeEnd < 0) {
      return { body: Buffer.concat(pieces), end: stream.length, complete: false };
    }
    const size = Number.parseInt(stream.toString("latin1", position, sizeEnd).split(";")[0] ?? "", HEX_RADIX);
    if (Number.isNaN(size)) {
      throw new Error(`malformed chunk size line: ${JSON.stringify(stream.toString("latin1", position, sizeEnd))}`);
    }
    const dataStart = sizeEnd + CRLF.length;
    if (size === 0) {
      const trailersEnd = stream.indexOf(HEAD_END, sizeEnd);
      const end = trailersEnd < 0 ? stream.length : trailersEnd + HEAD_END.length;
      return { body: Buffer.concat(pieces), end, complete: trailersEnd >= 0 };
    }
    const dataEnd = dataStart + size;
    if (dataEnd + CRLF.length > stream.length) {
      pieces.push(stream.subarray(dataStart));
      return { body: Buffer.concat(pieces), end: stream.length, complete: false };
    }
    pieces.push(stream.subarray(dataStart, dataEnd));
    position = dataEnd + CRLF.length;
  }
}

function readBody(stream: Buffer, offset: number, framing: Framing): Body {
  if (framing.kind === "none") {
    return { body: Buffer.alloc(0), end: offset, complete: true };
  }
  if (framing.kind === "chunked") {
    return readChunked(stream, offset);
  }
  if (framing.kind === "until-close") {
    return { body: stream.subarray(offset), end: stream.length, complete: true };
  }
  const end = offset + framing.bytes;
  return end <= stream.length ? { body: stream.subarray(offset, end), end, complete: true } : { body: stream.subarray(offset), end: stream.length, complete: false };
}

function methodOf(request: HttpMessage): string {
  return request.startLine.split(" ")[0] ?? "";
}

function statusOf(response: HttpMessage): number {
  return Number(response.startLine.split(" ")[1]);
}

/** A response has no body after a HEAD request or a 1xx, 204 or 304 status, whatever its headers say; with no length it runs to the end of the connection. */
function responseFraming(request: HttpMessage, status: number, headers: readonly (readonly [string, string])[]): Framing {
  if (methodOf(request) === "HEAD" || status < FIRST_FINAL_STATUS || status === STATUS_NO_CONTENT || status === STATUS_NOT_MODIFIED) {
    return { kind: "none" };
  }
  return framingOf(headers, { kind: "until-close" });
}

/** Reads the exchanges of one connection, requests and responses in lockstep. */
function readExchanges(conn: number, streams: ConnectionStreams): HttpExchange[] {
  const exchanges: HttpExchange[] = [];
  let clientOffset = 0;
  let serverOffset = 0;
  for (;;) {
    const requestHead = readHead(streams.client, clientOffset);
    if (requestHead === undefined) {
      return exchanges;
    }
    const requestBody = readBody(streams.client, requestHead.end, framingOf(requestHead.headers, { kind: "none" }));
    clientOffset = requestBody.end;
    const request: HttpMessage = { startLine: requestHead.startLine, headers: requestHead.headers, body: requestBody.body, complete: requestBody.complete };

    let response: HttpMessage | undefined;
    for (;;) {
      const responseHead = readHead(streams.server, serverOffset);
      if (responseHead === undefined) {
        break;
      }
      const status = Number(responseHead.startLine.split(" ")[1]);
      const responseBody = readBody(streams.server, responseHead.end, responseFraming(request, status, responseHead.headers));
      serverOffset = responseBody.end;
      if (status >= FIRST_FINAL_STATUS || status === STATUS_SWITCHING_PROTOCOLS) {
        response = { startLine: responseHead.startLine, headers: responseHead.headers, body: responseBody.body, complete: responseBody.complete };
        break;
      }
    }
    const upgraded = response !== undefined && statusOf(response) === STATUS_SWITCHING_PROTOCOLS;
    exchanges.push({ conn, host: streams.host, request, response, upgraded });
    if (upgraded || !requestBody.complete || response?.complete !== true) {
      return exchanges;
    }
  }
}

/** Every exchange of every connection in the capture, ordered by connection then by position on the connection. */
export function decodeExchanges(records: readonly CaptureRecord[]): HttpExchange[] {
  return [...connectionStreams(records)].sort(([left], [right]) => left - right).flatMap(([conn, streams]) => readExchanges(conn, streams));
}

/** The message body with its `content-encoding` removed, applying a list of encodings in reverse of how they were applied. An unsupported encoding is an error, not a pass-through, so an unreadable body is never mistaken for an empty one. */
export function decodeContent(message: HttpMessage): Buffer {
  const encodings = (headerValue(message.headers, "content-encoding") ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding !== "" && encoding !== "identity")
    .reverse();
  let body = message.body;
  for (const encoding of encodings) {
    switch (encoding) {
      case "gzip":
      case "x-gzip":
        body = zlib.gunzipSync(body);
        break;
      case "deflate":
        body = zlib.inflateSync(body);
        break;
      case "br":
        body = zlib.brotliDecompressSync(body);
        break;
      case "zstd":
        body = zlib.zstdDecompressSync(body);
        break;
      default:
        throw new Error(`unsupported content-encoding: ${encoding}`);
    }
  }
  return body;
}

/** The value with every string under a credential-named key replaced by a placeholder naming only its length. */
export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, typeof entry === "string" && SECRET_KEY_PATTERN.test(key) ? `<redacted ${String(entry.length)} chars>` : redactJson(entry)]),
    );
  }
  return value;
}

/** The structure of a JSON value: keys and value types, arrays reduced to their first element, short strings kept verbatim (null stays null). */
export function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shapeOf(value[0])];
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shapeOf(entry)]));
  }
  if (typeof value === "string") {
    return value.length <= SHAPE_LITERAL_MAX_CHARS ? value : "string";
  }
  return value === null ? null : typeof value;
}

export interface RenderOptions {
  /** Print each JSON body as its structure instead of its content. */
  readonly shape: boolean;
}

function renderBody(message: HttpMessage, options: RenderOptions): string | undefined {
  if (message.body.length === 0 && message.complete) {
    return undefined;
  }
  if (!message.complete) {
    return `(incomplete: ${String(message.body.length)} bytes captured, not decoded)`;
  }
  const content = decodeContent(message);
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) {
    return `(binary, ${String(content.length)} bytes)`;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return options.shape ? `(text, ${String(text.length)} chars)` : text;
  }
  const redacted = redactJson(json);
  return JSON.stringify(options.shape ? shapeOf(redacted) : redacted);
}

function renderMessage(message: HttpMessage, prefix: string, options: RenderOptions): string[] {
  const lines = [`${prefix} ${message.startLine}`];
  for (const [name, value] of message.headers) {
    lines.push(`${prefix} ${name}: ${REDACTED_HEADERS.has(name) ? "<redacted>" : value}`);
  }
  const body = renderBody(message, options);
  if (body !== undefined) {
    lines.push(body);
  }
  return lines;
}

/** One exchange as text: request lines marked `>`, response lines marked `<`, bodies below their headers. */
export function renderExchange(exchange: HttpExchange, options: RenderOptions): string {
  const lines = [`=== conn ${String(exchange.conn)} ${exchange.host}${exchange.upgraded ? " (upgraded)" : ""}`, ...renderMessage(exchange.request, ">", options)];
  lines.push(...(exchange.response === undefined ? ["< (no response captured)"] : renderMessage(exchange.response, "<", options)));
  return lines.join("\n");
}

/** Whether the exchange's request line (method and target) contains `needle`. */
export function matchesRequest(exchange: HttpExchange, needle: string): boolean {
  return exchange.request.startLine.includes(needle);
}

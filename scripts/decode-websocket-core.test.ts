import * as zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import { decodeExchanges, renderExchange, type HttpExchange } from "./decode-http-capture-core";
import { decodeFrames, negotiationOf, type WebSocketDirection, type WebSocketNegotiation } from "./decode-websocket-core";
import { encodeChunk, type CaptureRecord } from "./rc-capture-record";

const FIN = 0x80;
const RSV1 = 0x40;
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const MASK = 0x80;
const MASK_KEY = Buffer.from("37fa213d", "hex");
const CLOSE_NORMAL = 1000;
const LENGTH_16_BIT_MARKER = 126;
const LENGTH_64_BIT_MARKER = 127;
const SYNC_TAIL_BYTES = 4;
const MAX_16_BIT_LENGTH = 0xffff;
const RSV2 = 0x20;
const SHORT_HEADER_BYTES = 2;
const LENGTH_16_BYTES = 2;
const LENGTH_64_BYTES = 8;
/** Cuts a frame inside its payload: past the two-byte header, short of the end of every text used with it. */
const PARTIAL_BYTES = 6;
/** Enough repeats that a deflate stream reuses earlier text, so a decoder that drops the window between messages cannot decode the second one. */
const REPEATS = 20;
const HOST = "api.example.test";

const PLAIN: WebSocketNegotiation = { deflate: false, noContextTakeover: { client_to_server: false, server_to_client: false } };

interface FrameSpec {
  readonly opcode: number;
  readonly payload: Buffer;
  readonly fin?: boolean;
  readonly rsv1?: boolean;
  readonly masked?: boolean;
}

/** One frame as an endpoint would write it, with the payload length encoded in the shortest form the RFC allows unless `wide` forces the 64-bit one. */
function frame(spec: FrameSpec, wide = false): Buffer {
  const first = (spec.fin === false ? 0 : FIN) | (spec.rsv1 === true ? RSV1 : 0) | spec.opcode;
  const maskBit = spec.masked === true ? MASK : 0;
  const length = spec.payload.length;
  let head: Buffer;
  if (wide || length > MAX_16_BIT_LENGTH) {
    head = Buffer.alloc(SHORT_HEADER_BYTES + LENGTH_64_BYTES);
    head.writeUInt8(maskBit | LENGTH_64_BIT_MARKER, 1);
    head.writeBigUInt64BE(BigInt(length), SHORT_HEADER_BYTES);
  } else if (length >= LENGTH_16_BIT_MARKER) {
    head = Buffer.alloc(SHORT_HEADER_BYTES + LENGTH_16_BYTES);
    head.writeUInt8(maskBit | LENGTH_16_BIT_MARKER, 1);
    head.writeUInt16BE(length, SHORT_HEADER_BYTES);
  } else {
    head = Buffer.alloc(SHORT_HEADER_BYTES);
    head.writeUInt8(maskBit | length, 1);
  }
  head.writeUInt8(first, 0);
  if (spec.masked !== true) {
    return Buffer.concat([head, spec.payload]);
  }
  const masked = Buffer.from(spec.payload.map((byte, index) => byte ^ (MASK_KEY[index % MASK_KEY.length] ?? 0)));
  return Buffer.concat([head, MASK_KEY, masked]);
}

const text = (value: string, extra: Partial<FrameSpec> = {}): Buffer => frame({ opcode: OPCODE_TEXT, payload: Buffer.from(value), ...extra });

function decode(stream: Buffer, direction: WebSocketDirection = "server_to_client", negotiation: WebSocketNegotiation = PLAIN) {
  const { messages, trailingBytes } = decodeFrames(stream, direction, negotiation);
  return { messages: messages.map((message) => ({ kind: message.kind, payload: message.payload.toString("utf8") })), trailingBytes };
}

/** What a permessage-deflate sender puts on the wire for one message: the raw deflate stream with its trailing empty block removed, continuing from `history` when the context is kept. */
function deflateMessage(value: string, history?: Buffer): Buffer {
  const compressed = zlib.deflateRawSync(Buffer.from(value), { finishFlush: zlib.constants.Z_SYNC_FLUSH, ...(history === undefined ? {} : { dictionary: history }) });
  return compressed.subarray(0, compressed.length - SYNC_TAIL_BYTES);
}

describe("decodeFrames", () => {
  it("reads unmasked text and binary frames in order", () => {
    const stream = Buffer.concat([text("one"), frame({ opcode: OPCODE_BINARY, payload: Buffer.from("010203", "hex") }), text("two")]);
    expect(decode(stream).messages.map((message) => message.kind)).toEqual(["text", "binary", "text"]);
    expect(decode(stream).messages.map((message) => message.payload)).toEqual(["one", "\u0001\u0002\u0003", "two"]);
  });

  it("removes the client mask", () => {
    expect(decode(text("hello", { masked: true }), "client_to_server").messages).toEqual([{ kind: "text", payload: "hello" }]);
  });

  it("reads the 16-bit and 64-bit length forms", () => {
    const medium = "m".repeat(LENGTH_16_BIT_MARKER);
    const large = "l".repeat(MAX_16_BIT_LENGTH + 1);
    expect(decode(Buffer.concat([text(medium), text(large)])).messages.map((message) => message.payload.length)).toEqual([medium.length, large.length]);
    expect(decode(frame({ opcode: OPCODE_TEXT, payload: Buffer.from("w") }, true)).messages).toEqual([{ kind: "text", payload: "w" }]);
  });

  it("joins fragments, with a ping allowed between them", () => {
    const stream = Buffer.concat([
      text("frag", { fin: false }),
      frame({ opcode: OPCODE_PING, payload: Buffer.from("p") }),
      frame({ opcode: OPCODE_CONTINUATION, payload: Buffer.from("ment"), fin: false }),
      frame({ opcode: OPCODE_CONTINUATION, payload: Buffer.from("ed") }),
    ]);
    expect(decode(stream).messages).toEqual([
      { kind: "ping", payload: "p" },
      { kind: "text", payload: "fragmented" },
    ]);
  });

  it("returns a close frame's payload, status code first", () => {
    const code = Buffer.alloc(2);
    code.writeUInt16BE(CLOSE_NORMAL);
    const [message] = decodeFrames(frame({ opcode: OPCODE_CLOSE, payload: Buffer.concat([code, Buffer.from("bye")]) }), "server_to_client", PLAIN).messages;
    expect(message?.kind).toBe("close");
    expect(message?.payload.readUInt16BE(0)).toBe(CLOSE_NORMAL);
    expect(message?.payload.toString("utf8", 2)).toBe("bye");
  });

  it("counts the bytes of a frame the capture ends in the middle of", () => {
    const whole = text("complete");
    const partial = text("cut off here").subarray(0, PARTIAL_BYTES);
    expect(decode(Buffer.concat([whole, partial]))).toEqual({ messages: [{ kind: "text", payload: "complete" }], trailingBytes: partial.length });
  });

  it("counts a fragmented message the capture ends in the middle of from its first frame", () => {
    const first = text("start", { fin: false });
    expect(decode(Buffer.concat([text("done"), first]))).toEqual({ messages: [{ kind: "text", payload: "done" }], trailingBytes: first.length });
  });

  it("refuses a continuation with nothing to continue and a frame with reserved bits", () => {
    expect(() => decode(frame({ opcode: OPCODE_CONTINUATION, payload: Buffer.from("x") }))).toThrow("no message to continue");
    const reserved = text("x");
    reserved.writeUInt8(reserved.readUInt8(0) | RSV2, 0);
    expect(() => decode(reserved)).toThrow("RSV2 or RSV3");
  });
});

describe("permessage-deflate", () => {
  const repeated = "the same words again and again, ".repeat(REPEATS);
  const takeover = negotiationOf("permessage-deflate");

  it("decompresses a message whose first frame sets RSV1", () => {
    const stream = frame({ opcode: OPCODE_TEXT, payload: deflateMessage(repeated), rsv1: true });
    expect(decode(stream, "server_to_client", takeover).messages).toEqual([{ kind: "text", payload: repeated }]);
  });

  it("carries the window from one message to the next when the sender keeps its context", () => {
    const second = `${repeated}and then some more`;
    const stream = Buffer.concat([
      frame({ opcode: OPCODE_TEXT, payload: deflateMessage(repeated), rsv1: true }),
      frame({ opcode: OPCODE_TEXT, payload: deflateMessage(second, Buffer.from(repeated)), rsv1: true }),
    ]);
    expect(decode(stream, "server_to_client", takeover).messages.map((message) => message.payload)).toEqual([repeated, second]);
  });

  it("starts every message fresh under no_context_takeover, and reads each direction's flag for its own sender", () => {
    const negotiation = negotiationOf("permessage-deflate; server_no_context_takeover");
    expect(negotiation.noContextTakeover).toEqual({ client_to_server: false, server_to_client: true });
    const stream = Buffer.concat([
      frame({ opcode: OPCODE_TEXT, payload: deflateMessage(repeated), rsv1: true }),
      frame({ opcode: OPCODE_TEXT, payload: deflateMessage(repeated), rsv1: true }),
    ]);
    expect(decode(stream, "server_to_client", negotiation).messages.map((message) => message.payload)).toEqual([repeated, repeated]);
  });

  it("decompresses a fragmented message by the RSV1 of its first frame", () => {
    const wire = deflateMessage(repeated);
    const half = Math.floor(wire.length / 2);
    const stream = Buffer.concat([
      frame({ opcode: OPCODE_TEXT, payload: wire.subarray(0, half), rsv1: true, fin: false }),
      frame({ opcode: OPCODE_CONTINUATION, payload: wire.subarray(half) }),
    ]);
    expect(decode(stream, "server_to_client", takeover).messages).toEqual([{ kind: "text", payload: repeated }]);
  });

  it("refuses RSV1 when no compression was negotiated, and any other extension", () => {
    expect(() => decode(frame({ opcode: OPCODE_TEXT, payload: deflateMessage(repeated), rsv1: true }))).toThrow("not negotiated");
    expect(() => negotiationOf("x-webkit-deflate-frame")).toThrow("unsupported websocket extension");
  });

  it("reports no compression when the handshake named no extension", () => {
    expect(negotiationOf(undefined)).toEqual(PLAIN);
  });
});

function onlyExchange(records: readonly CaptureRecord[]): HttpExchange {
  const [exchange] = decodeExchanges(records);
  if (exchange === undefined) {
    throw new Error("expected an exchange");
  }
  return exchange;
}

describe("renderExchange over a WebSocket upgrade", () => {
  const record = (id: number, dir: CaptureRecord["dir"], bytes: Buffer): CaptureRecord => ({ ts: "2026-01-01T00:00:00.000Z", id, conn: 1, dir, host: HOST, ...encodeChunk(bytes) });
  const request = Buffer.from("GET /api/frame/sync HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: frame-sync.v1\r\n\r\n");
  const upgrade = (extensions: string): Buffer => Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Extensions: ${extensions}\r\n\r\n`);

  it("prints each direction's messages after the handshake, with credential-named JSON fields redacted", () => {
    const clientFrames = Buffer.concat([request, text(JSON.stringify({ type: "hello", sync_token: "s3cr3t-value" }), { masked: true })]);
    const serverFrames = Buffer.concat([upgrade(""), text(JSON.stringify({ type: "ack", seq: 7 }))]);
    const exchange = onlyExchange([record(1, "client_to_server", clientFrames), record(2, "server_to_client", serverFrames)]);
    const rendered = renderExchange(exchange, { shape: false });
    expect(rendered).toContain('ws > text {"type":"hello","sync_token":"<redacted 12 chars>"}');
    expect(rendered).toContain('ws < text {"type":"ack","seq":7}');
    expect(rendered).not.toContain("s3cr3t-value");
  });

  it("prints a compressed message's content and, under shape, its structure", () => {
    const body = JSON.stringify({ type: "snapshot", files: ["a.html", "b.css"], version: 3 });
    const compressed = frame({ opcode: OPCODE_TEXT, payload: deflateMessage(body), rsv1: true });
    const exchange = onlyExchange([record(1, "client_to_server", request), record(2, "server_to_client", Buffer.concat([upgrade("permessage-deflate"), compressed]))]);
    
    expect(renderExchange(exchange, { shape: false })).toContain(`ws < text ${body}`);
    expect(renderExchange(exchange, { shape: true })).toContain('ws < text {"type":"snapshot","files":["a.html"],"version":"number"}');
  });

  it("marks a message the capture ends in the middle of", () => {
    const exchange = onlyExchange([record(1, "client_to_server", request), record(2, "server_to_client", Buffer.concat([upgrade(""), text("whole"), text("truncated message").subarray(0, PARTIAL_BYTES)]))]);
    expect(renderExchange(exchange, { shape: false })).toContain(`ws < (incomplete: ${String(PARTIAL_BYTES)} bytes captured, not decoded)`);
  });

  it("leaves an upgrade that is not a WebSocket one unread", () => {
    const other = Buffer.from("GET /x HTTP/1.1\r\nUpgrade: h2c\r\n\r\n");
    const exchange = onlyExchange([record(1, "client_to_server", other), record(2, "server_to_client", Buffer.concat([upgrade(""), text("ignored")]))]);
    expect(renderExchange(exchange, { shape: false })).not.toContain("ws <");
  });
});

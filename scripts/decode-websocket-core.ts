import * as zlib from "node:zlib";

/**
 * The WebSocket half of `scripts/decode-http-capture.mts`: turns the bytes one direction of an upgraded connection carried after the `101` response back into the messages they framed (RFC 6455), with client masking removed, fragments joined and `permessage-deflate` (RFC 7692) undone.
 *
 * Each direction is decoded on its own, because the capture's two byte streams carry no ordering between them: the messages of one direction keep their order, and nothing says how a client message interleaved with a server one.
 */
export type WebSocketDirection = "client_to_server" | "server_to_client";

export type WebSocketMessageKind = "text" | "binary" | "ping" | "pong" | "close";

export interface WebSocketMessage {
  readonly direction: WebSocketDirection;
  readonly kind: WebSocketMessageKind;
  /** The message payload after unmasking and, for a compressed data message, decompression. */
  readonly payload: Buffer;
}

export interface WebSocketStream {
  readonly messages: readonly WebSocketMessage[];
  /** Bytes of a frame or fragmented message the capture ends in the middle of, which are not decoded. */
  readonly trailingBytes: number;
}

/** What the handshake negotiated, from the `Sec-WebSocket-Extensions` header of the `101` response. */
export interface WebSocketNegotiation {
  readonly deflate: boolean;
  /** True when the sender of each direction starts every message with an empty compression window. */
  readonly noContextTakeover: Readonly<Record<WebSocketDirection, boolean>>;
}

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

const FIN_BIT = 0x80;
const RSV1_BIT = 0x40;
const RESERVED_BITS = 0x30;
const OPCODE_MASK = 0x0f;
const MASK_BIT = 0x80;
const LENGTH_MASK = 0x7f;
const LENGTH_16_BIT_MARKER = 126;
const LENGTH_64_BIT_MARKER = 127;
const MASK_KEY_BYTES = 4;
const SHORT_HEADER_BYTES = 2;
const LENGTH_16_BYTES = 2;
const LENGTH_64_BYTES = 8;

/** The tail every deflate message loses on the wire: an empty stored block, appended again before inflating, with a sync flush because the message ends in no final block (RFC 7692 section 7.2.2). */
const DEFLATE_TAIL = Buffer.from("0000ffff", "hex");

/** The window a deflate stream can refer back to, which is all the history a context-taking receiver needs (RFC 1951). */
const DEFLATE_WINDOW_BYTES = 32_768;

const DATA_KINDS: Readonly<Record<number, WebSocketMessageKind>> = { [OPCODE_TEXT]: "text", [OPCODE_BINARY]: "binary" };
const CONTROL_KINDS: Readonly<Record<number, WebSocketMessageKind>> = { [OPCODE_CLOSE]: "close", [OPCODE_PING]: "ping", [OPCODE_PONG]: "pong" };

/** Reads the negotiated extensions: `permessage-deflate` and its two context-takeover parameters, which name the sender, so `client_no_context_takeover` governs the client's messages. Any other extension is an error, because it would change the bytes this decoder reads. */
export function negotiationOf(extensionsHeader: string | undefined): WebSocketNegotiation {
  let deflate = false;
  let clientNoContext = false;
  let serverNoContext = false;
  for (const extension of (extensionsHeader ?? "").split(",")) {
    const [name = "", ...parameters] = extension.split(";").map((part) => part.trim().toLowerCase());
    if (name === "") {
      continue;
    }
    if (name !== "permessage-deflate") {
      throw new Error(`unsupported websocket extension: ${name}`);
    }
    deflate = true;
    clientNoContext = parameters.includes("client_no_context_takeover");
    serverNoContext = parameters.includes("server_no_context_takeover");
  }
  return { deflate, noContextTakeover: { client_to_server: clientNoContext, server_to_client: serverNoContext } };
}

interface Frame {
  readonly fin: boolean;
  readonly compressed: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
  readonly end: number;
}

/** Reads one frame at `offset`, or undefined when the stream ends before the frame does. */
function readFrame(stream: Buffer, offset: number): Frame | undefined {
  if (stream.length - offset < SHORT_HEADER_BYTES) {
    return undefined;
  }
  const first = stream.readUInt8(offset);
  const second = stream.readUInt8(offset + 1);
  if ((first & RESERVED_BITS) !== 0) {
    throw new Error(`websocket frame at byte ${String(offset)} sets RSV2 or RSV3, which no negotiated extension uses`);
  }
  const masked = (second & MASK_BIT) !== 0;
  let position = offset + SHORT_HEADER_BYTES;
  let length = second & LENGTH_MASK;
  if (length === LENGTH_16_BIT_MARKER) {
    if (stream.length - position < LENGTH_16_BYTES) {
      return undefined;
    }
    length = stream.readUInt16BE(position);
    position += LENGTH_16_BYTES;
  } else if (length === LENGTH_64_BIT_MARKER) {
    if (stream.length - position < LENGTH_64_BYTES) {
      return undefined;
    }
    const wide = stream.readBigUInt64BE(position);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`websocket frame at byte ${String(offset)} declares a payload of ${String(wide)} bytes`);
    }
    length = Number(wide);
    position += LENGTH_64_BYTES;
  }
  const maskKey = masked ? stream.subarray(position, position + MASK_KEY_BYTES) : undefined;
  if (masked) {
    position += MASK_KEY_BYTES;
  }
  const end = position + length;
  if (end > stream.length || (masked && maskKey?.length !== MASK_KEY_BYTES)) {
    return undefined;
  }
  const payload = Buffer.from(stream.subarray(position, end));
  if (maskKey !== undefined) {
    for (const [index, byte] of payload.entries()) {
      payload[index] = byte ^ (maskKey[index % MASK_KEY_BYTES] ?? 0);
    }
  }
  return { fin: (first & FIN_BIT) !== 0, compressed: (first & RSV1_BIT) !== 0, opcode: first & OPCODE_MASK, payload, end };
}

/** Decodes the messages one direction of an upgraded connection carried. */
export function decodeFrames(stream: Buffer, direction: WebSocketDirection, negotiation: WebSocketNegotiation): WebSocketStream {
  const messages: WebSocketMessage[] = [];
  let offset = 0;
  let fragments: Buffer[] = [];
  let fragmentKind: WebSocketMessageKind | undefined;
  let fragmentCompressed = false;
  let fragmentStart = 0;
  let history = Buffer.alloc(0);

  const finishData = (kind: WebSocketMessageKind, parts: readonly Buffer[], compressed: boolean): void => {
    let payload = Buffer.concat(parts);
    if (compressed) {
      if (!negotiation.deflate) {
        throw new Error("websocket message sets RSV1 but permessage-deflate was not negotiated");
      }
      payload = zlib.inflateRawSync(Buffer.concat([payload, DEFLATE_TAIL]), { finishFlush: zlib.constants.Z_SYNC_FLUSH, ...(history.length === 0 ? {} : { dictionary: history }) });
      history = negotiation.noContextTakeover[direction] ? Buffer.alloc(0) : Buffer.concat([history, payload]).subarray(-DEFLATE_WINDOW_BYTES);
    }
    messages.push({ direction, kind, payload });
  };

  for (;;) {
    const frame = readFrame(stream, offset);
    if (frame === undefined) {
      const open = fragmentKind === undefined ? offset : fragmentStart;
      return { messages, trailingBytes: stream.length - open };
    }
    const control = CONTROL_KINDS[frame.opcode];
    if (control !== undefined) {
      messages.push({ direction, kind: control, payload: frame.payload });
    } else if (frame.opcode === OPCODE_CONTINUATION) {
      if (fragmentKind === undefined) {
        throw new Error(`websocket continuation frame at byte ${String(offset)} has no message to continue`);
      }
      fragments.push(frame.payload);
      if (frame.fin) {
        finishData(fragmentKind, fragments, fragmentCompressed);
        fragments = [];
        fragmentKind = undefined;
      }
    } else {
      const kind = DATA_KINDS[frame.opcode];
      if (kind === undefined) {
        throw new Error(`websocket frame at byte ${String(offset)} has reserved opcode ${String(frame.opcode)}`);
      }
      if (fragmentKind !== undefined) {
        throw new Error(`websocket data frame at byte ${String(offset)} starts a message inside an unfinished one`);
      }
      if (frame.fin) {
        finishData(kind, [frame.payload], frame.compressed);
      } else {
        fragmentKind = kind;
        fragmentCompressed = frame.compressed;
        fragmentStart = offset;
        fragments = [frame.payload];
      }
    }
    offset = frame.end;
  }
}

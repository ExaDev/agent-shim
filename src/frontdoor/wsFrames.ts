/**
 * Minimal RFC 6455 websocket frame decoding, for reading captured Remote Control traffic offline. The door's data path never parses these frames: the upgrade relay splices the bytes through untouched, the capture tees them, and this module exists so the recorded stream-chunks can be turned back into the frame sequence that crossed the wire (opcode, FIN, payload) without a websocket library or a live connection.
 *
 * Frames can straddle capture chunks in either direction, so decoding is incremental: feed a session's chunks in order with `push`, take whatever complete frames are ready, and the residue stays buffered for the next chunk. A masked client frame is unmasked in the emitted payload, since masking is a wire artifact with no diagnostic meaning. A close or ping or pong frame carries no payload worth reading but is emitted anyway, because the frame kinds themselves are part of the protocol's story. Nothing here validates protocol correctness beyond the framing arithmetic: a truncated header or an absurd length surfaces as an error frame rather than an exception, because a capture can legitimately start mid-stream.
 */

/** The RFC 6455 opcodes, named. */
type WsOpcode = "continuation" | "text" | "binary" | "close" | "ping" | "pong" | "unknown";

/** One decoded frame. `error` carries the reason decoding could not proceed, and always ends the stream. */
export interface WsFrame {
  /** True when the frame is the whole message (no continuation follows). */
  readonly fin: boolean;
  readonly opcode: WsOpcode;
  /** The frame's payload: UTF-8 text for text frames (invalid bytes replaced, since a capture exists to be read), the unmasked bytes otherwise. */
  readonly payload: string | Buffer;
  /** Present only on the final frame this decoder emits: why the stream ended. */
  readonly error?: string;
}

/** Incremental frame decoder for one direction of one captured stream. */
export interface WsFrameReader {
  /** Buffers one chunk and returns every frame it completes, in order. */
  readonly push: (chunk: Readonly<Buffer>) => readonly WsFrame[];
}

/** The smallest complete header: two bytes, no extended length, no mask. */
const MINIMAL_HEADER_BYTES = 2;
/** Where a 16-bit extended length sits. */
const HEADER_16_BYTES = 4;
/** Where a 64-bit extended length sits. */
const HEADER_64_BYTES = 10;
/** The largest payload this decoder will accept: frames of the maximum 2^63 are protocol-legal but no real capture holds one, so an absurd length is treated as garbage rather than buffered forever. */
const MAX_PLAUSIBLE_PAYLOAD = 67_108_864;

// RFC 6455 opcode numbers: 0 continuation, 1 text, 2 binary, 8 close, 9 ping, 10 pong; 3 to 7 and 11 up are reserved, and a reserved opcode is a frame this decoder names rather than interprets.
const OPCODE_NAMES: Readonly<Record<number, WsOpcode>> = { 0: "continuation", 1: "text", 2: "binary", 8: "close", 9: "ping", 10: "pong" };

/** The FIN bit in a frame's first byte. */
const FIN_BIT = 0x80;
/** The opcode nibble in a frame's first byte. */
const OPCODE_MASK = 0x0f;
/** The mask bit in a frame's second byte. */
const MASK_BIT = 0x80;
/** The length nibble in a frame's second byte. */
const LENGTH_MASK = 0x7f;
/** The 16-bit extended-length marker in the length nibble. */
const EXTENDED_16_MARKER = 126;
/** The 64-bit extended-length marker in the length nibble. */
const EXTENDED_64_MARKER = 127;
/** Where the high 32 bits of a 64-bit length sit. */
const LENGTH_64_HIGH_OFFSET = 2;
/** Where the low 32 bits of a 64-bit length sit. */
const LENGTH_64_LOW_OFFSET = 6;
/** 2 to the 32, the weight of a 64-bit length's high word. */
const LENGTH_64_HIGH_WEIGHT = 4_294_967_296;
/** A masking key's length, in bytes. */
const MASK_KEY_BYTES = 4;

/**
 * Builds a reader for one direction of a captured stream. Every chunk must be pushed in wire order; the reader holds whatever partial frame it has between pushes.
 */
export function createWsFrameReader(): WsFrameReader {
  let buffer = Buffer.alloc(0);
  const decodeOne = (): WsFrame | undefined => {
    if (buffer.length < MINIMAL_HEADER_BYTES) {
      return undefined;
    }
    const first = buffer[0] ?? 0;
    const second = buffer[1] ?? 0;
    const fin = (first & FIN_BIT) !== 0;
    const opcodeBits = first & OPCODE_MASK;
    const opcode: WsOpcode = OPCODE_NAMES[opcodeBits] ?? "unknown";
    const masked = (second & MASK_BIT) !== 0;
    const lengthBits = second & LENGTH_MASK;
    let headerBytes = MINIMAL_HEADER_BYTES;
    let length = lengthBits;
    if (lengthBits === EXTENDED_16_MARKER) {
      if (buffer.length < HEADER_16_BYTES) {
        return undefined;
      }
      length = buffer.readUInt16BE(MINIMAL_HEADER_BYTES);
      headerBytes = HEADER_16_BYTES;
    } else if (lengthBits === EXTENDED_64_MARKER) {
      if (buffer.length < HEADER_64_BYTES) {
        return undefined;
      }
      const high = buffer.readUInt32BE(LENGTH_64_HIGH_OFFSET);
      const low = buffer.readUInt32BE(LENGTH_64_LOW_OFFSET);
      length = high * LENGTH_64_HIGH_WEIGHT + low;
      headerBytes = HEADER_64_BYTES;
    }
    if (length > MAX_PLAUSIBLE_PAYLOAD) {
      return { fin, opcode, payload: "", error: `implausible payload length ${String(length)}; the capture is not frame-aligned here` };
    }
    const maskBytes = masked ? MASK_KEY_BYTES : 0;
    const total = headerBytes + maskBytes + length;
    if (buffer.length < total) {
      return undefined;
    }
    let payload = buffer.subarray(headerBytes + maskBytes, total);
    if (masked) {
      const mask = buffer.subarray(headerBytes, headerBytes + maskBytes);
      const unmasked = Buffer.alloc(payload.length);
      for (let index = 0; index < payload.length; index += 1) {
        unmasked[index] = (payload[index] ?? 0) ^ (mask[index % maskBytes] ?? 0);
      }
      payload = unmasked;
    }
    buffer = buffer.subarray(total);
    return {
      fin,
      opcode,
      payload: opcode === "text" ? payload.toString("utf8") : Buffer.from(payload),
    };
  };
  const push = (chunk: Readonly<Buffer>): readonly WsFrame[] => {
    buffer = Buffer.concat([buffer, chunk]);
    const frames: WsFrame[] = [];
    for (;;) {
      const frame = decodeOne();
      if (frame === undefined) {
        return frames;
      }
      frames.push(frame);
      if (frame.error !== undefined) {
        // A stream that failed to decode is over; further chunks are noise from a dead direction.
        buffer = Buffer.alloc(0);
        return frames;
      }
    }
  };
  return { push };
}

import { describe, expect, it } from "vitest";

import { createWsFrameReader, type WsFrame } from "./wsFrames";

/** A final text frame's first byte: FIN set, opcode 1. */
const TEXT_FIN = 0x81;
/** The mask bit in a frame's second byte. */
const MASK_BIT = 0x80;
/** An arbitrary mask key, the four bytes a real client picks at random. */
const MASK_BYTE_0 = 0x11;
const MASK_BYTE_1 = 0x22;
const MASK_BYTE_2 = 0x33;
const MASK_BYTE_3 = 0x44;
const MASK_KEY = [MASK_BYTE_0, MASK_BYTE_1, MASK_BYTE_2, MASK_BYTE_3] as const;

/** Builds one masked client text frame the way a real client does, with the mask applied. */
function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (MASK_KEY[index % MASK_KEY.length] ?? 0);
  }
  return Buffer.concat([Buffer.from([TEXT_FIN, MASK_BIT | payload.length]), Buffer.from([...MASK_KEY]), masked]);
}

/** A final binary frame's first byte: FIN set, opcode 2. */
const BINARY_FIN = 0x82;
/** The 16-bit extended-length marker in the length bits. */
const EXTENDED_16_LENGTH_BITS = 126;
/** A payload long enough to require the 16-bit extended length (over 125 bytes). */
const EXTENDED_16_PAYLOAD_BYTES = 300;
/** A text fragment's first byte: FIN clear, opcode 1. */
const TEXT_FRAGMENT = 0x01;
/** A final continuation's first byte: FIN set, opcode 0. */
const CONTINUATION_FIN = 0x80;
/** A close frame's first byte: FIN set, opcode 8. */
const CLOSE_FIN = 0x88;
/** A ping frame's first byte: FIN set, opcode 9. */
const PING_FIN = 0x89;
/** The 64-bit extended-length marker in the length bits. */
const LENGTH_64_BITS = 127;
/** A 64-bit length body's byte count. */
const LENGTH_64_BODY_BYTES = 8;
/** Every bit set, the body of a maximum-length header, which no plausible capture really holds. */
const ALL_BITS_SET = 0xff;
const MAX_LENGTH_BYTES = Buffer.alloc(LENGTH_64_BODY_BYTES, ALL_BITS_SET);

describe("createWsFrameReader", () => {
  it("decodes an unmasked server text frame", () => {
    const reader = createWsFrameReader();
    const payload = Buffer.from('{"kind":"hello"}', "utf8");
    const frame = Buffer.concat([Buffer.from([TEXT_FIN, payload.length]), payload]);
    expect(reader.push(frame)).toEqual([{ fin: true, opcode: "text", payload: '{"kind":"hello"}' }]);
  });

  it("decodes a masked client frame back to its payload", () => {
    const reader = createWsFrameReader();
    const frames = reader.push(maskedTextFrame("tap-payload"));
    expect(frames).toEqual([{ fin: true, opcode: "text", payload: "tap-payload" }]);
  });

  it("reassembles a frame split across chunks", () => {
    const reader = createWsFrameReader();
    const payload = Buffer.from("split-frame", "utf8");
    const frame = Buffer.concat([Buffer.from([TEXT_FIN, payload.length]), payload]);
    const SPLIT_AT = 3;
    expect(reader.push(frame.subarray(0, SPLIT_AT))).toEqual([]);
    const frames = reader.push(frame.subarray(SPLIT_AT));
    expect(frames).toEqual([{ fin: true, opcode: "text", payload: "split-frame" }]);
  });

  it("decodes a 16-bit extended length and a binary frame", () => {
    const reader = createWsFrameReader();
    const FILL_BYTE = 0x07;
    const payload = Buffer.alloc(EXTENDED_16_PAYLOAD_BYTES, FILL_BYTE);
    const frame = Buffer.concat([Buffer.from([BINARY_FIN, EXTENDED_16_LENGTH_BITS]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })(), payload]);
    const frames = reader.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.opcode).toBe("binary");
    expect((frames[0]?.payload as Buffer).length).toBe(EXTENDED_16_PAYLOAD_BYTES);
  });

  it("ends the stream with an error frame on a capture that is not frame-aligned", () => {
    const reader = createWsFrameReader();
    const frames = reader.push(Buffer.concat([Buffer.from([TEXT_FIN, LENGTH_64_BITS]), MAX_LENGTH_BYTES]));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.error).toContain("implausible payload length");
    expect(reader.push(Buffer.from("more-bytes"))).toEqual([]);
  });

  it("names close, ping and continuation opcodes and reports a fragmented message's FIN", () => {
    const reader = createWsFrameReader();
    const FIRST_FRAGMENT_LENGTH = 3;
    const SECOND_FRAGMENT_LENGTH = 5;
    const first = Buffer.concat([Buffer.from([TEXT_FRAGMENT, FIRST_FRAGMENT_LENGTH]), Buffer.from("par")]);
    const second = Buffer.concat([Buffer.from([CONTINUATION_FIN, SECOND_FRAGMENT_LENGTH]), Buffer.from("tial!")]);
    const close = Buffer.from([CLOSE_FIN, 0]);
    const ping = Buffer.from([PING_FIN, 0]);
    const frames: WsFrame[] = [...reader.push(first), ...reader.push(second), ...reader.push(close), ...reader.push(ping)];
    expect(frames.map((frame) => [frame.opcode, frame.fin])).toEqual([
      ["text", false],
      ["continuation", true],
      ["close", true],
      ["ping", true],
    ]);
    expect((frames[1]?.payload as Buffer).toString("utf8")).toBe("tial!");
  });
});

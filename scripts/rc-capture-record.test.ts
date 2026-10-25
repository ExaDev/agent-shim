import { describe, expect, it } from "vitest";

import { captureRecordSchema, decodeChunk, encodeChunk } from "./rc-capture-record";

/** Larger than a TLS record (16 KiB) and than the 500-character cap an earlier capture format applied, so a truncating encoder would fail the round trip. */
const LARGE_CHUNK_BYTES = 40_000;

describe("encodeChunk and decodeChunk", () => {
  it("keeps readable text as text", () => {
    const bytes = Buffer.from("GET /x HTTP/1.1\r\n\r\n", "utf8");
    const encoded = encodeChunk(bytes);
    expect(encoded.enc).toBe("utf8");
    expect(encoded.data).toBe("GET /x HTTP/1.1\r\n\r\n");
    expect(decodeChunk(encoded).equals(bytes)).toBe(true);
  });

  it("round-trips bytes that are not valid UTF-8 through base64", () => {
    const bytes = Buffer.from("6869fffe80", "hex");
    const encoded = encodeChunk(bytes);
    expect(encoded.enc).toBe("base64");
    expect(decodeChunk(encoded).equals(bytes)).toBe(true);
  });

  it("round-trips bytes containing NUL", () => {
    const bytes = Buffer.from("004100", "hex");
    expect(decodeChunk(encodeChunk(bytes)).equals(bytes)).toBe(true);
  });

  it("round-trips a large chunk without truncating it", () => {
    const bytes = Buffer.alloc(LARGE_CHUNK_BYTES, "ab", "hex");
    expect(decodeChunk(encodeChunk(bytes)).equals(bytes)).toBe(true);
  });
});

describe("captureRecordSchema", () => {
  it("rejects a record from before the lossless format", () => {
    const older = { ts: "2026-01-01T00:00:00.000Z", id: 1, dir: "client_to_server", host: "example.test", data: "GET / HTTP/1.1" };
    expect(captureRecordSchema.safeParse(older).success).toBe(false);
  });
});

import { z } from "zod";

/**
 * The record format of the RC rig's SNI proxy capture file, defined once for the proxy that writes it (`scripts/rc-sni-proxy-core.mts`) and the decoder that reads it (`scripts/decode-http-capture-core.ts`).
 *
 * One record is one socket read, so its size is bounded by the socket's read size and a line never grows without limit. The bytes are kept whole: `utf8` when decoding them as UTF-8 and encoding the result back reproduces them exactly, `base64` otherwise, so a reader recovers the stream byte for byte. `conn` names the connection the chunk belongs to, which is what lets a reader reassemble each connection's two byte streams while several connections interleave in one file; `id` is the order across all of them.
 */
export const CAPTURE_DIRECTIONS = ["client_to_server", "server_to_client"] as const;

export const captureRecordSchema = z.object({
  ts: z.string(),
  id: z.number().int().nonnegative(),
  conn: z.number().int().nonnegative(),
  dir: z.enum(CAPTURE_DIRECTIONS),
  host: z.string(),
  enc: z.enum(["utf8", "base64"]),
  data: z.string(),
});

export type CaptureRecord = z.infer<typeof captureRecordSchema>;

/** The `enc` and `data` fields for one chunk of bytes, readable text where that loses nothing. */
export function encodeChunk(bytes: Buffer): Pick<CaptureRecord, "enc" | "data"> {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? { enc: "utf8", data: text } : { enc: "base64", data: bytes.toString("base64") };
}

/** The bytes a record's `enc` and `data` fields stand for. */
export function decodeChunk(record: Readonly<Pick<CaptureRecord, "enc" | "data">>): Buffer {
  return Buffer.from(record.data, record.enc === "utf8" ? "utf8" : "base64");
}

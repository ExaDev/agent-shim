/**
 * Reads a front-door capture file and prints the websocket frames its recorded streams carried, decoded: the offline half of the Remote Control channel observation (the door tees the relayed websocket into `logs/frontdoor-capture.jsonl` and never parses it; this script turns the stream-chunk records back into the frame sequence that crossed the wire, per direction, in capture order).
 *
 * Usage: node scripts/decode-stream-capture.mts PATH-TO-CAPTURE-FILE [stream-id]
 * Without a stream id every stream in the file is decoded; with one, only that stream's. Text frames print as JSON when they parse (the channel's payloads are JSON objects) and verbatim otherwise; binary frames print as base64.
 *
 * The output can contain credential material: frames are the live protocol's payloads, and the capture stores compressed or binary bodies verbatim (see the capture's docs caveat). Read it, then delete the file; never paste it anywhere.
 */
import * as fs from "node:fs";

import { createWsFrameReader, type WsFrame } from "../src/frontdoor/wsFrames";

interface CaptureRecord {
  readonly ts?: string;
  readonly kind?: string;
  readonly id?: number;
  readonly dir?: "client-to-server" | "server-to-client";
  readonly host?: string;
  readonly body?: string;
  readonly b64?: string;
}

const file = process.argv[2];
if (file === undefined) {
  console.error("usage: node scripts/decode-stream-capture.mts PATH-TO-CAPTURE-FILE [stream-id]");
  process.exit(2);
}
const onlyId = process.argv[3] === undefined ? undefined : Number(process.argv[3]);

const records: CaptureRecord[] = fs
  .readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .map((line) => asCaptureRecord(JSON.parse(line)));

const streams = records.filter((record) => record.kind === "stream");
for (const stream of streams) {
  if (stream.id === undefined || (onlyId !== undefined && stream.id !== onlyId)) {
    continue;
  }
  const id = stream.id;
  const chunks = records.filter((record) => record.kind === "stream-chunk" && record.id === id);
  const readers = {
    "client-to-server": createWsFrameReader(),
    "server-to-client": createWsFrameReader(),
  };
  console.log(`\n=== stream ${String(id)} (${stream.host ?? "?"})`);
  for (const chunk of chunks) {
    const direction = chunk.dir;
    if (direction === undefined) {
      continue;
    }
    const bytes = chunk.b64 !== undefined ? Buffer.from(chunk.b64, "base64") : Buffer.from(chunk.body ?? "", "utf8");
    for (const frame of readers[direction].push(bytes)) {
      printFrame(chunk.ts ?? "?", direction, frame);
    }
  }
}

/** Narrows one parsed line to the record shape this script reads, in the house `in`-guard style, because JSON.parse is `any`. */
function asCaptureRecord(value: unknown): CaptureRecord {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number") {
      record[key] = entry;
    }
  }
  return record;
}

function printFrame(ts: string, direction: "client-to-server" | "server-to-client", frame: WsFrame): void {
  const arrow = direction === "client-to-server" ? "c>s" : "s>c";
  if (frame.error !== undefined) {
    console.log(`${ts} ${arrow} [${frame.opcode}] DECODE ERROR: ${frame.error}`);
    return;
  }
  if (typeof frame.payload === "string") {
    let rendered = frame.payload;
    try {
      const parsed: unknown = JSON.parse(frame.payload);
      rendered = JSON.stringify(parsed);
    } catch {
      // Not JSON: print verbatim.
    }
    console.log(`${ts} ${arrow} [${frame.opcode}${frame.fin ? "" : "+"}] ${rendered}`);
    return;
  }
  console.log(`${ts} ${arrow} [${frame.opcode}${frame.fin ? "" : "+"}] (binary ${String(frame.payload.length)}B) ${frame.payload.toString("base64")}`);
}

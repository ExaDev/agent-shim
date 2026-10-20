import { z } from "zod";

import type { StatuslinePorts } from "./ports";
import { boundedDisplayText } from "./sanitise";

/** How many bytes one read takes in while looking back through a transcript: large enough that the newest assistant record, a few kilobytes, nearly always lies inside the first read, and small enough that finding it costs little. A record larger than this is found by reading further back, a chunk at a time. */
export const TRANSCRIPT_CHUNK_BYTES = 65_536;

/** The most bytes of a transcript one render reads while looking for the newest assistant record: the per-refresh read budget the statusline holds itself to, which is more than a record carrying several images needs. Beyond it the model and advisor read as unknown, and the segments fall back to what the client reports. */
export const MAX_TRANSCRIPT_SCAN_BYTES = 4_194_304;

/** What the model and advisor segments take from the newest assistant record of a transcript. */
export interface TranscriptIdentity {
  /** The model the record says served it, which differs from the client's own name for it behind a proxy. */
  readonly model: string | undefined;
  /** The advisor model the record carries once `/advisor` has been set. */
  readonly advisor: string | undefined;
}

const NOT_FOUND: TranscriptIdentity = { model: undefined, advisor: undefined };

/** The model name Claude Code writes on an assistant record it generated itself (an API error, an interrupt) rather than one the API served. */
const SYNTHETIC_MODEL = "<synthetic>";

const NEWLINE = 0x0a;

const text = z.string().optional().catch(undefined);

/** A transcript record, read for the fields the identity segments use; every other field passes through unread. */
const RecordSchema = z.looseObject({
  type: text,
  advisorModel: text,
  message: z.looseObject({ model: text }).optional().catch(undefined),
});

/** Only a line that says it is an assistant record is worth parsing: a user line can carry megabytes of tool output or an image, and parsing it would cost far more than the check. */
const ASSISTANT_TYPE = /"type"\s*:\s*"assistant"/;

/**
 * The identity a transcript line states, or undefined when it is not an assistant record the API served. A line that is not a record is skipped: a transcript being appended to can end mid-record at the moment it is read, and the records before it are still good.
 */
function identityOfLine(line: string): TranscriptIdentity | undefined {
  if (!ASSISTANT_TYPE.test(line)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = RecordSchema.safeParse(parsed);
  if (!record.success || record.data.type !== "assistant") {
    return undefined;
  }
  const model = boundedDisplayText(record.data.message?.model ?? "");
  if (model === "" || model === SYNTHETIC_MODEL) {
    return undefined;
  }
  const advisor = boundedDisplayText(record.data.advisorModel ?? "");
  return { model, advisor: advisor === "" ? undefined : advisor };
}

/** The pieces joined into one array. */
function joined(pieces: readonly Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    whole.set(piece, at);
    at += piece.length;
  }
  return whole;
}

const EMPTY_LINE = new Uint8Array();

/** `bytes` cut at its newlines: `head` is what precedes the first, which continues a line that began in an earlier chunk, and `rest` is the segments after it, oldest first, the last of which continues into the next chunk. `rest` is empty when `bytes` holds no newline. */
function splitAtNewlines(bytes: Uint8Array): { readonly head: Uint8Array; readonly rest: readonly Uint8Array[] } {
  const firstBreak = bytes.indexOf(NEWLINE);
  if (firstBreak === -1) {
    return { head: bytes, rest: [] };
  }
  const rest: Uint8Array[] = [];
  let from = firstBreak + 1;
  for (let at = bytes.indexOf(NEWLINE, from); at !== -1; at = bytes.indexOf(NEWLINE, from)) {
    rest.push(bytes.subarray(from, at));
    from = at + 1;
  }
  rest.push(bytes.subarray(from));
  return { head: bytes.subarray(0, firstBreak), rest };
}

/**
 * The model and advisor of the newest assistant record the API served in the session's transcript, or neither when there is none within `MAX_TRANSCRIPT_SCAN_BYTES` of its end. The transcript is read backwards a chunk at a time and the lines are examined newest first, so the cost is the distance back to that record and not the transcript's length; a line larger than a chunk is joined from the chunks that hold it before it is parsed, so a large tool result after the record, or a large record, does not hide it. Records marked `<synthetic>` are skipped, since they are Claude Code's own messages and not a model's. The advisor is taken from the same record, which is stamped with it for as long as `/advisor` is set.
 */
export function readTranscriptIdentity(ports: StatuslinePorts, transcriptPath: string): TranscriptIdentity {
  const size = ports.readRange(transcriptPath, 0, 0)?.size;
  if (size === undefined) {
    return NOT_FOUND;
  }
  // The part of the line that the bytes read so far begin inside, in pieces: the line is whole once a newline, or the start of the file, lies before it.
  let carry: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const floor = Math.max(0, size - MAX_TRANSCRIPT_SCAN_BYTES);
  for (let end = size; end > floor; end = Math.max(floor, end - TRANSCRIPT_CHUNK_BYTES)) {
    const start = Math.max(floor, end - TRANSCRIPT_CHUNK_BYTES);
    const chunk = ports.readRange(transcriptPath, start, end - start);
    if (chunk === undefined) {
      return NOT_FOUND;
    }
    const { head, rest } = splitAtNewlines(chunk.bytes);
    if (rest.length === 0) {
      carry = [head, ...carry];
      continue;
    }
    // The last segment continues the line the later chunks began inside, so it is whole once they are joined to it; the segments before it are whole lines already.
    const [tail = EMPTY_LINE, ...older] = rest.toReversed();
    for (const line of [joined([tail, ...carry]), ...older]) {
      const found = identityOfLine(decoder.decode(line));
      if (found !== undefined) {
        return found;
      }
    }
    carry = [head];
  }
  // Reaching the start of the file makes the carried line whole: it is the file's first line.
  return floor === 0 ? (identityOfLine(decoder.decode(joined(carry))) ?? NOT_FOUND) : NOT_FOUND;
}

import { z } from "zod";

const text = z.string().optional().catch(undefined);
const number = z.number().optional().catch(undefined);
/** A token count the client wrote; a negative or malformed one reads as absent. */
const count = z.number().nonnegative().optional().catch(undefined);

/** One block of a message's content: a block's type, and the text of a text block. */
const ContentBlockSchema = z.looseObject({ type: text, text });

/**
 * The part of one transcript line (a JSON object Claude Code appends per record) the statusline reads. Every field is optional and a field of the wrong type reads as absent, so one malformed field neither discards the others nor fails the read; fields the statusline does not read pass through unread. A reader of another kind of session fact adds its fields here when it first needs one.
 */
const TranscriptRecordSchema = z
  .looseObject({
    type: text,
    subtype: text,
    timestamp: text,
    /** The session's generated name, written on every record of the session in some versions. */
    slug: text,
    /** The name `/rename` gave the session. */
    customTitle: text,
    /** The title Claude Code generated for the session. */
    aiTitle: text,
    isSidechain: z.boolean().optional().catch(undefined),
    /** Shared by the records one API request produced. */
    requestId: text,
    message: z
      .looseObject({
        /** The API response the record belongs to; the records of one response share it. */
        id: z.string().min(1).optional().catch(undefined),
        content: z.union([z.string(), z.array(ContentBlockSchema)]).optional().catch(undefined),
        usage: z
          .looseObject({
            input_tokens: count,
            output_tokens: count,
            cache_creation_input_tokens: count,
            cache_read_input_tokens: count,
            cache_creation: z.looseObject({ ephemeral_5m_input_tokens: number, ephemeral_1h_input_tokens: number }).optional().catch(undefined),
          })
          .optional()
          .catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .catch({});

export type TranscriptRecord = z.infer<typeof TranscriptRecordSchema>;

/** One transcript line read into the fields the statusline uses, or undefined when the line is not JSON or not an object. */
export function parseTranscriptRecord(line: string): TranscriptRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? TranscriptRecordSchema.parse(parsed) : undefined;
}

/** The record's timestamp in milliseconds since the epoch, or undefined when it has none or it is not a date. */
export function recordTimeMs(record: TranscriptRecord): number | undefined {
  if (record.timestamp === undefined) {
    return undefined;
  }
  const ms = Date.parse(record.timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

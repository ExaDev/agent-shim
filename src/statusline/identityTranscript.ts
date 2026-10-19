import { z } from "zod";

import { boundedDisplayText } from "./sanitise";

/** How much of the end of a session transcript the identity segments read: the model that answered and the advisor are stamped on every assistant record, so the latest of each sits within the last few replies, and a window of this size holds those however large a single tool result is, while the cost of a refresh stays a fixed number of bytes however long the session has run. */
export const TRANSCRIPT_TAIL_BYTES = 262_144;

/** What the model and advisor segments take from a transcript's last assistant records. */
export interface TranscriptIdentity {
  /** The model the latest assistant record says served it, which differs from the client's own name for it behind a proxy. */
  readonly model: string | undefined;
  /** The advisor model the latest assistant record carries once `/advisor` has been set. */
  readonly advisor: string | undefined;
}

const text = z.string().optional().catch(undefined);

/** A transcript record, read for the two fields the identity segments use; every other field passes through unread. */
const RecordSchema = z.looseObject({
  type: text,
  advisorModel: text,
  message: z.looseObject({ model: text }).optional().catch(undefined),
});

/**
 * Reads the latest model and advisor from the text of a transcript's tail (one JSON record per line). A line that is not a record is skipped: a transcript being appended to can end mid-record at the moment it is read, and the records before it are still good.
 */
export function readTranscriptIdentity(tail: string | undefined): TranscriptIdentity {
  let model: string | undefined;
  let advisor: string | undefined;
  for (const line of (tail ?? "").split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = RecordSchema.safeParse(parsed);
    if (!record.success || record.data.type !== "assistant") {
      continue;
    }
    // Both fields are stamped on assistant records only, and the latest record's value is the current one, so a record that lacks a field leaves the earlier value standing.
    model = boundedDisplayText(record.data.message?.model ?? "") || model;
    advisor = boundedDisplayText(record.data.advisorModel ?? "") || advisor;
  }
  return { model, advisor };
}

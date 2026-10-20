import type { RenderContext, RowOutput } from "../context";

/** How many times the session's context has been compacted, by `/compact` or automatically, counted from the transcript's compaction markers; nothing is drawn until the first. While the reader is still catching up with a transcript too big to read at once the later part is unread, and the count then ends in a plus; a line too big to read is skipped, which leaves the plus for good. */
export function compactionsRow(context: RenderContext): RowOutput {
  const transcript = context.transcript();
  if (transcript === undefined || transcript.session.compactions === 0) {
    return { kind: "text", lines: [] };
  }
  return { kind: "text", lines: [context.palette.paint("label", `Compactions: ${String(transcript.session.compactions)}${transcript.complete ? "" : "+"}`)] };
}

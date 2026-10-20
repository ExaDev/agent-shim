import type { RenderContext, RowOutput } from "../context";

/** How many times the session's context has been compacted, by `/compact` or automatically, counted from the transcript's compaction markers; nothing is drawn until the first. A transcript too big to read whole leaves its earlier part unread, and the count then ends in a plus. */
export function compactionsRow(context: RenderContext): RowOutput {
  const transcript = context.transcript();
  if (transcript === undefined || transcript.session.compactions === 0) {
    return { kind: "text", lines: [] };
  }
  return { kind: "text", lines: [context.palette.paint("label", `Compactions: ${String(transcript.session.compactions)}${transcript.complete ? "" : "+"}`)] };
}

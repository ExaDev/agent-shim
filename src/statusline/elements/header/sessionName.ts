import type { RenderContext } from "../context";

/** The name `/rename` gave the session, else the name Claude Code generated for it, or undefined when the transcript holds neither. The facts hold it already sanitised, with the first name that has any visible text chosen. */
export function sessionNameSegment(context: RenderContext): string | undefined {
  return context.transcript()?.session.title;
}

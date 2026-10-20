import type { RenderContext } from "../context";
import { formatElapsed } from "../sessionFormat";

/** How long the session has run, from the first timestamp in its transcript, or undefined when the transcript has none. The variation selector makes the stopwatch an emoji two columns wide, which the two spaces after it leave room for. */
export function durationSegment(context: RenderContext): string | undefined {
  const startedAtMs = context.transcript()?.session.startedAtMs;
  return startedAtMs === undefined ? undefined : `⏱️  ${formatElapsed(context.nowMs - startedAtMs)}`;
}

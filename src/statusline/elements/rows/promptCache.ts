import type { RenderContext, RowOutput } from "../context";
import { formatWallClock } from "../../wallClock";

const MS_PER_SECOND = 1_000;

/** The least time left on the cache that is called running out, whatever its tier: under a minute is too little to send another request in. */
const MIN_WARNING_SECONDS = 60;

/** A cache is running out in the last fifth of its lifetime, at least `MIN_WARNING_SECONDS` and never more than the lifetime itself. */
const WARNING_FRACTION_DENOMINATOR = 5;

function warningSecondsOf(ttlSeconds: number): number {
  return Math.min(ttlSeconds, Math.max(MIN_WARNING_SECONDS, Math.floor(ttlSeconds / WARNING_FRACTION_DENOMINATOR)));
}

/**
 * When the prompt cache expires, as a clock time and not a countdown: the statusline refreshes while Claude Code is working and not between turns, which is exactly when the cache drains, so a countdown would freeze at whatever it last showed, while a clock time stays true however stale the render is. The lifetime is the tier the transcript's cache writes show, else `promptCache.ttlSeconds`. Nothing is drawn before the main conversation has sent a request.
 */
export function promptCacheRow(context: RenderContext): RowOutput {
  const cache = context.transcript()?.session.promptCache;
  if (cache === undefined) {
    return { kind: "text", lines: [] };
  }
  const { palette, nowMs, settings } = context;
  const ttlSeconds = cache.ttlSeconds ?? settings.promptCache.ttlSeconds;
  const expiresAtMs = cache.anchorAtMs + ttlSeconds * MS_PER_SECOND;
  const remainingMs = expiresAtMs - nowMs;
  const name = palette.paint("label", "Cache");
  if (remainingMs <= 0) {
    return { kind: "text", lines: [`${name} ${palette.paint("label", "⏱ expired")}`] };
  }
  const role = remainingMs <= warningSecondsOf(ttlSeconds) * MS_PER_SECOND ? "warning" : "context";
  return { kind: "text", lines: [`${name} ${palette.paint(role, `⏱ until ${formatWallClock(expiresAtMs, nowMs, context.ports.clock, settings.clock)}`)}`] };
}

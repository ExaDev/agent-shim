import type { ResolvedStatusline } from "../config/statusline";
import type { StatuslinePorts } from "./ports";
import { formatDuration, FULL_PERCENT, secondsUntil } from "./style";
import { formatWallClock } from "./wallClock";

/** What a window with no reset still to come is said to be: the form `formatDuration` already gives a window with nothing outstanding. */
const AVAILABLE = formatDuration(undefined);

/** A quota window's reset: the instant it resets, and how long the window is when that is known (the share of it already gone needs both). */
export interface ResetWindow {
  readonly resetsAt: string | undefined;
  readonly periodMs: number | undefined;
}

/** A window's reset as `usage.timeFormat` tells it. `pending` is whether a reset is still to come, which is what the words `resets in` can truthfully introduce. */
export interface ResetText {
  readonly text: string;
  readonly pending: boolean;
}

/** The share of a window already gone, as a whole percentage, or undefined when the reset instant or the window's length is not known; a window past its reset is wholly gone. */
function elapsedPercent(resetMs: number, periodMs: number | undefined, nowMs: number): number | undefined {
  if (!Number.isFinite(resetMs) || periodMs === undefined) {
    return undefined;
  }
  const share = ((nowMs - (resetMs - periodMs)) / periodMs) * FULL_PERCENT;
  return Math.max(0, Math.min(FULL_PERCENT, Math.round(share)));
}

/**
 * Tells when `window` resets under `settings.usage.timeFormat`: `1h 30m` (relative, the statusline's own duration form), `at 14:30` (absolute, with the day added when it is not today), both joined by a comma, `53% elapsed`, or that and the absolute time. A reset that is unknown or already past is `available` in every form that tells a time; the elapsed forms say nothing when the window's length is not known, and so can be empty.
 */
export function formatResetTime(window: ResetWindow, nowMs: number, settings: ResolvedStatusline, clock: StatuslinePorts["clock"]): ResetText {
  const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  const secondsLeft = secondsUntil(window.resetsAt, nowMs);
  // A reset less than half a second away rounds to no time left, and is said to be available rather than "resets in available".
  const pending = secondsLeft !== undefined && secondsLeft > 0;
  const relative = formatDuration(secondsLeft);
  const absolute = pending ? `at ${formatWallClock(resetMs, nowMs, clock, settings.clock)}` : AVAILABLE;
  const elapsed = elapsedPercent(resetMs, window.periodMs, nowMs);
  const elapsedText = elapsed === undefined ? undefined : `${String(elapsed)}% elapsed`;
  switch (settings.usage.timeFormat) {
    case "relative":
      return { text: relative, pending };
    case "absolute":
      return { text: absolute, pending };
    case "both":
      return { text: pending ? `${relative}, ${absolute}` : AVAILABLE, pending };
    case "elapsed":
      return { text: elapsedText ?? "", pending };
    case "elapsedAndAbsolute":
      return { text: [elapsedText, pending ? absolute : undefined].filter((part) => part !== undefined).join(", "), pending };
    default:
      return settings.usage.timeFormat satisfies never;
  }
}

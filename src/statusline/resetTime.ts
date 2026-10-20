import type { ResolvedStatusline } from "../config/statusline";
import type { Translate } from "./messages/catalogues";
import type { StatuslinePorts } from "./ports";
import { formatDuration, FULL_PERCENT, secondsUntil } from "./style";
import { formatWallClock } from "./wallClock";

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
 * Tells when `window` resets, in the words of `t`, under `settings.usage.timeFormat`: `1h 30m` (relative, the statusline's own duration form), `at 14:30` (absolute, with the day added when it is not today), both joined by a comma, `53% elapsed`, or that and the absolute time. With `labelled`, a reset still to come is introduced by `resets in` or `resets at`; the elapsed forms are never introduced. A reset that is unknown or already past is `available` in every form that tells a time; the elapsed forms say nothing when the window's length is not known, and so can be empty.
 */
export function formatResetTime(window: ResetWindow, nowMs: number, settings: ResolvedStatusline, clock: StatuslinePorts["clock"], t: Translate, labelled: boolean): ResetText {
  const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  const secondsLeft = secondsUntil(window.resetsAt, nowMs);
  // A reset less than half a second away rounds to no time left, and is said to be available rather than "resets in available".
  const pending = secondsLeft !== undefined && secondsLeft > 0;
  const available = t("quota.available");
  if (!pending && settings.usage.timeFormat !== "elapsed" && settings.usage.timeFormat !== "elapsedAndAbsolute") {
    return { text: settings.usage.timeFormat === "relative" ? formatDuration(secondsLeft, t) : available, pending };
  }
  const introduced = labelled && pending;
  const relative = formatDuration(secondsLeft, t);
  const time = pending ? formatWallClock(resetMs, nowMs, clock, settings.clock) : "";
  const elapsed = elapsedPercent(resetMs, window.periodMs, nowMs);
  const elapsedText = elapsed === undefined ? undefined : t("quota.elapsed", { percent: elapsed });
  switch (settings.usage.timeFormat) {
    case "relative":
      return { text: introduced ? t("quota.resetsIn", { time: relative }) : relative, pending };
    case "absolute":
      return { text: introduced ? t("quota.resetsAt", { time }) : t("quota.at", { time }), pending };
    case "both":
      return { text: introduced ? t("quota.resetsInAt", { relative, time }) : t("quota.relativeAt", { relative, time }), pending };
    case "elapsed":
      return { text: elapsedText ?? "", pending };
    case "elapsedAndAbsolute":
      if (elapsedText === undefined) {
        return { text: pending ? t("quota.at", { time }) : "", pending };
      }
      return { text: pending ? t("quota.elapsedAt", { elapsed: elapsedText, time }) : elapsedText, pending };
    default:
      return settings.usage.timeFormat satisfies never;
  }
}

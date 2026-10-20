import type { BarCell } from "./barGrid";
import type { Translate } from "./messages/catalogues";
import { RESET, type Palette } from "./palette";

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_DAY = 86_400;
const THOUSAND = 1_000;
const MILLION = 1_000_000;
const TEN = 10;
export const FULL_PERCENT = 100;
export const ONE_PERCENT = 1;
/** The colour bands on a used fraction: red from `criticalAt`, yellow from `warnAt` (whole percentages), green under it. The defaults are the Antigravity statusline's own (red from 90%, yellow from 70%). */
interface ColourBands {
  readonly warnAt: number;
  readonly criticalAt: number;
}


/** `text` in the escape sequence `color`, ended with a reset; unchanged when `color` is empty, because a reset with no colour before it would put an escape in text that has none. */
export function withColor(color: string, text: string): string {
  return color === "" ? text : `${color}${text}${RESET}`;
}

/** How a bar and its figures are coloured: the band thresholds, the palette, which role colours the bar below the warning threshold, and the characters that draw it. */
export interface BarStyle {
  readonly bands: ColourBands;
  readonly palette: Palette;
  /** The role of a bar below its warning threshold: the context bar and the quota bars have their own. */
  readonly okRole: "context" | "usage";
  readonly filled: string;
  readonly empty: string;
}

/** The escape sequence that colours a fraction of use by its band: critical from `criticalAt`, the warning colour from `warnAt`, and the style's own colour under it. For a measure that is better the higher it is (`isUsedMetric` false) the bands are mirrored. */
export function statusColor(fraction: number, isUsedMetric: boolean, style: BarStyle): string {
  const yellowAt = style.bands.warnAt / FULL_PERCENT;
  const redAt = style.bands.criticalAt / FULL_PERCENT;
  const warningRole = style.okRole === "usage" ? "usageWarning" : "warning";
  const { ansi } = style.palette;
  if (isUsedMetric) {
    if (fraction >= redAt) {
      return ansi("critical");
    }
    return fraction >= yellowAt ? ansi(warningRole) : ansi(style.okRole);
  }
  if (fraction <= 1 - redAt) {
    return ansi("critical");
  }
  return fraction <= 1 - yellowAt ? ansi(warningRole) : ansi(style.okRole);
}

export function formatTokens(num: number): string {
  if (num >= MILLION) {
    const val = num / MILLION;
    return val % 1 === 0 ? `${String(Math.round(val))}M` : `${val.toFixed(1)}M`;
  }
  if (num >= THOUSAND) {
    const val = num / THOUSAND;
    return val >= TEN ? `${String(Math.round(val))}k` : `${val.toFixed(1)}k`;
  }
  return String(Math.round(num));
}

/** A time left as the statusline writes it: days and hours (`6d 17h`), hours and padded minutes (`4h 03m`), minutes (`23m`), seconds under a minute (`45s`), and the language's word for `available` for nothing outstanding. */
export function formatDuration(seconds: number | undefined, t: Translate): string {
  if (seconds === undefined || seconds <= 0) {
    return t("quota.available");
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return `${String(seconds)}s`;
  }
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const hours = Math.floor((seconds % SECONDS_PER_DAY) / (MINUTES_PER_HOUR * SECONDS_PER_MINUTE));
  const minutes = Math.floor((seconds % (MINUTES_PER_HOUR * SECONDS_PER_MINUTE)) / SECONDS_PER_MINUTE);
  if (days > 0) {
    return `${String(days)}d ${String(hours)}h`;
  }
  if (hours > 0) {
    return `${String(hours)}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${String(minutes)}m`;
}

export function secondsUntil(resetAt: string | undefined, nowMs: number): number | undefined {
  if (resetAt === undefined) {
    return undefined;
  }
  const resetMs = Date.parse(resetAt);
  return Number.isNaN(resetMs) ? undefined : Math.max(0, Math.round((resetMs - nowMs) / THOUSAND));
}

/** A bar that fills with `fraction`, coloured by its band, `cells` fill positions wide between its brackets. */
function drawBar(fraction: number, cells: number, style: BarStyle): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * cells);
  const color = statusColor(clamped, true, style);
  const emptyColor = style.palette.ansi("empty");
  const body = `${style.filled.repeat(filled)}${style.empty.repeat(cells - filled)}`;
  if (color === "" && emptyColor === "") {
    return `[${body}]`;
  }
  return `[${color}${style.filled.repeat(filled)}${emptyColor}${style.empty.repeat(cells - filled)}${RESET}]`;
}

export function barCell(prefix: string, suffix: string, fraction: number, style: BarStyle): BarCell {
  return { prefix, suffix, draw: (cells) => drawBar(fraction, cells, style) };
}

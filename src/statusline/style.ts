import { ESCAPE } from "./ansi";
import type { BarCell } from "./barGrid";

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_DAY = 86_400;
const THOUSAND = 1_000;
const MILLION = 1_000_000;
const TEN = 10;
export const TWENTY = 20;
export const FULL_PERCENT = 100;
export const ONE_PERCENT = 1;
/** The colour bands on a used fraction: red from `criticalAt`, yellow from `warnAt` (whole percentages), green under it. The defaults are the Antigravity statusline's own (red from 90%, yellow from 70%). */
export interface ColourBands {
  readonly warnAt: number;
  readonly criticalAt: number;
}

export const RESET = `${ESCAPE}[0m`;
const DIM = `${ESCAPE}[90m`;
const GREEN = `${ESCAPE}[32m`;
const YELLOW = `${ESCAPE}[33m`;
const RED = `${ESCAPE}[31m`;

function colorize(): boolean {
  return process.env.NO_COLOR === undefined;
}

export function statusColor(fraction: number, isUsedMetric: boolean, bands: ColourBands): string {
  if (!colorize()) {
    return "";
  }
  const yellowAt = bands.warnAt / FULL_PERCENT;
  const redAt = bands.criticalAt / FULL_PERCENT;
  if (isUsedMetric) {
    if (fraction >= redAt) {
      return RED;
    }
    return fraction >= yellowAt ? YELLOW : GREEN;
  }
  if (fraction <= 1 - redAt) {
    return RED;
  }
  return fraction <= 1 - yellowAt ? YELLOW : GREEN;
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

/** The Antigravity statusline's own duration form: `6d 17h`, `4h 23m`, `23m`, and `available` for nothing outstanding. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) {
    return "available";
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
function drawBar(fraction: number, cells: number, bands: ColourBands): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * cells);
  const color = statusColor(clamped, true, bands);
  return color === "" ? `[${"█".repeat(filled)}${"░".repeat(cells - filled)}]` : `[${color}${"█".repeat(filled)}${DIM}${"░".repeat(cells - filled)}${RESET}]`;
}

export function barCell(prefix: string, suffix: string, fraction: number, bands: ColourBands): BarCell {
  return { prefix, suffix, draw: (cells) => drawBar(fraction, cells, bands) };
}


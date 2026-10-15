import type { StatuslineSummary } from "./enrich";

/** The payload fields the built-in line shows: the client names the model and the context window's use. */
export interface StatuslinePayloadView {
  readonly modelDisplayName: string | undefined;
  readonly contextUsedPercentage: number | undefined;
}

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

function untilLabel(resetAt: string | undefined, nowMs: number): string | undefined {
  if (resetAt === undefined) {
    return undefined;
  }
  const resetMs = Date.parse(resetAt);
  if (Number.isNaN(resetMs) || resetMs <= nowMs) {
    return undefined;
  }
  const minutes = Math.round((resetMs - nowMs) / (SECONDS_PER_MINUTE * MS_PER_SECOND));
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(minutes)}m`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return `${String(hours)}h ${String(minutes % MINUTES_PER_HOUR)}m`;
  }
  return `${String(Math.floor(hours / HOURS_PER_DAY))}d ${String(hours % HOURS_PER_DAY)}h`;
}

/**
 * The built-in line, for machines with no renderer configured: the model, the context window's use, the binding usage windows with their resets, and whose quota those windows describe. Plain text, no colour, safe for any terminal.
 */
export function renderStatuslineLine(summary: StatuslineSummary, view: StatuslinePayloadView, nowMs: number): string {
  const parts: string[] = [];
  if (view.modelDisplayName !== undefined && view.modelDisplayName !== "") {
    parts.push(view.modelDisplayName);
  }
  if (view.contextUsedPercentage !== undefined) {
    parts.push(`ctx ${String(Math.round(view.contextUsedPercentage))}%`);
  }
  const fiveReset = untilLabel(summary.fiveHourResetAt, nowMs);
  if (summary.fiveHourUsed !== undefined) {
    parts.push(`5h ${String(Math.round(summary.fiveHourUsed))}%${fiveReset === undefined ? "" : ` (${fiveReset})`}`);
  }
  const sevenReset = untilLabel(summary.sevenDayResetAt, nowMs);
  if (summary.sevenDayUsed !== undefined) {
    parts.push(`7d ${String(Math.round(summary.sevenDayUsed))}%${sevenReset === undefined ? "" : ` (${sevenReset})`}`);
  }
  if (summary.provider !== undefined) {
    parts.push(summary.providerAccountEmail === undefined ? summary.provider : `${summary.provider} · ${summary.providerAccountEmail}`);
  }
  return parts.join(" │ ");
}

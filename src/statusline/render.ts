import type { StatuslineSummary } from "./enrich";

/** The payload fields the built-in statusline shows: the model, the context window's use, and the prompt cache's effectiveness. */
export interface StatuslinePayloadView {
  readonly modelDisplayName: string | undefined;
  readonly contextUsedPercentage: number | undefined;
  readonly contextTotalTokens: number | undefined;
  readonly contextWindowTokens: number | undefined;
  readonly cacheHitRatio: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly freshInputTokens: number | undefined;
}

/** How the bars share the terminal's width, in the Antigravity statusline's own modes: fill it on one line and wrapped, only when wrapped, or never. */
type FillMode = "always" | "wrapped" | "never";

const BAR_WIDTH = 10;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_DAY = 86_400;
const THOUSAND = 1_000;
const MILLION = 1_000_000;
const TEN = 10;
const TWENTY = 20;
/** Claude Code indents the status line one column from the terminal edge and truncates at its own usable width, replacing the final column with an ellipsis. COLUMNS is correct in the child environment, but the usable width is four columns short of it, so a line as wide as COLUMNS minus two still loses its tail. */
export const RESERVED_COLUMNS = 4;
const SEPARATOR = " | ";
const FULL_PERCENT = 100;
/** The Antigravity statusline's colour bands on a used fraction: red from 90%, yellow from 70%, green under it. */
const USED_RED_AT = 0.9;
const USED_YELLOW_AT = 0.7;

const ESCAPE_CHAR_CODE = 27;
const ESCAPE = String.fromCharCode(ESCAPE_CHAR_CODE);
const RESET = `${ESCAPE}[0m`;
const DIM = `${ESCAPE}[90m`;
const GREEN = `${ESCAPE}[32m`;
const YELLOW = `${ESCAPE}[33m`;
const RED = `${ESCAPE}[31m`;
const ANSI_REGEX = new RegExp(`${ESCAPE}\\[[0-9;]*[a-zA-Z]`, "g");

function visibleLength(text: string): number {
  return text.replace(ANSI_REGEX, "").length;
}

function colorize(): boolean {
  return process.env.NO_COLOR === undefined;
}

function statusColor(fraction: number, isUsedMetric: boolean): string {
  if (!colorize()) {
    return "";
  }
  if (isUsedMetric) {
    if (fraction >= USED_RED_AT) {
      return RED;
    }
    return fraction >= USED_YELLOW_AT ? YELLOW : GREEN;
  }
  if (fraction <= 1 - USED_RED_AT) {
    return RED;
  }
  return fraction <= 1 - USED_YELLOW_AT ? YELLOW : GREEN;
}

function formatTokens(num: number): string {
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
function formatDuration(seconds: number | undefined): string {
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

/** The prompt cache's hit percentage, preferring the client's own request-level hit ratio, which survives a cold turn, over the last request's share of prompt tokens read from cache, which a single cold turn zeroes. */
function cacheShareText(view: StatuslinePayloadView): string {
  const hitRatio = view.cacheHitRatio;
  if (hitRatio !== undefined && Number.isFinite(hitRatio)) {
    return ` (Cache: ${(Math.max(0, Math.min(1, hitRatio)) * FULL_PERCENT).toFixed(0)}%)`;
  }
  const promptTotal = (view.cacheReadTokens ?? 0) + (view.freshInputTokens ?? 0);
  if (promptTotal > 0 && (view.cacheReadTokens ?? 0) > 0) {
    return ` (Cache: ${((view.cacheReadTokens ?? 0) / promptTotal * FULL_PERCENT).toFixed(0)}%)`;
  }
  return "";
}

/** An organisation type as the plan name a person knows it by; undefined for a personal account or a type with no known name, where the rate-limit tier labels the plan instead. */
/** The multiplier suffix of a rate-limit tier: `default_claude_max_20x` carries `20x`. */
function tierSuffixOf(tier: string | undefined): string | undefined {
  const match = /_(\d+x)$/i.exec(tier ?? "");
  return match === null ? undefined : match[1];
}

/**
 * Maps the OAuth account's plan fields to the label a person knows the plan by, the same mapping the claude-hud fork established from live accounts: the organisation names the plan, a team seat names its tier, and an unmapped organisation type renders raw so an unexpected plan stays visible. An account with no organisation carries its plan only in its rate-limit tier.
 */
function accountPlanLabel(summary: StatuslineSummary): string | undefined {
  switch (summary.loginOrganizationType) {
    case undefined:
      return planLabelOf(summary.loginRateLimitTier);
    case "claude_max": {
      const tier = tierSuffixOf(summary.loginRateLimitTier);
      return tier === undefined ? "Max" : `Max ${tier}`;
    }
    case "claude_pro":
      return "Pro";
    case "claude_team":
      if (summary.loginSeatTier === "team_standard") {
        return "Team Standard";
      }
      if (summary.loginSeatTier === "team_tier_1") {
        return "Team Premium";
      }
      return "Team";
    case "claude_enterprise":
      return "Enterprise";
    default:
      return summary.loginOrganizationType;
  }
}

/** Anthropic's rate-limit tier names (`claude_max_20x`, organisation-prefixed `default_claude_pro`, `free`) as the plan name a person knows them by. */
function planLabelOf(tier: string | undefined): string | undefined {
  if (tier === undefined || tier === "") {
    return undefined;
  }
  const cleaned = tier.startsWith("default_") ? tier.slice("default_".length) : tier;
  if (cleaned === "free") {
    return "Free";
  }
  const maxWithMultiplier = /^claude_max_(\d+)x$/.exec(cleaned);
  if (maxWithMultiplier !== null) {
    return `Max ${maxWithMultiplier[1] ?? ""}x`;
  }
  if (cleaned === "claude_max") {
    return "Max";
  }
  if (cleaned === "claude_pro") {
    return "Pro";
  }
  return cleaned;
}

function secondsUntil(resetAt: string | undefined, nowMs: number): number | undefined {
  if (resetAt === undefined) {
    return undefined;
  }
  const resetMs = Date.parse(resetAt);
  return Number.isNaN(resetMs) ? undefined : Math.max(0, Math.round((resetMs - nowMs) / THOUSAND));
}

class Segment {
  constructor(
    readonly kind: "static" | "bar",
    readonly text = "",
    readonly prefix = "",
    readonly suffix = "",
    readonly fraction = 0,
    readonly isUsed = true,
  ) {}

  baseLength(baseBarWidth: number): number {
    if (this.kind === "static") {
      return visibleLength(this.text);
    }
    return visibleLength(this.prefix) + baseBarWidth + 2 + visibleLength(this.suffix);
  }

  render(barWidth: number): string {
    if (this.kind === "static") {
      return this.text;
    }
    const clamped = Math.max(0, Math.min(1, this.fraction));
    const filled = Math.round(clamped * barWidth);
    const color = statusColor(clamped, this.isUsed);
    const bar = color === "" ? `[${"█".repeat(filled)}${"░".repeat(barWidth - filled)}]` : `[${color}${"█".repeat(filled)}${DIM}${"░".repeat(barWidth - filled)}${RESET}]`;
    return `${this.prefix}${bar}${this.suffix}`;
  }
}

function renderLineWithExtra(segments: readonly Segment[], maxWidth: number, separator: string, baseBarWidth: number): string {
  const separatorLength = visibleLength(separator);
  const bars = segments.filter((segment) => segment.kind === "bar");
  const lineBase = segments.reduce((total, segment) => total + segment.baseLength(baseBarWidth), 0) + separatorLength * (segments.length - 1);
  const extra = Math.max(0, maxWidth - lineBase);
  const extraById = new Map<Segment, number>();
  if (bars.length > 0 && extra > 0) {
    const perBar = Math.floor(extra / bars.length);
    const remainder = extra % bars.length;
    bars.forEach((bar, index) => {
      extraById.set(bar, perBar + (index < remainder ? 1 : 0));
    });
  }
  return segments.map((segment) => segment.render(baseBarWidth + (extraById.get(segment) ?? 0))).join(separator);
}

/** Justifies segments across the line's width: the first flush left, the last flush right, and each separator sharing the spare space evenly around its pipe. A line with no spare width, or a single segment, joins plainly. */
function justifySegments(segments: readonly Segment[], maxWidth: number, separator: string, baseBarWidth: number): string {
  const rendered = segments.map((segment) => segment.render(baseBarWidth));
  if (segments.length < 2) {
    return rendered.join(separator);
  }
  const separatorLength = visibleLength(separator);
  const total = segments.reduce((sum, segment) => sum + segment.baseLength(baseBarWidth), 0) + separatorLength * (segments.length - 1);
  const spare = maxWidth - total;
  if (spare <= 0) {
    return rendered.join(separator);
  }
  const gaps = segments.length - 1;
  const extraPerGap = Math.floor(spare / gaps);
  let remainder = spare % gaps;
  const parts: string[] = [];
  segments.forEach((_, index) => {
    if (index > 0) {
      const extra = extraPerGap + (remainder > 0 ? 1 : 0);
      if (remainder > 0) {
        remainder -= 1;
      }
      const left = Math.floor(extra / 2);
      parts.push(`${" ".repeat(left + 1)}|${" ".repeat(extra - left + 1)}`);
    }
    parts.push(rendered[index] ?? "");
  });
  return parts.join("");
}

/** Packs segments onto as few lines as fit, in order: a segment joins the current line when it fits beside what is there, and a segment already alone on a line that is still too wide renders whole, exactly as the Antigravity statusline's own fallback does. */
function packSegments(segments: readonly Segment[], maxWidth: number, separator: string, baseBarWidth: number, fillWrapped: boolean): string[] {
  const separatorLength = visibleLength(separator);
  const lines: Segment[][] = [];
  let current: Segment[] = [];
  let currentWidth = 0;
  for (const segment of segments) {
    const width = segment.baseLength(baseBarWidth);
    const added = current.length === 0 ? width : width + separatorLength;
    if (current.length > 0 && currentWidth + added > maxWidth) {
      lines.push(current);
      current = [segment];
      currentWidth = width;
    } else {
      current.push(segment);
      currentWidth += added;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.map((line) => (fillWrapped ? renderLineWithExtra(line, maxWidth, separator, baseBarWidth) : justifySegments(line, maxWidth, separator, baseBarWidth)));
}

/**
 * The Antigravity statusline's own layout: one line when everything fits, two when it does not (context and git above, quota windows below), with the bars expanding to share whatever width is left.
 */
function layoutGrouped(group1: readonly Segment[], group2: readonly Segment[], maxWidth: number, fillMode: FillMode, separator: string, baseBarWidth: number): string {
  const separatorLength = visibleLength(separator);
  const allSegments = [...group1, ...group2];
  if (allSegments.length === 0) {
    return "";
  }
  const fillUnwrapped = fillMode === "always";
  const fillWrapped = fillMode === "always" || fillMode === "wrapped";
  const totalBase = allSegments.reduce((total, segment) => total + segment.baseLength(baseBarWidth), 0) + separatorLength * (allSegments.length - 1);
  if (totalBase <= maxWidth) {
    if (fillUnwrapped) {
      return renderLineWithExtra(allSegments, maxWidth, separator, baseBarWidth);
    }
    return justifySegments(allSegments, maxWidth, separator, baseBarWidth);
  }
  const lines = [group1, group2].map((group) => {
    if (group.length === 0) {
      return "";
    }
    const groupBase = group.reduce((total, segment) => total + segment.baseLength(baseBarWidth), 0) + separatorLength * (group.length - 1);
    if (groupBase <= maxWidth) {
      return fillWrapped ? renderLineWithExtra(group, maxWidth, separator, baseBarWidth) : group.map((segment) => segment.render(baseBarWidth)).join(separator);
    }
    return packSegments(group, maxWidth, separator, baseBarWidth, fillWrapped).join("\n");
  });
  return lines.filter((line) => line !== "").join("\n");
}

/**
 * The built-in statusline, laid out and coloured the way the Antigravity CLI's own statusline is: the model, the provider's account (email and subscription plan) and the identity when it is not that account, on the first line; then the context window's use (tokens against the window, the prompt cache's hit percentage) and the quota windows the door reports, each a bar that fills with use and turns yellow then red, one line when they fit and two when they do not.
 */
export function renderStatuslineBlock(summary: StatuslineSummary, view: StatuslinePayloadView, terminalWidth: number, nowMs: number): string {
  const header: Segment[] = [];
  if (view.modelDisplayName !== undefined && view.modelDisplayName !== "") {
    header.push(new Segment("static", view.modelDisplayName));
  }
  if (summary.provider !== undefined) {
    const account = [summary.providerAccountEmail, summary.providerPlan].filter((part) => part !== undefined);
    header.push(new Segment("static", account.length > 0 ? `${summary.provider} · ${account.join(" · ")}` : summary.provider));
  }
  // An account in an organisation is on the organisation's plan with its seat's tier naming the variant, and the seat's rate-limit tier names limits, not the plan; a personal account's plan is the tier itself. A personal plan's organizationName is only the account holder's own name, redundant beside the email, so an organisation's name shows only for the organisation types.
  const loginPlan = accountPlanLabel(summary);
  const loginOrgName = summary.loginOrganizationType === "claude_team" || summary.loginOrganizationType === "claude_enterprise" ? summary.loginOrganizationName : undefined;
  const loginParts = [summary.loginAccountEmail, loginOrgName, loginPlan].filter((part) => part !== undefined);
  if (summary.loginAccountEmail !== undefined && summary.loginAccountEmail !== summary.providerAccountEmail) {
    header.push(new Segment("static", loginParts.join(" · ")));
  } else if (summary.provider === undefined && loginParts.length > 0) {
    header.push(new Segment("static", loginParts.join(" · ")));
  }
  if (summary.identity !== undefined && summary.identity !== summary.providerAccountEmail && summary.identity !== summary.loginAccountEmail) {
    header.push(new Segment("static", summary.identity));
  }

  const contextGroup: Segment[] = [];
  if (view.contextUsedPercentage !== undefined) {
    const fraction = Math.max(0, Math.min(1, view.contextUsedPercentage / FULL_PERCENT));
    const color = statusColor(fraction, true);
    const percent = `${color}${view.contextUsedPercentage.toFixed(1)}%${RESET}`;
    const tokens = view.contextTotalTokens !== undefined && view.contextWindowTokens !== undefined ? `${formatTokens(view.contextTotalTokens)}/${formatTokens(view.contextWindowTokens)} ` : "";
    const cache = cacheShareText(view);
    contextGroup.push(new Segment("bar", "", `Ctx ${tokens}`, ` ${percent}${cache}`, fraction, true));
  }

  const quotaGroup: Segment[] = [];
  if (summary.fiveHourUsed !== undefined) {
    const fraction = Math.max(0, Math.min(1, summary.fiveHourUsed / FULL_PERCENT));
    const color = statusColor(fraction, true);
    quotaGroup.push(new Segment("bar", "", "5h ", ` ${color}${summary.fiveHourUsed.toFixed(1)}%${RESET} (${formatDuration(secondsUntil(summary.fiveHourResetAt, nowMs))})`, fraction, true));
  }
  if (summary.sevenDayUsed !== undefined) {
    const fraction = Math.max(0, Math.min(1, summary.sevenDayUsed / FULL_PERCENT));
    const color = statusColor(fraction, true);
    quotaGroup.push(new Segment("bar", "", "Wk ", ` ${color}${summary.sevenDayUsed.toFixed(1)}%${RESET} (${formatDuration(secondsUntil(summary.sevenDayResetAt, nowMs))})`, fraction, true));
  }

  const width = Math.max(TWENTY, terminalWidth - RESERVED_COLUMNS);
  const lines: string[] = [];
  if (header.length > 0) {
    lines.push(layoutGrouped(header, [], width, "never", SEPARATOR, BAR_WIDTH));
  }
  const body = layoutGrouped(contextGroup, quotaGroup, width, "always", SEPARATOR, BAR_WIDTH);
  if (body !== "") {
    lines.push(body);
  }
  return lines.join("\n");
}

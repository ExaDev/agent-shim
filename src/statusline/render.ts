import { ESCAPE, visibleLength } from "./ansi";
import { STATUSLINE_DEFAULTS, type ResolvedStatusline, type StatuslineHeaderSegment } from "../config/statusline";
import { layoutBarGrid, type BarCell } from "./barGrid";
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
const ONE_PERCENT = 1;
/** The colour bands on a used fraction: red from `criticalAt`, yellow from `warnAt` (whole percentages), green under it. The defaults are the Antigravity statusline's own (red from 90%, yellow from 70%). */
interface ColourBands {
  readonly warnAt: number;
  readonly criticalAt: number;
}

const RESET = `${ESCAPE}[0m`;
const DIM = `${ESCAPE}[90m`;
const GREEN = `${ESCAPE}[32m`;
const YELLOW = `${ESCAPE}[33m`;
const RED = `${ESCAPE}[31m`;

function colorize(): boolean {
  return process.env.NO_COLOR === undefined;
}

function statusColor(fraction: number, isUsedMetric: boolean, bands: ColourBands): string {
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

/** What headroom's compression saved this session, as tokens, percentage and dollars; each figure is left out when the proxy did not report it, and undefined when none was reported. */
function headroomText(stats: StatuslineSummary["headroom"]): string | undefined {
  if (stats === undefined) {
    return undefined;
  }
  // Under one percent a single decimal hides most of the figure (a saving of 0.01% would read 0.0%), so it gets two.
  const overall = stats.savingsPercent === undefined ? undefined : `${stats.savingsPercent.toFixed(stats.savingsPercent < ONE_PERCENT ? 2 : 1)}% overall`;
  const parts = [
    stats.tokensSaved === undefined ? undefined : `${formatTokens(stats.tokensSaved)} saved`,
    overall,
    stats.savingsUsd === undefined ? undefined : `$${stats.savingsUsd.toFixed(2)}`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : `headroom ${parts.join(" · ")}`;
}

/** The cache hit fraction drawn as a percentage in the colour of its band: a hit ratio is better the higher it is, so the bands are the remaining-style ones, red when nearly nothing is served from cache and green when most is. */
function cacheHitText(hitFraction: number, bands: ColourBands): string {
  const clamped = Math.max(0, Math.min(1, hitFraction));
  return ` (Cache: ${statusColor(clamped, false, bands)}${(clamped * FULL_PERCENT).toFixed(0)}%${RESET})`;
}

/** The prompt cache's hit percentage, preferring the client's own request-level hit ratio, which survives a cold turn, over the last request's share of prompt tokens read from cache, which a single cold turn zeroes. */
function cacheShareText(view: StatuslinePayloadView, bands: ColourBands): string {
  const hitRatio = view.cacheHitRatio;
  if (hitRatio !== undefined && Number.isFinite(hitRatio)) {
    return cacheHitText(hitRatio, bands);
  }
  const promptTotal = (view.cacheReadTokens ?? 0) + (view.freshInputTokens ?? 0);
  if (promptTotal > 0 && (view.cacheReadTokens ?? 0) > 0) {
    return cacheHitText((view.cacheReadTokens ?? 0) / promptTotal, bands);
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

/** A bar that fills with `fraction`, coloured by its band, `cells` fill positions wide between its brackets. */
function drawBar(fraction: number, cells: number, bands: ColourBands): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * cells);
  const color = statusColor(clamped, true, bands);
  return color === "" ? `[${"█".repeat(filled)}${"░".repeat(cells - filled)}]` : `[${color}${"█".repeat(filled)}${DIM}${"░".repeat(cells - filled)}${RESET}]`;
}

function barCell(prefix: string, suffix: string, fraction: number, bands: ColourBands): BarCell {
  return { prefix, suffix, draw: (cells) => drawBar(fraction, cells, bands) };
}

/** Justifies texts across the line's width: the first flush left, the last flush right, and each separator sharing the spare space evenly around its pipe. A line with no spare width, or a single text, joins plainly. */
function justify(texts: readonly string[], maxWidth: number, separator: string): string {
  if (texts.length < 2) {
    return texts.join(separator);
  }
  const separatorLength = visibleLength(separator);
  const total = texts.reduce((sum, text) => sum + visibleLength(text), 0) + separatorLength * (texts.length - 1);
  const spare = maxWidth - total;
  if (spare <= 0) {
    return texts.join(separator);
  }
  const gaps = texts.length - 1;
  const extraPerGap = Math.floor(spare / gaps);
  let remainder = spare % gaps;
  const parts: string[] = [];
  texts.forEach((text, index) => {
    if (index > 0) {
      const extra = extraPerGap + (remainder > 0 ? 1 : 0);
      if (remainder > 0) {
        remainder -= 1;
      }
      const left = Math.floor(extra / 2);
      parts.push(`${" ".repeat(left + 1)}|${" ".repeat(extra - left + 1)}`);
    }
    parts.push(text);
  });
  return parts.join("");
}

/** Packs texts onto as few lines as fit, in order, each line justified across the width: a text joins the current line when it fits beside what is there, and a text already alone on a line that is still too wide renders whole, exactly as the Antigravity statusline's own fallback does. */
function layoutHeader(texts: readonly string[], maxWidth: number, separator: string): string {
  const separatorLength = visibleLength(separator);
  const lines: string[][] = [];
  let current: string[] = [];
  let currentWidth = 0;
  for (const text of texts) {
    const width = visibleLength(text);
    const added = current.length === 0 ? width : width + separatorLength;
    if (current.length > 0 && currentWidth + added > maxWidth) {
      lines.push(current);
      current = [text];
      currentWidth = width;
    } else {
      current.push(text);
      currentWidth += added;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.map((line) => justify(line, maxWidth, separator)).join("\n");
}

/**
 * The built-in statusline, laid out and coloured the way the Antigravity CLI's own statusline is: the model, the provider's account (email and subscription plan) and the identity when it is not that account, on the first line; then the context window's use (tokens against the window, the prompt cache's hit percentage) and the quota windows the door reports, each a bar that fills with use and turns yellow then red, one line when they fit and two when they do not.
 */
export function renderStatuslineBlock(summary: StatuslineSummary, view: StatuslinePayloadView, terminalWidth: number, nowMs: number, settings: ResolvedStatusline = STATUSLINE_DEFAULTS): string {
  const segments: Partial<Record<StatuslineHeaderSegment, string>> = {};
  // A dynamic mode's selection draws the model that answered beside the name the session typed (`auto -> glm-5.3`), because the client's own model name alone says nothing about what is actually serving. The provider joins the arrow when the choice could have landed on more than one, or when it left the launch's provider: exactly the cases where the provider is part of the answer.
  const choiceNamesProvider = summary.modelChoice !== undefined && (summary.modelChoice.providers.length > 1 || summary.routedTarget !== undefined);
  const modelSegment =
    summary.modelChoice !== undefined && view.modelDisplayName !== undefined && view.modelDisplayName !== ""
      ? `${view.modelDisplayName} -> ${choiceNamesProvider ? `${summary.modelChoice.provider}/${summary.modelChoice.served}` : summary.modelChoice.served}`
      : view.modelDisplayName;
  if (modelSegment !== undefined && modelSegment !== "") {
    segments.model = modelSegment;
  }
  if (summary.provider !== undefined) {
    const account = [summary.providerAccountEmail, summary.providerPlan].filter((part) => part !== undefined);
    segments.provider = account.length > 0 ? `${summary.provider} · ${account.join(" · ")}` : summary.provider;
  }
  // The target the last request was served by, when routing by name sent it off the launch's provider: a qualified name's choice, shown where the person is looking rather than only in the usage log. A dynamic mode's arrow already names the provider in this case, so the two never repeat each other.
  if (summary.routedTarget !== undefined && !choiceNamesProvider) {
    segments.route = `via ${summary.routedTarget}`;
  }
  // An account in an organisation is on the organisation's plan with its seat's tier naming the variant, and the seat's rate-limit tier names limits, not the plan; a personal account's plan is the tier itself. A personal plan's organizationName is only the account holder's own name, redundant beside the email, so an organisation's name shows only for the organisation types. Beside a provider the login's plan names quota the session is not drawing from, so there the login names its organisation, or just its account when it has none.
  const loginPlan = summary.provider === undefined ? (summary.loginPlan ?? accountPlanLabel(summary)) : undefined;
  const loginOrgName = summary.loginOrganizationType === "claude_team" || summary.loginOrganizationType === "claude_enterprise" ? summary.loginOrganizationName : undefined;
  const loginParts = [summary.loginAccountEmail, loginOrgName, loginPlan].filter((part) => part !== undefined);
  if (summary.loginAccountEmail !== undefined && summary.loginAccountEmail !== summary.providerAccountEmail) {
    segments.account = loginParts.join(" · ");
  } else if (summary.provider === undefined && loginParts.length > 0) {
    segments.account = loginParts.join(" · ");
  }
  // The identity names which login launched the session, worth its own segment only beside a provider, where it is not the account already named; a plain anthropic session is its login account, so the identity name would repeat it.
  if (summary.identity !== undefined && summary.provider !== undefined && summary.identity !== summary.providerAccountEmail && summary.identity !== summary.loginAccountEmail) {
    segments.identity = summary.identity;
  }
  const savings = headroomText(summary.headroom);
  if (savings !== undefined) {
    segments.headroom = savings;
  }
  // The segments drawn are the ones the settings list, in the order they list them.
  const header = settings.header.flatMap((name) => segments[name] ?? []);
  const bands: ColourBands = { warnAt: settings.warnAt, criticalAt: settings.criticalAt };

  const contextGroup: BarCell[] = [];
  if (view.contextUsedPercentage !== undefined) {
    const fraction = Math.max(0, Math.min(1, view.contextUsedPercentage / FULL_PERCENT));
    const color = statusColor(fraction, true, bands);
    const percent = `${color}${view.contextUsedPercentage.toFixed(1)}%${RESET}`;
    const tokens = view.contextTotalTokens !== undefined && view.contextWindowTokens !== undefined ? `${formatTokens(view.contextTotalTokens)}/${formatTokens(view.contextWindowTokens)} ` : "";
    const cache = cacheShareText(view, bands);
    contextGroup.push(barCell(`Ctx ${tokens}`, ` ${percent}${cache}`, fraction, bands));
  }

  const quotaGroup: BarCell[] = [];
  const drawWindow = (label: string, fraction: number, resetsAt: string | undefined): void => {
    const clamped = Math.max(0, Math.min(1, fraction));
    const color = statusColor(clamped, true, bands);
    quotaGroup.push(barCell(`${label} `, ` ${color}${(fraction * FULL_PERCENT).toFixed(1)}%${RESET} (${formatDuration(secondsUntil(resetsAt, nowMs))})`, clamped, bands));
  };
  if (summary.quotaFamilies.length > 0) {
    // An Antigravity account's limits are per model family, so every family's window is drawn whichever model is in use.
    for (const window of summary.quotaFamilies) {
      drawWindow(window.measures, window.utilization, window.resetsAt);
    }
  } else {
    if (summary.fiveHourUsed !== undefined) {
      drawWindow(settings.fiveHourLabel, summary.fiveHourUsed / FULL_PERCENT, summary.fiveHourResetAt);
    }
    if (summary.sevenDayUsed !== undefined) {
      drawWindow(settings.sevenDayLabel, summary.sevenDayUsed / FULL_PERCENT, summary.sevenDayResetAt);
    }
    // A provider outside Anthropic's unified rate-limit family (z.ai) reports its usage only through its own quota windows, which are drawn when no unified window is.
    if (summary.fiveHourUsed === undefined && summary.sevenDayUsed === undefined) {
      for (const window of summary.providerQuotaWindows) {
        drawWindow(window.measures, window.utilization, window.resetsAt);
      }
    }
  }

  const width = Math.max(TWENTY, terminalWidth - RESERVED_COLUMNS);
  const lines: string[] = [];
  if (header.length > 0) {
    lines.push(layoutHeader(header, width, SEPARATOR));
  }
  const groups = { context: contextGroup, quota: quotaGroup };
  lines.push(...layoutBarGrid(settings.bars.map((name) => groups[name]), width, SEPARATOR, settings.barWidth));
  return lines.join("\n");
}

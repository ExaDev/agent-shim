import type { ResolvedStatusline } from "../config/statusline";
import type { BarCell } from "./barGrid";
import { blendRgb, type Rgb } from "./colour";
import type { Translate } from "./messages/catalogues";
import { RESET, type ColourRole, type Palette } from "./palette";

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_DAY = 86_400;
const THOUSAND = 1_000;
const MILLION = 1_000_000;
const TEN = 10;
export const FULL_PERCENT = 100;
export const ONE_PERCENT = 1;
/** The colour bands on a used fraction: red from `criticalAt`, yellow from `warnAt` (whole percentages) and green under it. They colour the figures beside a bar in every mode, and the bar itself while `bar.gradient` is `off`; they are also the thresholds the gradient's stops sit at (`use` holds yellow exactly at `warnAt` and red from `criticalAt`), and `width` colours a bar by its cells, not by these bands, once a cell of its used part is drawn; either gradient falls back to them when one of its stops names no colour of its own (`default` or `dim`), and `width` also when no cell of its used part is drawn. The defaults are the Antigravity statusline's own (red from 90%, yellow from 70%). */
interface ColourBands {
  readonly warnAt: number;
  readonly criticalAt: number;
}

/** How a bar's fill is coloured: `off` draws the band's single colour, `use` blends the bar's own, warning and critical colours by the use, and `width` blends the bar's own colour into the critical one across the bar's cells; either gradient draws the band's single colour instead when one of its stops names no colour of its own, and `width` also when no cell of its used part is drawn. */
type BarGradientMode = ResolvedStatusline["bar"]["gradient"];

/** `text` in the escape sequence `color`, ended with a reset; unchanged when `color` is empty, because a reset with no colour before it would put an escape in text that has none. */
export function withColor(color: string, text: string): string {
  return color === "" ? text : `${color}${text}${RESET}`;
}

/** How a bar and its figures are coloured: the band thresholds, the palette, which role is the bar's own colour (below the warning threshold while `bar.gradient` is `off`, and the first stop of a gradient), how the fill's colour is gradiented, and the characters that draw it. */
export interface BarStyle {
  readonly bands: ColourBands;
  readonly palette: Palette;
  /** The role of a bar's own colour, drawn below its warning threshold while `bar.gradient` is `off` and the first stop of a gradient: the context bar and the quota bars have their own. */
  readonly okRole: "context" | "usage";
  /** How the fill's colour is gradiented beyond the band's single colour (`bar.gradient`). */
  readonly gradient: BarGradientMode;
  readonly filled: string;
  readonly empty: string;
}

/** The role a bar's warning colour comes from: the quota bars and the memory bar, whose okRole is usage, have their own. */
function warningRoleOf(style: BarStyle): "warning" | "usageWarning" {
  return style.okRole === "usage" ? "usageWarning" : "warning";
}

/** The escape sequence that colours a fraction of use by its band: critical from `criticalAt`, the warning colour from `warnAt`, and the style's own colour under it. For a measure that is better the higher it is (`isUsedMetric` false) the bands are mirrored. */
export function statusColor(fraction: number, isUsedMetric: boolean, style: BarStyle): string {
  const yellowAt = style.bands.warnAt / FULL_PERCENT;
  const redAt = style.bands.criticalAt / FULL_PERCENT;
  const { ansi } = style.palette;
  if (isUsedMetric) {
    if (fraction >= redAt) {
      return ansi("critical");
    }
    return fraction >= yellowAt ? ansi(warningRoleOf(style)) : ansi(style.okRole);
  }
  if (fraction <= 1 - redAt) {
    return ansi("critical");
  }
  return fraction <= 1 - yellowAt ? ansi(warningRoleOf(style)) : ansi(style.okRole);
}

/** A role's colour as a gradient stop: the role, whose own escape the stop draws, and the RGB the gradient blends from or to. */
interface GradientStop {
  readonly role: ColourRole;
  readonly rgb: Rgb;
}

/** The stop a role's colour makes, or undefined when it names no RGB of its own (`default` and `dim`), which leaves the fill the band's colour. */
function stopOf(role: ColourRole, style: BarStyle): GradientStop | undefined {
  const rgb = style.palette.rgbOf(role);
  return rgb === undefined ? undefined : { role, rgb };
}

/** The escape between two stops, `at` of the way from the first to the second: each stop's own role escape at its end, so a stop draws exactly as the bands mode draws that role, and a 24-bit blend of their RGB strictly between. */
function colourBetween(from: GradientStop, to: GradientStop, at: number, style: BarStyle): string {
  if (at <= 0) {
    return style.palette.ansi(from.role);
  }
  if (at >= 1) {
    return style.palette.ansi(to.role);
  }
  return style.palette.rgb(blendRgb(from.rgb, to.rgb, at));
}

/** The gradient's colour for a fill that follows its use: the ok colour at none of it, the warning colour at the warning threshold and the critical colour from the critical threshold, each exactly as the bands mode draws it, blended linearly between those stops. Undefined when a stop's colour names no RGB of its own, which leaves the fill the band's colour. */
function gradientColorOf(fraction: number, style: BarStyle): string | undefined {
  const ok = stopOf(style.okRole, style);
  const warning = stopOf(warningRoleOf(style), style);
  const critical = stopOf("critical", style);
  if (ok === undefined || warning === undefined || critical === undefined) {
    return undefined;
  }
  const warnAt = style.bands.warnAt / FULL_PERCENT;
  const criticalAt = style.bands.criticalAt / FULL_PERCENT;
  return fraction < warnAt ? colourBetween(ok, warning, fraction / warnAt, style) : colourBetween(warning, critical, (fraction - warnAt) / (criticalAt - warnAt), style);
}

/** The stops of a fill coloured across its width: the ok colour at the first cell and the critical one at the last. Undefined when either names no RGB of its own, which leaves the fill the band's colour. */
function widthStopsOf(style: BarStyle): { readonly ok: GradientStop; readonly critical: GradientStop } | undefined {
  const ok = stopOf(style.okRole, style);
  const critical = stopOf("critical", style);
  return ok === undefined || critical === undefined ? undefined : { ok, critical };
}

/** Where a column of a fill sits across the bar's cells: 0 at the first cell, 1 at the last. A bar of a single cell is both first and last, so it takes the first stop. */
function acrossBar(column: number, cells: number): number {
  return cells <= 1 ? 0 : column / (cells - 1);
}

/** The fill a bar draws: the band's single colour over the whole of it, or the gradient's, which under `width` colours each column of it where it sits across the bar. Under `width`, a bar with no used cell drawn has no column to colour, so it is drawn as the band mode draws it; so is a bar of either gradient mode with a stop that names no colour of its own. */
function fillOf(fraction: number, filled: number, cells: number, style: BarStyle): string {
  const stops = style.gradient === "width" ? widthStopsOf(style) : undefined;
  if (stops !== undefined && filled > 0) {
    return Array.from({ length: filled }, (_, column) => `${colourBetween(stops.ok, stops.critical, acrossBar(column, cells), style)}${style.filled}`).join("");
  }
  const color = style.gradient === "use" ? gradientColorOf(fraction, style) : undefined;
  return `${color ?? statusColor(fraction, true, style)}${style.filled.repeat(filled)}`;
}

/** A bar that fills with `fraction`, `cells` fill positions wide between its brackets, its fill coloured by its band or, when the settings ask, every stop they need names a colour and (under `width`) a cell of the used part is drawn, by its use or across its width. */
function drawBar(fraction: number, cells: number, style: BarStyle): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * cells);
  const emptyColor = style.palette.ansi("empty");
  const fill = fillOf(clamped, filled, cells, style);
  const empty = style.empty.repeat(cells - filled);
  // With no colour on the fill or the empty part, the bar is drawn plain, as colour off and a palette of defaults leave it: no escape and no reset.
  return fill === style.filled.repeat(filled) && emptyColor === "" ? `[${fill}${empty}]` : `[${fill}${emptyColor}${empty}${RESET}]`;
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

export function barCell(prefix: string, suffix: string, fraction: number, style: BarStyle): BarCell {
  return { prefix, suffix, draw: (cells) => drawBar(fraction, cells, style) };
}

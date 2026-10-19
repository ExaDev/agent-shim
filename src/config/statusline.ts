import { z } from "zod";

/** The segments of the statusline's header, in the order they are drawn unless a setting reorders them. */
export const STATUSLINE_HEADER_SEGMENTS = ["model", "provider", "route", "account", "identity", "headroom"] as const;
export type StatuslineHeaderSegment = (typeof STATUSLINE_HEADER_SEGMENTS)[number];

/** The bar groups below the header: the context window's bar, and the quota windows' bars. */
export const STATUSLINE_BAR_GROUPS = ["context", "quota"] as const;
type StatuslineBarGroup = (typeof STATUSLINE_BAR_GROUPS)[number];

const MAX_PERCENT = 100;

/** The longest a window label may be: a label is padded into a column beside its bar, so a longer one crowds the bar out at narrow widths. */
export const MAX_STATUSLINE_LABEL_CHARS = 12;

/** The widest a bar's base size may be: bars grow to fill the line's spare width anyway, so a base beyond a wide terminal's usable columns only forces the layout to wrap. */
const MAX_BAR_CELLS = 40;

/** Printable text with no control, format or separator characters, so a label cannot move the cursor or split the line. */
const LABEL_RE = /^[^\p{C}\p{Z}]+(?: [^\p{C}\p{Z}]+)*$/u;

const wholePercent = z.number().int().min(1).max(MAX_PERCENT);

/** A list that names each member once: the order is the drawing order, and a repeated member would draw twice. */
function distinctList<T extends z.ZodType<string>>(member: T): z.ZodArray<T> {
  return z.array(member).refine((items) => new Set(items).size === items.length, "must not repeat a segment");
}

/**
 * How the built-in statusline looks, resolved through the configuration cascade key by key (a deeper layer's value for a key replaces a shallower one's, and a list replaces the list). Every key is optional; an absent key keeps the default in `STATUSLINE_DEFAULTS`.
 *
 * - `header` is the header segments to draw, in drawing order; a segment left out is hidden, and an empty list hides the header.
 * - `bars` is the bar groups to draw, in drawing order, on the same terms.
 * - `warnAt` and `criticalAt` are the whole percentages at which a bar of use turns yellow and red; `warnAt` must be the lower.
 * - `fiveHourLabel` and `sevenDayLabel` name the two subscription windows.
 * - `barWidth` is the width of a bar in cells before the line's spare width is shared out among the bars.
 */
export const StatuslineSchema = z.strictObject({
  header: distinctList(z.enum(STATUSLINE_HEADER_SEGMENTS)).optional(),
  bars: distinctList(z.enum(STATUSLINE_BAR_GROUPS)).optional(),
  warnAt: wholePercent.optional(),
  criticalAt: wholePercent.optional(),
  fiveHourLabel: z.string().max(MAX_STATUSLINE_LABEL_CHARS).regex(LABEL_RE, "must be visible text without control characters").optional(),
  sevenDayLabel: z.string().max(MAX_STATUSLINE_LABEL_CHARS).regex(LABEL_RE, "must be visible text without control characters").optional(),
  barWidth: z.number().int().min(1).max(MAX_BAR_CELLS).optional(),
});
export type StatuslineSettings = z.infer<typeof StatuslineSchema>;

/** A change to the settings, key by key: a value sets that key, `false` clears it so the cascade's shallower layers or the default apply again, and a key left out is untouched. */
export const StatuslineChangeSchema = z.strictObject({
  header: z.union([StatuslineSchema.shape.header.unwrap(), z.literal(false)]).optional(),
  bars: z.union([StatuslineSchema.shape.bars.unwrap(), z.literal(false)]).optional(),
  warnAt: z.union([StatuslineSchema.shape.warnAt.unwrap(), z.literal(false)]).optional(),
  criticalAt: z.union([StatuslineSchema.shape.criticalAt.unwrap(), z.literal(false)]).optional(),
  fiveHourLabel: z.union([StatuslineSchema.shape.fiveHourLabel.unwrap(), z.literal(false)]).optional(),
  sevenDayLabel: z.union([StatuslineSchema.shape.sevenDayLabel.unwrap(), z.literal(false)]).optional(),
  barWidth: z.union([StatuslineSchema.shape.barWidth.unwrap(), z.literal(false)]).optional(),
});

/** The statusline with every setting decided. */
export interface ResolvedStatusline {
  readonly header: readonly StatuslineHeaderSegment[];
  readonly bars: readonly StatuslineBarGroup[];
  readonly warnAt: number;
  readonly criticalAt: number;
  readonly fiveHourLabel: string;
  readonly sevenDayLabel: string;
  readonly barWidth: number;
}

/** What the statusline draws when no layer sets a key. */
export const STATUSLINE_DEFAULTS: ResolvedStatusline = {
  header: STATUSLINE_HEADER_SEGMENTS,
  bars: STATUSLINE_BAR_GROUPS,
  warnAt: 70,
  criticalAt: 90,
  fiveHourLabel: "5h",
  sevenDayLabel: "Wk",
  barWidth: 10,
};

/** The statusline's settings with the defaults filled in, or a message naming what is wrong when the combination is not drawable (the warning threshold must sit below the critical one, which a per-key cascade cannot check layer by layer). */
export function resolveStatusline(settings: Readonly<StatuslineSettings> | undefined): ResolvedStatusline {
  const resolved: ResolvedStatusline = {
    header: settings?.header ?? STATUSLINE_DEFAULTS.header,
    bars: settings?.bars ?? STATUSLINE_DEFAULTS.bars,
    warnAt: settings?.warnAt ?? STATUSLINE_DEFAULTS.warnAt,
    criticalAt: settings?.criticalAt ?? STATUSLINE_DEFAULTS.criticalAt,
    fiveHourLabel: settings?.fiveHourLabel ?? STATUSLINE_DEFAULTS.fiveHourLabel,
    sevenDayLabel: settings?.sevenDayLabel ?? STATUSLINE_DEFAULTS.sevenDayLabel,
    barWidth: settings?.barWidth ?? STATUSLINE_DEFAULTS.barWidth,
  };
  if (resolved.warnAt >= resolved.criticalAt) {
    throw new RangeError(`statusline warnAt (${String(resolved.warnAt)}) must be below criticalAt (${String(resolved.criticalAt)})`);
  }
  return resolved;
}

/** The environment variable that carries a launch's statusline settings (a JSON object of `StatuslineSchema`) to the statusline command the launched session runs. */
export const STATUSLINE_ENV = "AGENT_SHIM_STATUSLINE";

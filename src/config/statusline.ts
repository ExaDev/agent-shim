import { z } from "zod";

/** The segments of the statusline's header, in the order they are drawn unless a setting reorders them. */
export const STATUSLINE_HEADER_SEGMENTS = ["model", "provider", "route", "account", "identity", "headroom"] as const;

/** The rows below the header, in the order they are drawn unless a setting reorders them: the context window's bar, and the quota windows' bars. */
export const STATUSLINE_ROWS = ["context", "quota"] as const;

/** The named colours, as the terminal's own palette: `default` leaves the text in the terminal's colour, and `dim` is the faint attribute rather than a colour. */
export const STATUSLINE_COLOUR_NAMES = [
  "default",
  "dim",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const MAX_PERCENT = 100;
/** The highest index of the 256-colour palette. */
export const MAX_STATUSLINE_PALETTE_INDEX = 255;

/** The longest a window label may be: a label is padded into a column beside its bar, so a longer one crowds the bar out at narrow widths. */
export const MAX_STATUSLINE_LABEL_CHARS = 12;

/** The widest a bar's base size may be: bars grow to fill the line's spare width anyway, so a base beyond a wide terminal's usable columns only forces the layout to wrap. */
const MAX_BAR_CELLS = 40;

/** Printable text with no control, format or separator characters, so a label cannot move the cursor or split the line. */
const LABEL_RE = /^[^\p{C}\p{Z}]+(?: [^\p{C}\p{Z}]+)*$/u;

/** A list that names each member once: the order is the drawing order, and a repeated member would draw twice. */
function distinctList<T extends z.ZodType<string>>(member: T): z.ZodArray<T> {
  return z.array(member).refine((items) => new Set(items).size === items.length, "must not repeat a segment");
}

/** A colour: a named one, an index into the 256-colour palette, or a `#rrggbb` hex value. */
const colourValue = z.union([z.enum(STATUSLINE_COLOUR_NAMES), z.number().int().min(0).max(MAX_STATUSLINE_PALETTE_INDEX), z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a colour name, a palette index from 0 to 255 or #rrggbb")]);

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Whether `text` is one grapheme that draws something: no control, format, separator or unassigned character, so a bar character cannot move the cursor or vanish. Wide glyphs pass and may misalign a bar, which the terminal decides. */
function isSingleVisibleGrapheme(text: string): boolean {
  return [...GRAPHEMES.segment(text)].length === 1 && !/[\p{C}\p{Z}]/u.test(text);
}

const barCharacter = z.string().refine(isSingleVisibleGrapheme, "must be a single visible character");

const labelText = z.string().max(MAX_STATUSLINE_LABEL_CHARS).regex(LABEL_RE, "must be visible text without control characters");
const wholePercent = z.number().int().min(1).max(MAX_PERCENT);

/**
 * Every statusline setting, grouped, with each leaf's meaning attached as its description. The groups are declared once as plain shapes and used twice: whole, for the resolved settings (every key present), and `partial`, for what a configuration layer may set (every key optional). The description of a key is what `agent-shim statusline keys` prints, so a key without one is a defect, and a test refuses it.
 */
const SHAPES = {
  layout: {
    header: distinctList(z.enum(STATUSLINE_HEADER_SEGMENTS)).describe("The header segments to draw, in drawing order; a segment left out is hidden, and an empty list hides the header."),
    rows: distinctList(z.enum(STATUSLINE_ROWS)).describe("The rows to draw below the header, in drawing order; a row left out is hidden, and an empty list hides every row."),
  },
  bands: {
    warnAt: wholePercent.describe("The whole percentage of use at which a bar turns yellow; it must be below criticalAt."),
    criticalAt: wholePercent.describe("The whole percentage of use at which a bar turns red."),
  },
  labels: {
    fiveHour: labelText.describe("The name of the five-hour subscription window."),
    sevenDay: labelText.describe("The name of the weekly subscription window."),
  },
  bar: {
    width: z.number().int().min(1).max(MAX_BAR_CELLS).describe("A bar's width in cells before the line's spare width is shared out among the bars."),
    filled: barCharacter.describe("The character that draws the used part of a bar."),
    empty: barCharacter.describe("The character that draws the unused part of a bar."),
  },
  colours: {
    context: colourValue.describe("The colour of the context bar and its figures below the warning threshold."),
    usage: colourValue.describe("The colour of the quota bars and their figures below the warning threshold."),
    warning: colourValue.describe("The colour of the context bar at or above bands.warnAt, and of a cache hit share that is middling."),
    usageWarning: colourValue.describe("The colour of a quota bar at or above bands.warnAt."),
    critical: colourValue.describe("The colour of a bar at or above bands.criticalAt, and of a cache hit share that is nearly nothing."),
    model: colourValue.describe("The colour of the model and provider segments."),
    label: colourValue.describe("The colour of labels and secondary text: row labels, and the route, account, identity and headroom segments."),
    empty: colourValue.describe("The colour of the unused part of a bar."),
  },
};

/** What a configuration layer may set: every group and every key optional, so a layer names only what it changes. */
export const StatuslineSchema = z.strictObject({
  layout: z.strictObject(SHAPES.layout).partial().optional(),
  bands: z.strictObject(SHAPES.bands).partial().optional(),
  labels: z.strictObject(SHAPES.labels).partial().optional(),
  bar: z.strictObject(SHAPES.bar).partial().optional(),
  colours: z.strictObject(SHAPES.colours).partial().optional(),
});
export type StatuslineSettings = z.infer<typeof StatuslineSchema>;

/** The statusline with every setting decided. */
export const ResolvedStatuslineSchema = z.strictObject({
  layout: z.strictObject(SHAPES.layout),
  bands: z.strictObject(SHAPES.bands),
  labels: z.strictObject(SHAPES.labels),
  bar: z.strictObject(SHAPES.bar),
  colours: z.strictObject(SHAPES.colours),
});
export type ResolvedStatusline = z.infer<typeof ResolvedStatuslineSchema>;

/** What the statusline draws when no layer sets a key. */
export const STATUSLINE_DEFAULTS: ResolvedStatusline = {
  layout: { header: [...STATUSLINE_HEADER_SEGMENTS], rows: [...STATUSLINE_ROWS] },
  bands: { warnAt: 70, criticalAt: 90 },
  labels: { fiveHour: "5h", sevenDay: "Wk" },
  bar: { width: 10, filled: "█", empty: "░" },
  colours: {
    context: "green",
    usage: "green",
    warning: "yellow",
    usageWarning: "yellow",
    critical: "red",
    model: "default",
    label: "default",
    empty: "brightBlack",
  },
};

/** A plain JSON object, narrowed so its keys can be read without an assertion. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `over` laid on `base`, key by key: objects merge, and anything else (a scalar, a list) in `over` replaces what `base` has. Neither argument is changed. */
export function mergeStatuslineSettings(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) {
    return over === undefined ? base : over;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in base ? mergeStatuslineSettings(base[key], value) : value;
  }
  return merged;
}

/** The statusline's settings with the defaults filled in, or a message naming what is wrong when the combination is not drawable (the warning threshold must sit below the critical one, which a per-key cascade cannot check layer by layer). */
export function resolveStatusline(settings: Readonly<StatuslineSettings> | undefined): ResolvedStatusline {
  const resolved = ResolvedStatuslineSchema.parse(mergeStatuslineSettings(STATUSLINE_DEFAULTS, settings));
  if (resolved.bands.warnAt >= resolved.bands.criticalAt) {
    throw new RangeError(`statusline bands.warnAt (${String(resolved.bands.warnAt)}) must be below bands.criticalAt (${String(resolved.bands.criticalAt)})`);
  }
  return resolved;
}

/** The environment variable that carries a launch's statusline settings (a JSON object of `StatuslineSchema`) to the statusline command the launched session runs. */
export const STATUSLINE_ENV = "AGENT_SHIM_STATUSLINE";

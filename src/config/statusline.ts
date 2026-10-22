import stringWidth from "string-width";
import { z } from "zod";

import { drawsNothing } from "../statusline/blank";
import { graphemesOf } from "../statusline/graphemes";
import { STATUSLINE_LANGUAGES } from "../statusline/messages/languages";

/** The segments of the statusline's header, in the order they are drawn unless a setting reorders them. */
export const STATUSLINE_HEADER_SEGMENTS = ["model", "provider", "route", "account", "identity", "headroom", "project", "vcs", "effort", "advisor", "version", "outputStyle", "cost", "dailyCost", "sessionName", "duration", "speed", "extra"] as const;

/** The rows below the header, in the order they are drawn unless a setting reorders them: the context window's bar, the quota windows' bars, the added directories, the files the working tree has changed, the machine's memory bar, and the line of configuration counts, then the lines of text about the session read from its transcript: when it started and last answered, its prompt cache, its compactions and tokens, and what it is doing (its tool calls, the skills and MCP servers it has used, its agents and its todo list). */
export const STATUSLINE_ROWS = ["context", "quota", "addedDirs", "gitFiles", "memory", "environment", "sessionTime", "promptCache", "compactions", "tokens", "tools", "skills", "mcp", "agents", "todos"] as const;

/** The parts of the session-time row, in the order the row draws them. */
const STATUSLINE_SESSION_TIME_PARTS = ["started", "lastReply"] as const;

/** The lifetimes of Anthropic's prompt cache: the five minutes a cache write lives unless it asked for more, and the one-hour tier a request can opt into (https://docs.claude.com/en/docs/build-with-claude/prompt-caching). */
export const PROMPT_CACHE_TTL_SECONDS = { fiveMinutes: 300, oneHour: 3600 } as const;

/** The orange of the 256-colour palette, which no colour name stands for and the custom line is drawn in by default, as claude-hud draws its own. */
const ORANGE_PALETTE_INDEX = 208;

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

/**
 * The segments and rows drawn when no layer sets `layout`: every element stock claude-hud draws under its own default configuration, then agent-shim's own. claude-hud's default draws the model with the platform label beside it, the project path with its added directories inline and its git status, the extra label once a command is given, and the context and usage bars (its `DEFAULT_CONFIG` and `DEFAULT_ELEMENT_ORDER` in `src/config.ts`, at the commit `src/statusline/parity/inventory.ts` names); here that is the model segment (whose platform `model.platform` draws, on by default), the project and vcs segments, the extra segment (which draws nothing until `extra.command` is set) and the context and quota rows. The `addedDirs` row is listed because claude-hud's default element order holds its added directories line, which it draws once `addedDirsLayout` is `line`; it draws nothing while `project.addedDirsLayout` is `inline`. The provider, route, account, identity and headroom segments are agent-shim's own and sit between the version control and the extra segment, in the order they have always had. A segment or row added later stays hidden until a layer lists it.
 */
const DEFAULT_HEADER_SEGMENTS: readonly (typeof STATUSLINE_HEADER_SEGMENTS)[number][] = ["model", "project", "vcs", "provider", "route", "account", "identity", "headroom", "extra"];
const DEFAULT_ROWS: readonly (typeof STATUSLINE_ROWS)[number][] = ["context", "quota", "addedDirs"];

/**
 * The defaults that follow stock claude-hud's own, so the default shows at least what claude-hud's default does (each is a value of claude-hud's `DEFAULT_CONFIG.display`, at the commit `src/statusline/parity/inventory.ts` names): the reset label is `showResetLabel: true`, the per-model windows are `showModelScopedUsage: true`, the weekly window's threshold is `sevenDayThreshold: 80`, the estimate when the client reports no percentage is `autocompactBuffer: 'enabled'`, which adds the reserve, and the breakdown at the critical threshold is `showTokenBreakdown: true`. The platform label beside the model is drawn because claude-hud's `formatModelDisplay` (`src/render/model-display.ts`) appends the label `getProviderLabel` detects whatever its configuration says, so no value of its own turns it off.
 */
const CLAUDE_HUD_DEFAULTS = {
  model: { platform: true },
  usage: { resetLabel: true, modelScoped: true, sevenDayThreshold: 80 },
  context: { estimate: "buffered", breakdown: "critical" },
} as const;

/** The named bundles of settings a layer can choose with `preset`: `standard` is what the statusline draws with no settings at all (claude-hud's default display and agent-shim's own segments), and the rest are claude-hud's presets. */
export const STATUSLINE_PRESETS = ["standard", "full", "essential", "minimal"] as const;

/** The keys every preset sets, and no others, so that choosing a preset in a deeper layer leaves nothing of a shallower layer's preset behind. They are the keys claude-hud's presets are written in terms of. */
interface PresetBundle {
  readonly layout: { readonly header: readonly (typeof STATUSLINE_HEADER_SEGMENTS)[number][]; readonly rows: readonly (typeof STATUSLINE_ROWS)[number][] };
  readonly git: { readonly enabled: boolean; readonly showDirty: boolean; readonly showAheadBehind: boolean; readonly showLineDiff: boolean };
  readonly jj: { readonly enabled: boolean; readonly showDirty: boolean; readonly showConflicts: boolean };
  readonly usage: { readonly resetLabel: boolean };
  readonly context: { readonly breakdown: "never" | "critical" };
}

/** claude-hud's version control style for all of its presets: git on, with the dirty marker, without ahead and behind and without file statistics. */
const GIT_WITH_DIRTY_MARKER = { enabled: true, showDirty: true, showAheadBehind: false, showLineDiff: false } as const;

/** Jujutsu off, with the markers it shows once opted in left at claude-hud's defaults. */
const JJ_OFF = { enabled: false, showDirty: true, showConflicts: true } as const;

/**
 * What each preset sets. `standard` is the default: everything claude-hud's own default configuration draws (the model, project, version control and extra segments over the context, quota and added directories rows, with the reset label and the token breakdown at high use), and agent-shim's provider, route, account, identity and headroom segments. All the others are claude-hud's presets as its guided configuration (`commands/configure.md`) defines them, for the elements the statusline has: each is a claude-hud configuration with that preset applied, so a toggle the preset does not list stays at claude-hud's default (the reset label on, the added directories on, usage on). `full` is the model, project, version control, effort, advisor, version, output style, cost, session name and duration, over the context, quota, added directories, memory, environment, tools, skills, mcp, agents, todos, prompt cache, compactions and session tokens rows, with the token breakdown on the context row at high use and Jujutsu on. `essential` is the model, project, version control and duration over the context, added directories, tools, agents and todos rows, and `minimal` is the same without the duration; neither adds the token breakdown. The segments and rows that are agent-shim's own (provider, route, account, identity, headroom, daily cost, speed, the changed files and the session times) are in none of claude-hud's three, because claude-hud's presets never turn them on.
 */
const PRESET_BUNDLES: Readonly<Record<(typeof STATUSLINE_PRESETS)[number], PresetBundle>> = {
  standard: { layout: { header: DEFAULT_HEADER_SEGMENTS, rows: DEFAULT_ROWS }, git: GIT_WITH_DIRTY_MARKER, jj: JJ_OFF, usage: { resetLabel: CLAUDE_HUD_DEFAULTS.usage.resetLabel }, context: { breakdown: CLAUDE_HUD_DEFAULTS.context.breakdown } },
  full: {
    layout: { header: ["model", "project", "vcs", "effort", "advisor", "version", "extra", "outputStyle", "cost", "sessionName", "duration"], rows: ["context", "quota", "addedDirs", "memory", "environment", "tools", "skills", "mcp", "agents", "todos", "promptCache", "compactions", "tokens"] },
    git: GIT_WITH_DIRTY_MARKER,
    jj: { enabled: true, showDirty: true, showConflicts: true },
    usage: { resetLabel: true },
    context: { breakdown: "critical" },
  },
  essential: { layout: { header: ["model", "project", "vcs", "extra", "duration"], rows: ["context", "addedDirs", "tools", "agents", "todos"] }, git: GIT_WITH_DIRTY_MARKER, jj: JJ_OFF, usage: { resetLabel: true }, context: { breakdown: "never" } },
  minimal: { layout: { header: ["model", "project", "vcs", "extra"], rows: ["context", "addedDirs"] }, git: GIT_WITH_DIRTY_MARKER, jj: JJ_OFF, usage: { resetLabel: true }, context: { breakdown: "never" } },
};

/** How many directory levels the project path shows: one to three, or the whole path. Written as text so that every value of a setting is one of a closed set of choices. */
export const STATUSLINE_PATH_LEVELS = ["1", "2", "3", "full"] as const;

/** How the quota row writes a window's figure: the share of the window used, or the share still left. */
const STATUSLINE_USAGE_VALUES = ["used", "remaining"] as const;

/** How the quota row tells when a window resets: the time left, the wall-clock time, both, the share of the window already gone, or that share and the wall-clock time. */
const STATUSLINE_TIME_FORMATS = ["relative", "absolute", "both", "elapsed", "elapsedAndAbsolute"] as const;

/** The hour cycles a wall-clock time can be written in, as `Intl.DateTimeFormat` names them; `auto` leaves it to the locale. */
const STATUSLINE_HOUR_CYCLES = ["auto", "h11", "h12", "h23", "h24"] as const;

const MAX_PERCENT = 100;
/** The highest index of the 256-colour palette. */
export const MAX_STATUSLINE_PALETTE_INDEX = 255;

/** The most terminal columns a window label may take (a wide character takes two): a label is padded into a column beside its bar, so a wider one crowds the bar out at narrow widths. */
export const MAX_STATUSLINE_LABEL_COLUMNS = 12;

/** The fewest columns a line is drawn to: narrower than this a bar has no room beside its label and figures, so a line is never drawn to less, and a width set for the statusline is at least this. */
export const MIN_STATUSLINE_COLUMNS = 20;

/** The widest a terminal is taken to be: no terminal is wider, and a limit beyond it would only let a typing slip make every line unreadable. */
export const MAX_STATUSLINE_COLUMNS = 1000;

/** The widest a bar's base size may be: bars grow to fill the line's spare width anyway, so a base beyond a wide terminal's usable columns only forces the layout to wrap. */
const MAX_BAR_CELLS = 40;

/** The longest an email address may be (RFC 5321's path limit less its angle brackets), so a cut at or beyond it never shortens an account. */
export const MAX_ACCOUNT_USER_CHARS = 254;

/** The most characters of text that comes from outside the statusline (a model name, an output style, an advisor) or that a setting replaces one with: longer than any real identifier of those kinds, and short enough to leave the header line room for its other segments. */
export const MAX_DISPLAY_TEXT_CHARS = 80;

/** The most arguments (the program included) the extra segment's command may have: a command that prints a label is a program and a few flags, and a longer list is a script that belongs in a file. */
export const MAX_EXTRA_COMMAND_ARGUMENTS = 16;

/** The longest one argument of the extra segment's command may be, in characters: well above any path or flag, and short enough that a settings file cannot be made to carry a payload as an argument. */
export const MAX_EXTRA_COMMAND_ARGUMENT_CHARS = 1024;

/** The settings group of the extra segment, whose `command` is the one statusline setting that runs a program the configuration chooses. Only the person's own layers may set it, which the project-file schema and the door's config API both enforce. */
export const STATUSLINE_EXTRA_GROUP = "extra" as const;

/** One argument of a command: any text but a NUL, which no program can be given. */
const commandArgument = z.string().max(MAX_EXTRA_COMMAND_ARGUMENT_CHARS).refine((argument) => !argument.includes("\u0000"), "must not contain a NUL character");

/** Printable text with no control, format or separator characters, so a label cannot move the cursor or split the line. */
const LABEL_RE = /^[^\p{C}\p{Z}]+(?: [^\p{C}\p{Z}]+)*$/u;

/** `LABEL_RE`, or nothing at all: the text of a setting whose empty value means "leave it to the statusline". */
const OPTIONAL_LABEL_RE = /^(?:[^\p{C}\p{Z}]+(?: [^\p{C}\p{Z}]+)*)?$/u;

/** A list that names each member once: the order is the drawing order, and a repeated member would draw twice. */
function distinctList<T extends z.ZodType<string>>(member: T): z.ZodArray<T> {
  return z.array(member).refine((items) => new Set(items).size === items.length, "must not repeat an entry");
}

/** Groups of rows that may share a line: each names at least two distinct rows, and a row is in at most one group, since a row cannot join two lines at once. */
const mergeGroups = z.array(distinctList(z.enum(STATUSLINE_ROWS)).min(2)).refine((groups) => {
  const rows = groups.flat();
  return new Set(rows).size === rows.length;
}, "must not name a row in more than one group");

/** A colour: a named one, an index into the 256-colour palette, or a `#rrggbb` hex value. */
const colourValue = z.union([z.enum(STATUSLINE_COLOUR_NAMES), z.number().int().min(0).max(MAX_STATUSLINE_PALETTE_INDEX), z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a colour name, a palette index from 0 to 255 or #rrggbb")]);

/** Whether `text` is one grapheme that draws something in exactly one terminal column: no control, format, separator or unassigned character, so a bar character cannot move the cursor or vanish, and not a wide or zero-width one, because a bar is laid out in columns and repeats the glyph once per column. */
function isSingleVisibleGrapheme(text: string): boolean {
  return graphemesOf(text).length === 1 && stringWidth(text) === 1 && !/[\p{C}\p{Z}]/u.test(text) && !drawsNothing(text);
}

const barCharacter = z.string().refine(isSingleVisibleGrapheme, "must be a single visible character that takes one terminal column");

/** How the context figure is written: the tokens held against the window and the percentage together, either alone, or the percentage left. */
const STATUSLINE_CONTEXT_VALUES = ["both", "percent", "tokens", "remaining"] as const;

/** What the context row draws when the client reports no percentage of the window in use: nothing, an estimate from the tokens held, or that estimate with the autocompact reserve added. */
const STATUSLINE_CONTEXT_ESTIMATES = ["never", "raw", "buffered"] as const;

/** The share of the context window Claude Code reserves for compaction, as `/context` reports it. It is measured from Claude Code's output, not documented by Anthropic, and is a share of whatever window the client reports. */
export const AUTOCOMPACT_RESERVE_FRACTION = 0.165;

/** The share of the window held below which no reserve is added: compaction does not start early in a session, so the reserve would overstate a window that was just cleared. */
export const AUTOCOMPACT_RESERVE_RAMP_START = 0.05;

/** The share of the window held from which the whole reserve is added; between the ramp's start and this the reserve rises in a straight line. */
export const AUTOCOMPACT_RESERVE_RAMP_END = 0.5;

const labelWithinColumns = (text: string): boolean => stringWidth(text) <= MAX_STATUSLINE_LABEL_COLUMNS;
const labelWithinColumnsMessage = `must take no more than ${String(MAX_STATUSLINE_LABEL_COLUMNS)} terminal columns`;
const labelShowsSomething = (text: string): boolean => !drawsNothing(text);
const labelShowsSomethingMessage = "must show something: a label of only combining marks or blank characters draws nothing";
const labelIsPlainText = (text: string): boolean => LABEL_RE.test(text);
const labelIsPlainTextMessage = "must be visible text without control characters";

/** A window's name, or nothing to use the name the language gives it. */
const windowLabel = z
  .string()
  .refine((text) => text === "" || labelWithinColumns(text), labelWithinColumnsMessage)
  .refine((text) => text === "" || labelShowsSomething(text), labelShowsSomethingMessage)
  .refine((text) => text === "" || labelIsPlainText(text), labelIsPlainTextMessage);
/** Text that replaces something the statusline would otherwise work out; empty leaves the statusline to work it out. */
const overrideText = z.string().max(MAX_DISPLAY_TEXT_CHARS).regex(OPTIONAL_LABEL_RE, "must be visible text without control characters");
const wholePercent = z.number().int().min(1).max(MAX_PERCENT);
/** A whole percentage that may be nothing, for a threshold where zero means "always". */
const thresholdPercent = z.number().int().min(0).max(MAX_PERCENT);

/**
 * Every statusline setting, grouped, with each leaf's meaning attached as its description. The groups are declared once as plain shapes and used twice: whole, for the resolved settings (every key present except the optional ones, which have no default and are absent until a layer sets them), and `partial`, for what a configuration layer may set (every key optional; a layer may also write null for an optional key, see `unsettable`). The description of a key is what `agent-shim statusline keys` prints, so a key without one is a defect, and a test refuses it.
 */
const SHAPES = {
  layout: {
    header: distinctList(z.enum(STATUSLINE_HEADER_SEGMENTS)).describe("The header segments to draw, in drawing order; a segment left out is hidden, and an empty list hides the header."),
    rows: distinctList(z.enum(STATUSLINE_ROWS)).describe("The rows to draw below the header, in drawing order; a row left out is hidden, and an empty list hides every row."),
    mode: z.enum(["expanded", "compact"]).describe("How the statusline is laid out: expanded draws the header and then the rows, each on lines of its own as layout.merge allows, and compact draws the header segments and every row's content on one line, starting a new line only where the line would be wider than the width. layout.mergeBars, layout.merge, layout.rightAlign and layout.rule have no effect in compact."),
    rule: z.enum(["none", "belowHeader"]).describe(`Whether a rule is drawn across the line between the header and the rows beneath it, as wide as the header's widest line (at least ${String(MIN_STATUSLINE_COLUMNS)} columns, at most the width); it is drawn only when both the header and the rows have something to show, and not in the compact layout.`),
    mergeBars: z.boolean().describe("Whether bar rows that sit next to each other in layout.rows share a line, and one grid, when they fit (the context and quota bars do by default); when false each bar row is on a line of its own, its bars still aligned to its neighbours'. A row of text is never joined by this setting, whichever form the quota row takes: layout.merge does that."),
    merge: mergeGroups.describe("Groups of rows that share a line when they sit next to each other in layout.rows and fit on one line together, and are drawn on lines of their own when they do not; each group names at least two rows, and no row belongs to two groups. A group may mix bar rows and rows of text, which are joined with the separator when every member is a single line. Bar rows outside a group follow layout.mergeBars. A group in which no row has anything to show draws nothing: one with a row of text in it still ends a run of bars sharing a line, as an empty row of text does, and one of bar rows alone is left out, so the bars either side of it share as if it were not there."),
    rightAlign: distinctList(z.enum(STATUSLINE_ROWS)).describe("Rows that start the right-aligned part of a merged line: the first of them to appear on a line, and the rows after it, are pushed to the right edge, with the gap padded by spaces. A row named here must belong to a group in layout.merge, and it has no effect when it is the first row of its line."),
    maxWidth: z
      .number()
      .int()
      .min(0)
      .max(MAX_STATUSLINE_COLUMNS)
      .refine((columns) => columns === 0 || columns >= MIN_STATUSLINE_COLUMNS, `must be 0, or at least ${String(MIN_STATUSLINE_COLUMNS)} columns`)
      .describe(`The exact width in columns lines are drawn to when the client reports none and the COLUMNS environment variable names none, in place of the default width it would assume for the terminal; unlike a terminal's width, it is not reduced by the columns Claude Code keeps back for itself. It is 0, to leave it unset, or from ${String(MIN_STATUSLINE_COLUMNS)} to ${String(MAX_STATUSLINE_COLUMNS)}; a value outside that is refused, not clamped.`),
    forceMaxWidth: z.boolean().describe("Whether maxWidth is the exact width lines are drawn to for whatever the client reports, even when the terminal is narrower or wider; it needs maxWidth to be set."),
  },
  model: {
    format: z.enum(["full", "compact", "short"]).describe("How the model's name is written: full is the name as the client gives it, compact drops a context-window suffix such as (1M context), and short also drops a leading Claude."),
    override: overrideText.describe("A name to show in place of the client's own model name, whatever model is running; empty shows the model's own name. A dynamic mode's served model still follows it."),
    source: z.enum(["client", "transcript", "auto"]).describe("Where the model's name comes from: client is the name the client reports (its display name, else its model id, each trimmed and read as absent when blank), transcript is the model the session's last reply came from (what a proxy actually served), and auto uses the transcript's model only when it is not a Claude model, which is what a proxy redirect looks like."),
    platform: z.boolean().describe("Whether the model segment ends with the label claude-hud draws beside the model name, chosen from the client's environment and model id as claude-hud chooses it, the first that holds: Bedrock when CLAUDE_CODE_USE_BEDROCK is 1, Vertex when CLAUDE_CODE_USE_VERTEX is 1, MiniMax when ANTHROPIC_BASE_URL (else ANTHROPIC_API_BASE_URL) is https://api.minimax.io/anthropic or https://api.minimaxi.com/anthropic, and Enterprise when the model id is opusplan, sonnetplan or haikuplan. Nothing is drawn when none holds, and the label stands alone when no name is known: the client's display name and model id are both absent or blank, no override is set, and the transcript supplies none where model.source reads it. The switches and the model ids are Claude Code's, so an Antigravity client never draws the label. It is not the provider segment, which names the agent-shim provider the launch selected and the door routes to."),
  },
  provider: {
    name: overrideText.describe("A label to show in place of the launch's provider name, or on its own when the launch has no provider; empty shows the provider's own name."),
  },
  account: {
    parts: distinctList(z.enum(["user", "organisation", "plan"])).describe("What the account segment says about the login account, in drawing order: the account's email address, its organisation (shown for team and enterprise accounts) and its plan. A part left out is hidden, and an empty list hides the segment."),
    userLength: z.number().int().min(0).max(MAX_ACCOUNT_USER_CHARS).describe("The most characters of the account's email address to show, with an ellipsis after a cut one; 0 shows all of it."),
  },
  effort: {
    format: z.enum(["full", "symbol", "text"]).describe("How the reasoning effort is written: full is a symbol and the level (a filled circle that grows with the level, then the name), symbol is the symbol alone, and text is the level's name alone. A level with no symbol is always written as its name."),
  },
  advisor: {
    override: overrideText.describe("A name to show for the advisor model in place of the one the session's transcript records; empty shows the transcript's, prettified."),
  },
  context: {
    bar: z.enum(["shown", "hidden"]).describe("Whether the context row draws its bar, or only its figures on one line of text."),
    value: z.enum(STATUSLINE_CONTEXT_VALUES).describe("The context figure: both (the tokens held against the window, then the percentage), percent, tokens, or remaining (the percentage of the window left)."),
    warnAt: wholePercent.optional().describe("The whole percentage of the context window at which the context bar turns yellow; while it is unset the context bar follows bands.warnAt."),
    criticalAt: wholePercent.optional().describe("The whole percentage of the context window at which the context bar turns red and, with context.breakdown set to critical, the token breakdown appears; while it is unset the context bar follows bands.criticalAt."),
    autoCompactWindow: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("A window in tokens to measure the context against instead of the model's, matching the figure /context gives once Claude Code compacts before the window is full. While it is set, the row draws nothing until the client reports the tokens held, since without them there is nothing to measure against it; while it is unset the model's own window is used."),
    estimate: z.enum(STATUSLINE_CONTEXT_ESTIMATES).describe(`What to draw when the client reports no percentage of the window in use, or reports 0 while tokens are already held (which is how a client says it has not worked it out yet): never (nothing is estimated: a percentage reported, 0 included, is drawn as it is, and none reported draws nothing), raw (the tokens held over the window), or buffered (that, plus the ${String(AUTOCOMPACT_RESERVE_FRACTION * MAX_PERCENT)}% of the window Claude Code reserves for compaction, rising from nothing at ${String(AUTOCOMPACT_RESERVE_RAMP_START * MAX_PERCENT)}% of the window held to the whole reserve at ${String(AUTOCOMPACT_RESERVE_RAMP_END * MAX_PERCENT)}%).`),
    breakdown: z.enum(["never", "critical"]).describe("Whether to add the input and cache tokens of the last request to the context row once its use reaches context.criticalAt."),
  },
  customLine: {
    text: overrideText.describe(`A line of your own text to draw, in colours.custom; empty draws nothing. It is refused when longer than ${String(MAX_DISPLAY_TEXT_CHARS)} characters or when it holds control, format or separator characters, and words are separated by single spaces. A character that passes but draws nothing, such as a braille blank, is removed, and the line is cut to the usable width.`),
    position: z.enum(["first", "last"]).describe("Where the custom line sits: first draws it above the header, and last below the last row, as a line of its own in either layout mode."),
  },
  extra: {
    command: z
      .array(commandArgument)
      .max(MAX_EXTRA_COMMAND_ARGUMENTS)
      .refine((command) => command[0]?.startsWith("-") !== true, "the program, the first item, must not start with a dash, which the system would read as an option: name it by an absolute path")
      .describe(
        `The program and arguments the extra segment runs, as a list and not a shell string (for example ["git", "describe", "--tags"]). The first line of its standard output that shows something, or the label of a JSON object it prints, is the segment; a line with nothing a person could see in it, such as spaces, zero-width characters or an escape sequence alone, is skipped. Escape sequences are removed from the whole output first, so an operating system command with no terminator removes everything up to the next escape character or the end of the output, line breaks included. A command that fails or prints nothing draws nothing. It is refused when it has more than ${String(MAX_EXTRA_COMMAND_ARGUMENTS)} arguments (the program included), when an argument is longer than ${String(MAX_EXTRA_COMMAND_ARGUMENT_CHARS)} characters or holds a NUL, and when the program starts with a dash. It runs on every refresh with your privileges and the statusline's whole environment. Its output is written to a file the system limits in size. That limit applies to every file it writes and every process it starts, so a program that writes a large cache is stopped and draws nothing, and so does one whose output reaches the limit. A process it starts is left running when it is killed for outrunning its time limit or when a newer update cancels the refresh. Because it runs a program with your privileges, only your own configuration may set it. That means the global config, a profile in your config-profiles directory, a directory rule or a command-line assignment. A project file such as .agent-shim.json is refused, though it may select one of your profiles by name, and a config write through the door's API (an MCP agent or the web client with the writes grant) is refused the extra settings for the same reason.`,
      ),
  },
  bands: {
    warnAt: wholePercent.describe("The whole percentage of use at which a bar turns yellow; it must be below criticalAt."),
    criticalAt: wholePercent.describe("The whole percentage of use at which a bar turns red."),
  },
  labels: {
    fiveHour: windowLabel.describe("The name of the five-hour window; empty uses the language's own name for it."),
    sevenDay: windowLabel.describe("The name of the weekly window; empty uses the language's own name for it."),
  },
  bar: {
    width: z.number().int().min(1).max(MAX_BAR_CELLS).describe("A bar's width in cells before the line's spare width is shared out among the bars."),
    filled: barCharacter.describe("The character that draws the used part of a bar."),
    empty: barCharacter.describe("The character that draws the unused part of a bar."),
  },
  usage: {
    value: z.enum(STATUSLINE_USAGE_VALUES).describe("Whether a quota window's figure is the share of it used or the share left; the bar and the colour always follow the share used."),
    bar: z.boolean().describe("Whether each quota window is drawn as a bar, or as text alone."),
    compact: z.boolean().describe("Whether the quota windows are drawn as one short line of text (`5h: 25.0% (1h 30m)`) in place of bars; it takes precedence over usage.bar."),
    resetLabel: z.boolean().describe("Whether a window's reset time is introduced with `resets in` (`resets` for a wall-clock time), as in `(resets in 1h 30m)`, rather than the bare `(1h 30m)`."),
    modelScoped: z.boolean().describe("Whether the per-model weekly windows the client reports (rate_limits.model_scoped) are drawn after the five-hour and weekly windows; they describe the signed-in account, so a session that selected a provider never shows them, nor does a Bedrock session, whose subscription windows do not apply."),
    timeFormat: z.enum(STATUSLINE_TIME_FORMATS).describe("How a window's reset is shown: the time left (`1h 30m`), the wall-clock time (`at 14:30`), both, the share of the window already gone (`53% elapsed`), or that share and the wall-clock time. A window whose length is not known shows no share."),
    threshold: thresholdPercent.describe("The whole percentage of use that at least one quota window must reach for the quota row to be drawn at all; 0 never hides it. A Bedrock session that selected no provider draws no five-hour, weekly or per-model window, whatever this is."),
    sevenDayThreshold: thresholdPercent.describe("The whole percentage of use at which the weekly window is drawn beside the five-hour one; below it the weekly window is hidden, and 0 never hides it. A weekly window with no five-hour window beside it is never hidden by this setting. A Bedrock session that selected no provider draws no five-hour, weekly or per-model window, so this setting has nothing to hide there, and usage.threshold can still hide the whole row."),
  },
  clock: {
    hourCycle: z.enum(STATUSLINE_HOUR_CYCLES).describe("The hour cycle of a wall-clock time: `auto` follows the system locale, `h23` and `h24` are 24-hour time (`h24` writes midnight as 24:00), and `h12` and `h11` are 12-hour time with am or pm (`h11` writes the hour after midnight as 0)."),
    seconds: z.boolean().describe("Whether a wall-clock time includes seconds (`14:30:07`)."),
  },
  cost: {
    routed: z.boolean().describe("Whether the cost segments draw for a session routed through a provider or a cloud platform's model id, where the client's own figure is not what was billed; the figure drawn is then priced from the door's usage log with `agent-shim model price`, else the client's own when it is above zero."),
  },
  environment: {
    threshold: z.number().int().min(0).describe("The fewest configuration items in total (CLAUDE.md files, rules, MCP servers and hook events) that must exist for the environment row to draw its counts."),
  },
  sessionTime: {
    parts: distinctList(z.enum(STATUSLINE_SESSION_TIME_PARTS)).describe("The parts of the sessionTime row to draw, in drawing order: when the session started, and how long ago the last response was written; a part left out is hidden, and an empty list hides the row."),
  },
  promptCache: {
    ttlSeconds: z
      .number()
      .int()
      .min(1)
      .describe("How long the prompt cache lives, in seconds, when the transcript has not yet shown which tier the session writes (five minutes or one hour); the tier the transcript shows takes over once it does."),
  },
  tools: {
    nameMaxLength: z.number().int().min(0).describe("The most terminal columns of a tool's name the tools row draws, cut with an ellipsis. With a limit set, a tool of an MCP server is shown by its own name, without the server's, whether or not it needs cutting. 0 draws every name whole, an MCP tool's with its server."),
    maxVisible: z.number().int().min(0).describe("The most kinds of finished tool call the tools row names, the most-used first, with the rest counted as +N more. 0 names every kind."),
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
    project: colourValue.describe("The colour of the project path segment."),
    git: colourValue.describe("The colour of the version control segment's wrapper text (`git:(` and `)`)."),
    gitBranch: colourValue.describe("The colour of the branch or bookmark and its ahead, behind and dirty markers."),
    activity: colourValue.describe("The colour of the names of the tools, skills and MCP servers the tools, skills and mcp rows draw. Their running markers take colours.warning and their finished markers colours.context."),
    agent: colourValue.describe("The colour of an agent's type in the agents row."),
    custom: colourValue.describe("The colour of the custom line."),
  },
  project: {
    pathLevels: z.enum(STATUSLINE_PATH_LEVELS).describe("How many trailing directories of the working directory the project segment shows: 1, 2 or 3, or full for the whole absolute path."),
    addedDirsLayout: z.enum(["inline", "row"]).describe("Where the directories added to the session are drawn: inline, as +name after the project path in the project segment, or row, as an Added dirs line when layout.rows lists addedDirs."),
  },
  git: {
    enabled: z.boolean().describe("Whether the vcs segment and the gitFiles row read the working directory's git status."),
    showDirty: z.boolean().describe("Whether the branch is followed by * when the working tree has uncommitted changes."),
    showAheadBehind: z.boolean().describe("Whether the branch is followed by the commits ahead of (up-arrow) and behind (down-arrow) its upstream."),
    showLineDiff: z.boolean().describe("Whether the segment shows the total lines added and removed against HEAD, as [+a -d]."),
    branchOverflow: z.enum(["truncate", "wrap"]).describe("How the vcs segment sits beside the project segment when they are listed next to each other: truncate keeps them as one unit the client cuts off at the terminal's edge, and wrap lets the line break between them."),
    pushWarnAt: z.number().int().min(0).describe("The count of unpushed commits at which the ahead marker takes colours.warning; 0 turns it off."),
    pushCriticalAt: z.number().int().min(0).describe("The count of unpushed commits at which the ahead marker takes colours.critical; 0 turns it off."),
  },
  jj: {
    enabled: z.boolean().describe("Whether the vcs segment reads a Jujutsu repository's status, instead of git's, when the working directory is inside one."),
    showDirty: z.boolean().describe("Whether the bookmark or change id is followed by * when the working-copy commit differs from its parent."),
    showConflicts: z.boolean().describe("Whether the segment shows !conflict when the working-copy commit has an unresolved conflict."),
  },
};

/** What a layer writes to return an optional setting to unset even though a shallower layer sets it. Merging a layer drops the key, so what the layers above see is the setting absent, as if no layer had set it. */
const UNSET_NOTE = "A layer may write null to return it to unset when a shallower layer sets it.";

/** An optional setting as a layer may write it: the value, or null to unset it for the layers it is merged over. The resolved settings never hold null, since merging removes it. */
function unsettable<T extends z.ZodType>(setting: z.ZodOptional<T>) {
  return setting.unwrap().nullable().optional().describe(`${setting.description ?? ""} ${UNSET_NOTE}`);
}

const LANGUAGE_DESCRIPTION = "The language of the words the statusline writes (labels, units of waiting such as `ago`, the names of effort levels): en, zh-Hans for Chinese in simplified characters, and zh-Hant for traditional; zh and zh-TW are read as zh-Hans and zh-Hant, and any other tag is refused. Durations, token counts, the dollar sign and clock times are written the same in every language, and a clock time follows the system locale and the clock settings.";

/** The tags a layer may write for a language: the canonical ones, and the two shorter ones claude-hud also accepts, which mean Chinese in simplified and in traditional characters. */
const LANGUAGE_TAGS = [...STATUSLINE_LANGUAGES, "zh", "zh-TW"] as const;

/** The canonical tag each of the shorter ones means. */
const LANGUAGE_ALIASES = { zh: "zh-Hans", "zh-TW": "zh-Hant" } as const;

function canonicalLanguage(tag: (typeof LANGUAGE_TAGS)[number]): (typeof STATUSLINE_LANGUAGES)[number] {
  return tag === "zh" || tag === "zh-TW" ? LANGUAGE_ALIASES[tag] : tag;
}

/** The settings that are not part of a group. A layer's `language` is read in any of its tags and kept as the canonical one, so everything after the schema sees one value. */
const TOP_LEVEL = {
  language: z.enum(STATUSLINE_LANGUAGES).describe(LANGUAGE_DESCRIPTION),
  preset: z.enum(STATUSLINE_PRESETS).describe("A named bundle of settings (layout.header, layout.rows, git.enabled, git.showDirty, git.showAheadBehind, git.showLineDiff, jj.enabled, jj.showDirty, jj.showConflicts, usage.resetLabel and context.breakdown) that this layer sets beneath the keys it names itself and above everything the shallower layers set: standard is the statusline's own default, everything claude-hud's default configuration draws plus agent-shim's own segments; full, essential and minimal are claude-hud's presets. Each draws the model, project and version control segments, the extra segment once extra.command is set, and the context row; standard adds the provider, route, account, identity and headroom segments and the quota and added directories rows, with the reset label and the token breakdown at high use, full adds the effort, advisor, version, output style, cost, session name and duration segments and the quota, added directories, memory, environment, tools, skills, mcp, agents, todos, prompt cache, compactions and session tokens rows, with the token breakdown at high use, essential adds the duration, the added directories row and the tools, agents and todos rows, and minimal adds the added directories row alone."),
};

/** What a configuration layer may set: every group and every key optional, so a layer names only what it changes. */
export const StatuslineSchema = z.strictObject({
  language: z.enum(LANGUAGE_TAGS).transform(canonicalLanguage).describe(LANGUAGE_DESCRIPTION).optional(),
  preset: TOP_LEVEL.preset.optional(),
  layout: z.strictObject(SHAPES.layout).partial().optional(),
  model: z.strictObject(SHAPES.model).partial().optional(),
  provider: z.strictObject(SHAPES.provider).partial().optional(),
  account: z.strictObject(SHAPES.account).partial().optional(),
  effort: z.strictObject(SHAPES.effort).partial().optional(),
  advisor: z.strictObject(SHAPES.advisor).partial().optional(),
  context: z
    .strictObject({ ...SHAPES.context, warnAt: unsettable(SHAPES.context.warnAt), criticalAt: unsettable(SHAPES.context.criticalAt), autoCompactWindow: unsettable(SHAPES.context.autoCompactWindow) })
    .partial()
    .optional(),
  customLine: z.strictObject(SHAPES.customLine).partial().optional(),
  extra: z.strictObject(SHAPES.extra).partial().optional(),
  bands: z.strictObject(SHAPES.bands).partial().optional(),
  labels: z.strictObject(SHAPES.labels).partial().optional(),
  bar: z.strictObject(SHAPES.bar).partial().optional(),
  usage: z.strictObject(SHAPES.usage).partial().optional(),
  clock: z.strictObject(SHAPES.clock).partial().optional(),
  cost: z.strictObject(SHAPES.cost).partial().optional(),
  environment: z.strictObject(SHAPES.environment).partial().optional(),
  sessionTime: z.strictObject(SHAPES.sessionTime).partial().optional(),
  promptCache: z.strictObject(SHAPES.promptCache).partial().optional(),
  tools: z.strictObject(SHAPES.tools).partial().optional(),
  colours: z.strictObject(SHAPES.colours).partial().optional(),
  project: z.strictObject(SHAPES.project).partial().optional(),
  git: z.strictObject(SHAPES.git).partial().optional(),
  jj: z.strictObject(SHAPES.jj).partial().optional(),
});
export type StatuslineSettings = z.infer<typeof StatuslineSchema>;

/** The statusline with every setting decided, except the optional ones (`context.warnAt`, `context.criticalAt` and `context.autoCompactWindow`), which stay absent until a layer sets them. */
export const ResolvedStatuslineSchema = z.strictObject({
  language: TOP_LEVEL.language,
  preset: TOP_LEVEL.preset,
  layout: z.strictObject(SHAPES.layout),
  model: z.strictObject(SHAPES.model),
  provider: z.strictObject(SHAPES.provider),
  account: z.strictObject(SHAPES.account),
  effort: z.strictObject(SHAPES.effort),
  advisor: z.strictObject(SHAPES.advisor),
  context: z.strictObject(SHAPES.context),
  customLine: z.strictObject(SHAPES.customLine),
  extra: z.strictObject(SHAPES.extra),
  bands: z.strictObject(SHAPES.bands),
  labels: z.strictObject(SHAPES.labels),
  bar: z.strictObject(SHAPES.bar),
  usage: z.strictObject(SHAPES.usage),
  clock: z.strictObject(SHAPES.clock),
  cost: z.strictObject(SHAPES.cost),
  environment: z.strictObject(SHAPES.environment),
  sessionTime: z.strictObject(SHAPES.sessionTime),
  promptCache: z.strictObject(SHAPES.promptCache),
  tools: z.strictObject(SHAPES.tools),
  colours: z.strictObject(SHAPES.colours),
  project: z.strictObject(SHAPES.project),
  git: z.strictObject(SHAPES.git),
  jj: z.strictObject(SHAPES.jj),
});
export type ResolvedStatusline = z.infer<typeof ResolvedStatuslineSchema>;

/** What the statusline draws when no layer sets a key. */
export const STATUSLINE_DEFAULTS: ResolvedStatusline = {
  language: "en",
  preset: "standard",
  layout: { header: [...DEFAULT_HEADER_SEGMENTS], rows: [...DEFAULT_ROWS], mode: "expanded", rule: "none", mergeBars: true, merge: [], rightAlign: [], maxWidth: 0, forceMaxWidth: false },
  model: { format: "full", override: "", source: "client", platform: CLAUDE_HUD_DEFAULTS.model.platform },
  provider: { name: "" },
  account: { parts: ["user", "organisation", "plan"], userLength: 0 },
  effort: { format: "full" },
  advisor: { override: "" },
  context: { bar: "shown", value: "both", estimate: CLAUDE_HUD_DEFAULTS.context.estimate, breakdown: CLAUDE_HUD_DEFAULTS.context.breakdown },
  customLine: { text: "", position: "last" },
  extra: { command: [] },
  bands: { warnAt: 70, criticalAt: 90 },
  labels: { fiveHour: "", sevenDay: "" },
  bar: { width: 10, filled: "\u2588", empty: "\u2591" },
  usage: { value: "used", bar: true, compact: false, resetLabel: CLAUDE_HUD_DEFAULTS.usage.resetLabel, modelScoped: CLAUDE_HUD_DEFAULTS.usage.modelScoped, timeFormat: "relative", threshold: 0, sevenDayThreshold: CLAUDE_HUD_DEFAULTS.usage.sevenDayThreshold },
  clock: { hourCycle: "auto", seconds: false },
  cost: { routed: false },
  environment: { threshold: 0 },
  sessionTime: { parts: [...STATUSLINE_SESSION_TIME_PARTS] },
  promptCache: { ttlSeconds: PROMPT_CACHE_TTL_SECONDS.fiveMinutes },
  tools: { nameMaxLength: 0, maxVisible: 4 },
  colours: {
    context: "green",
    usage: "green",
    warning: "yellow",
    usageWarning: "yellow",
    critical: "red",
    model: "default",
    label: "default",
    empty: "brightBlack",
    project: "yellow",
    git: "magenta",
    gitBranch: "cyan",
    activity: "cyan",
    agent: "magenta",
    custom: ORANGE_PALETTE_INDEX,
  },
  project: { pathLevels: "1", addedDirsLayout: "inline" },
  git: { enabled: true, showDirty: true, showAheadBehind: false, showLineDiff: false, branchOverflow: "truncate", pushWarnAt: 0, pushCriticalAt: 0 },
  jj: { enabled: false, showDirty: true, showConflicts: true },
};

/** A plain JSON object, narrowed so its keys can be read without an assertion. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `over` laid on `base`, key by key: objects merge, anything else (a scalar, a list) in `over` replaces what `base` has, and a null in `over` removes the key, which is how a layer unsets an optional setting a shallower layer set. The result holds no null, whatever `base` was. Neither argument is changed. */
function mergeKeys(base: unknown, over: unknown): unknown {
  if (!isPlainObject(over)) {
    return over === undefined ? base : over;
  }
  const merged: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(over)) {
    if (value === null) {
      Reflect.deleteProperty(merged, key);
    } else {
      merged[key] = mergeKeys(merged[key], value);
    }
  }
  return merged;
}

/** The colour bands of the context bar: its own thresholds where the settings give them, `bands` while it leaves one unset. */
export function contextBands({ bands, context }: Readonly<ResolvedStatusline>): { readonly warnAt: number; readonly criticalAt: number } {
  return { warnAt: context.warnAt ?? bands.warnAt, criticalAt: context.criticalAt ?? bands.criticalAt };
}

function isPresetName(value: unknown): value is (typeof STATUSLINE_PRESETS)[number] {
  return STATUSLINE_PRESETS.some((name) => name === value);
}

/**
 * `over` laid on `base`, key by key: objects merge, and anything else (a scalar, a list) in `over` replaces what `base` has. A null in `over` removes the key it names, which is how a layer unsets an optional setting. A `preset` in `over` first lays its bundle on `base`, so the layer's own keys sit above the preset and the preset above every shallower layer; the result keeps the preset's name and the keys it set, which makes laying it again on the defaults change nothing. Neither argument is changed.
 */
export function mergeStatuslineSettings(base: unknown, over: unknown): unknown {
  const preset = isPlainObject(over) ? over.preset : undefined;
  return mergeKeys(isPresetName(preset) ? mergeKeys(base, PRESET_BUNDLES[preset]) : base, over);
}

/** The statusline's settings with the defaults filled in, or a message naming what is wrong when the combination is not drawable (a warning threshold must sit below its critical one, a right-aligned row must be in a merge group, and a forced width needs a width to force, which a per-key cascade cannot check layer by layer). */
export function resolveStatusline(settings: Readonly<StatuslineSettings> | undefined): ResolvedStatusline {
  const resolved = ResolvedStatuslineSchema.parse(mergeStatuslineSettings(STATUSLINE_DEFAULTS, settings));
  if (resolved.bands.warnAt >= resolved.bands.criticalAt) {
    throw new RangeError(`statusline bands.warnAt (${String(resolved.bands.warnAt)}) must be below bands.criticalAt (${String(resolved.bands.criticalAt)})`);
  }
  const forContext = contextBands(resolved);
  if (forContext.warnAt >= forContext.criticalAt) {
    throw new RangeError(`statusline context.warnAt (${String(forContext.warnAt)}) must be below context.criticalAt (${String(forContext.criticalAt)}), each following bands while it is unset`);
  }
  const merged = new Set(resolved.layout.merge.flat());
  const unmerged = resolved.layout.rightAlign.filter((row) => !merged.has(row));
  if (unmerged.length > 0) {
    throw new RangeError(`statusline layout.rightAlign names ${unmerged.join(", ")}, which no group in layout.merge contains`);
  }
  if (resolved.layout.forceMaxWidth && resolved.layout.maxWidth === 0) {
    throw new RangeError("statusline layout.forceMaxWidth needs layout.maxWidth to be set");
  }
  return resolved;
}

/** The environment variable that carries a launch's statusline settings (a JSON object of `StatuslineSchema`) to the statusline command the launched session runs. */
export const STATUSLINE_ENV = "AGENT_SHIM_STATUSLINE";

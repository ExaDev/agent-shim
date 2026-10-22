import { describe, expect, it } from "vitest";

import { resolveStatusline, STATUSLINE_DEFAULTS, type ResolvedStatusline, type StatuslineSettings, type STATUSLINE_HEADER_SEGMENTS, type STATUSLINE_ROWS } from "../../config/statusline";
import { ESCAPE } from "../ansi";
import { parseClientPayload, viewOf } from "../payload";
import { renderStatuslineBlock } from "../render";
import { fakeStatuslinePorts, fakeStatuslineSummary } from "../testing";
import { inventoryKeys } from "./map";

/** claude-hud's default share of the weekly window from which it draws that window (`display.sevenDayThreshold` in its `DEFAULT_CONFIG`, `src/config.ts`, at the commit `inventory.ts` names), recorded here apart from the statusline's own constant so that a change to the default is checked against claude-hud rather than against itself. */
const CLAUDE_HUD_SEVEN_DAY_THRESHOLD = 80;

/**
 * Every element stock claude-hud draws under its own default configuration (its `DEFAULT_CONFIG` and `DEFAULT_ELEMENT_ORDER`, at the commit `inventory.ts` names), keyed as the parity map keys it, with the header segment or row that draws it here. The added directories ride on the project segment while they are inline, as claude-hud's default draws them, and the row is listed for its other layout.
 */
const CLAUDE_HUD_DEFAULT_ELEMENTS: readonly { readonly key: string; readonly header?: (typeof STATUSLINE_HEADER_SEGMENTS)[number]; readonly row?: (typeof STATUSLINE_ROWS)[number] }[] = [
  { key: "segment:model", header: "model" },
  { key: "display.showModel", header: "model" },
  { key: "segment:project", header: "project" },
  { key: "element:project", header: "project" },
  { key: "display.showProject", header: "project" },
  { key: "display.showAddedDirs", header: "project" },
  { key: "element:addedDirs", row: "addedDirs" },
  { key: "gitStatus.enabled", header: "vcs" },
  { key: "segment:extra", header: "extra" },
  { key: "flag:--extra-cmd", header: "extra" },
  { key: "element:context", row: "context" },
  { key: "display.showContextBar", row: "context" },
  { key: "element:usage", row: "quota" },
  { key: "display.showUsage", row: "quota" },
];

/** Every default option of claude-hud's that decides how much an element shows, with what the statusline's settings must hold to show at least as much. */
const CLAUDE_HUD_DEFAULT_OPTIONS: readonly { readonly key: string; readonly showsAsMuch: (settings: ResolvedStatusline) => boolean }[] = [
  { key: "display.showResetLabel", showsAsMuch: (settings) => settings.usage.resetLabel },
  { key: "display.showModelScopedUsage", showsAsMuch: (settings) => settings.usage.modelScoped },
  { key: "display.sevenDayThreshold", showsAsMuch: (settings) => settings.usage.sevenDayThreshold <= CLAUDE_HUD_SEVEN_DAY_THRESHOLD },
  { key: "display.usageThreshold", showsAsMuch: (settings) => settings.usage.threshold === 0 },
  { key: "display.usageBarEnabled", showsAsMuch: (settings) => settings.usage.bar && !settings.usage.compact },
  { key: "display.usageValue", showsAsMuch: (settings) => settings.usage.value === "used" },
  { key: "display.showTokenBreakdown", showsAsMuch: (settings) => settings.context.breakdown === "critical" },
  { key: "display.autocompactBuffer", showsAsMuch: (settings) => settings.context.estimate === "buffered" },
  { key: "display.contextValue", showsAsMuch: (settings) => settings.context.value === "both" || settings.context.value === "percent" },
  { key: "display.addedDirsLayout", showsAsMuch: (settings) => settings.project.addedDirsLayout === "inline" },
  { key: "gitStatus.showDirty", showsAsMuch: (settings) => settings.git.enabled && settings.git.showDirty },
  // claude-hud's model segment ends with the platform it detects (Bedrock, Vertex, MiniMax, Enterprise) under every configuration, so its default draws it too.
  { key: "segment:model", showsAsMuch: (settings) => settings.model.platform },
];

const DEFAULTS_BY_ROUTE: readonly (readonly [string, ResolvedStatusline])[] = [
  ["the defaults", STATUSLINE_DEFAULTS],
  ["no settings", resolveStatusline(undefined)],
  ["preset: standard", resolveStatusline({ preset: "standard" })],
];

describe("the default statusline as a superset of claude-hud's default", () => {
  it("names only keys claude-hud's inventory holds", () => {
    const held = new Set(inventoryKeys());
    expect([...CLAUDE_HUD_DEFAULT_ELEMENTS, ...CLAUDE_HUD_DEFAULT_OPTIONS].map(({ key }) => key).filter((key) => !held.has(key))).toEqual([]);
  });

  it.each(DEFAULTS_BY_ROUTE)("draws every element claude-hud's default draws, under %s", (_route, settings) => {
    const missing = CLAUDE_HUD_DEFAULT_ELEMENTS.filter(({ header, row }) => (header !== undefined && !settings.layout.header.includes(header)) || (row !== undefined && !settings.layout.rows.includes(row))).map(({ key }) => key);
    expect(missing).toEqual([]);
  });

  it.each(DEFAULTS_BY_ROUTE)("shows at least as much as claude-hud's default options do, under %s", (_route, settings) => {
    expect(CLAUDE_HUD_DEFAULT_OPTIONS.filter(({ showsAsMuch }) => !showsAsMuch(settings)).map(({ key }) => key)).toEqual([]);
  });

  it.each(DEFAULTS_BY_ROUTE)("keeps agent-shim's own segments after the model, project and version control, under %s", (_route, settings) => {
    expect(settings.layout.header).toEqual(["model", "project", "vcs", "provider", "route", "account", "identity", "headroom", "extra"]);
  });
});

describe("the default render of a stand-in session", () => {
  const NOW_MS = Date.parse("2026-10-21T12:00:00.000Z");
  const WIDE_TERMINAL = 200;
  const NUL = "\0";
  const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
  const STATUS = ["# branch.oid 0123", "# branch.head main", "1 .M N... 100644 100644 100644 aaaa bbbb dirty.ts"].map((field) => `${field}${NUL}`).join("");
  const SESSION = {
    cwd: "/work/demo-project",
    workspace: { added_dirs: ["/work/extra-dir"] },
    model: { id: "claude-opus-4-5", display_name: "Opus 4.5" },
    context_window: { used_percentage: 92, context_window_size: 200_000, current_usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 177_800 } },
    rate_limits: { model_scoped: [{ display_name: "Opus", utilization: 37, resets_at: "2026-10-23T12:00:00.000Z" }] },
  };
  const QUOTA = { fiveHourUsed: 42, fiveHourResetAt: "2026-10-21T13:30:00.000Z", sevenDayUsed: 85, sevenDayResetAt: "2026-10-24T14:00:00.000Z" };

  function draw(payloadFields: Readonly<Record<string, unknown>>, env: Readonly<Record<string, string>> = {}): string {
    const payload = parseClientPayload(payloadFields);
    const run = (file: string, args: readonly string[]): string | undefined => (file === "git" && args.includes("status") ? STATUS : undefined);
    return renderStatuslineBlock({ summary: fakeStatuslineSummary(QUOTA), view: viewOf(payload), payload, terminalWidth: WIDE_TERMINAL, nowMs: NOW_MS, ports: fakeStatuslinePorts({ env: { NO_COLOR: "1", ...env }, run }) }).replace(ANSI, "");
  }

  it("draws each piece claude-hud's default draws for the same session", () => {
    const drawn = draw(SESSION);
    // claude-hud: `[Opus 4.5] │ demo-project +extra-dir git:(main*)`, `Context ... 92% (in: 1k, cache: 183k)`, `Usage ... 42% (resets in 1h 30m) | Weekly ... 85% (resets in 3d 2h)` and `Opus ... 37% (resets in 2d)`.
    for (const piece of ["Opus 4.5", "demo-project +extra-dir git:(main*)", "92.0%", "(in: 1.2k, cache: 183k)", "42.0% (resets in 1h 30m)", "85.0% (resets in 3d 2h)", "Opus [", "37.0% (resets in 2d 0h)"]) {
      expect(drawn, piece).toContain(piece);
    }
  });

  it("ends the model with the platform label claude-hud's default draws beside it", () => {
    // claude-hud: `[Opus 4.5 | Vertex]` under CLAUDE_CODE_USE_VERTEX=1, `[Opus 4.5 | Bedrock]` under CLAUDE_CODE_USE_BEDROCK=1.
    expect(draw(SESSION, { CLAUDE_CODE_USE_VERTEX: "1" })).toContain("Opus 4.5 | Vertex");
    expect(draw(SESSION, { CLAUDE_CODE_USE_BEDROCK: "1" })).toContain("Opus 4.5 | Bedrock");
    expect(draw(SESSION)).not.toMatch(/Opus 4\.5 \| (Bedrock|Vertex|MiniMax|Enterprise)/);
  });

  it("estimates the context with the compaction reserve when the client reports no percentage, as claude-hud's default does", () => {
    const drawn = draw({ ...SESSION, context_window: { context_window_size: SESSION.context_window.context_window_size, current_usage: SESSION.context_window.current_usage, total_input_tokens: 90_000 } });
    // claude-hud draws `Context ... 60%` here: the tokens held over the window with the reserve added in part.
    expect(drawn).toContain("59.7%");
  });
});

describe("the documented restore of the default before it became a superset", () => {
  const NOW_MS = Date.parse("2026-10-21T12:00:00.000Z");
  const WIDE_TERMINAL = 200;
  const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");
  /** The settings `docs/statusline-claude-hud-parity.md` and `docs/configuration-model.md` give for drawing what the default drew before. */
  const RESTORE: StatuslineSettings = {
    layout: { header: ["model", "provider", "route", "account", "identity", "headroom"], rows: ["context", "quota"] },
    usage: { resetLabel: false, modelScoped: false, sevenDayThreshold: 0 },
    model: { platform: false },
    context: { estimate: "never", breakdown: "never" },
  };
  const SESSION = {
    cwd: "/work/demo-project",
    workspace: { added_dirs: ["/work/extra-dir"] },
    model: { id: "claude-opus-4-5", display_name: "Opus 4.5" },
    context_window: { used_percentage: 92, context_window_size: 200_000, current_usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 177_800 } },
    rate_limits: { model_scoped: [{ display_name: "Opus", utilization: 37, resets_at: "2026-10-23T12:00:00.000Z" }] },
  };
  /** A weekly use above claude-hud's weekly threshold and one below it, which the default before drew alike. */
  const WEEKLY_HIGH = 85;
  const WEEKLY_LOW = 30;
  /** What the default drew for `SESSION` before it became a superset, as the statusline rendered it before that change, with the weekly use at `WEEKLY_HIGH` and at `WEEKLY_LOW`. */
  const BEFORE = {
    weeklyHigh: "Opus 4.5\nCtx [███████████████████████████████████████░░░] 92.0% (Cache: 99%) | 5h [██████████████████░░░░░░░░░░░░░░░░░░░░░░░░] 42.0% (1h 30m) | Wk [████████████████████████████████████░░░░░░] 85.0% (3d 2h)",
    weeklyLow: "Opus 4.5\nCtx [███████████████████████████████████████░░░] 92.0% (Cache: 99%) | 5h [██████████████████░░░░░░░░░░░░░░░░░░░░░░░░] 42.0% (1h 30m) | Wk [█████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 30.0% (3d 2h)",
  };
  const QUOTA = { fiveHourUsed: 42, fiveHourResetAt: "2026-10-21T13:30:00.000Z", sevenDayResetAt: "2026-10-24T14:00:00.000Z" };

  function draw(payloadFields: Readonly<Record<string, unknown>>, sevenDayUsed: number, env: Readonly<Record<string, string>> = {}): string {
    const payload = parseClientPayload(payloadFields);
    return renderStatuslineBlock({ summary: fakeStatuslineSummary({ ...QUOTA, sevenDayUsed }), view: viewOf(payload), payload, terminalWidth: WIDE_TERMINAL, nowMs: NOW_MS, settings: resolveStatusline(RESTORE), ports: fakeStatuslinePorts({ env: { NO_COLOR: "1", ...env } }) }).replace(ANSI, "");
  }

  it("draws what the default drew before for a session that is not a Bedrock one and has an unpadded display name, whatever the weekly use", () => {
    expect(draw(SESSION, WEEKLY_HIGH)).toBe(BEFORE.weeklyHigh);
    expect(draw(SESSION, WEEKLY_LOW)).toBe(BEFORE.weeklyLow);
    expect(draw(SESSION, WEEKLY_HIGH, { CLAUDE_CODE_USE_VERTEX: "1" })).toBe(BEFORE.weeklyHigh);
  });

  it("still draws no subscription window for a Bedrock session that selected no provider, which the restore does not undo", () => {
    // The default before drew the five-hour and weekly windows here; they do not apply to a Bedrock session whatever the settings say.
    for (const drawn of [draw(SESSION, WEEKLY_HIGH, { CLAUDE_CODE_USE_BEDROCK: "1" }), draw({ ...SESSION, model: { id: "us.anthropic.claude-opus-4-5-20251101-v1:0", display_name: "Opus 4.5" } }, WEEKLY_HIGH)]) {
      expect(drawn).toMatch(/^Opus 4\.5\nCtx \[[\u2588\u2591]+\] 92\.0% \(Cache: 99%\)$/u);
    }
  });

  it("names the model by its id when the client sends no display name or a blank one, where the default before drew no model for the first", () => {
    expect(draw({ ...SESSION, model: { id: "claude-opus-4-5" } }, WEEKLY_HIGH)).toBe(BEFORE.weeklyHigh.replace("Opus 4.5", "claude-opus-4-5"));
  });

  it("draws a display name padded with white space without its padding and treats a blank one as absent, which the restore does not undo", () => {
    // The default before drew the padding as sent and the blank text as sent for a blank name.
    expect(draw({ ...SESSION, model: { id: "claude-opus-4-5", display_name: "  Opus 4.5  " } }, WEEKLY_HIGH)).toBe(BEFORE.weeklyHigh);
    expect(draw({ ...SESSION, model: { id: "claude-opus-4-5", display_name: "   " } }, WEEKLY_HIGH)).toBe(BEFORE.weeklyHigh.replace("Opus 4.5", "claude-opus-4-5"));
    expect(draw({ ...SESSION, model: { display_name: "   " } }, WEEKLY_HIGH).startsWith("Ctx ")).toBe(true);
  });
});

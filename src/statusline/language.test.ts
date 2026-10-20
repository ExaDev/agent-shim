import { describe, expect, it } from "vitest";

import { resolveStatusline, STATUSLINE_ROWS, type StatuslineSettings } from "../config/statusline";
import { ESCAPE } from "./ansi";
import type { StatuslineSummary } from "./enrich";
import { CATALOGUES } from "./messages/catalogues";
import { STATUSLINE_LANGUAGES, type StatuslineLanguage } from "./messages/languages";
import { parseClientPayload, viewOf } from "./payload";
import { renderStatuslineBlock } from "./render";
import { fakeStatuslineFilesystem, fakeStatuslinePorts, fakeStatuslineSummary, type FakeStatuslineFilesystem } from "./testing";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const HOUR = 3_600_000;
const WIDE_TERMINAL = 300;
const TRANSCRIPT = "/sessions/one.jsonl";
const SEVENTH_DIR = 7;
const FOUR_AFTER_START = 240_000;
const THIRTY_SECONDS = 30_000;
const FIVE_HOUR_USED = 25;
const SEVEN_DAY_USED = 40;
const FRACTION_USED = 63.4;
const CONTEXT_TOKENS = 634_000;
const CONTEXT_WINDOW = 1_000_000;
const CACHE_HIT = 0.9;
const COST_USD = 1.25;
const OUTPUT_TOKENS_A = 100;
const EIGHT_GIB = 8_589_934_592;
const SIXTEEN_GIB = 17_179_869_184;
const TEN_AFTER_START = 600_000;
const THREE_DAYS = 259_200_000;
const HOUR_AND_HALF = 5_400_000;

const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*[a-zA-Z]`, "g");
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

/** A session that started at `T0`, was named, answered with an advisor's help, was compacted and wrote to the five-minute cache. */
const SESSION =
  line({ type: "user", timestamp: at(0), slug: "generated-name" }) +
  line({ type: "assistant", timestamp: at(THIRTY_SECONDS), requestId: "r1", advisorModel: "claude-opus-4-7", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 } } } }) +
  line({ type: "system", subtype: "compact_boundary", timestamp: at(2 * THIRTY_SECONDS) }) +
  line({ type: "custom-title", customTitle: "renamed" });

const FILES: Readonly<Record<string, string>> = {
  [TRANSCRIPT]: SESSION,
  "/home/test/.claude/settings.json": JSON.stringify({ outputStyle: "concise", hooks: { PreToolUse: [], Stop: [] } }),
  "/home/test/.claude/CLAUDE.md": "",
  "/home/test/.claude/rules/a.md": "",
  "/home/test/.claude/rules/b.md": "",
  "/work/CLAUDE.md": "",
  "/work/.mcp.json": JSON.stringify({ mcpServers: { one: {} } }),
};

/** Everything the statusline can say in words, with each piece of data chosen so that none of it is itself an English word the catalogue holds. */
const SUMMARY: StatuslineSummary = {
  ...fakeStatuslineSummary(),
  routedTarget: "zeta/glm",
  headroom: { tokensSaved: 41_816, savingsPercent: 3.5, savingsUsd: 0.13 },
  fiveHourUsed: FIVE_HOUR_USED,
  fiveHourResetAt: at(HOUR_AND_HALF),
  sevenDayUsed: SEVEN_DAY_USED,
  sevenDayResetAt: at(-HOUR),
};

const EVERYTHING: StatuslineSettings = {
  layout: {
    header: ["model", "route", "headroom", "project", "effort", "advisor", "version", "outputStyle", "cost", "dailyCost", "sessionName", "duration", "speed"],
    rows: ["context", "quota", "addedDirs", "memory", "environment", "sessionTime", "promptCache", "compactions", "tokens"],
  },
  context: { warnAt: 50, criticalAt: 60, breakdown: "critical" },
  usage: { resetLabel: true, timeFormat: "both" },
  project: { addedDirsLayout: "row" },
};

interface Draw {
  readonly language: StatuslineLanguage;
  readonly settings?: StatuslineSettings;
  readonly nowMs?: number;
  readonly summary?: StatuslineSummary;
  readonly cost?: number;
  readonly outputTokens?: number;
  readonly disk?: FakeStatuslineFilesystem;
}

/** The statusline for the scene, in plain text, one string per line. */
function draw({ language, settings = EVERYTHING, nowMs = T0 + FOUR_AFTER_START, summary = SUMMARY, cost, outputTokens = OUTPUT_TOKENS_A, disk = fakeStatuslineFilesystem(FILES) }: Draw): string[] {
  const payload = parseClientPayload({
    transcript_path: TRANSCRIPT,
    session_id: "s1",
    cwd: "/work",
    model: { display_name: "Sonnet 5.5" },
    version: "2.1.0",
    effort: "high",
    workspace: { added_dirs: Array.from({ length: SEVENTH_DIR + 1 }, (_value, index) => `/extra/d${String(index)}`) },
    context_window: { used_percentage: FRACTION_USED, total_input_tokens: CONTEXT_TOKENS, context_window_size: CONTEXT_WINDOW, current_usage: { input_tokens: 12_000, output_tokens: outputTokens, cache_read_input_tokens: 40_000 } },
    prompt_cache: { hit_ratio: CACHE_HIT },
    ...(cost === undefined ? {} : { cost: { total_cost_usd: cost } }),
  });
  const text = renderStatuslineBlock({
    summary,
    view: viewOf(payload),
    payload,
    terminalWidth: WIDE_TERMINAL,
    nowMs,
    settings: resolveStatusline({ ...settings, language }),
    ports: fakeStatuslinePorts({ ...disk.ports, env: { NO_COLOR: "1" }, memoryUse: () => ({ usedBytes: EIGHT_GIB, totalBytes: SIXTEEN_GIB }), stateDirectory: "/state/test" }),
  });
  // The header is spread across the line, so its segments are compared apart from the spaces between them.
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((row, index) => (index === 0 ? row.split("|").map((segment) => segment.trim()).join(" | ") : row));
}

/** The words of the English catalogue that a Chinese rendering must not contain: those of three or more letters, less the ones a Chinese catalogue keeps itself (product names, `tok/s`, `CLAUDE.md`). */
function englishWordsAbsentFrom(language: StatuslineLanguage): string[] {
  const words = (text: string): string[] => text.replace(/\{\w+\}/g, " ").match(/[A-Za-z][A-Za-z.]{2,}/g) ?? [];
  const kept = new Set(Object.values(CATALOGUES[language]).flatMap(words));
  return [...new Set(Object.values(CATALOGUES.en).flatMap(words))].filter((word) => !kept.has(word));
}

describe("the statusline in English", () => {
  it("writes every word of a full statusline as it always has", () => {
    const disk = fakeStatuslineFilesystem(FILES);
    draw({ language: "en", cost: 1, disk });
    const lines = draw({ language: "en", cost: COST_USD, disk });
    expect(lines).toEqual([
      "Sonnet 5.5 | via zeta/glm | headroom 42k saved \u00b7 3.5% overall \u00b7 $0.13 | work | \u25d1 high | Advisor: Opus 4.7 | CC v2.1.0 | style: concise | Cost $1.25 | Today $0.250 | renamed | \u23f1\ufe0f  4m",
      expect.stringMatching(/^Ctx 634k\/1M \[.*\] 63\.4% \(Cache: 90%\) \(in: 12k, cache: 40k\) \| 5h \[.*\] 25\.0% \(resets in 1h 26m, at 11:30\) \| Wk \[.*\] 40\.0% \(available\)$/),
      "Added dirs: d0, d1, d2, d3, d4, +3 more",
      expect.stringMatching(/^RAM \[.*\] 50\.0% \(8\.0 GB \/ 16 GB\)$/),
      "2 CLAUDE.md | 2 rules | 1 MCP | 2 hooks",
      "Started: 10:00 \u2502 Last reply: 3m ago",
      "Cache \u23f1 until 10:05",
      "Compactions: 1",
      "Tokens 65 (in: 10, out: 20, cache: 35)",
    ]);
  });
});

describe.each(STATUSLINE_LANGUAGES.filter((language) => language !== "en"))("the statusline in %s", (language) => {
  it("writes none of English's words anywhere it writes words", () => {
    const scenes = [
      draw({ language, cost: COST_USD }),
      draw({ language, nowMs: T0 + TEN_AFTER_START }),
      draw({ language, settings: { ...EVERYTHING, usage: { timeFormat: "elapsed" } }, summary: { ...SUMMARY, doorCostUsd: COST_USD } }),
      draw({ language, settings: { ...EVERYTHING, usage: { timeFormat: "absolute", resetLabel: true } } }),
      draw({ language, nowMs: T0 + THREE_DAYS }),
    ];
    const text = scenes.flat().join("\n");
    const english = englishWordsAbsentFrom(language).filter((word) => new RegExp(`(?<![A-Za-z])${word.replace(".", "\\.")}(?![A-Za-z])`).test(text));
    expect(english).toEqual([]);
  });

  it("writes the words it has, from its own catalogue", () => {
    const text = draw({ language, cost: COST_USD }).join("\n");
    const messages = CATALOGUES[language];
    for (const expected of [messages["context.label"], messages["promptCache.label"], messages["memory.label"], messages["compactions.label"].replace("{count}", "1"), messages["addedDirs.label"], messages["sessionTime.started"], messages["environment.rules.other"].replace("{count}", "2")]) {
      expect(text, expected).toContain(expected);
    }
  });
});

describe("the window names", () => {
  const WINDOWS_ONLY: StatuslineSettings = { layout: { header: [], rows: ["quota"] } };

  it("follow the language until a setting names them", () => {
    expect(draw({ language: "en", settings: WINDOWS_ONLY })[0]).toMatch(/^5h .*Wk /);
    expect(draw({ language: "zh-Hans", settings: WINDOWS_ONLY })[0]).toMatch(/^5\u5C0F\u65F6 .*\u672C\u5468 /);
    expect(draw({ language: "zh-Hans", settings: { ...WINDOWS_ONLY, labels: { fiveHour: "S", sevenDay: "W" } } })[0]).toMatch(/^S .*W /);
  });
});

describe("the time of day", () => {
  it("is written by the clock settings and the system locale, whatever the language", () => {
    const rows: StatuslineSettings = { layout: { header: [], rows: ["sessionTime"] }, clock: { hourCycle: "h12" } };
    expect(draw({ language: "en", settings: rows })[0]).toContain("Started: 10:00 am");
    expect(draw({ language: "zh-Hans", settings: rows })[0]).toContain("\u5F00\u59CB\uFF1A 10:00 am");
  });

  it("keeps durations, token counts and money the same in every language", () => {
    const figures = (language: StatuslineLanguage): string[] => draw({ language, cost: COST_USD }).join("\n").match(/\$\d+\.\d+|\d+(?:\.\d+)?[kM]\/\d+[kM]|\d+h \d+m|\d+m/g) ?? [];
    expect(figures("zh-Hans")).toEqual(figures("en"));
    expect(figures("zh-Hant")).toEqual(figures("en"));
  });
});

describe("the rows the language setting reaches", () => {
  it("are all of them: a scene draws something on each row, so no row escapes the check above", () => {
    expect(EVERYTHING.layout?.rows).toEqual(expect.arrayContaining(STATUSLINE_ROWS.filter((row) => row !== "gitFiles")));
  });
});

describe("a detached head", () => {
  const DETACHED_ONLY: StatuslineSettings = { layout: { header: ["vcs"], rows: [] } };
  const NUL = "\0";

  function detached(language: StatuslineLanguage): string {
    const payload = parseClientPayload({ cwd: "/work" });
    const run = (_file: string, args: readonly string[]): string | undefined => {
      if (args.includes("status")) {
        return `# branch.oid 0123${NUL}# branch.head (detached)${NUL}`;
      }
      return args.includes("--short") ? "abc1234\n" : undefined;
    };
    return renderStatuslineBlock({ summary: SUMMARY, view: viewOf(payload), payload, terminalWidth: WIDE_TERMINAL, nowMs: T0, settings: resolveStatusline({ ...DETACHED_ONLY, language }), ports: fakeStatuslinePorts({ env: { NO_COLOR: "1" }, run }) });
  }

  it("is named by its commit in the language's words", () => {
    expect(detached("en")).toBe("git:(detached:abc1234)");
    expect(detached("zh-Hans")).toBe("git:(\u5206\u79bb\u4e8e abc1234)");
    expect(detached("zh-Hant")).toBe("git:(\u5206\u96e2\u65bc abc1234)");
  });
});

describe("the reset of a quota window", () => {
  const RESETS: StatuslineSettings = { layout: { header: [], rows: ["quota"] }, usage: { bar: false } };
  const row = (language: StatuslineLanguage, usage: Readonly<NonNullable<StatuslineSettings["usage"]>>): string => draw({ language, settings: { ...RESETS, usage: { ...RESETS.usage, ...usage } }, summary: { ...SUMMARY, sevenDayUsed: undefined } })[0] ?? "";

  it("says that a wall-clock time is the reset, with the label and without it, in every language", () => {
    expect(row("en", { timeFormat: "absolute" })).toBe("5h 25.0% (at 11:30)");
    expect(row("en", { timeFormat: "absolute", resetLabel: true })).toBe("5h 25.0% (resets at 11:30)");
    expect(row("zh-Hans", { timeFormat: "absolute" })).toBe("5\u5c0f\u65f6 25.0% (11:30 \u91cd\u7f6e)");
    expect(row("zh-Hans", { timeFormat: "absolute", resetLabel: true })).toBe("5\u5c0f\u65f6 25.0% (\u91cd\u7f6e\u4e8e 11:30)");
    expect(row("zh-Hant", { timeFormat: "absolute" })).toBe("5\u5c0f\u6642 25.0% (11:30 \u91cd\u8a2d)");
  });

  it("keeps the meaning of a reset when the share elapsed and the time are told together", () => {
    expect(row("en", { timeFormat: "elapsedAndAbsolute" })).toBe("5h 25.0% (71% elapsed, at 11:30)");
    expect(row("zh-Hans", { timeFormat: "elapsedAndAbsolute" })).toBe("5\u5c0f\u65f6 25.0% (\u5df2\u8fc7 71%\uff0c11:30 \u91cd\u7f6e)");
  });

  it("tells the time left and the time of day together, introduced when the label asks", () => {
    expect(row("en", { timeFormat: "both", resetLabel: true })).toBe("5h 25.0% (resets in 1h 26m, at 11:30)");
    expect(row("zh-Hans", { timeFormat: "both", resetLabel: true })).toBe("5\u5c0f\u65f6 25.0% (\u8ddd\u91cd\u7f6e 1h 26m\uff0c\u4e8e 11:30)");
    expect(row("zh-Hans", { timeFormat: "both" })).toBe("5\u5c0f\u65f6 25.0% (1h 26m\uff0c11:30 \u91cd\u7f6e)");
  });
});

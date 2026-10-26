import { describe, expect, it } from "vitest";

import { MAX_DISPLAY_TEXT_CHARS, MIN_STATUSLINE_COLUMNS, resolveStatusline, STATUSLINE_PRESETS, type StatuslineSettings } from "../config/statusline";
import { ESCAPE } from "./ansi";
import { parseClientPayload, viewOf } from "./payload";
import { RESERVED_COLUMNS, renderStatuslineBlock } from "./render";
import { fakeStatuslinePorts, fakeStatuslineSummary } from "./testing";
import { RUN_MAX_OUTPUT_BYTES, type StatuslinePorts } from "./ports";

const WIDE_TERMINAL = 120;
/** A terminal whose width less the columns the client keeps back is exactly the fewest columns a line is drawn in. */
const NARROW_TERMINAL = MIN_STATUSLINE_COLUMNS + RESERVED_COLUMNS;
const ORANGE_INDEX = "38;5;208";
const PROJECT_DIR = "/work/app";

interface Scene {
  readonly settings?: StatuslineSettings;
  readonly payload?: unknown;
  readonly run?: StatuslinePorts["run"];
  readonly terminalWidth?: number;
  readonly colour?: boolean;
}

/** The statusline for a scene; plain text unless the scene asks for colour. */
function draw(scene: Scene): string {
  const payload = parseClientPayload(scene.payload ?? {});
  return renderStatuslineBlock({
    summary: fakeStatuslineSummary(),
    view: viewOf(payload),
    payload,
    terminalWidth: scene.terminalWidth ?? WIDE_TERMINAL,
    nowMs: 0,
    settings: resolveStatusline(scene.settings),
    ports: fakeStatuslinePorts({ env: scene.colour === true ? {} : { NO_COLOR: "1" }, ...(scene.run === undefined ? {} : { run: scene.run }) }),
  });
}

const MODEL_ONLY: StatuslineSettings = { layout: { header: ["model"], rows: [] } };
const MODEL = { model: { id: "m", display_name: "Opus 5.5" } };

describe("the custom line", () => {
  it("draws nothing by default, and nothing for text that is empty or shows nothing", () => {
    expect(draw({ payload: MODEL })).not.toContain("hello");
    for (const text of ["", "\u2800\u3164"]) {
      expect(draw({ payload: MODEL, settings: { ...MODEL_ONLY, customLine: { text } } }), JSON.stringify(text)).toBe("Opus 5.5");
    }
  });

  it("draws below the last row by default, and above the header when its position is first", () => {
    const text = "deploy: prod";
    expect(draw({ payload: MODEL, settings: { ...MODEL_ONLY, customLine: { text } } }).split("\n")).toEqual(["Opus 5.5", text]);
    expect(draw({ payload: MODEL, settings: { ...MODEL_ONLY, customLine: { text, position: "first" } } }).split("\n")).toEqual([text, "Opus 5.5"]);
  });

  it("keeps to a line of its own in the compact layout, above everything or below it", () => {
    const text = "deploy: prod";
    const compact = { layout: { header: ["model", "route"], rows: [], mode: "compact" } } satisfies StatuslineSettings;
    expect(draw({ payload: MODEL, settings: { ...compact, customLine: { text } } }).split("\n")).toEqual(["Opus 5.5", text]);
    expect(draw({ payload: MODEL, settings: { ...compact, customLine: { text, position: "first" } } }).split("\n")).toEqual([text, "Opus 5.5"]);
  });

  it("draws on its own when nothing else does", () => {
    expect(draw({ settings: { layout: { header: [], rows: [] }, customLine: { text: "only" } } })).toBe("only");
  });

  it("is painted in colours.custom, orange by default, and in the colour set", () => {
    const settings: StatuslineSettings = { layout: { header: [], rows: [] }, customLine: { text: "hi" } };
    expect(draw({ settings, colour: true })).toBe(`${ESCAPE}[${ORANGE_INDEX}mhi${ESCAPE}[0m`);
    expect(draw({ settings: { ...settings, colours: { custom: "cyan" } }, colour: true })).toBe(`${ESCAPE}[36mhi${ESCAPE}[0m`);
  });

  it("is cut to the usable width in columns, wide characters counting two", () => {
    const long = "x".repeat(MIN_STATUSLINE_COLUMNS * 2);
    expect(draw({ terminalWidth: NARROW_TERMINAL, settings: { layout: { header: [], rows: [] }, customLine: { text: long } } })).toBe("x".repeat(MIN_STATUSLINE_COLUMNS));
    const wide = "\u6f22".repeat(MIN_STATUSLINE_COLUMNS);
    expect(draw({ terminalWidth: NARROW_TERMINAL, settings: { layout: { header: [], rows: [] }, customLine: { text: wide } } })).toBe("\u6f22".repeat(MIN_STATUSLINE_COLUMNS / 2));
  });
});

describe("the extra segment", () => {
  const EXTRA_ONLY = (command: readonly string[]): StatuslineSettings => ({ layout: { header: ["extra"], rows: [] }, extra: { command: [...command] } });

  it("runs nothing and draws nothing unless the layout lists it, whatever the command", () => {
    const calls: string[] = [];
    const run: StatuslinePorts["run"] = (file) => {
      calls.push(file);
      return "out\n";
    };
    expect(draw({ run, settings: { layout: { header: ["model"], rows: [] }, extra: { command: ["tool"] } }, payload: MODEL })).toBe("Opus 5.5");
    expect(calls).toEqual([]);
  });

  it("runs nothing when no command is set", () => {
    const calls: string[] = [];
    const run: StatuslinePorts["run"] = (file) => {
      calls.push(file);
      return "out\n";
    };
    expect(draw({ run, settings: { layout: { header: ["extra"], rows: [] } } })).toBe("");
    expect(calls).toEqual([]);
  });

  it("runs the program with its arguments, as given and without a shell, in the session's directory, with its output going to a file", () => {
    const calls: [string, readonly string[], string, unknown][] = [];
    const run: StatuslinePorts["run"] = (file, args, cwd, options) => {
      calls.push([file, args, cwd, options]);
      return "v1.2\n";
    };
    expect(draw({ run, settings: EXTRA_ONLY(["tool", "--flag", "a b; $HOME"]), payload: { cwd: PROJECT_DIR } })).toBe("v1.2");
    expect(calls).toEqual([["tool", ["--flag", "a b; $HOME"], PROJECT_DIR, { outputInFile: true }]]);
  });

  it("draws the first line with something on it, or the label of a JSON object", () => {
    const run = (output: string): StatuslinePorts["run"] => () => output;
    expect(draw({ run: run("\n\n  first  \nsecond\n"), settings: EXTRA_ONLY(["t"]) })).toBe("first");
    expect(draw({ run: run('{"label":"from json","other":1}'), settings: EXTRA_ONLY(["t"]) })).toBe("from json");
  });

  it.each(["1234", "true", "null", '"quoted"', "[1,2]", '{"nolabel":1}', '{"label":1}', "{not json"])("draws output that is not an object with a string label, %s, as the line it is", (output) => {
    expect(draw({ run: () => `${output}\nsecond\n`, settings: EXTRA_ONLY(["t"]) })).toBe(output);
  });

  it("takes the label of a JSON object even when it is not on the first line", () => {
    expect(draw({ run: () => '{\n  "label": "multi line json"\n}\n', settings: EXTRA_ONLY(["t"]) })).toBe("multi line json");
  });

  it("draws nothing when the command fails, outruns its limit or prints nothing visible", () => {
    expect(draw({ run: () => undefined, settings: EXTRA_ONLY(["t"]) })).toBe("");
    expect(draw({ run: () => "", settings: EXTRA_ONLY(["t"]) })).toBe("");
    expect(draw({ run: () => "\u200b\n", settings: EXTRA_ONLY(["t"]) })).toBe("");
  });

  it("cleans what the command prints and cuts it like other text from outside the statusline", () => {
    const hostile = `${ESCAPE}]0;title\u0007${ESCAPE}[31mlabel${ESCAPE}[0m\u202e`;
    expect(draw({ run: () => `${hostile}\n`, settings: EXTRA_ONLY(["t"]) })).toBe("label");
    expect(draw({ run: () => "y".repeat(MAX_DISPLAY_TEXT_CHARS * 2), settings: EXTRA_ONLY(["t"]) })).toBe("y".repeat(MAX_DISPLAY_TEXT_CHARS));
  });

  it("drops control characters that are not white space, a NUL included, rather than replacing them, so the neighbours of one join", () => {
    expect(draw({ run: () => "a\u0000b\u0007c\n", settings: EXTRA_ONLY(["t"]) })).toBe("abc");
  });

  it("makes the white space controls, a tab included, one space between words, collapsed with the spaces and the invisible characters beside them", () => {
    expect(draw({ run: () => "a\tb\n", settings: EXTRA_ONLY(["t"]) })).toBe("a b");
    expect(draw({ run: () => "a \t\r \u000b\f b\u0085c\n", settings: EXTRA_ONLY(["t"]) })).toBe("a b c");
    expect(draw({ run: () => "\tlead\t\n", settings: EXTRA_ONLY(["t"]) })).toBe("lead");
    expect(draw({ run: () => "a\t\u200b\tb\n", settings: EXTRA_ONLY(["t"]) })).toBe("a b");
    expect(draw({ run: () => "a\u2028b\n", settings: EXTRA_ONLY(["t"]) })).toBe("a b");
    expect(draw({ run: () => '{"label":"from\\tjson\\nlabel"}', settings: EXTRA_ONLY(["t"]) })).toBe("from json label");
  });

  it("removes an escape sequence whole when a tab or a line break stands inside it, in plain output and in a JSON label", () => {
    expect(draw({ run: () => `a\t${ESCAPE}]0;ti\ttle\u0007\tb\n`, settings: EXTRA_ONLY(["t"]) })).toBe("a b");
    expect(draw({ run: () => '{"label":"a\\t\\u001b]0;ti\\ntle\\u0007\\tb"}', settings: EXTRA_ONLY(["t"]) })).toBe("a b");
  });

  it("draws the first line that shows something, skipping lines of spaces of any width, of characters that draw nothing and of escape sequences", () => {
    for (const blank of ["\u200b", "\u00a0", "\u3000", "\u2800", `${ESCAPE}[0m`, `${ESCAPE}]0;title\u0007`, "  "]) {
      expect(draw({ run: () => `${blank}\nsecond\n`, settings: EXTRA_ONLY(["t"]) }), JSON.stringify(blank)).toBe("second");
    }
    expect(draw({ run: () => "\u200b\n\u00a0\n", settings: EXTRA_ONLY(["t"]) })).toBe("");
  });

  it("chooses the line once the escape sequences are removed from the whole output, as it cleans a JSON label", () => {
    expect(draw({ run: () => `${ESCAPE}[0m\nbranch-x\n`, settings: EXTRA_ONLY(["t"]) })).toBe("branch-x");
    expect(draw({ run: () => `${ESCAPE}]0;ti\ntle\u0007\nsecond\n`, settings: EXTRA_ONLY(["t"]) })).toBe("second");
    expect(draw({ run: () => `a ${ESCAPE}]0;ti\ntle\u0007 b\n`, settings: EXTRA_ONLY(["t"]) })).toBe("a  b");
    expect(draw({ run: () => '{"label":"a \\u001b]0;ti\\ntle\\u0007 b"}', settings: EXTRA_ONLY(["t"]) })).toBe("a  b");
  });

  it("reads colourised JSON and JSON after a byte order mark as JSON, because escape sequences and the mark are removed before the output is looked at", () => {
    const colourised = `${ESCAPE}[1;39m{\n  ${ESCAPE}[0m${ESCAPE}[34;1m"label"${ESCAPE}[0m${ESCAPE}[1;39m: ${ESCAPE}[0m${ESCAPE}[0;32m"built"${ESCAPE}[0m${ESCAPE}[1;39m\n${ESCAPE}[1;39m}${ESCAPE}[0m\n`;
    expect(draw({ run: () => colourised, settings: EXTRA_ONLY(["t"]) })).toBe("built");
    expect(draw({ run: () => `${ESCAPE}[0m{"label":"x"}${ESCAPE}[0m\n`, settings: EXTRA_ONLY(["t"]) })).toBe("x");
    expect(draw({ run: () => '\ufeff{"label":"x"}\n', settings: EXTRA_ONLY(["t"]) })).toBe("x");
  });

  it("leaves what valid JSON means alone: an escape written inside a string is the JSON escape, and is cleaned from the label as an escape sequence", () => {
    expect(draw({ run: () => '{"label":"a\\u001b[31mb"}', settings: EXTRA_ONLY(["t"]) })).toBe("ab");
  });

  it("removes, with an operating system command that has no end, everything up to the next escape character or the end of the output, whatever lines that takes", () => {
    expect(draw({ run: () => `${ESCAPE}]0;x\nfoo\n`, settings: EXTRA_ONLY(["t"]) })).toBe("");
    expect(draw({ run: () => `foo\n${ESCAPE}]0;x\nbar\n`, settings: EXTRA_ONLY(["t"]) })).toBe("foo");
    expect(draw({ run: () => `${ESCAPE}]0;x\nfoo${ESCAPE}[0m\nbar\n`, settings: EXTRA_ONLY(["t"]) })).toBe("bar");
  });

  it("removes a byte order mark that follows an escape sequence, which the sequence's removal leaves at the start", () => {
    expect(draw({ run: () => `${ESCAPE}[0m\ufeff{"label":"x"}\n`, settings: EXTRA_ONLY(["t"]) })).toBe("x");
  });

  it("skips lines and pieces of default-ignorable characters that no character set assigns", () => {
    expect(draw({ run: () => `${"\u{2065}\n".repeat(MAX_DISPLAY_TEXT_CHARS)}word\n`, settings: EXTRA_ONLY(["t"]) })).toBe("word");
    expect(draw({ run: () => `${"\u{e0000}\t".repeat(MAX_DISPLAY_TEXT_CHARS)}word\n`, settings: EXTRA_ONLY(["t"]) })).toBe("word");
  });

  /** How many times the output cap a single run of one kind of character is tried at: the patterns the cleaning applies to the whole output must cope with far more than the cap lets through, so that a change to the cap or to a pattern cannot turn a long output into an exception. */
  const OUTPUT_MARGIN = 4;
  it.each([
    ["a word", (length: number) => "x".repeat(length), "x".repeat(MAX_DISPLAY_TEXT_CHARS)],
    ["an operating system command with no end", (length: number) => `${ESCAPE}]0;${"x".repeat(length)}`, ""],
    ["spaces between two letters", (length: number) => `a${" ".repeat(length)}b`, "a"],
    ["zero-width spaces", (length: number) => "\u200b".repeat(length), ""],
    ["tabs between two letters", (length: number) => `a${"\t".repeat(length)}b`, "a b"],
  ])("copes with %s as long as several times the output cap", (_kind, make, expected) => {
    expect(draw({ run: () => make(RUN_MAX_OUTPUT_BYTES * OUTPUT_MARGIN), settings: EXTRA_ONLY(["t"]) })).toBe(expected);
  });

  it("is painted in the label colour", () => {
    const text = draw({ run: () => "lbl", settings: { layout: { header: ["extra"], rows: [] }, extra: { command: ["t"] }, colours: { label: "cyan" } }, colour: true });
    expect(text).toBe(`${ESCAPE}[36mlbl${ESCAPE}[0m`);
  });
});

describe("the extra segment in the presets", () => {
  it.each(STATUSLINE_PRESETS)("is drawn in %s once a command is set, as claude-hud draws its extra label under its default and every preset", (preset) => {
    expect(draw({ run: () => "from tool\n", payload: MODEL, settings: { preset, extra: { command: ["t"] } } })).toContain("from tool");
  });

  it.each(STATUSLINE_PRESETS)("changes nothing in %s while no command is set", (preset) => {
    const calls: string[] = [];
    const run: StatuslinePorts["run"] = (file) => {
      calls.push(file);
      return "from tool\n";
    };
    const withoutExtra = resolveStatusline({ preset }).layout.header.filter((name) => name !== "extra");
    expect(draw({ run, payload: MODEL, settings: { preset } })).toBe(draw({ run, payload: MODEL, settings: { preset, layout: { header: withoutExtra } } }));
    expect(calls).not.toContain("t");
  });
});

import { describe, expect, it } from "vitest";

import { MAX_DISPLAY_TEXT_CHARS, MIN_STATUSLINE_COLUMNS, resolveStatusline, type StatuslineSettings } from "../config/statusline";
import { ESCAPE } from "./ansi";
import { parseClientPayload, viewOf } from "./payload";
import { RESERVED_COLUMNS, renderStatuslineBlock } from "./render";
import { fakeStatuslinePorts, fakeStatuslineSummary } from "./testing";
import type { StatuslinePorts } from "./ports";

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

  it("drops control characters, a NUL included, rather than replacing them, so the neighbours of one join", () => {
    expect(draw({ run: () => "a\u0000b\tc\n", settings: EXTRA_ONLY(["t"]) })).toBe("abc");
  });

  it("is painted in the label colour", () => {
    const text = draw({ run: () => "lbl", settings: { layout: { header: ["extra"], rows: [] }, extra: { command: ["t"] }, colours: { label: "cyan" } }, colour: true });
    expect(text).toBe(`${ESCAPE}[36mlbl${ESCAPE}[0m`);
  });
});

describe("the extra segment in the presets", () => {
  const CLAUDE_HUD_PRESETS = ["full", "essential", "minimal"] as const;

  it.each(CLAUDE_HUD_PRESETS)("is drawn in %s once a command is set, as claude-hud draws its extra label under every preset", (preset) => {
    expect(draw({ run: () => "from tool\n", payload: MODEL, settings: { preset, extra: { command: ["t"] } } })).toContain("from tool");
  });

  it.each(CLAUDE_HUD_PRESETS)("changes nothing in %s while no command is set", (preset) => {
    const calls: string[] = [];
    const run: StatuslinePorts["run"] = (file) => {
      calls.push(file);
      return "from tool\n";
    };
    const withoutExtra = resolveStatusline({ preset }).layout.header.filter((name) => name !== "extra");
    expect(draw({ run, payload: MODEL, settings: { preset } })).toBe(draw({ run, payload: MODEL, settings: { preset, layout: { header: withoutExtra } } }));
    expect(calls).not.toContain("t");
  });

  it("is left out of the statusline's own preset, which a command alone does not change", () => {
    expect(draw({ run: () => "from tool\n", payload: MODEL, settings: { preset: "standard", extra: { command: ["t"] } } })).not.toContain("from tool");
  });
});

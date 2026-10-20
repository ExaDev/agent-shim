import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../../config/statusline";
import { ESCAPE, visibleLength } from "../ansi";
import { createPalette } from "../palette";
import { fakeRenderContext } from "../testing";
import { EMPTY_ACTIVITY_FACTS, type ActivityFacts, type AgentFact, type ToolCallFact } from "../transcript/activity";
import type { TranscriptFacts } from "../transcript/reader";
import type { RenderContext, RowOutput } from "./context";
import { agentsRow } from "./rows/agents";
import { mcpRow } from "./rows/mcp";
import { skillsRow } from "./rows/skills";
import { todosRow } from "./rows/todos";
import { toolsRow } from "./rows/tools";

const NOW_MS = Date.parse("2026-10-20T10:00:00.000Z");
const MINUTE = 60_000;
const WIDE = 200;
const NARROW = 40;
const TRANSCRIPT_BYTES = 1_000;
const FIVE = 5;
const SEVEN = 7;
const TWENTY_FIVE = 25;
const FIFTY_ONE = 51;
const TWENTY_COLUMNS = 20;
const THIRTY_COLUMNS = 30;
const FORTY_COLUMNS = 40;
const ONE_HOUR_ONE_MINUTE = 3_660_000;
const TWELVE_SECONDS = 12_000;
const MAX_KINDS_SHOWN = 4;
const THREE_MINUTES = 180_000;
const TEN_SECONDS = 10_000;
const TWENTY_SECONDS = 20_000;
const THIRTY_SECONDS = 30_000;
const TYPE_COLUMNS = 24;
const DESCRIPTION_COLUMNS = 40;
const TODO_COLUMNS = 50;
const TARGET_COLUMNS = 20;
const NAME_COLUMNS = 64;
const LONG_NAME_COLUMNS = 70;
const ELLIPSIS = "\u2026";

function facts(activity: Partial<ActivityFacts>, complete = true): TranscriptFacts {
  return {
    bytes: TRANSCRIPT_BYTES,
    complete,
    session: { title: undefined, startedAtMs: undefined, lastResponseAtMs: undefined, compactions: 0, promptCache: undefined },
    tokens: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    activity: { ...EMPTY_ACTIVITY_FACTS, ...activity },
  };
}

interface Drawing {
  readonly settings?: StatuslineSettings;
  readonly width?: number;
  readonly colour?: boolean;
}

function contextOf(transcript: TranscriptFacts | undefined, { settings = {}, width = WIDE, colour = false }: Drawing = {}): RenderContext {
  const resolved = resolveStatusline(settings);
  return fakeRenderContext({ settings: resolved, palette: createPalette(resolved.colours, colour), width, nowMs: NOW_MS, transcript: () => transcript });
}

function linesOf(output: RowOutput): readonly string[] {
  expect(output.kind).toBe("text");
  return output.kind === "text" ? output.lines : [];
}

const tool = (name: string, status: ToolCallFact["status"] = "completed", target?: string): ToolCallFact => ({ name, target, status });
const agent = (overrides: Partial<AgentFact> = {}): AgentFact => ({ type: "Explore", model: undefined, description: undefined, status: "running", startedAtMs: NOW_MS - TWELVE_SECONDS, endedAtMs: undefined, ...overrides });

describe("the tools row", () => {
  const draw = (tools: readonly ToolCallFact[], drawing?: Drawing): readonly string[] => linesOf(toolsRow(contextOf(facts({ tools }), drawing)));

  it("draws nothing without a transcript, or without a call", () => {
    expect(linesOf(toolsRow(contextOf(undefined)))).toEqual([]);
    expect(draw([])).toEqual([]);
  });

  it("names a running call with what it acts on, and finished kinds with their counts, most used first", () => {
    const tools = [tool("Read"), tool("Bash"), tool("Read"), tool("Grep"), tool("Read"), tool("Bash"), tool("Edit", "running", "/a/b.ts")];
    expect(draw(tools)).toEqual([`\u25D0 Edit: /a/b.ts | \u2713 Read \u00D73 | \u2713 Bash \u00D72 | \u2713 Grep \u00D71`]);
  });

  it("counts a call that failed with the finished ones", () => {
    expect(draw([tool("Bash", "error"), tool("Bash")])).toEqual(["\u2713 Bash \u00D72"]);
  });

  it("orders kinds with the same count in the order they were first seen", () => {
    expect(draw([tool("B"), tool("A"), tool("C")])).toEqual(["\u2713 B \u00D71 | \u2713 A \u00D71 | \u2713 C \u00D71"]);
  });

  it("names at most the two newest running calls", () => {
    const tools = [tool("One", "running"), tool("Two", "running"), tool("Three", "running")];
    expect(draw(tools)).toEqual(["\u25D0 Two | \u25D0 Three"]);
  });

  it("names at most tools.maxVisible kinds and counts the rest, or every kind when it is 0", () => {
    const tools = ["A", "B", "C", "D", "E", "F"].map((name) => tool(name));
    expect(draw(tools)).toEqual(["\u2713 A \u00D71 | \u2713 B \u00D71 | \u2713 C \u00D71 | \u2713 D \u00D71 | +2 more"]);
    expect(draw(tools, { settings: { tools: { maxVisible: 2 } } })).toEqual(["\u2713 A \u00D71 | \u2713 B \u00D71 | +4 more"]);
    expect(draw(tools, { settings: { tools: { maxVisible: 0 } } })).toEqual(["\u2713 A \u00D71 | \u2713 B \u00D71 | \u2713 C \u00D71 | \u2713 D \u00D71 | \u2713 E \u00D71 | \u2713 F \u00D71"]);
    expect(draw(tools.slice(0, MAX_KINDS_SHOWN), { settings: { tools: { maxVisible: MAX_KINDS_SHOWN } } })).toEqual(["\u2713 A \u00D71 | \u2713 B \u00D71 | \u2713 C \u00D71 | \u2713 D \u00D71"]);
  });

  it("draws every name whole by default, an MCP tool's with its server", () => {
    expect(draw([tool("mcp__github__list_issues")])).toEqual(["\u2713 mcp__github__list_issues \u00D71"]);
  });

  it("cuts a name to tools.nameMaxLength columns, and shows an MCP tool by its own name once a limit is set", () => {
    const settings = { tools: { nameMaxLength: SEVEN } };
    expect(draw([tool("mcp__github__list_issues"), tool("Read")], { settings })).toEqual([`\u2713 list_i${ELLIPSIS} \u00D71 | \u2713 Read \u00D71`]);
    expect(draw([tool("mcp__github__ok")], { settings })).toEqual(["\u2713 ok \u00D71"]);
    expect(draw([tool("ExactlySeven"), tool("Seven77")], { settings: { tools: { nameMaxLength: SEVEN } } })).toEqual([`\u2713 Exactl${ELLIPSIS} \u00D71 | \u2713 Seven77 \u00D71`]);
  });

  it("counts the columns of a name, not its characters", () => {
    expect(draw([tool("\u65e5\u672c\u8a9e\u30c4\u30fc\u30eb")], { settings: { tools: { nameMaxLength: FIVE } } })).toEqual([`\u2713 \u65e5\u672c${ELLIPSIS} \u00D71`]);
  });

  it("shortens a file's path to its name when it does not fit, and cuts any other target", () => {
    const run = (name: string, target: string): string => draw([tool(name, "running", target)])[0] ?? "";
    expect(run("Read", "/short/a.ts")).toBe("\u25D0 Read: /short/a.ts");
    expect(run("Read", "/a/long/directory/path/index.ts")).toBe("\u25D0 Read: .../index.ts");
    expect(run("Edit", `/a/b/${"x".repeat(TWENTY_FIVE)}.ts`)).toBe(`\u25D0 Edit: ${"x".repeat(TARGET_COLUMNS - "...".length)}...`);
    expect(run("Read", "C:\\Users\\joe\\project\\src\\index.ts")).toBe("\u25D0 Read: .../index.ts");
    expect(run("Bash", "git status")).toBe("\u25D0 Bash: git status");
    expect(run("Bash", "npm run build -- --watch --verbose")).toBe(`\u25D0 Bash: npm run build -- --${ELLIPSIS}`);
    expect(run("Grep", "needle")).toBe("\u25D0 Grep: needle");
  });

  it("draws a running call with no target without a colon", () => {
    expect(draw([tool("Task", "running")])).toEqual(["\u25D0 Task"]);
  });

  it("leaves Skill calls out when the skills row is listed, and keeps them otherwise", () => {
    const tools = [tool("Skill", "completed", "commit"), tool("Read")];
    expect(draw(tools)).toEqual(["\u2713 Skill \u00D71 | \u2713 Read \u00D71"]);
    expect(draw(tools, { settings: { layout: { rows: ["tools", "skills"] } } })).toEqual(["\u2713 Read \u00D71"]);
    expect(draw([tool("Skill", "running", "commit")], { settings: { layout: { rows: ["tools", "skills"] } } })).toEqual([]);
  });

  it("breaks onto further lines where the width needs it", () => {
    const tools = [tool("Alpha"), tool("Beta"), tool("Gamma"), tool("Delta")];
    const lines = draw(tools, { width: NARROW });
    expect(lines).toEqual(["\u2713 Alpha \u00D71 | \u2713 Beta \u00D71 | \u2713 Gamma \u00D71", "\u2713 Delta \u00D71"]);
  });

  it("paints the running marker in the warning colour, the name in the activity colour, the finished marker in the context colour and the figures in the label colour", () => {
    const settings: StatuslineSettings = { colours: { warning: "yellow", activity: "cyan", context: "green", label: "blue" } };
    const [line = ""] = draw([tool("Edit", "running", "a.ts"), tool("Read")], { settings, colour: true });
    expect(line).toContain(`${ESCAPE}[33m\u25D0${ESCAPE}[0m ${ESCAPE}[36mEdit${ESCAPE}[0m${ESCAPE}[34m: a.ts${ESCAPE}[0m`);
    expect(line).toContain(`${ESCAPE}[32m\u2713${ESCAPE}[0m Read ${ESCAPE}[34m\u00D71${ESCAPE}[0m`);
  });
});

describe("the skills and mcp rows", () => {
  const skills = (names: readonly string[], drawing?: Drawing & { readonly complete?: boolean }): readonly string[] => linesOf(skillsRow(contextOf(facts({ skills: names }, drawing?.complete), drawing)));
  const servers = (names: readonly string[], drawing?: Drawing): readonly string[] => linesOf(mcpRow(contextOf(facts({ mcpServers: names }), drawing)));

  it("draw nothing without a transcript, or without a name", () => {
    expect(linesOf(skillsRow(contextOf(undefined)))).toEqual([]);
    expect(linesOf(mcpRow(contextOf(undefined)))).toEqual([]);
    expect(skills([])).toEqual([]);
    expect(servers([])).toEqual([]);
  });

  it("count and name what was used, each row under its own title", () => {
    expect(skills(["commit", "journal"])).toEqual(["\u2713 Skills (2): commit, journal"]);
    expect(servers(["github"])).toEqual(["\u2713 MCPs (1): github"]);
  });

  it("name the first four and count the rest", () => {
    expect(skills(["a", "b", "c", "d", "e", "f"])).toEqual(["\u2713 Skills (6): a, b, c, d, +2 more"]);
    expect(skills(["a", "b", "c", "d"])).toEqual(["\u2713 Skills (4): a, b, c, d"]);
  });

  it("end the count in a plus while the transcript has not been read to its end", () => {
    expect(skills(["a"], { complete: false })).toEqual(["\u2713 Skills (1+): a"]);
  });

  it("cut a name that is far too long", () => {
    expect(skills(["x".repeat(LONG_NAME_COLUMNS)])).toEqual([`\u2713 Skills (1): ${"x".repeat(NAME_COLUMNS - 1)}${ELLIPSIS}`]);
  });

  it("break onto further lines where the width needs it", () => {
    expect(skills(["alpha-skill", "beta-skill", "gamma-skill"], { width: NARROW })).toEqual(["\u2713 Skills (3): alpha-skill, beta-skill", "gamma-skill"]);
  });

  it("paint the marker in the context colour, the names in the activity colour and the figures in the label colour", () => {
    const settings: StatuslineSettings = { colours: { context: "green", activity: "cyan", label: "blue" } };
    const [line = ""] = skills(["commit", "a", "b", "c", "d"], { settings, colour: true });
    expect(line).toBe(`${ESCAPE}[32m\u2713${ESCAPE}[0m ${ESCAPE}[34mSkills (5):${ESCAPE}[0m ${ESCAPE}[36mcommit${ESCAPE}[0m, ${ESCAPE}[36ma${ESCAPE}[0m, ${ESCAPE}[36mb${ESCAPE}[0m, ${ESCAPE}[36mc${ESCAPE}[0m, ${ESCAPE}[34m+1 more${ESCAPE}[0m`);
  });
});

describe("the agents row", () => {
  const draw = (agents: readonly AgentFact[], drawing?: Drawing): readonly string[] => linesOf(agentsRow(contextOf(facts({ agents }), drawing)));

  it("draws nothing without a transcript, or without an agent", () => {
    expect(linesOf(agentsRow(contextOf(undefined)))).toEqual([]);
    expect(draw([])).toEqual([]);
  });

  it("draws a running agent with its type, model, description and how long it has run", () => {
    expect(draw([agent({ model: "claude-opus-4-8[1m]", description: "Find the thing" })])).toEqual(["\u25D0 Explore [opus-4.8]: Find the thing (12s)"]);
    expect(draw([agent()])).toEqual(["\u25D0 Explore (12s)"]);
  });

  it("draws a finished agent with its marker and how long it ran", () => {
    const finished = agent({ status: "completed", startedAtMs: NOW_MS - THREE_MINUTES, endedAtMs: NOW_MS - TEN_SECONDS });
    expect(draw([finished])).toEqual(["\u2713 Explore (2m 50s)"]);
  });

  it("writes a model as a short label", () => {
    const label = (model: string): string => draw([agent({ model })])[0] ?? "";
    expect(label("claude-haiku-4-5-20251001")).toContain("[haiku-4.5]");
    expect(label("claude-3-5-sonnet-20241022")).toContain("[sonnet-3.5]");
    expect(label("opus")).toContain("[opus]");
    expect(label("glm-5.3[1m]")).toContain("[glm-5.3]");
    expect(label("claude-")).not.toContain("[");
  });

  it("draws the newest three running agents, and as many agents that finished in the last minute as there are places left, at most two", () => {
    const running = (type: string): AgentFact => agent({ type });
    const finished = (type: string, endedAgoMs: number): AgentFact => agent({ type, status: "completed", startedAtMs: NOW_MS - 2 * MINUTE, endedAtMs: NOW_MS - endedAgoMs });
    const recent = [finished("Done1", TEN_SECONDS), finished("Done2", TWENTY_SECONDS), finished("Done3", THIRTY_SECONDS)];
    expect(draw([running("R1"), ...recent])).toEqual(["\u25D0 R1 (12s)", "\u2713 Done2 (1m 40s)", "\u2713 Done3 (1m 30s)"]);
    expect(draw([running("R1"), running("R2"), ...recent])).toEqual(["\u25D0 R1 (12s)", "\u25D0 R2 (12s)", "\u2713 Done3 (1m 30s)"]);
    expect(draw([running("R1"), running("R2"), running("R3"), running("R4"), ...recent])).toEqual(["\u25D0 R2 (12s)", "\u25D0 R3 (12s)", "\u25D0 R4 (12s)"]);
  });

  it("leaves out an agent that finished more than a minute ago, or whose end is in the future", () => {
    const old = agent({ status: "completed", endedAtMs: NOW_MS - MINUTE - 1 });
    const edge = agent({ type: "Edge", status: "completed", startedAtMs: NOW_MS - 2 * MINUTE, endedAtMs: NOW_MS - MINUTE });
    const future = agent({ status: "completed", endedAtMs: NOW_MS + 1 });
    expect(draw([old, edge, future])).toEqual(["\u2713 Edge (1m 0s)"]);
  });

  it("cuts a type that is too long", () => {
    expect(draw([agent({ type: "t".repeat(TWENTY_FIVE) })])).toEqual([`\u25D0 ${"t".repeat(TYPE_COLUMNS - 1)}${ELLIPSIS} (12s)`]);
  });

  it("gives the description what the line has left, and none when there is no room", () => {
    const described = agent({ description: "d".repeat(FIFTY_ONE) });
    expect(draw([described])).toEqual([`\u25D0 Explore: ${"d".repeat(DESCRIPTION_COLUMNS - "...".length)}... (12s)`]);
    const [narrow = ""] = draw([described], { width: NARROW });
    expect(narrow.length).toBeLessThanOrEqual(NARROW);
    expect(narrow.endsWith("... (12s)")).toBe(true);
    expect(draw([described], { width: "\u25D0 Explore (12s)".length })).toEqual(["\u25D0 Explore (12s)"]);
  });

  it("fits every line to the width, giving up the description, then the model, then the end of the type", () => {
    const long = agent({ type: "general-purpose", model: "claude-opus-4-8", description: "Write the tests for the rows", startedAtMs: NOW_MS - ONE_HOUR_ONE_MINUTE });
    expect(draw([long], { width: WIDE })).toEqual(["\u25D0 general-purpose [opus-4.8]: Write the tests for the rows (1h 1m)"]);
    expect(draw([long], { width: FORTY_COLUMNS })).toEqual(["\u25D0 general-purpose [opus-4.8] (1h 1m)"]);
    expect(draw([long], { width: THIRTY_COLUMNS })).toEqual(["\u25D0 general-purpose (1h 1m)"]);
    expect(draw([long], { width: TWENTY_COLUMNS })).toEqual([`\u25D0 general-p${ELLIPSIS} (1h 1m)`]);
    for (const width of [TWENTY_COLUMNS, THIRTY_COLUMNS, FORTY_COLUMNS]) {
      for (const drawn of draw([long], { width })) {
        expect(visibleLength(drawn), `width ${String(width)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("paints the type in the agent colour and the marker in the warning colour", () => {
    const settings: StatuslineSettings = { colours: { agent: "magenta", warning: "yellow", label: "blue" } };
    const [line = ""] = draw([agent()], { settings, colour: true });
    expect(line).toBe(`${ESCAPE}[33m\u25D0${ESCAPE}[0m ${ESCAPE}[35mExplore${ESCAPE}[0m ${ESCAPE}[34m(12s)${ESCAPE}[0m`);
  });
});

describe("the todos row", () => {
  const draw = (todos: ActivityFacts["todos"], drawing?: Drawing): readonly string[] => linesOf(todosRow(contextOf(facts({ todos }), drawing)));

  it("draws nothing without a transcript, or without a list", () => {
    expect(linesOf(todosRow(contextOf(undefined)))).toEqual([]);
    expect(draw([])).toEqual([]);
  });

  it("draws the item in progress with how many are done", () => {
    const todos = [{ content: "Plan", status: "completed" as const }, { content: "Write the tests", status: "in_progress" as const }, { content: "Ship", status: "pending" as const }];
    expect(draw(todos)).toEqual(["\u25B8 Write the tests (1/3)"]);
  });

  it("draws the first of two items in progress", () => {
    expect(draw([{ content: "A", status: "in_progress" }, { content: "B", status: "in_progress" }])).toEqual(["\u25B8 A (0/2)"]);
  });

  it("says that every item is done once none is left", () => {
    expect(draw([{ content: "A", status: "completed" }, { content: "B", status: "completed" }])).toEqual(["\u2713 All todos complete (2/2)"]);
  });

  it("draws nothing for a list with items still to do and none in progress", () => {
    expect(draw([{ content: "A", status: "completed" }, { content: "B", status: "pending" }])).toEqual([]);
  });

  it("cuts the words of the item in progress", () => {
    expect(draw([{ content: "w".repeat(FIFTY_ONE + FIVE), status: "in_progress" }])).toEqual([`\u25B8 ${"w".repeat(TODO_COLUMNS - "...".length)}... (0/1)`]);
    expect(draw([{ content: "w".repeat(FIFTY_ONE - 1), status: "in_progress" }])).toEqual([`\u25B8 ${"w".repeat(FIFTY_ONE - 1)} (0/1)`]);
  });

  it("fits the line to the width with the progress whole, and the words giving way", () => {
    const working = [{ content: "Write the tests for the new rows and ship them", status: "in_progress" as const }, { content: "b", status: "pending" as const }];
    const finished = [{ content: "a", status: "completed" as const }, { content: "b", status: "completed" as const }];
    expect(draw(working, { width: TWENTY_COLUMNS })).toEqual(["\u25B8 Write the... (0/2)"]);
    expect(draw(working, { width: THIRTY_COLUMNS })).toEqual(["\u25B8 Write the tests for... (0/2)"]);
    expect(draw(working, { width: FORTY_COLUMNS })).toEqual(["\u25B8 Write the tests for the new r... (0/2)"]);
    expect(draw(finished, { width: TWENTY_COLUMNS })).toEqual(["\u2713 All todos... (2/2)"]);
    expect(draw(finished, { width: THIRTY_COLUMNS })).toEqual(["\u2713 All todos complete (2/2)"]);
    for (const width of [TWENTY_COLUMNS, THIRTY_COLUMNS, FORTY_COLUMNS]) {
      for (const drawn of [...draw(working, { width }), ...draw(finished, { width })]) {
        expect(visibleLength(drawn), `width ${String(width)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("leaves the words out and draws the progress alone when even a cut word does not fit", () => {
    const [drawn = ""] = linesOf(todosRow({ ...contextOf(facts({ todos: [{ content: "Write", status: "in_progress" }] }), { width: 1 }), width: 1 }));
    expect(drawn).toBe("\u25B8 (0/1)");
  });

  it("paints the marker in the warning colour when work is in progress and the context colour when it is all done", () => {
    const settings: StatuslineSettings = { colours: { warning: "yellow", context: "green" } };
    expect(draw([{ content: "A", status: "in_progress" }], { settings, colour: true })[0]).toContain(`${ESCAPE}[33m\u25B8${ESCAPE}[0m`);
    expect(draw([{ content: "A", status: "completed" }], { settings, colour: true })[0]).toContain(`${ESCAPE}[32m\u2713${ESCAPE}[0m`);
  });
});

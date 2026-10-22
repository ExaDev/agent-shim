import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../../config/statusline";
import { ESCAPE } from "../ansi";
import type { StatuslineSummary } from "../enrich";
import { parseClientPayload } from "../payload";
import { renderStatuslineBlock } from "../render";
import { fakeStatuslineFilesystem, fakeStatuslinePorts } from "../testing";
import { BASH_MAX_TIMEOUT_MS } from "../transcript/activity";

const TRANSCRIPT = "/sessions/activity.jsonl";
const T0 = Date.parse("2026-10-20T09:00:00.000Z");
const SECOND = 1_000;
const WIDE_TERMINAL = 170;
const NARROW_TERMINAL = 44;
const RESERVED_AND_PADDING = 4;
const STEP = { third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 } as const;

const SUMMARY: StatuslineSummary = {
  identity: undefined,
  provider: undefined,
  providerAccountEmail: undefined,
  providerAccountSub: undefined,
  providerPlan: undefined,
  loginAccountEmail: undefined,
  loginRateLimitTier: undefined,
  loginOrganizationName: undefined,
  loginOrganizationType: undefined,
  loginSeatTier: undefined,
  loginPlan: undefined,
  providerQuotaWindows: [],
  quotaFamilies: [],
  headroom: undefined,
  fiveHourUsed: undefined,
  fiveHourResetAt: undefined,
  sevenDayUsed: undefined,
  sevenDayResetAt: undefined,
};

const at = (ms: number): string => new Date(T0 + ms).toISOString();
const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*[a-zA-Z]`, "g");
const plain = (text: string): string => text.replace(ANSI, "");

const use = (ms: number, id: string, name: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string => line({ type: "assistant", timestamp: at(ms), message: { content: [{ type: "tool_use", id, name, input }] }, ...extra });
const result = (ms: number, id: string, extra: Record<string, unknown> = {}): string => line({ type: "user", timestamp: at(ms), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...extra });

/** A session that read a file, ran a search and a test run, used a skill and two MCP servers, started a background agent and a foreground one that has finished, has a todo list with one item in progress, and is still running a build. A subagent's own calls are mixed in and must not show. */
const SESSION =
  use(0, "r1", "Read", { file_path: "/repo/src/index.ts" }) +
  result(SECOND, "r1") +
  use(2 * SECOND, "g1", "Grep", { pattern: "needle" }) +
  result(STEP.third * SECOND, "g1") +
  use(STEP.fourth * SECOND, "s1", "Skill", { skill: "commit" }) +
  result(STEP.fifth * SECOND, "s1") +
  use(STEP.sixth * SECOND, "m1", "mcp__github__list_issues") +
  result(STEP.seventh * SECOND, "m1") +
  use(STEP.eighth * SECOND, "m2", "mcp__playwright__navigate") +
  result(STEP.ninth * SECOND, "m2") +
  use(0, "side", "Bash", { command: "echo from a subagent" }, { isSidechain: true }) +
  use(STEP.tenth * SECOND, "a1", "Agent", { subagent_type: "Explore", description: "Map the code", model: "sonnet" }) +
  result(STEP.tenth * SECOND + SECOND, "a1", { toolUseResult: { isAsync: true, status: "async_launched" } }) +
  use(STEP.tenth * SECOND, "a2", "Agent", { subagent_type: "general-purpose", description: "Fix it" }) +
  result(STEP.tenth * SECOND + 2 * SECOND, "a2") +
  use(STEP.tenth * SECOND, "todo", "TodoWrite", { todos: [{ content: "Write the tests", status: "in_progress" }, { content: "Ship it", status: "pending" }] }) +
  use(STEP.tenth * SECOND, "b1", "Bash", { command: "pnpm build" });

function render(settings: StatuslineSettings, options: { readonly nowMs?: number; readonly terminalWidth?: number; readonly transcript?: string; readonly env?: Record<string, string> } = {}): string[] {
  const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: options.transcript ?? SESSION });
  const text = renderStatuslineBlock({
    summary: SUMMARY,
    view: { clientModelName: undefined, contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined },
    payload: parseClientPayload({ transcript_path: TRANSCRIPT }),
    terminalWidth: options.terminalWidth ?? WIDE_TERMINAL,
    nowMs: options.nowMs ?? T0 + STEP.tenth * SECOND + STEP.fifth * SECOND,
    settings: resolveStatusline(settings),
    ports: fakeStatuslinePorts({ ...disk.ports, env: options.env ?? {} }),
  });
  return text === "" ? [] : text.split("\n");
}

const rows = (...names: readonly ("tools" | "skills" | "mcp" | "agents" | "todos")[]): StatuslineSettings => ({ layout: { header: [], rows: [...names] } });

describe("the activity rows", () => {
  it("draw nothing and read no transcript by default, so a default statusline is what it was", () => {
    expect(render({}, { env: {} }).map(plain)).toEqual([]);
    const unreadable = fakeStatuslinePorts({
      readRange: () => {
        throw new Error("the transcript was read");
      },
    });
    const input = { summary: SUMMARY, view: { clientModelName: "Sonnet 5.5", contextUsedPercentage: undefined, contextTotalTokens: undefined, contextWindowTokens: undefined, cacheHitRatio: undefined, cacheReadTokens: undefined, freshInputTokens: undefined }, payload: parseClientPayload({ transcript_path: TRANSCRIPT }), terminalWidth: WIDE_TERMINAL, nowMs: T0, ports: unreadable };
    expect(plain(renderStatuslineBlock(input))).toBe("Sonnet 5.5");
  });

  it("each draw what the session's transcript says, in the order the layout lists them", () => {
    expect(render(rows("tools", "skills", "mcp", "agents", "todos")).map(plain)).toEqual([
      "\u25D0 Bash: pnpm build | \u2713 Read \u00D71 | \u2713 Grep \u00D71 | \u2713 mcp__github__list_issues \u00D71 | \u2713 mcp__playwright__navigate \u00D71",
      "\u2713 Skills (1): commit",
      "\u2713 MCPs (2): github, playwright",
      "\u25D0 Explore [sonnet]: Map the code (5s)",
      "\u2713 general-purpose: Fix it (2s)",
      "\u25B8 Write the tests (0/2)",
    ]);
    expect(render(rows("todos", "mcp")).map(plain)).toEqual(["\u25B8 Write the tests (0/2)", "\u2713 MCPs (2): github, playwright"]);
  });

  it("draw the foreground agent as finished while it is recent, and name the Skill call in the tools row when the skills row is not listed", () => {
    const [tools] = render(rows("tools"), { nowMs: T0 + STEP.tenth * SECOND + 2 * SECOND + 1 }).map(plain);
    expect(tools).toContain("\u2713 Skill \u00D71");
    const agents = render(rows("agents"), { nowMs: T0 + STEP.tenth * SECOND + 2 * SECOND + 1 }).map(plain);
    expect(agents).toEqual(["\u25D0 Explore [sonnet]: Map the code (2s)", "\u2713 general-purpose: Fix it (2s)"]);
  });

  it("leave out the calls of a subagent", () => {
    const [tools = ""] = render(rows("tools")).map(plain);
    expect(tools).not.toContain("Bash \u00D7");
    expect(render(rows("tools"), { transcript: use(0, "side", "Bash", {}, { isSidechain: true }) })).toEqual([]);
  });

  it("stop showing a call as running once it has run for longer than a live call can", () => {
    const [tools = ""] = render(rows("tools"), { nowMs: T0 + STEP.tenth * SECOND + BASH_MAX_TIMEOUT_MS + 1 }).map(plain);
    expect(tools).not.toContain("\u25D0");
    expect(tools).toContain("\u2713 Read");
  });

  it("break onto lines that fit a narrow terminal and keep every word", () => {
    const lines = render(rows("tools", "agents"), { terminalWidth: NARROW_TERMINAL }).map(plain);
    for (const drawn of lines) {
      expect(drawn.length).toBeLessThanOrEqual(NARROW_TERMINAL - RESERVED_AND_PADDING);
    }
    expect(lines.join(" ")).toContain("Bash: pnpm build");
    expect(lines.filter((drawn) => drawn.startsWith("\u25D0 Explore"))).toHaveLength(1);
  });

  it("paint with the colours the settings give them", () => {
    const settings: StatuslineSettings = { ...rows("mcp"), colours: { activity: "red", context: "blue" } };
    const [drawn = ""] = render(settings);
    expect(drawn).toContain(`${ESCAPE}[34m\u2713${ESCAPE}[0m`);
    expect(drawn).toContain(`${ESCAPE}[31mgithub${ESCAPE}[0m`);
  });

  it("draw nothing when the transcript has none of what they show", () => {
    const chat = line({ type: "user", timestamp: at(0), message: { content: "hello" } });
    expect(render(rows("tools", "skills", "mcp", "agents", "todos"), { transcript: chat })).toEqual([]);
  });
});

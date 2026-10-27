import { describe, expect, it } from "vitest";

import { resolveStatusline, type ResolvedStatusline, type StatuslineSettings } from "../../config/statusline";
import { visibleLength } from "../ansi";
import { STATUSLINE_LANGUAGES } from "../messages/languages";
import { createPalette, type Palette } from "../palette";
import { fakeRenderContext } from "../testing";
import { EMPTY_ACTIVITY_FACTS, type ActivityFacts, type AgentFact, type NamesFact, type ToolCallFact } from "../transcript/activity";
import type { RenderContext, RowOutput } from "./context";
import { agentsRow } from "./rows/agents";
import { mcpRow } from "./rows/mcp";
import { skillsRow } from "./rows/skills";
import { todosRow } from "./rows/todos";
import { toolsRow } from "./rows/tools";

const NOW_MS = Date.parse("2026-10-20T10:00:00.000Z");
const MIN_WIDTH = 8;
const MAX_WIDTH = 128;
const SESSIONS = 12;
const MAX_ITEMS = 8;
const MAX_TEXT_CHARS = 90;
const SEED = 1;
const MS_PER_MINUTE = 60_000;
const MAX_AGE_MINUTES = 200;

/** The multiplier, increment and modulus of a linear congruential generator (Numerical Recipes), so the same seed gives the same sessions and a failure repeats. */
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;
const LCG_STATE_BITS = 32;
const LCG_MODULUS = 2 ** LCG_STATE_BITS;

/** How often a fact is left out, in the sessions the test generates, as a share of one. */
const RARELY = 0.2;
const SOMETIMES = 0.3;
const HALF = 0.5;

function randomFrom(seed: number): () => number {
  let state = seed % LCG_MODULUS;
  return () => {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) % LCG_MODULUS;
    return (state >>> 0) / LCG_MODULUS;
  };
}

/** Letters, wide characters, a path separator and a space, so a text breaks and measures in more than one way. */
const ALPHABET = ["a", "b", "c", "x", "-", "_", "/", " ", "\u4E2D", "\u6587", "\u5B57"] as const;

function session(seed: number): ActivityFacts {
  const random = randomFrom(seed);
  const below = (limit: number): number => Math.floor(random() * limit);
  const pick = <T>(items: readonly [T, ...T[]]): T => items[below(items.length)] ?? items[0];
  const text = (): string => Array.from({ length: 1 + below(MAX_TEXT_CHARS) }, () => pick(ALPHABET)).join("");
  const many = <T>(make: () => T): T[] => Array.from({ length: below(MAX_ITEMS) }, make);
  const names = (): NamesFact => {
    const shown = many(text);
    return { names: shown, total: shown.length + below(MAX_ITEMS), exact: random() < HALF };
  };
  const tool = (): ToolCallFact => ({ name: random() < SOMETIMES ? `mcp__${text()}__${text()}` : text(), target: random() < RARELY ? undefined : text(), status: pick(["running", "completed", "error"] as const) });
  const agent = (): AgentFact => {
    const startedAtMs = NOW_MS - below(MAX_AGE_MINUTES) * MS_PER_MINUTE;
    const status = pick(["running", "completed"] as const);
    return { type: random() < RARELY ? undefined : text(), model: random() < HALF ? undefined : pick(["opus", "claude-haiku-4-5-20251001", text()]), description: random() < SOMETIMES ? undefined : text(), status, startedAtMs, endedAtMs: status === "completed" ? NOW_MS - below(MS_PER_MINUTE) : undefined };
  };
  return {
    ...EMPTY_ACTIVITY_FACTS,
    tools: many(tool),
    skills: names(),
    mcpServers: names(),
    agents: many(agent),
    todos: many(() => ({ content: random() < RARELY ? undefined : text(), status: pick(["pending", "in_progress", "completed"] as const) })),
  };
}

/** The context a row draws from, for `activity` at `width`. The resolved settings and the palette are the caller's, built once per settings choice: they depend on neither the session nor the width, and resolving them parses the whole settings schema. */
function contextOf(activity: ActivityFacts, width: number, resolved: ResolvedStatusline, palette: Palette): RenderContext {
  return fakeRenderContext({
    settings: resolved,
    palette,
    width,
    nowMs: NOW_MS,
    transcript: () => ({
      bytes: 1,
      complete: true,
      session: { title: undefined, startedAtMs: undefined, lastResponseAtMs: undefined, compactions: 0, promptCache: undefined },
      tokens: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      activity,
    }),
  });
}

function linesOf(output: RowOutput): readonly string[] {
  return output.kind === "text" ? output.lines : [];
}

const ROWS = { tools: toolsRow, skills: skillsRow, mcp: mcpRow, agents: agentsRow, todos: todosRow } as const;

/** Setting choices that change what a row draws: its own limit on a tool's name and on the kinds named, and the languages. */
const SETTINGS: readonly (readonly [string, Omit<StatuslineSettings, "language">])[] = [
  ["defaults", {}],
  ["every kind and name limit", { tools: { nameMaxLength: 12, maxVisible: 0 } }],
];

describe("the activity rows at every width", () => {
  for (const language of STATUSLINE_LANGUAGES) {
    for (const [choice, settings] of SETTINGS) {
      it(`never draw a line wider than the width, in ${language} with ${choice}`, () => {
        const resolved = resolveStatusline({ ...settings, language });
        const palette = createPalette(resolved.colours, true);
        const overflowing: string[] = [];
        for (let index = 0; index < SESSIONS; index += 1) {
          const activity = session(SEED + index);
          for (let width = MIN_WIDTH; width <= MAX_WIDTH; width += 1) {
            const context = contextOf(activity, width, resolved, palette);
            for (const [name, row] of Object.entries(ROWS)) {
              for (const line of linesOf(row(context))) {
                if (visibleLength(line) > width) {
                  overflowing.push(`${name} session ${String(index)} width ${String(width)}: ${String(visibleLength(line))} columns`);
                }
              }
            }
          }
        }
        expect(overflowing).toEqual([]);
      });
    }
  }

  it("draw something for the sessions the test generates, so the widths it checks are not all empty rows", () => {
    const resolved = resolveStatusline({});
    const palette = createPalette(resolved.colours, true);
    const drawn = Object.values(ROWS).map((row) => Array.from({ length: SESSIONS }, (_, index) => linesOf(row(contextOf(session(SEED + index), MAX_WIDTH, resolved, palette))).length).reduce((total, count) => total + count, 0));
    expect(drawn.every((count) => count > 0)).toBe(true);
  });
});

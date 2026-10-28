import path from "node:path";

import { resolveStatusline, type StatuslineSettings } from "../config/statusline";
import { ESCAPE } from "./ansi";
import { contextFrameOf } from "./contextFrame";
import { parseClientPayload, viewOf, type ContextWindowFrame } from "./payload";
import type { StatuslinePorts } from "./ports";
import { renderStatuslineBlock } from "./render";
import { fakeStatuslineFilesystem, fakeStatuslinePorts, fakeStatuslineSummary } from "./testing";
import type { Compaction } from "./transcript/session";

/** Fixtures and helpers the context frame tests share: the frames a transcript's record is kept from and rewritten into, in-memory ports whose clock a test moves, and renders of the context row and the whole statusline over them. */

export const T0 = Date.parse("2026-10-27T12:00:00.000Z");
export const SECOND = 1_000;
export const WINDOW = 200_000;
export const SMALLER_WINDOW = 100_000;
export const GOOD_PERCENT = 40;
export const LATER_PERCENT = 60;
const HIGH_PERCENT = 92;
export const GOOD_HELD = 80_000;
const HIGH_HELD = 184_000;
export const POST_TOKENS = 30_000;
/** `POST_TOKENS` over `WINDOW`, as a percentage. */
export const POST_PERCENT = 15;
/** Tokens a compaction left that are not a whole percentage of `WINDOW`, and the percentage they make of it. */
export const FRACTIONAL_POST_TOKENS = 31_000;
export const FRACTIONAL_POST_PERCENT = 15.5;
/** An earlier compaction's tokens, and the percentage they make of `WINDOW`. */
export const EARLY_POST_TOKENS = 60_000;
export const EARLY_POST_PERCENT = 30;
/** How long before `T0` the earlier and the later of two compactions happened. */
export const EARLY_COMPACTION_AGE_MS = 600_000;
export const LATER_COMPACTION_AGE_MS = 50_000;
/** More tokens after a compaction than the window holds, which draws as the whole window. */
export const OVERFULL_POST_TOKENS = 250_000;
export const FULL_PERCENT = 100;
export const NEGATIVE_PERCENT = -5;
export const NEGATIVE_COUNT = -3;
/** A percentage above 0 that rounds to none, which claude-hud's `hasGoodContext` still counts as good. */
export const FRACTION_OF_A_PERCENT = 0.4;
/** The negative zero JSON's `-0` parses to, which claude-hud's `?? 0` comparisons judge to be 0. */
export const NEGATIVE_ZERO = -0;
/** A window that holds nothing, and one below that, neither of which a percentage can be made over. */
export const EMPTY_WINDOW = 0;
export const NEGATIVE_WINDOW = -1;
/** Windows above 0 of a token or less, which claude-hud's `hasGoodContext` takes for a window as it takes any above 0. */
export const FRACTION_OF_A_TOKEN_WINDOW = 0.5;
export const ONE_TOKEN_WINDOW = 1;
/** Tokens held that `context.estimate: raw` draws as a percentage above 0 but below 1 of `WINDOW`. */
export const SLIVER_HELD = 600;
/** The most tokens held whose estimate over `WINDOW` (below 0.05%) the row writes as `0.0%`, and the fewest whose estimate it writes as `0.1%`. */
export const MOST_HELD_WRITTEN_AS_NONE = 99;
export const LEAST_HELD_WRITTEN_AS_SOME = 100;
/** A quarter of `WINDOW`: the tokens held a frame reports that a window set to `WINDOW` measures as 25%. */
export const QUARTER_HELD = 50_000;
/** A hit ratio the client reports for the prompt cache, drawn as 50%, unlike the 99% share of cache reads the last good frame's last request gives. */
export const HALF_HIT_RATIO = 0.5;
/** Tokens a compaction left that reach the breakdown threshold of `WINDOW`. */
export const CRITICAL_POST_TOKENS = 180_000;
/** The last request of a frame whose four counters are all 0. */
export const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
export const TRANSCRIPT = "/home/test/.claude/projects/p/session.jsonl";
export const OTHER_TRANSCRIPT = "/home/test/.claude/projects/p/other.jsonl";
export const RED = `${ESCAPE}[31m`;
/** The prompt each filler line of a transcript too big to read at once carries, and how many reads of the transcript reader that transcript spans at least. */
export const FILLER_CHARACTERS = 1_000;
export const FILLER_READS = 3;

export const usage = (input: number, read: number): NonNullable<ContextWindowFrame["current_usage"]> => ({ input_tokens: input, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: read });
/** The fresh input and cache reads of the last request of each good frame, which add up to the tokens it holds. */
export const GOOD_INPUT = 1_000;
export const GOOD_CACHE_READ = GOOD_HELD - GOOD_INPUT;
const HIGH_INPUT = 4_000;
const HIGH_CACHE_READ = HIGH_HELD - HIGH_INPUT;
export const GOOD: ContextWindowFrame = { context_window_size: WINDOW, used_percentage: GOOD_PERCENT, total_input_tokens: GOOD_HELD, current_usage: usage(GOOD_INPUT, GOOD_CACHE_READ) };
export const LATER: ContextWindowFrame = { ...GOOD, used_percentage: LATER_PERCENT };
export const HIGH: ContextWindowFrame = { context_window_size: WINDOW, used_percentage: HIGH_PERCENT, total_input_tokens: HIGH_HELD, current_usage: usage(HIGH_INPUT, HIGH_CACHE_READ) };
/** The frame Claude Code sends right after `/compact`: no last request, no tokens held and a percentage of 0. */
export const ZERO: ContextWindowFrame = { context_window_size: WINDOW, used_percentage: 0, total_input_tokens: 0 };

/** Statusline ports over an in-memory tree whose files carry the time they were last written at, on a clock the test moves. */
export function machine(initial: Readonly<Record<string, string>> = {}): { readonly ports: StatuslinePorts; readonly files: Map<string, string>; readonly mtimes: Map<string, number>; at: (ms: number) => void } {
  const tree = fakeStatuslineFilesystem(initial);
  const mtimes = new Map<string, number>();
  let now = T0;
  const ports = fakeStatuslinePorts({
    ...tree.ports,
    writeText: (target, text) => {
      tree.ports.writeText(target, text);
      mtimes.set(path.normalize(target), now);
    },
    removePath: (target) => {
      tree.ports.removePath(target);
      mtimes.delete(path.normalize(target));
    },
    modifiedAtMs: (target) => mtimes.get(path.normalize(target)),
  });
  return {
    ports,
    files: tree.files,
    mtimes,
    at: (ms) => {
      now = ms;
    },
  };
}

/** The frame drawn for `frame` at `nowMs`, with the transcript recording `compaction`, for a frame the row draws a percentage above 0 from when `drawsPercent` says so. */
export function drawnAt(box: ReturnType<typeof machine>, frame: ContextWindowFrame | undefined, nowMs: number, compaction?: Compaction, transcriptPath: string | undefined = TRANSCRIPT, drawsPercent = false): ContextWindowFrame | undefined {
  box.at(nowMs);
  return contextFrameOf({ ports: box.ports, transcriptPath, frame, drawsPercent, nowMs, compaction: () => compaction });
}

/** The context row of the default statusline for `frame`, as rendered with `box`'s ports at `nowMs`. */
export function contextLine(box: ReturnType<typeof machine>, frame: unknown, nowMs: number, settings: StatuslineSettings = {}): string {
  box.at(nowMs);
  const payload = parseClientPayload({ transcript_path: TRANSCRIPT, context_window: frame });
  return renderStatuslineBlock({ summary: fakeStatuslineSummary(), view: viewOf(payload), payload, terminalWidth: 200, nowMs, settings: resolveStatusline({ layout: { header: [], rows: ["context"] }, bar: { width: 10 }, ...settings }), ports: box.ports });
}

/** `text` with its colour and style escapes removed, as a terminal shows it. */
export function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g"), "");
}

/** The rendered statusline for `payload` under `settings` with `box`'s ports at `nowMs`. */
export function renderAt(box: ReturnType<typeof machine>, payload: Readonly<Record<string, unknown>>, nowMs: number, settings: StatuslineSettings): string {
  box.at(nowMs);
  const parsed = parseClientPayload(payload);
  return renderStatuslineBlock({ summary: fakeStatuslineSummary(), view: viewOf(parsed), payload: parsed, terminalWidth: 200, nowMs, settings: resolveStatusline({ bar: { width: 10 }, ...settings }), ports: box.ports });
}

import path from "node:path";

import { describe, expect, it } from "vitest";

import { CACHE_RETENTION_MS, cacheFileFor } from "./cacheFile";
import { CONTEXT_RECORD_MAX_AGE_MS, CONTEXT_WRITE_INTERVAL_MS, contextFrameOf, MAX_CONTEXT_RECORDS } from "./contextFrame";
import { parseClientPayload, type ContextWindowFrame } from "./payload";
import type { StatuslinePorts } from "./ports";
import { FAKE_WORKING_DIRECTORY, fakeStatuslinePorts } from "./testing";
import type { Compaction } from "./transcript/session";
import { T0, SECOND, WINDOW, SMALLER_WINDOW, GOOD_PERCENT, LATER_PERCENT, GOOD_HELD, POST_TOKENS, POST_PERCENT, FRACTIONAL_POST_TOKENS, FRACTIONAL_POST_PERCENT, EARLY_POST_TOKENS, EARLY_POST_PERCENT, EARLY_COMPACTION_AGE_MS, LATER_COMPACTION_AGE_MS, OVERFULL_POST_TOKENS, FULL_PERCENT, NEGATIVE_PERCENT, NEGATIVE_COUNT, FRACTION_OF_A_PERCENT, NEGATIVE_ZERO, EMPTY_WINDOW, NEGATIVE_WINDOW, FRACTION_OF_A_TOKEN_WINDOW, ONE_TOKEN_WINDOW, TRANSCRIPT, OTHER_TRANSCRIPT, usage, GOOD_INPUT, GOOD, LATER, ZERO, machine, drawnAt, ZERO_USAGE } from "./contextFrameTesting";

/** claude-hud's limits on its context cache, which the parity document states the record keeps: writes at most once in 3 seconds, a record drawn for 7 days after its last write, and 100 records. */
const HUD_WRITE_INTERVAL_SECONDS = 3;
const HUD_MAX_AGE_DAYS = 7;
const HUD_MAX_RECORDS = 100;
const HOUR_MS = 3_600_000;
const HOURS_PER_DAY = 24;
/** How far into a second a record is written, and half a second, so a later refresh within the write interval of that write is past the interval from the start of its second. */
const MOST_OF_A_SECOND_MS = 900;
const HALF_A_SECOND_MS = 500;
/** A record stamped this far ahead of the clock, past the maximum age several times over. */
const FUTURE_AGES = 4;
const CONTEXT_RECORDS_FUTURE_MS = FUTURE_AGES * CONTEXT_RECORD_MAX_AGE_MS;
/** A compaction that left a single token, over a window of two: the smallest count that gives a percentage, and the half of the window it makes. */
const ONE_POST_TOKEN = 1;
const TWO_TOKEN_WINDOW = 2;
const HALF_PERCENT = 50;
/** A percentage above 0 that the row writes as `0.0`: a reading still, since claude-hud's `isSuspiciousZero` takes only exactly 0 for none. */
const HUNDREDTH_OF_A_PERCENT = 0.01;
/** The index, among records filling the cap, of the one given the earliest file time, away from both ends of the directory's listing. */
const MIDDLE_RECORD = 50;
/** How many records past the cap a directory holds before one more is written, more than one write's worth. */
const RECORDS_PAST_CAP = 3;
/** A directory the statusline runs in other than the fake ports' own, and a transcript path relative to whichever it runs in. */
const OTHER_WORKING_DIRECTORY = "/work/other";
const RELATIVE_TRANSCRIPT = "t.jsonl";
/** How far ahead of the clock a compaction is stamped: past the age limit, so a record drawn from it outlives the limit only if its age is measured from that compaction. */
const FUTURE_COMPACTION_AHEAD_MS = 2 * CONTEXT_RECORD_MAX_AGE_MS;

describe("the context record's limits", () => {
  it("are claude-hud's write interval, maximum age and record cap", () => {
    expect(CONTEXT_WRITE_INTERVAL_MS).toBe(HUD_WRITE_INTERVAL_SECONDS * SECOND);
    expect(CONTEXT_RECORD_MAX_AGE_MS).toBe(HUD_MAX_AGE_DAYS * HOURS_PER_DAY * HOUR_MS);
    expect(MAX_CONTEXT_RECORDS).toBe(HUD_MAX_RECORDS);
  });
});

describe("the context frame drawn in place of a suspicious zero", () => {
  it("draws the transcript's last good frame for a frame reporting 0 or no percentage and no last request or each of its counters 0 or none, with its tokens and last request, keeping the frame's other fields", () => {
    const box = machine();
    expect(drawnAt(box, GOOD, T0)).toBe(GOOD);
    const unreported: ContextWindowFrame = { context_window_size: WINDOW, total_input_tokens: 0 };
    const withOutputTotal: ContextWindowFrame = { ...ZERO, total_output_tokens: GOOD_INPUT };
    for (const zero of [ZERO, unreported, withOutputTotal, { ...ZERO, current_usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, { ...ZERO, current_usage: {} }, { context_window_size: WINDOW }]) {
      expect(drawnAt(box, zero, T0 + SECOND)).toEqual({ ...zero, used_percentage: GOOD_PERCENT, total_input_tokens: GOOD_HELD, current_usage: GOOD.current_usage, context_window_size: WINDOW });
    }
  });

  it("takes the frame's own window over the record's, a window of 0 or below included, and the record's where the frame reports none", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, { ...ZERO, context_window_size: SMALLER_WINDOW }, T0 + SECOND)?.context_window_size).toBe(SMALLER_WINDOW);
    expect(drawnAt(box, { used_percentage: 0 }, T0 + SECOND)?.context_window_size).toBe(WINDOW);
    for (const windowTokens of [EMPTY_WINDOW, NEGATIVE_WINDOW]) {
      expect(drawnAt(box, { ...ZERO, context_window_size: windowTokens }, T0 + SECOND)).toEqual({ ...ZERO, used_percentage: GOOD_PERCENT, total_input_tokens: GOOD_HELD, current_usage: GOOD.current_usage, context_window_size: windowTokens });
    }
  });

  it("draws a frame with a token of the last request, or one the row draws a percentage above 0 from, as it stands, since it is a reading", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    const withUsage = { ...ZERO, current_usage: usage(POST_TOKENS, 0) };
    const withHeld = { ...ZERO, total_input_tokens: POST_TOKENS };
    expect(drawnAt(box, withUsage, T0 + SECOND)).toBe(withUsage);
    expect(drawnAt(box, withHeld, T0 + SECOND, { atMs: T0 + 1, postTokens: POST_TOKENS }, TRANSCRIPT, true)).toBe(withHeld);
  });

  it.each(["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"])("draws a frame whose last request holds %s alone as it stands, with a percentage of 0 or none, since it is a reading", (counter) => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    const oneCounter = { ...ZERO, current_usage: { [counter]: POST_TOKENS } };
    const unreported: ContextWindowFrame = { context_window_size: WINDOW, current_usage: { [counter]: POST_TOKENS } };
    expect(drawnAt(box, oneCounter, T0 + SECOND)).toBe(oneCounter);
    expect(drawnAt(box, unreported, T0 + SECOND)).toBe(unreported);
  });

  it.each(["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const)("keeps and restores a last request that reports no %s, as claude-hud restores whatever last request it kept", (counter) => {
    const box = machine();
    const partial = Object.fromEntries(Object.entries(usage(GOOD_INPUT, GOOD_INPUT)).filter(([key]) => key !== counter));
    drawnAt(box, { ...GOOD, current_usage: partial }, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND)?.current_usage).toEqual(partial);
  });

  it("does not keep a frame drawn as it stands at 0%, so a later zero still draws the last good frame", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    const estimated = { ...ZERO, total_input_tokens: POST_TOKENS };
    drawnAt(box, estimated, T0 + CONTEXT_WRITE_INTERVAL_MS, undefined, TRANSCRIPT, true);
    const reading = { ...ZERO, current_usage: usage(POST_TOKENS, 0) };
    drawnAt(box, reading, T0 + 2 * CONTEXT_WRITE_INTERVAL_MS);
    expect(drawnAt(box, ZERO, T0 + 2 * CONTEXT_WRITE_INTERVAL_MS + SECOND)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("reads a percentage or a counter of negative zero as 0, as claude-hud does, so the frame is rewritten", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    const payload = parseClientPayload(JSON.parse('{"context_window":{"context_window_size":200000,"used_percentage":-0,"total_input_tokens":0,"current_usage":{"input_tokens":-0}}}'));
    expect(Object.is(payload.context_window?.used_percentage, NEGATIVE_ZERO)).toBe(true);
    expect(drawnAt(box, payload.context_window, T0 + SECOND)?.used_percentage).toBe(GOOD_PERCENT);
    expect(drawnAt(box, { ...ZERO, used_percentage: NEGATIVE_ZERO }, T0 + SECOND)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("draws a frame whose last request has a negative counter as it stands, as claude-hud does", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    const negativeCounter = { ...ZERO, current_usage: { input_tokens: NEGATIVE_COUNT, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    expect(drawnAt(box, negativeCounter, T0 + SECOND)).toBe(negativeCounter);
  });

  it("rewrites a frame holding tokens the row draws no percentage from, as claude-hud, which does not read them, does", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    const heldWithoutWindow: ContextWindowFrame = { used_percentage: 0, total_input_tokens: POST_TOKENS };
    expect(drawnAt(box, heldWithoutWindow, T0 + SECOND)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("draws the frame as it stands for a transcript with no record, with no transcript, and with a blank one, writing nothing for either of the last two", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND, undefined, OTHER_TRANSCRIPT)).toBe(ZERO);
    const quiet = machine();
    for (const transcriptPath of [undefined, "  "]) {
      expect(contextFrameOf({ ports: quiet.ports, transcriptPath, frame: GOOD, drawsPercent: false, nowMs: T0, compaction: () => undefined })).toBe(GOOD);
    }
    expect(quiet.files.size).toBe(0);
    expect(drawnAt(quiet, undefined, T0)).toBeUndefined();
  });

  it("keys the record by the transcript path with the white space around it removed, as claude-hud trims it", () => {
    const box = machine();
    const padded = ` ${TRANSCRIPT}\t\n`;
    drawnAt(box, GOOD, T0, undefined, padded);
    expect(box.files.has(cacheFileFor(box.ports, "context", TRANSCRIPT))).toBe(true);
    expect(box.files.has(cacheFileFor(box.ports, "context", padded))).toBe(false);
    expect(drawnAt(box, ZERO, T0 + SECOND)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("does not keep a frame reporting a negative percentage, as claude-hud keeps one above 0 alone", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    drawnAt(box, { ...GOOD, used_percentage: NEGATIVE_PERCENT }, T0 + CONTEXT_WRITE_INTERVAL_MS);
    expect(drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS + SECOND)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("draws a frame reporting a percentage, even a negative one, as it stands", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    const negative = { ...ZERO, used_percentage: NEGATIVE_PERCENT };
    expect(drawnAt(box, negative, T0 + SECOND)).toBe(negative);
    expect(drawnAt(box, LATER, T0 + SECOND)).toBe(LATER);
  });
});

describe("the compaction guard", () => {
  it("draws the tokens the newest compaction left over the frame's window when it is later than the record, or there is none", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND, { atMs: T0 + 1, postTokens: POST_TOKENS })?.used_percentage).toBe(POST_PERCENT);
    expect(drawnAt(machine(), ZERO, T0, { atMs: T0 - SECOND, postTokens: POST_TOKENS })).toEqual({ ...ZERO, used_percentage: POST_PERCENT });
    expect(drawnAt(machine(), ZERO, T0, { atMs: T0, postTokens: OVERFULL_POST_TOKENS })?.used_percentage).toBe(FULL_PERCENT);
  });

  it("keeps the fraction of a percentage the compaction left, unrounded", () => {
    expect(drawnAt(machine(), ZERO, T0, { atMs: T0, postTokens: FRACTIONAL_POST_TOKENS })?.used_percentage).toBeCloseTo(FRACTIONAL_POST_PERCENT);
  });

  it("draws the percentage a compaction of a single token left, as claude-hud counts any count above 0", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, { ...ZERO, context_window_size: TWO_TOKEN_WINDOW }, T0 + SECOND, { atMs: T0 + 1, postTokens: ONE_POST_TOKEN })?.used_percentage).toBe(HALF_PERCENT);
  });

  it("draws the percentage a compaction left over a window of a fraction of a token as the whole window, as claude-hud takes any window above 0", () => {
    expect(drawnAt(machine(), { ...ZERO, context_window_size: FRACTION_OF_A_TOKEN_WINDOW }, T0, { atMs: T0, postTokens: POST_TOKENS })?.used_percentage).toBe(FULL_PERCENT);
  });

  it("draws a frame reporting a percentage above 0 that the row writes as 0.0 as it stands, as claude-hud takes only exactly 0 for none", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    const sliver = { ...ZERO, used_percentage: HUNDREDTH_OF_A_PERCENT };
    expect(drawnAt(box, sliver, T0 + SECOND)).toBe(sliver);
  });

  it("keys the record by the transcript path resolved against the directory the statusline runs in, as claude-hud resolves it, so a trailing separator or a relative spelling names the same record", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND, undefined, `${TRANSCRIPT}/`)?.used_percentage).toBe(GOOD_PERCENT);
    expect(drawnAt(box, ZERO, T0 + SECOND, undefined, path.relative(FAKE_WORKING_DIRECTORY, TRANSCRIPT))?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("keeps one relative path's records apart for each directory the statusline runs in, as claude-hud resolves it against its own", () => {
    const box = machine();
    const elsewhere = { ...box, ports: { ...box.ports, absolutePath: (target: string) => path.resolve(OTHER_WORKING_DIRECTORY, target) } };
    drawnAt(box, GOOD, T0, undefined, RELATIVE_TRANSCRIPT);
    expect(drawnAt(elsewhere, ZERO, T0 + SECOND, undefined, RELATIVE_TRANSCRIPT)).toBe(ZERO);
    expect(drawnAt(box, ZERO, T0 + SECOND, undefined, RELATIVE_TRANSCRIPT)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("keeps the records of paths that differ only in case apart, as claude-hud's digest of the path does", () => {
    const box = machine();
    drawnAt(box, GOOD, T0, undefined, "/home/test/X/t.jsonl");
    expect(drawnAt(box, ZERO, T0 + SECOND, undefined, "/home/test/x/T.jsonl")).toBe(ZERO);
  });

  it("keeps a record for a path of a single character", () => {
    const box = machine();
    drawnAt(box, GOOD, T0, undefined, "t");
    expect(drawnAt(box, ZERO, T0 + SECOND, undefined, "t")?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("measures the age of a record drawn from a compaction stamped ahead of the clock from its write, so it is read as none once that is longer ago than the age limit", () => {
    const box = machine();
    const compaction = { atMs: T0 + FUTURE_COMPACTION_AHEAD_MS, postTokens: EARLY_POST_TOKENS };
    expect(drawnAt(box, ZERO, T0, compaction)?.used_percentage).toBe(EARLY_POST_PERCENT);
    const windowless = { used_percentage: 0 };
    expect(drawnAt(box, windowless, T0 + CONTEXT_RECORD_MAX_AGE_MS + SECOND, compaction)).toBe(windowless);
  });

  it("forgets the cache files not written to for long by the clock when a record is first written from a compaction stamped ahead of it, not by that compaction's time", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND, { atMs: T0 + CACHE_RETENTION_MS + CONTEXT_RECORD_MAX_AGE_MS, postTokens: POST_TOKENS }, OTHER_TRANSCRIPT)?.used_percentage).toBe(POST_PERCENT);
    expect(drawnAt(box, ZERO, T0 + 2 * SECOND)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("keeps the zero rather than the record from before the compaction when the compaction recorded no count of 1 or more or the frame reports no window above 0", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND, { atMs: T0 + 1 })).toBe(ZERO);
    expect(drawnAt(box, ZERO, T0 + SECOND, { atMs: T0 + 1, postTokens: 0 })).toBe(ZERO);
    const windowless = { used_percentage: 0 };
    expect(drawnAt(box, windowless, T0 + SECOND, { atMs: T0 + 1, postTokens: POST_TOKENS })).toBe(windowless);
    // The tokens held are not a window: claude-hud divides by the frame's window alone.
    const windowlessHolding = { used_percentage: 0, total_input_tokens: SMALLER_WINDOW };
    expect(drawnAt(box, windowlessHolding, T0 + SECOND, { atMs: T0 + 1, postTokens: POST_TOKENS })).toBe(windowlessHolding);
    for (const windowTokens of [EMPTY_WINDOW, NEGATIVE_WINDOW]) {
      const empty = { ...ZERO, context_window_size: windowTokens };
      expect(drawnAt(box, empty, T0 + SECOND, { atMs: T0 + 1, postTokens: POST_TOKENS })).toBe(empty);
    }
  });

  it("draws the record when the compaction is no later than it", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND, { atMs: T0, postTokens: POST_TOKENS })?.used_percentage).toBe(GOOD_PERCENT);
    expect(drawnAt(box, ZERO, T0 + SECOND, { atMs: T0 - SECOND, postTokens: POST_TOKENS })?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("keeps the percentage after a compaction as the record, so a later zero draws it again", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS, { atMs: T0 + 1, postTokens: POST_TOKENS });
    expect(drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS + SECOND, { atMs: T0 + 1 })?.used_percentage).toBe(POST_PERCENT);
  });

  it("compares a compaction with the reading a restored frame came from, not with when it was written back", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    // The compaction is not yet read (a transcript being caught up), so the record is restored and written back.
    expect(drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS)?.used_percentage).toBe(GOOD_PERCENT);
    expect(drawnAt(box, ZERO, T0 + 2 * CONTEXT_WRITE_INTERVAL_MS, { atMs: T0 + SECOND, postTokens: POST_TOKENS })?.used_percentage).toBe(POST_PERCENT);
  });

  it("keeps the time of the reading through every write-back of a restored frame, not the time of the write-back before", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    // Two write-backs while the compaction is not yet read: the second restores the record the first wrote.
    expect(drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS)?.used_percentage).toBe(GOOD_PERCENT);
    expect(drawnAt(box, ZERO, T0 + 2 * CONTEXT_WRITE_INTERVAL_MS)?.used_percentage).toBe(GOOD_PERCENT);
    // The refresh after the two write-backs, the first to read the compaction.
    const boundaryReadIntervals = 3;
    expect(drawnAt(box, ZERO, T0 + boundaryReadIntervals * CONTEXT_WRITE_INTERVAL_MS, { atMs: T0 + SECOND, postTokens: POST_TOKENS })?.used_percentage).toBe(POST_PERCENT);
  });

  it("counts a compaction stamped a millisecond after the one the last good frame was drawn from", () => {
    const box = machine();
    const first: Compaction = { atMs: T0 - LATER_COMPACTION_AGE_MS, postTokens: POST_TOKENS };
    expect(drawnAt(box, ZERO, T0, first)?.used_percentage).toBe(POST_PERCENT);
    const next: Compaction = { atMs: first.atMs + 1, postTokens: EARLY_POST_TOKENS };
    expect(drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS, next)?.used_percentage).toBe(EARLY_POST_PERCENT);
  });

  it("keeps a frame drawn from a compaction as observed at the compaction's time, so a later compaction read afterwards still wins", () => {
    const box = machine();
    // An early compaction is all the reader has seen of a transcript it is still catching up with.
    const early: Compaction = { atMs: T0 - EARLY_COMPACTION_AGE_MS, postTokens: EARLY_POST_TOKENS };
    expect(drawnAt(box, ZERO, T0, early)?.used_percentage).toBe(EARLY_POST_PERCENT);
    // The reader then reaches a later compaction, stamped before the refresh that drew the early one.
    const later: Compaction = { atMs: T0 - LATER_COMPACTION_AGE_MS, postTokens: POST_TOKENS };
    expect(drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS, later)?.used_percentage).toBe(POST_PERCENT);
  });

  it("reads the transcript for a suspicious zero and not for a good frame", () => {
    const box = machine();
    let reads = 0;
    const read = (frame: ContextWindowFrame): void => {
      contextFrameOf({ ports: box.ports, transcriptPath: TRANSCRIPT, frame, drawsPercent: false, nowMs: T0, compaction: () => {
        reads += 1;
        return undefined;
      } });
    };
    read(GOOD);
    expect(reads).toBe(0);
    read(ZERO);
    expect(reads).toBe(1);
  });

  it("reads the record only for a frame it may rewrite, so a refresh that draws a frame as it stands costs no read of it", () => {
    const box = machine();
    const record = cacheFileFor(box.ports, "context", TRANSCRIPT);
    let reads = 0;
    const counted: StatuslinePorts = {
      ...box.ports,
      readText: (target) => {
        reads += target === record ? 1 : 0;
        return box.ports.readText(target);
      },
    };
    const draw = (frame: ContextWindowFrame, nowMs: number, drawsPercent: boolean): void => {
      box.at(nowMs);
      contextFrameOf({ ports: counted, transcriptPath: TRANSCRIPT, frame, drawsPercent, nowMs, compaction: () => undefined });
    };
    draw(GOOD, T0, true);
    draw(LATER, T0 + CONTEXT_WRITE_INTERVAL_MS, true);
    draw({ ...ZERO, current_usage: usage(POST_TOKENS, 0) }, T0 + 2 * CONTEXT_WRITE_INTERVAL_MS, false);
    draw({ ...ZERO, total_input_tokens: POST_TOKENS }, T0 + 2 * CONTEXT_WRITE_INTERVAL_MS, true);
    expect(reads).toBe(0);
    draw(ZERO, T0 + 2 * CONTEXT_WRITE_INTERVAL_MS, false);
    expect(reads).toBe(1);
  });
});

describe("the record's bounds", () => {
  it("measures the write interval from the record's file time to the millisecond, not from the whole second it falls in", () => {
    const box = machine();
    const writtenAtMs = T0 + MOST_OF_A_SECOND_MS;
    drawnAt(box, GOOD, writtenAtMs);
    const withinIntervalMs = writtenAtMs + CONTEXT_WRITE_INTERVAL_MS - HALF_A_SECOND_MS;
    drawnAt(box, LATER, withinIntervalMs);
    expect(drawnAt(box, ZERO, withinIntervalMs)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("writes a good frame no sooner than the write interval after the last write", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    drawnAt(box, LATER, T0 + CONTEXT_WRITE_INTERVAL_MS - 1);
    expect(drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS - 1)?.used_percentage).toBe(GOOD_PERCENT);
    drawnAt(box, LATER, T0 + CONTEXT_WRITE_INTERVAL_MS);
    expect(drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS)?.used_percentage).toBe(LATER_PERCENT);
  });

  it("lets a compaction older than a record past its maximum age count, the record being none", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, ZERO, T0 + CONTEXT_RECORD_MAX_AGE_MS + 1, { atMs: T0 - SECOND, postTokens: POST_TOKENS })?.used_percentage).toBe(POST_PERCENT);
  });

  it("leaves a record past its maximum age in place when it reads it as none, for the cap or the retention to remove", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, ZERO, T0 + CONTEXT_RECORD_MAX_AGE_MS + 1)).toBe(ZERO);
    expect(box.files.has(cacheFileFor(box.ports, "context", TRANSCRIPT))).toBe(true);
  });

  it("writes back a restored frame that reports no window of its own, carrying the record's window, so its age is measured from that write", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    const windowless: ContextWindowFrame = { used_percentage: 0 };
    expect(drawnAt(box, windowless, T0 + CONTEXT_RECORD_MAX_AGE_MS)?.used_percentage).toBe(GOOD_PERCENT);
    expect(drawnAt(box, windowless, T0 + 2 * CONTEXT_RECORD_MAX_AGE_MS)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("restores a record exactly its maximum age old and reads one older as none", () => {
    const atAge = machine();
    drawnAt(atAge, GOOD, T0);
    expect(drawnAt(atAge, ZERO, T0 + CONTEXT_RECORD_MAX_AGE_MS)?.used_percentage).toBe(GOOD_PERCENT);
    const pastAge = machine();
    drawnAt(pastAge, GOOD, T0);
    expect(drawnAt(pastAge, ZERO, T0 + CONTEXT_RECORD_MAX_AGE_MS + 1)).toBe(ZERO);
  });

  it.each([HOURS_PER_DAY * HOUR_MS, CONTEXT_RECORD_MAX_AGE_MS + 1, CONTEXT_RECORDS_FUTURE_MS])("restores a record stamped %d ms later than now, as a clock set back leaves it, as claude-hud draws one", (aheadMs) => {
    const box = machine();
    drawnAt(box, GOOD, T0 + aheadMs);
    expect(drawnAt(box, ZERO, T0)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("writes a restored frame back, so a record still being restored is measured for age from its last restore", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    expect(drawnAt(box, ZERO, T0 + CONTEXT_RECORD_MAX_AGE_MS)?.used_percentage).toBe(GOOD_PERCENT);
    expect(drawnAt(box, ZERO, T0 + 2 * CONTEXT_RECORD_MAX_AGE_MS)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("keeps no frame that reports a percentage without a window above 0", () => {
    for (const windowTokens of [undefined, EMPTY_WINDOW, NEGATIVE_WINDOW]) {
      const box = machine();
      drawnAt(box, { ...GOOD, context_window_size: windowTokens }, T0);
      expect(drawnAt(box, ZERO, T0 + SECOND)).toBe(ZERO);
    }
  });

  it("keeps a frame that reports a percentage over any window above 0, one of a token or less included, as claude-hud's `hasGoodContext` keeps it", () => {
    for (const windowTokens of [FRACTION_OF_A_TOKEN_WINDOW, ONE_TOKEN_WINDOW]) {
      const box = machine();
      drawnAt(box, { ...GOOD, context_window_size: windowTokens }, T0);
      expect(drawnAt(box, { used_percentage: 0 }, T0 + SECOND)).toEqual({ used_percentage: GOOD_PERCENT, total_input_tokens: GOOD_HELD, current_usage: GOOD.current_usage, context_window_size: windowTokens });
    }
  });

  it("reads a record that is not JSON, or JSON of another shape (any field, or any counter of its last request, of another type), as none", () => {
    const file = cacheFileFor(fakeStatuslinePorts(), "context", TRANSCRIPT);
    expect(drawnAt(machine({ [file]: "not json" }), ZERO, T0)).toBe(ZERO);
    expect(drawnAt(machine({ [file]: JSON.stringify({ savedAtMs: T0, usedPercentage: "40" }) }), ZERO, T0)).toBe(ZERO);
    const written = { savedAtMs: T0 - SECOND, observedAtMs: T0 - SECOND, usedPercentage: GOOD_PERCENT, windowTokens: WINDOW };
    expect(drawnAt(machine({ [file]: JSON.stringify(written) }), ZERO, T0)?.used_percentage).toBe(GOOD_PERCENT);
    const withoutObservedAt = { savedAtMs: written.savedAtMs, usedPercentage: written.usedPercentage, windowTokens: written.windowTokens };
    const usageWithAddedField = { ...written, currentUsage: { ...ZERO_USAGE, cache_creation: { ephemeral_5m_input_tokens: GOOD_INPUT } } };
    const complete = { ...written, totalInputTokens: GOOD_HELD, currentUsage: ZERO_USAGE };
    expect(drawnAt(machine({ [file]: JSON.stringify(complete) }), ZERO, T0)?.total_input_tokens).toBe(GOOD_HELD);
    // Each field the record holds, and each counter of its last request, set in turn to its JSON text and to null.
    const fieldsOfAnotherType = [...Object.entries(complete).flatMap(([field, value]) => [{ ...complete, [field]: JSON.stringify(value) }, { ...complete, [field]: null }]), ...Object.entries(ZERO_USAGE).flatMap(([counter, value]) => [{ ...complete, currentUsage: { ...ZERO_USAGE, [counter]: String(value) } }, { ...complete, currentUsage: { ...ZERO_USAGE, [counter]: null } }])];
    for (const other of [withoutObservedAt, { ...written, sessionName: "s" }, usageWithAddedField, ...fieldsOfAnotherType]) {
      expect(drawnAt(machine({ [file]: JSON.stringify(other) }), ZERO, T0)).toBe(ZERO);
      expect(drawnAt(machine({ [file]: JSON.stringify(other) }), ZERO, T0, { atMs: T0 - EARLY_COMPACTION_AGE_MS, postTokens: POST_TOKENS })?.used_percentage).toBe(POST_PERCENT);
    }
  });

  it("restores a record holding a negative percentage as it stands, as claude-hud restores any finite one", () => {
    const file = cacheFileFor(fakeStatuslinePorts(), "context", TRANSCRIPT);
    const negative = { savedAtMs: T0 - SECOND, observedAtMs: T0 - SECOND, usedPercentage: NEGATIVE_PERCENT, windowTokens: WINDOW };
    expect(drawnAt(machine({ [file]: JSON.stringify(negative) }), ZERO, T0)).toEqual({ ...ZERO, used_percentage: NEGATIVE_PERCENT, total_input_tokens: undefined, current_usage: undefined });
  });

  it("restores a record whose reading was taken before the epoch, as a frame drawn from a compaction stamped then is kept", () => {
    const box = machine();
    const beforeEpoch: Compaction = { atMs: -SECOND, postTokens: POST_TOKENS };
    expect(drawnAt(box, ZERO, T0, beforeEpoch)?.used_percentage).toBe(POST_PERCENT);
    expect(drawnAt(box, ZERO, T0 + SECOND)?.used_percentage).toBe(POST_PERCENT);
  });

  it("restores a record holding a percentage of 0 as that 0, in place of the frame's own percentage, none or negative zero", () => {
    const file = cacheFileFor(fakeStatuslinePorts(), "context", TRANSCRIPT);
    const nothing = { savedAtMs: T0 - SECOND, observedAtMs: T0 - SECOND, usedPercentage: 0, windowTokens: WINDOW };
    for (const zero of [{ context_window_size: WINDOW }, { ...ZERO, used_percentage: NEGATIVE_ZERO }]) {
      expect(Object.is(drawnAt(machine({ [file]: JSON.stringify(nothing) }), zero, T0)?.used_percentage, 0)).toBe(true);
    }
  });

  it.each([FRACTION_OF_A_PERCENT, FULL_PERCENT])("keeps a frame reporting %s percent, as claude-hud keeps any percentage above 0", (percent) => {
    const box = machine();
    drawnAt(box, { ...GOOD, used_percentage: percent }, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND)?.used_percentage).toBe(percent);
  });

  it("restores a record that holds no tokens figure without one, rather than beside the zero frame's own", () => {
    const box = machine();
    const unheld: ContextWindowFrame = { context_window_size: WINDOW, used_percentage: GOOD_PERCENT, current_usage: GOOD.current_usage };
    drawnAt(box, unheld, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND)).toEqual({ ...ZERO, used_percentage: GOOD_PERCENT, total_input_tokens: undefined, current_usage: GOOD.current_usage });
  });

  it("keeps the last request's four counters alone, so a frame whose last request carries other fields writes a record that loads again", () => {
    const box = machine();
    const payload = parseClientPayload({ context_window: { ...GOOD, current_usage: { ...GOOD.current_usage, cache_creation: { ephemeral_5m_input_tokens: GOOD_INPUT } } } });
    drawnAt(box, payload.context_window, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND)).toEqual({ ...ZERO, used_percentage: GOOD_PERCENT, total_input_tokens: GOOD_HELD, current_usage: GOOD.current_usage });
  });

  it("drops a write that cannot be made and draws what it would otherwise: a record it can still read, a compaction's percentage, or the frame as it stands", () => {
    const unwritable = fakeStatuslinePorts();
    const at = (ports: StatuslinePorts, frame: ContextWindowFrame, compaction?: Compaction): ContextWindowFrame | undefined => contextFrameOf({ ports, transcriptPath: TRANSCRIPT, frame, drawsPercent: false, nowMs: T0, compaction: () => compaction });
    expect(at(unwritable, GOOD)).toBe(GOOD);
    expect(at(unwritable, ZERO)).toBe(ZERO);
    expect(at(unwritable, ZERO, { atMs: T0 - SECOND, postTokens: POST_TOKENS })?.used_percentage).toBe(POST_PERCENT);
    // A record written before the session state became read-only.
    const box = machine();
    drawnAt(box, GOOD, T0 - SECOND);
    const readOnly: StatuslinePorts = { ...box.ports, writeText: () => undefined };
    expect(at(readOnly, ZERO)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("keeps the records with the latest file modification times up to the cap, removing the earliest when a new one would pass it", () => {
    const box = machine();
    const transcripts = Array.from({ length: MAX_CONTEXT_RECORDS + 1 }, (_, index) => `/home/test/.claude/projects/p/s${String(index)}.jsonl`);
    transcripts.forEach((transcript, index) => {
      drawnAt(box, GOOD, T0 + index * SECOND, undefined, transcript);
    });
    const kept = (transcript: string): boolean => box.files.has(cacheFileFor(box.ports, "context", transcript));
    expect(transcripts.filter(kept)).toEqual(transcripts.slice(1));
    // Rewriting a record already kept adds none, so nothing more is removed.
    drawnAt(box, LATER, T0 + transcripts.length * SECOND, undefined, transcripts[1]);
    expect(transcripts.filter(kept)).toEqual(transcripts.slice(1));
  });

  it("removes the record with the earliest file modification time past the cap, whatever order the directory lists the records in", () => {
    const box = machine();
    const transcriptAt = (index: number): string => `/home/test/.claude/projects/p/s${String(index)}.jsonl`;
    const transcripts = Array.from({ length: MAX_CONTEXT_RECORDS }, (_, index) => transcriptAt(index));
    const recordOf = (transcript: string): string => path.normalize(cacheFileFor(box.ports, "context", transcript));
    transcripts.forEach((transcript) => {
      drawnAt(box, GOOD, T0, undefined, transcript);
    });
    // The directory lists the records in the order they were written, the first written listed first; their file times run the other way, and one in the middle is the earliest of all.
    transcripts.forEach((transcript, index) => {
      box.mtimes.set(recordOf(transcript), T0 - index * SECOND);
    });
    const earliest = transcriptAt(MIDDLE_RECORD);
    box.mtimes.set(recordOf(earliest), T0 - transcripts.length * SECOND);
    drawnAt(box, GOOD, T0 + SECOND);
    expect(transcripts.filter((transcript) => !box.files.has(recordOf(transcript)))).toEqual([earliest]);
  });

  it("removes, among records past the cap whose file modification times tie, the one the directory lists first, as claude-hud's sweep keeps the listing order of a tie", () => {
    const box = machine();
    const transcripts = Array.from({ length: MAX_CONTEXT_RECORDS }, (_, index) => `/home/test/.claude/projects/p/s${String(index)}.jsonl`);
    const nameOf = (transcript: string): string => path.basename(cacheFileFor(box.ports, "context", transcript));
    transcripts.forEach((transcript) => {
      drawnAt(box, GOOD, T0, undefined, transcript);
    });
    // The directory lists the record whose name falls in the middle of the records' names first and the rest by name, so the record listed first is neither the first nor the last by name in either order.
    const first = [...transcripts].sort((left, right) => nameOf(left).localeCompare(nameOf(right)))[MIDDLE_RECORD];
    if (first === undefined) {
      throw new Error("no record falls in the middle");
    }
    const listed: StatuslinePorts = {
      ...box.ports,
      listDirectory: (target) => {
        const names = box.ports.listDirectory(target);
        return names === undefined ? undefined : [nameOf(first), ...names.filter((name) => name !== nameOf(first)).sort()];
      },
    };
    box.at(T0 + SECOND);
    contextFrameOf({ ports: listed, transcriptPath: TRANSCRIPT, frame: GOOD, drawsPercent: false, nowMs: T0 + SECOND, compaction: () => undefined });
    expect(transcripts.filter((transcript) => !box.files.has(cacheFileFor(box.ports, "context", transcript)))).toEqual([first]);
  });

  it("removes the record just written when the clock has been set back behind the file times of the records at the cap, as claude-hud's sweep removes it, and keeps it otherwise", () => {
    const transcripts = Array.from({ length: MAX_CONTEXT_RECORDS }, (_, index) => `/home/test/.claude/projects/p/s${String(index)}.jsonl`);
    const afterCapAt = (writtenAtMs: number): ContextWindowFrame | undefined => {
      const box = machine();
      transcripts.forEach((transcript, index) => {
        drawnAt(box, GOOD, writtenAtMs + index * SECOND, undefined, transcript);
      });
      drawnAt(box, LATER, T0);
      return drawnAt(box, ZERO, T0 + SECOND);
    };
    expect(afterCapAt(T0 + HOUR_MS)).toBe(ZERO);
    expect(afterCapAt(T0 - HOUR_MS)?.used_percentage).toBe(LATER_PERCENT);
  });

  it("removes every record past the cap in one write, however many the directory holds", () => {
    const box = machine();
    const transcripts = Array.from({ length: MAX_CONTEXT_RECORDS + RECORDS_PAST_CAP }, (_, index) => `/home/test/.claude/projects/p/s${String(index)}.jsonl`);
    const recordOf = (transcript: string): string => cacheFileFor(box.ports, "context", transcript);
    // Records another writer left past the cap, written straight to the directory.
    transcripts.forEach((transcript, index) => {
      box.at(T0 + index * SECOND);
      box.ports.writeText(recordOf(transcript), "{}");
    });
    drawnAt(box, GOOD, T0 + transcripts.length * SECOND);
    const kept = [...transcripts, TRANSCRIPT].filter((transcript) => box.files.has(recordOf(transcript)));
    expect(kept).toEqual([...transcripts.slice(RECORDS_PAST_CAP + 1), TRANSCRIPT]);
  });

  it("neither counts nor removes a record whose time of writing cannot be read, as claude-hud's sweep skips a file it cannot stat", () => {
    const box = machine();
    const transcripts = Array.from({ length: MAX_CONTEXT_RECORDS + 1 }, (_, index) => `/home/test/.claude/projects/p/s${String(index)}.jsonl`);
    const recordOf = (transcript: string): string => cacheFileFor(box.ports, "context", transcript);
    transcripts.forEach((transcript, index) => {
      drawnAt(box, GOOD, T0 + index * SECOND, undefined, transcript);
      if (index === 0) {
        box.mtimes.delete(path.normalize(recordOf(transcript)));
      }
    });
    expect(transcripts.filter((transcript) => box.files.has(recordOf(transcript)))).toEqual(transcripts);
  });

  it("scans the session state for the cap when a record is written for a transcript that had no record file, and neither when a write within the interval is skipped nor when a later write replaces that record", () => {
    const box = machine();
    let scans = 0;
    const counted: StatuslinePorts = {
      ...box.ports,
      listDirectory: (directory) => {
        scans += 1;
        return box.ports.listDirectory(directory);
      },
    };
    const draw = (frame: ContextWindowFrame, nowMs: number): void => {
      box.at(nowMs);
      contextFrameOf({ ports: counted, transcriptPath: TRANSCRIPT, frame, drawsPercent: false, nowMs, compaction: () => undefined });
    };
    draw(GOOD, T0);
    const scansForNew = scans;
    expect(scansForNew).toBeGreaterThan(0);
    draw(LATER, T0 + CONTEXT_WRITE_INTERVAL_MS - 1);
    expect(box.files.get(cacheFileFor(box.ports, "context", TRANSCRIPT))).toContain(`"usedPercentage":${String(GOOD_PERCENT)}`);
    expect(scans).toBe(scansForNew);
    draw(LATER, T0 + CONTEXT_WRITE_INTERVAL_MS);
    expect(box.files.get(cacheFileFor(box.ports, "context", TRANSCRIPT))).toContain(`"usedPercentage":${String(LATER_PERCENT)}`);
    expect(scans).toBe(scansForNew);
  });

  it("scans the session state for the cap on a failed write for a transcript with no record file as on one that succeeds, and again on the next, since that transcript still has none", () => {
    const scansOf = (failWrites: boolean): number[] => {
      const box = machine();
      let scans = 0;
      const counted: StatuslinePorts = {
        ...box.ports,
        ...(failWrites ? { writeText: () => undefined } : {}),
        listDirectory: (directory) => {
          scans += 1;
          return box.ports.listDirectory(directory);
        },
      };
      return [GOOD, LATER].map((frame, index) => {
        const nowMs = T0 + index * CONTEXT_WRITE_INTERVAL_MS;
        box.at(nowMs);
        const before = scans;
        contextFrameOf({ ports: counted, transcriptPath: TRANSCRIPT, frame, drawsPercent: false, nowMs, compaction: () => undefined });
        return scans - before;
      });
    };
    const [firstWritten] = scansOf(false);
    expect(scansOf(true)).toEqual([firstWritten, firstWritten]);
  });

  it("leaves the session state that is not a context record alone when it removes records past the cap", () => {
    const box = machine();
    const contextRecord = cacheFileFor(box.ports, "context", TRANSCRIPT);
    // Another kind's files, a file that shares the records' prefix but is not JSON, one with the prefix whose name ends in `json` with no dot before it, one with the prefix whose name holds `.json` but does not end in it, a JSON file whose name starts with the kind's word but not its prefix, and one whose name has the prefix in capitals.
    const others = [...["transcript", "speed"].map((kind) => cacheFileFor(box.ports, kind, TRANSCRIPT)), ...["context-notes", "context-foreignjson", "context-notes.json.bak", "contextual.json", "CONTEXT-notes.json"].map((name) => path.join(path.dirname(contextRecord), name))];
    for (const other of others) {
      box.ports.writeText(other, "{}");
      box.mtimes.set(path.normalize(other), T0 - SECOND);
    }
    Array.from({ length: MAX_CONTEXT_RECORDS + 1 }, (_, index) => `/home/test/.claude/projects/p/s${String(index)}.jsonl`).forEach((transcript, index) => {
      drawnAt(box, GOOD, T0 + index * SECOND, undefined, transcript);
    });
    expect(others.filter((other) => box.files.has(other))).toEqual(others);
  });
});

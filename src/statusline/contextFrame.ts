import path from "node:path";

import { z } from "zod";

import { cacheFileFor, loadCache, saveCache, transcriptKeyOf } from "./cacheFile";
import type { ContextWindowFrame } from "./payload";
import type { StatuslinePorts } from "./ports";
import { FULL_PERCENT } from "./style";
import type { Compaction } from "./transcript/session";

/** The kind of cache file the last good frame of a transcript is kept in. */
const CACHE_KIND = "context";

/** The shortest time between two writes of one transcript's record, as claude-hud's `WRITE_TTL_MS`: the statusline refreshes in bursts while a response streams, and a good frame is not written while the last write is less than this before the clock, which a last write stamped ahead of the clock always is, so the steady state costs a check of the file's time rather than a write. */
export const CONTEXT_WRITE_INTERVAL_MS = 3_000;

const RECORD_MAX_AGE_DAYS = 7;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1_000;

/** How old a record may be and still be drawn, as claude-hud's `MAX_CACHE_AGE_MS`, after which its sweep removes the file: a record last written longer ago than this is read as absent, and its file is left for the cap (`MAX_CONTEXT_RECORDS`) or the retention of the statusline's session state (`CACHE_RETENTION_MS`) to remove. */
export const CONTEXT_RECORD_MAX_AGE_MS = RECORD_MAX_AGE_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** The most records kept, as claude-hud's `MAX_CACHE_ENTRIES`: each time a write is attempted for a transcript whose record path holds anything but an entry that is itself a regular file (nothing, for a new record; see `saveCache`), the records beyond this with the earliest file modification times are removed (see `capRecords`). */
export const MAX_CONTEXT_RECORDS = 100;

const UsageSchema = z.strictObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});

/** What is kept of a transcript's last good frame: when the record was last written, when the reading behind the frame it keeps was taken (see `observedAtMs`), and the frame's fields the context row draws from. */
const ContextRecordSchema = z.strictObject({
  /** When the record was last written, a restored frame written back included: the record's age is measured from it. */
  savedAtMs: z.number(),
  /** When the reading behind the frame the record keeps was taken: the refresh that drew it from the client's own report, or the compaction it was drawn from (that compaction's own time). A restored frame written back keeps the time of the frame it restores, so the compaction guard compares a compaction with the time of the reading itself. */
  observedAtMs: z.number(),
  usedPercentage: z.number(),
  totalInputTokens: z.number().optional(),
  windowTokens: z.number().optional(),
  currentUsage: UsageSchema.optional(),
});

type ContextRecord = z.infer<typeof ContextRecordSchema>;

/** Whether a figure is absent or 0, as claude-hud's `?? 0` comparisons judge one: a negative figure is something, not nothing. */
function isNothing(value: number | undefined): boolean {
  return value === undefined || value === 0;
}

/**
 * Whether a frame looks like the client's glitch rather than a reading, as claude-hud's `isSuspiciousZero` judges it: it reports no percentage or 0, and no `current_usage` or each of its four counters absent or 0 (a negative percentage or counter is neither, so such a frame is a reading). A field of the wrong type is read as absent here, as the payload reads it everywhere (see `parseClientPayload`).
 */
function isSuspiciousZero(frame: ContextWindowFrame): boolean {
  const usage = frame.current_usage;
  const usageEmpty = usage === undefined || (isNothing(usage.input_tokens) && isNothing(usage.output_tokens) && isNothing(usage.cache_creation_input_tokens) && isNothing(usage.cache_read_input_tokens));
  return isNothing(frame.used_percentage) && usageEmpty;
}

/** The percentage of a frame worth keeping, as claude-hud's `hasGoodContext` judges one: a frame that reports a window above 0 and a percentage above 0. Undefined for any other frame. */
function goodPercentOf(frame: ContextWindowFrame): number | undefined {
  const { context_window_size: windowTokens, used_percentage: usedPercentage } = frame;
  return windowTokens !== undefined && windowTokens > 0 && usedPercentage !== undefined && usedPercentage > 0 ? usedPercentage : undefined;
}

/** The frame with the percentage the compaction left (its `postTokens` over the frame's own window), or the frame as it is when the compaction holds no count of 1 or more (`postTokens`, a finite count the transcript reader truncated to a whole token) or the frame reports no window above 0. */
function afterCompaction(frame: ContextWindowFrame, compaction: Readonly<Compaction>): ContextWindowFrame {
  const { postTokens } = compaction;
  const windowTokens = frame.context_window_size;
  if (postTokens === undefined || postTokens <= 0 || windowTokens === undefined || windowTokens <= 0) {
    return frame;
  }
  return { ...frame, used_percentage: Math.min(FULL_PERCENT, (postTokens / windowTokens) * FULL_PERCENT) };
}

/** The frame with the record's percentage, tokens and last request in place of its own, and the record's window where the frame reports no window at all (a window of 0 or below is the frame's own and stays). */
function restored(frame: ContextWindowFrame, record: ContextRecord): ContextWindowFrame {
  return { ...frame, used_percentage: record.usedPercentage, total_input_tokens: record.totalInputTokens, current_usage: record.currentUsage, context_window_size: frame.context_window_size ?? record.windowTokens };
}

/** The record of a good frame drawn from a reading taken at `observedAtMs`. The last request's four counters are kept by name, since the payload's object may carry fields the record does not. */
function recordOf(frame: ContextWindowFrame, usedPercentage: number, observedAtMs: number, nowMs: number): ContextRecord {
  const usage = frame.current_usage;
  return {
    savedAtMs: nowMs,
    observedAtMs,
    usedPercentage,
    totalInputTokens: frame.total_input_tokens,
    windowTokens: frame.context_window_size,
    currentUsage: usage === undefined ? undefined : { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens },
  };
}

/** Removes the context records beyond `MAX_CONTEXT_RECORDS` with the earliest file modification times from `directory`, as claude-hud's sweep orders them, records whose times tie taken in the order the directory lists them. A context record is an entry that is itself a regular file (`StatuslinePorts.entryKind` names it `file`, so a symbolic link is not one even to a regular file, as claude-hud's sweep takes only such entries), whose name starts with the kind's prefix and ends in `.json`; every other entry is neither counted nor removed, since the directory holds the statusline's other session state too. A write sets a file's modification time to the clock's time, so after the clock is set back behind the times of the records kept, the record just written is the one removed; a record whose modification time cannot be read is neither counted nor removed. */
function capRecords(ports: StatuslinePorts, directory: string): void {
  const names = ports.listDirectory(directory);
  if (names === undefined) {
    return;
  }
  const records = names
    .filter((name) => name.startsWith(`${CACHE_KIND}-`) && name.endsWith(".json"))
    .flatMap((name) => {
      const file = path.join(directory, name);
      const modifiedAtMs = ports.entryKind(file) === "file" ? ports.modifiedAtMs(file) : undefined;
      return modifiedAtMs === undefined ? [] : [{ file, modifiedAtMs }];
    })
    .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
  for (const { file } of records.slice(0, Math.max(0, records.length - MAX_CONTEXT_RECORDS))) {
    ports.removePath(file);
  }
}

/** Keeps a good frame, drawn from a reading taken at `observedAtMs`, as the transcript's record, unless the record's last write is less than `CONTEXT_WRITE_INTERVAL_MS` before `nowMs`, which one stamped after `nowMs` always is; a write attempted where anything but an entry that is itself a regular file is at the record's path (see `saveCache`), whether or not it succeeds, removes the records past `MAX_CONTEXT_RECORDS` with the earliest file modification times (see `capRecords`). */
function remember(ports: StatuslinePorts, file: string, frame: ContextWindowFrame, usedPercentage: number, observedAtMs: number, nowMs: number): void {
  const modifiedAtMs = ports.modifiedAtMs(file);
  if (modifiedAtMs !== undefined && nowMs - modifiedAtMs < CONTEXT_WRITE_INTERVAL_MS) {
    return;
  }
  if (saveCache(ports, file, recordOf(frame, usedPercentage, observedAtMs, nowMs), nowMs)) {
    capRecords(ports, path.dirname(file));
  }
}

/** What `contextFrameOf` reads. */
export interface ContextFrameInput {
  readonly ports: StatuslinePorts;
  /** The transcript path the payload names, which the record is kept by as `transcriptKeyOf` gives it, as claude-hud keys its own: a record is shared by every refresh whose path resolves to the same one. */
  readonly transcriptPath: string | undefined;
  /** The context window as this frame of the payload reports it. */
  readonly frame: ContextWindowFrame | undefined;
  /** Whether the percentage of the window in use the context row works out from `frame` as it stands is above 0 when rounded to the one decimal the row rounds the percentage of the window in use to (so one written as `0.0` is not, nor one the row does not draw), whatever figure `context.value` has the row write from it (100 less it for `remaining`, the tokens held for `tokens`). For a frame reporting 0 or no percentage that is an estimate from the tokens it holds (`total_input_tokens`), which claude-hud does not read: such a frame is a reading, and is drawn as it stands. It is weighed only for a frame that is a suspicious zero (see `isSuspiciousZero`): any other frame is drawn as it stands whatever it says. */
  readonly drawsPercent: boolean;
  readonly nowMs: number;
  /** The newest compaction the transcript records, asked for only when the frame is a suspicious zero, so a refresh that draws a good frame never reads the transcript for it. */
  readonly compaction: () => Compaction | undefined;
}

/**
 * The context window frame the statusline's elements draw from (see `RenderContext.contextFrame`), as claude-hud's `applyContextWindowFallback` chooses the frame its whole payload carries. A frame that is a suspicious zero (see `isSuspiciousZero`) and whose percentage of the window in use, as the context row works it out, is not above 0 when rounded to the one decimal the row rounds it to (`drawsPercent` false) is rewritten. When the transcript records a compaction later than the reading the transcript's last good frame was drawn from, or there is no last good frame, it is given the percentage that compaction left (its `postTokens` over the frame's window), or kept as it stands when the compaction holds no count of 1 or more (its `postTokens`, truncated to a whole token) or the frame reports no window above 0, since a compaction since the reading means the last good frame is from before it. Otherwise it is given the last good frame's percentage, tokens and last request (and its window where the frame reports none) when there is one, and kept as it stands when there is none. Every other frame is kept as it stands. Each element then reads the frame as it would the payload's own, so a row measuring tokens against a set window (`context.autoCompactWindow`) reads the tokens and not the percentage. Afterwards the frame, when it carries a window and a percentage above 0 (the client's own or one given it here, never an estimate a row makes), becomes the transcript's last good frame, unless that was last written less than `CONTEXT_WRITE_INTERVAL_MS` before `nowMs`, which one stamped after `nowMs` always is; for the compaction guard, a frame the client reported is kept as observed now, one given a compaction's percentage as observed at the compaction's time, and a restored frame written back keeps the time of the reading it restores, and each write refreshes the record's age. With no transcript, or a path `transcriptKeyOf` gives no key for, there is nothing to keep a frame by and the frame is kept as it stands; a record that is absent, unreadable, of another shape or written longer than `CONTEXT_RECORD_MAX_AGE_MS` ago is read as none (one stamped later than `nowMs`, as a clock set back leaves it, is drawn, as claude-hud draws it), and a write that fails is dropped, so the next good frame writes it again. Returns the same object when the frame is kept as it stands.
 */
export function contextFrameOf(input: Readonly<ContextFrameInput>): ContextWindowFrame | undefined {
  const { ports, transcriptPath, frame, nowMs } = input;
  const key = transcriptPath === undefined ? undefined : transcriptKeyOf(ports, transcriptPath);
  if (frame === undefined || key === undefined) {
    return frame;
  }
  const file = cacheFileFor(ports, CACHE_KIND, key);
  let drawn = frame;
  let observedAtMs = nowMs;
  if (isSuspiciousZero(frame) && !input.drawsPercent) {
    const loaded = loadCache(ports, file, ContextRecordSchema);
    const record = loaded !== undefined && nowMs - loaded.savedAtMs <= CONTEXT_RECORD_MAX_AGE_MS ? loaded : undefined;
    const compaction = input.compaction();
    if (compaction !== undefined && (record === undefined || compaction.atMs > record.observedAtMs)) {
      drawn = afterCompaction(frame, compaction);
      // Kept as observed when the compaction happened, not now, so a later compaction the transcript reader has not reached yet still wins the guard once it is read.
      observedAtMs = compaction.atMs;
    } else if (record !== undefined) {
      drawn = restored(frame, record);
      observedAtMs = record.observedAtMs;
    }
  }
  const goodPercent = goodPercentOf(drawn);
  if (goodPercent !== undefined) {
    remember(ports, file, drawn, goodPercent, observedAtMs, nowMs);
  }
  return drawn;
}

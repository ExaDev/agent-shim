import { createHash } from "node:crypto";

import { z } from "zod";

import { cacheFileFor, loadCache, saveCache } from "../cacheFile";
import type { StatuslinePorts } from "../ports";
import { parseTranscriptRecord, type TranscriptRecord } from "./record";
import { EMPTY_TOKEN_STATE, foldTokens, TokenStateSchema, type SessionTokens, type TokenState } from "./tokens";
import { EMPTY_LATEST_STATE, EMPTY_SESSION_STATE, foldLatest, foldSession, LatestStateSchema, SessionStateSchema, sessionFactsOf, type LatestState, type SessionFacts, type SessionState } from "./session";

/** The most bytes one read of a transcript takes in. A transcript grows to many megabytes and the statusline reads it at every refresh, so the work is bounded by bytes: a refresh reads at most this much from where the last one stopped, and a transcript that has grown by more than this since (or that has never been read) is caught up over several refreshes. */
export const MAX_TRANSCRIPT_READ_BYTES = 4_194_304;

/** The most of a transcript's first line that identifies it. A cache describes one file, and the file at a path can be replaced by another that is longer than the old one, so the cache keeps a digest of the first line (the first records of a session are written once and never change), cut at this many bytes for a line longer than that. */
export const FINGERPRINT_BYTES = 4_096;

const NEWLINE = 0x0a;

/** The kind of cache file the reader keeps, and the version of what it holds: a file of another version is read as absent. */
const CACHE_KIND = "transcript";
const CACHE_VERSION = 5;

const TranscriptCacheSchema = z.strictObject({
  version: z.literal(CACHE_VERSION),
  /** A digest of the transcript's first line when this was written: another file at the same path has another one. */
  fingerprint: z.string(),
  /** How far into the transcript the state has been folded: the start of a line, except while `skipping`. */
  offset: z.number().int().nonnegative(),
  /** False once a line was skipped without being folded, so the state is missing what it said for good. */
  complete: z.boolean(),
  /** True while the offset lies inside a line that was too big to read, which is passed a window at a time until its end. */
  skipping: z.literal(true).optional(),
  session: SessionStateSchema,
  tokens: TokenStateSchema,
  /** While the cumulative facts are being caught up, the latest-state facts folded from the end of the transcript, and where that fold has read to. Absent once the cumulative fold has reached the end, when it holds them itself. */
  newer: z.strictObject({ offset: z.number().int().nonnegative(), state: LatestStateSchema }).optional(),
});

type TranscriptCache = z.infer<typeof TranscriptCacheSchema>;

/** The cache without the end-of-transcript fold: what the cumulative fold carries on. */
type CumulativeCache = Omit<TranscriptCache, "newer">;

/**
 * What the transcript says, as the statusline's elements read it. A reader of another kind of fact (the tools, agents and todos a session shows) adds its own key beside `session`, folded from the same lines, and `bytes` and `complete` describe the read for all of them.
 */
export interface TranscriptFacts {
  /** The transcript's size in bytes when it was read. */
  readonly bytes: number;
  /** False while the reader is still catching up with a transcript bigger than a read takes in, or for good once it skipped a line bigger than a read, so a count over the whole session (compactions, tokens) may fall short of the truth. The facts that are the newest value of something are the end's even then. */
  readonly complete: boolean;
  readonly session: SessionFacts;
  /** The tokens the session has used, over every response read; short of the truth while `complete` is false. */
  readonly tokens: SessionTokens;
}

/** The records of the whole lines of `bytes`, in order, passed to `visit`, and how many bytes those lines took: only whole lines are taken, so a record the client is still writing is read at the next refresh. */
function eachRecord(bytes: Uint8Array, visit: (record: TranscriptRecord) => void): number {
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split("\n")) {
    const record = line === "" ? undefined : parseTranscriptRecord(line);
    if (record !== undefined) {
      visit(record);
    }
  }
  return end;
}

/** The session facts and token totals after the whole lines of `bytes`, and how many bytes those lines took. */
function foldLines(state: { readonly session: SessionState; readonly tokens: TokenState }, bytes: Uint8Array): { readonly session: SessionState; readonly tokens: TokenState; readonly consumed: number } {
  let session = state.session;
  let tokens = state.tokens;
  const consumed = eachRecord(bytes, (record) => {
    session = foldSession(session, record);
    tokens = foldTokens(tokens, record);
  });
  return { session, tokens, consumed };
}

/** A digest of the transcript's first line, or of its first `FINGERPRINT_BYTES` when that line is longer. A cache is written only once a line is complete, so the digest of a first line still being written is never kept. */
function fingerprintOf(head: Uint8Array): string {
  const newline = head.subarray(0, FINGERPRINT_BYTES).indexOf(NEWLINE);
  return createHash("sha256")
    .update(head.subarray(0, newline === -1 ? FINGERPRINT_BYTES : newline + 1))
    .digest("hex");
}

/** The facts of what the cache holds, whether or not the read that produced it reached the end of the transcript. Until it has, the cumulative facts lack what the rest of the transcript says, so the facts are not complete; the latest-state facts are the end's, which the cache holds separately. */
function factsOf(size: number, cache: TranscriptCache, reachedEnd: boolean): TranscriptFacts {
  return { bytes: size, complete: cache.complete && reachedEnd, session: sessionFactsOf(cache.session, cache.newer?.state), tokens: cache.tokens.totals };
}

/** What the state holds when a line that may have shown the session's start was skipped. */
const START_UNKNOWN: Pick<SessionState["cumulative"], "startUnknown"> = { startUnknown: true };

/**
 * `cache` moved on over `window`, the bytes that follow its offset. When the offset is inside a line that was skipped, the rest of that line is passed first. The whole lines of what is left are folded; a window that holds none is either a line still being written (when it reached the end of the transcript) or a line bigger than a window, which is skipped a window at a time and leaves the facts incomplete for good, with the session's start unknown if it was not yet seen.
 */
function advance(cache: CumulativeCache, window: Uint8Array, reachedEnd: boolean): CumulativeCache {
  let offset = cache.offset;
  let bytes = window;
  if (cache.skipping === true) {
    const lineEnd = bytes.indexOf(NEWLINE);
    if (lineEnd === -1) {
      // Still inside the line: nothing in this window is a line start.
      return { ...cache, offset: offset + bytes.length };
    }
    offset += lineEnd + 1;
    bytes = bytes.subarray(lineEnd + 1);
  }
  const { session: folded, tokens, consumed } = foldLines(cache, bytes);
  if (consumed === 0 && bytes.length > 0 && !reachedEnd) {
    const { cumulative } = cache.session;
    const session = cumulative.startedAtMs === undefined ? { ...cache.session, cumulative: { ...cumulative, ...START_UNKNOWN } } : cache.session;
    return { ...cache, offset: offset + bytes.length, complete: false, skipping: true, session };
  }
  return { version: cache.version, fingerprint: cache.fingerprint, offset: offset + consumed, complete: cache.complete, session: folded, tokens };
}

/**
 * What the session's transcript says, read through the ports and kept between refreshes. A refresh reads one window of the transcript, `MAX_TRANSCRIPT_READ_BYTES`, from where the cache ends (the start of the file when there is none) and folds its whole lines in order, so a transcript bigger than a window is caught up over successive refreshes. The facts that add up over the whole transcript are exact once the cache reaches the end of the file and marked incomplete until then; the facts that are the newest value of something are folded from the last window of the transcript while it is behind, and so are right at once. Each refresh reads at most two windows. A cache of another file, which the first line tells, is not used. A complete line bigger than a window is skipped without being read whole, and the facts stay incomplete for good, since what it said is lost. Returns undefined when the transcript cannot be read.
 */
export function readTranscript(ports: StatuslinePorts, transcriptPath: string, nowMs: number): TranscriptFacts | undefined {
  const file = cacheFileFor(ports, CACHE_KIND, transcriptPath);
  const loaded = loadCache(ports, file, TranscriptCacheSchema);
  const head = loaded === undefined ? undefined : ports.readRange(transcriptPath, 0, FINGERPRINT_BYTES);
  // A cache is for the file it was written from: a shorter file, or one that begins differently, has taken the path's place.
  const cached = loaded !== undefined && head !== undefined && head.size >= loaded.offset && fingerprintOf(head.bytes) === loaded.fingerprint ? loaded : undefined;
  const from = cached?.offset ?? 0;
  const window = ports.readRange(transcriptPath, from, MAX_TRANSCRIPT_READ_BYTES);
  if (window === undefined) {
    return undefined;
  }
  const { newer: previousNewer, ...base }: TranscriptCache = cached ?? { version: CACHE_VERSION, fingerprint: "", offset: 0, complete: true, session: EMPTY_SESSION_STATE, tokens: EMPTY_TOKEN_STATE };
  const reachedEnd = window.size - from <= MAX_TRANSCRIPT_READ_BYTES;
  const advanced = advance(base, window.bytes, reachedEnd);
  // While the cumulative facts are behind, the latest-state ones are folded from the end of the transcript, so what the session last did is not hidden for as many refreshes as the catching up takes.
  const newer = reachedEnd ? undefined : newerFrom(ports, transcriptPath, window.size, previousNewer);
  const next: TranscriptCache = { ...advanced, ...(newer === undefined ? {} : { newer }) };
  if (next.offset > base.offset) {
    // A cache is written only once a line is complete, so the digest of a first line still being written is never kept.
    saveCache(ports, file, { ...next, fingerprint: cached === undefined ? fingerprintOf(window.bytes) : base.fingerprint }, nowMs);
  }
  return factsOf(window.size, next, reachedEnd);
}

/**
 * The latest-state facts of the end of a transcript of `size` bytes, to carry in the cache: `previous` carried on over what was appended since when that is no more than a read, else the last read's worth of the transcript from its first whole line, folded from nothing. Nothing when no line starts inside that read.
 */
function newerFrom(ports: StatuslinePorts, transcriptPath: string, size: number, previous: TranscriptCache["newer"]): TranscriptCache["newer"] {
  if (previous !== undefined && previous.offset <= size && size - previous.offset <= MAX_TRANSCRIPT_READ_BYTES) {
    const appended = ports.readRange(transcriptPath, previous.offset, MAX_TRANSCRIPT_READ_BYTES);
    return appended === undefined ? undefined : foldNewer(previous.state, appended.bytes, previous.offset);
  }
  // One byte more than the window is read, so a window that starts exactly on a line is not mistaken for one that starts inside a line.
  const from = Math.max(0, size - MAX_TRANSCRIPT_READ_BYTES - 1);
  const tail = ports.readRange(transcriptPath, from, MAX_TRANSCRIPT_READ_BYTES + 1);
  if (tail === undefined) {
    return undefined;
  }
  const firstLine = from === 0 ? 0 : tail.bytes.indexOf(NEWLINE) + 1;
  return firstLine === 0 && from > 0 ? undefined : foldNewer(EMPTY_LATEST_STATE, tail.bytes.subarray(firstLine), from + firstLine);
}

/** The latest-state facts after the whole lines of `bytes`, which start at `offset`, with where they end. */
function foldNewer(state: LatestState, bytes: Uint8Array, offset: number): NonNullable<TranscriptCache["newer"]> {
  let folded = state;
  const consumed = eachRecord(bytes, (record) => {
    folded = foldLatest(folded, record);
  });
  return { offset: offset + consumed, state: folded };
}

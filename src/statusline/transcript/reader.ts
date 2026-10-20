import { createHash } from "node:crypto";

import { z } from "zod";

import { cacheFileFor, loadCache, pruneCache, saveCache } from "../cacheFile";
import type { FileRange, StatuslinePorts } from "../ports";
import { parseTranscriptRecord, recordTimeMs } from "./record";
import { EMPTY_SESSION_STATE, foldSession, SessionStateSchema, sessionFactsOf, type SessionFacts, type SessionState } from "./session";

/** The most bytes one read of a transcript takes in. A transcript grows to many megabytes and the statusline reads it at every refresh, so the work is bounded by bytes: a refresh reads only what was appended since the last one, and a transcript that has grown by more than this since it was last read (or that has never been read) is read from its end back this far. */
export const MAX_TRANSCRIPT_READ_BYTES = 4_194_304;

/** The most of a transcript's first line that identifies it. A cache describes one file, and the file at a path can be replaced by another that is longer than the old one, so the cache keeps a digest of the first line (the first records of a session are written once and never change), cut at this many bytes for a line longer than that. */
export const FINGERPRINT_BYTES = 4_096;

/** Thirty days: a transcript that has not grown for a month belongs to a session that is over, and each cache file is small enough that keeping one that long costs nothing worth a shorter limit. */
const RETENTION_DAYS = 30;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1_000;

/** How long a transcript's cache file may go without a write before it is removed. A write happens whenever new lines were read, so a file this old belongs to a transcript that has not grown for that long, and a session resumed after it simply reads its transcript afresh. */
export const TRANSCRIPT_CACHE_RETENTION_MS = RETENTION_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

const NEWLINE = 0x0a;

/** The kind of cache file the reader keeps, and the version of what it holds: a file of another version is read as absent. */
const CACHE_KIND = "transcript";
const CACHE_VERSION = 2;

const TranscriptCacheSchema = z.strictObject({
  version: z.literal(CACHE_VERSION),
  /** A digest of the transcript's first line when this was written: another file at the same path has another one. */
  fingerprint: z.string(),
  /** How far into the transcript the state has been folded: always the start of a line. */
  offset: z.number().int().nonnegative(),
  /** False once bytes were left unread, so the state may be missing records from before the part read. */
  complete: z.boolean(),
  session: SessionStateSchema,
});

type TranscriptCache = z.infer<typeof TranscriptCacheSchema>;

/**
 * What the transcript says, as the statusline's elements read it. A reader of another kind of fact (the tools, agents and todos a session shows) adds its own key beside `session`, folded from the same lines, and `bytes` and `complete` describe the read for all of them.
 */
export interface TranscriptFacts {
  /** The transcript's size in bytes when it was read. */
  readonly bytes: number;
  /** False when the transcript was bigger than a read takes in and its earlier part was left unread, so a count over the whole session (compactions) may fall short of the truth. */
  readonly complete: boolean;
  readonly session: SessionFacts;
}

/** The lines of a read as records, in order, and how many bytes they took: only whole lines are taken, so a record the client is still writing is read at the next refresh. */
function foldLines(state: SessionState, bytes: Uint8Array): { readonly state: SessionState; readonly consumed: number } {
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  let folded = state;
  for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split("\n")) {
    const record = line === "" ? undefined : parseTranscriptRecord(line);
    if (record !== undefined) {
      folded = foldSession(folded, record);
    }
  }
  return { state: folded, consumed: end };
}

/** The time of the first record that has one among the whole lines of `head`, the transcript's start read from the start of the file, which a read of its end cannot see. Undefined when none of them has a timestamp. */
function startOf(head: Uint8Array): number | undefined {
  const end = head.lastIndexOf(NEWLINE) + 1;
  const decoder = new TextDecoder();
  let from = 0;
  while (from < end) {
    const lineEnd = head.indexOf(NEWLINE, from);
    const record = parseTranscriptRecord(decoder.decode(head.subarray(from, lineEnd)));
    const atMs = record === undefined ? undefined : recordTimeMs(record);
    if (atMs !== undefined) {
      return atMs;
    }
    from = lineEnd + 1;
  }
  return undefined;
}

/** A digest of the transcript's first line, or of its first `FINGERPRINT_BYTES` when that line is longer. A cache is written only once a line is complete, so the digest of a first line still being written is never kept. */
function fingerprintOf(head: Uint8Array): string {
  const newline = head.subarray(0, FINGERPRINT_BYTES).indexOf(NEWLINE);
  return createHash("sha256")
    .update(head.subarray(0, newline === -1 ? FINGERPRINT_BYTES : newline + 1))
    .digest("hex");
}

/** The last `MAX_TRANSCRIPT_READ_BYTES` of a transcript from its first whole line, with where that line starts, or undefined when no line begins inside them. */
function readTail(ports: StatuslinePorts, file: string, size: number): { readonly bytes: Uint8Array; readonly offset: number } | undefined {
  // One byte more than the window is read, so a window that starts exactly on a line is not mistaken for one that starts inside a line.
  const from = Math.max(0, size - MAX_TRANSCRIPT_READ_BYTES - 1);
  const range = ports.readRange(file, from, MAX_TRANSCRIPT_READ_BYTES + 1);
  if (range === undefined) {
    return undefined;
  }
  const firstLine = from === 0 ? 0 : range.bytes.indexOf(NEWLINE) + 1;
  return firstLine === 0 && from > 0 ? undefined : { bytes: range.bytes.subarray(firstLine), offset: from + firstLine };
}

/** A read that found nothing new: the facts of what is already known. */
function factsOf(range: FileRange, cache: TranscriptCache): TranscriptFacts {
  return { bytes: range.size, complete: cache.complete, session: sessionFactsOf(cache.session) };
}

/** What the state holds when the part of the transcript that would show the session's start was left unread. */
const START_UNKNOWN: Pick<SessionState, "startUnknown"> = { startUnknown: true };

/**
 * What the session's transcript says, read through the ports and kept between refreshes. Only what has been appended since the cache was written is read, and never more than `MAX_TRANSCRIPT_READ_BYTES`: a transcript that has never been read, or has grown by more than that, is read from its end, its start time taken from its first lines when they hold one. A cache of another file, which the first line tells, is not used. Returns undefined when the transcript cannot be read.
 */
export function readTranscript(ports: StatuslinePorts, transcriptPath: string, nowMs: number): TranscriptFacts | undefined {
  const file = cacheFileFor(ports, CACHE_KIND, transcriptPath);
  const loaded = loadCache(ports, file, TranscriptCacheSchema);
  const head = loaded === undefined ? undefined : ports.readRange(transcriptPath, 0, FINGERPRINT_BYTES);
  // A cache is for the file it was written from: a shorter file, or one that begins differently, has taken the path's place.
  const cached = loaded !== undefined && head !== undefined && head.size >= loaded.offset && fingerprintOf(head.bytes) === loaded.fingerprint ? loaded : undefined;
  const from = cached?.offset ?? 0;
  const first = ports.readRange(transcriptPath, from, MAX_TRANSCRIPT_READ_BYTES);
  if (first === undefined) {
    return undefined;
  }
  const base: TranscriptCache = cached ?? { version: CACHE_VERSION, fingerprint: "", offset: 0, complete: true, session: EMPTY_SESSION_STATE };
  const fold = { ports, file, nowMs, range: first, created: cached === undefined, head: cached === undefined ? first.bytes : undefined };
  if (first.size - from <= MAX_TRANSCRIPT_READ_BYTES) {
    return foldInto({ ...fold, base, source: { bytes: first.bytes, offset: from } });
  }
  // What lies between the cache and the tail stays unread. A first read still wants the start, which only the head holds; with no timestamp in the head, or none read so far, the start is unknown, and a timestamp met later is not it.
  const startedAtMs = base.session.startedAtMs ?? (cached === undefined ? startOf(first.bytes) : undefined);
  const unread: TranscriptCache = { ...base, complete: false, session: startedAtMs === undefined ? { ...base.session, ...START_UNKNOWN } : { ...base.session, startedAtMs } };
  const tail = readTail(ports, transcriptPath, first.size);
  return tail === undefined ? factsOf(first, unread) : foldInto({ ...fold, base: unread, source: tail });
}

/** What `foldInto` takes: the ports and the cache file, the clock, the read that found the transcript's size, whether the cache is new and the transcript's head when it is, the cache to carry on from, and the bytes to fold into it with where they start. */
interface Fold {
  readonly ports: StatuslinePorts;
  readonly file: string;
  readonly nowMs: number;
  readonly range: FileRange;
  readonly created: boolean;
  readonly head: Uint8Array | undefined;
  readonly base: TranscriptCache;
  readonly source: { readonly bytes: Uint8Array; readonly offset: number };
}

/**
 * The facts after folding `source`'s whole lines into `base`, with the cache moved on to match. The cache moves on whenever its offset does, which includes a tail that holds no whole line but begins past the old offset: a line too long for a read leaves nothing to take, and the offset must still pass it or every refresh would read the same window again.
 */
function foldInto({ ports, file, nowMs, range, created, head, base, source }: Readonly<Fold>): TranscriptFacts {
  const { state, consumed } = foldLines(base.session, source.bytes);
  const next: TranscriptCache = { ...base, offset: source.offset + consumed, session: state };
  const fingerprint = created && head !== undefined ? fingerprintOf(head) : base.fingerprint;
  if (next.offset > base.offset) {
    saveCache(ports, file, { ...next, fingerprint });
    if (created) {
      // A transcript's first write is the moment to forget the sessions that are over; later writes would only repeat the directory scan.
      pruneCache(ports, nowMs - TRANSCRIPT_CACHE_RETENTION_MS);
    }
  }
  return factsOf(range, next);
}

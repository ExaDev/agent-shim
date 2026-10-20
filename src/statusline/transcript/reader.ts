import { createHash } from "node:crypto";

import { z } from "zod";

import { cacheFileFor, loadCache, saveCache } from "../cacheFile";
import type { StatuslinePorts } from "../ports";
import { parseTranscriptRecord } from "./record";
import { EMPTY_SESSION_STATE, foldSession, SessionStateSchema, sessionFactsOf, type SessionFacts, type SessionState } from "./session";

/** The most bytes one read of a transcript takes in. A transcript grows to many megabytes and the statusline reads it at every refresh, so the work is bounded by bytes: a refresh reads at most this much from where the last one stopped, and a transcript that has grown by more than this since (or that has never been read) is caught up over several refreshes. */
export const MAX_TRANSCRIPT_READ_BYTES = 4_194_304;

/** The most of a transcript's first line that identifies it. A cache describes one file, and the file at a path can be replaced by another that is longer than the old one, so the cache keeps a digest of the first line (the first records of a session are written once and never change), cut at this many bytes for a line longer than that. */
export const FINGERPRINT_BYTES = 4_096;

const NEWLINE = 0x0a;

/** The kind of cache file the reader keeps, and the version of what it holds: a file of another version is read as absent. */
const CACHE_KIND = "transcript";
const CACHE_VERSION = 3;

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
});

type TranscriptCache = z.infer<typeof TranscriptCacheSchema>;

/**
 * What the transcript says, as the statusline's elements read it. A reader of another kind of fact (the tools, agents and todos a session shows) adds its own key beside `session`, folded from the same lines, and `bytes` and `complete` describe the read for all of them.
 */
export interface TranscriptFacts {
  /** The transcript's size in bytes when it was read. */
  readonly bytes: number;
  /** False while the reader is still catching up with a transcript bigger than a read takes in, or for good once it skipped a line bigger than a read, so a count over the whole session (compactions) may fall short of the truth. */
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

/** A digest of the transcript's first line, or of its first `FINGERPRINT_BYTES` when that line is longer. A cache is written only once a line is complete, so the digest of a first line still being written is never kept. */
function fingerprintOf(head: Uint8Array): string {
  const newline = head.subarray(0, FINGERPRINT_BYTES).indexOf(NEWLINE);
  return createHash("sha256")
    .update(head.subarray(0, newline === -1 ? FINGERPRINT_BYTES : newline + 1))
    .digest("hex");
}

/** The facts of what the cache holds, whether or not the read that produced it reached the end of the transcript: until it has, the state lacks what the rest of the transcript says, so the facts are not complete. */
function factsOf(size: number, cache: TranscriptCache, reachedEnd: boolean): TranscriptFacts {
  return { bytes: size, complete: cache.complete && reachedEnd, session: sessionFactsOf(cache.session) };
}

/** What the state holds when a line that may have shown the session's start was skipped. */
const START_UNKNOWN: Pick<SessionState, "startUnknown"> = { startUnknown: true };

/**
 * `cache` moved on over `window`, the bytes that follow its offset. When the offset is inside a line that was skipped, the rest of that line is passed first. The whole lines of what is left are folded; a window that holds none is either a line still being written (when it reached the end of the transcript) or a line bigger than a window, which is skipped a window at a time and leaves the facts incomplete for good, with the session's start unknown if it was not yet seen.
 */
function advance(cache: TranscriptCache, window: Uint8Array, reachedEnd: boolean): TranscriptCache {
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
  const { state, consumed } = foldLines(cache.session, bytes);
  if (consumed === 0 && bytes.length > 0 && !reachedEnd) {
    const session = cache.session.startedAtMs === undefined ? { ...cache.session, ...START_UNKNOWN } : cache.session;
    return { ...cache, offset: offset + bytes.length, complete: false, skipping: true, session };
  }
  return { version: cache.version, fingerprint: cache.fingerprint, offset: offset + consumed, complete: cache.complete, session: state };
}

/**
 * What the session's transcript says, read through the ports and kept between refreshes. A refresh reads one window of the transcript, `MAX_TRANSCRIPT_READ_BYTES`, from where the cache ends (the start of the file when there is none) and folds its whole lines in order, so a transcript bigger than a window is caught up over successive refreshes, each bounded by one window, and the facts are exact once the cache reaches the end of the file; until then they are marked incomplete. A cache of another file, which the first line tells, is not used. A complete line bigger than a window is skipped without being read whole, and the facts stay incomplete for good, since what it said is lost. Returns undefined when the transcript cannot be read.
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
  const base: TranscriptCache = cached ?? { version: CACHE_VERSION, fingerprint: "", offset: 0, complete: true, session: EMPTY_SESSION_STATE };
  const reachedEnd = window.size - from <= MAX_TRANSCRIPT_READ_BYTES;
  const next = advance(base, window.bytes, reachedEnd);
  if (next.offset > base.offset) {
    // A cache is written only once a line is complete, so the digest of a first line still being written is never kept.
    saveCache(ports, file, { ...next, fingerprint: cached === undefined ? fingerprintOf(window.bytes) : base.fingerprint }, nowMs);
  }
  return factsOf(window.size, next, reachedEnd);
}

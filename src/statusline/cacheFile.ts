import { createHash } from "node:crypto";
import path from "node:path";
import type { z } from "zod";

import type { StatuslinePorts } from "./ports";

/** The directory of what the statusline learns about sessions between refreshes, under its state directory. */
const SESSION_CACHE_DIRECTORY = "session";

function cacheDirectory(ports: StatuslinePorts): string {
  return path.join(ports.stateDirectory, SESSION_CACHE_DIRECTORY);
}

/** The cache file one kind of state about one transcript lives in: named by the kind and a digest of the path it is given for the transcript, so each such path has one file of each kind. */
export function cacheFileFor(ports: StatuslinePorts, kind: string, transcriptPath: string): string {
  return path.join(cacheDirectory(ports), `${kind}-${createHash("sha256").update(transcriptPath).digest("hex")}.json`);
}

/** The path the statusline keeps a transcript's context record and speed sample by, as claude-hud keys its own: the transcript path with the white space around it removed, resolved against the directory the statusline runs in (`StatuslinePorts.absolutePath`). Undefined for a path of white space alone, which leaves nothing to keep state by. */
export function transcriptKeyOf(ports: StatuslinePorts, transcriptPath: string): string | undefined {
  const trimmed = transcriptPath.trim();
  return trimmed === "" ? undefined : ports.absolutePath(trimmed);
}

/** Thirty days: a transcript that has not grown for a month belongs to a session that is over, and each cache file is small enough that keeping one that long costs nothing worth a shorter limit. */
const RETENTION_DAYS = 30;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1_000;

/** How long a cache file may go without a write before it is removed. A write happens whenever there is something new to keep, so a file this old belongs to a session that has been quiet for that long, and a session resumed after it simply learns again. */
export const CACHE_RETENTION_MS = RETENTION_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** Removes the cache files last written before `cutoffMs` (milliseconds since the epoch), the ones of sessions that are over. */
function pruneCache(ports: StatuslinePorts, cutoffMs: number): void {
  const directory = cacheDirectory(ports);
  const names = ports.listDirectory(directory);
  if (names === undefined) {
    return;
  }
  for (const name of names) {
    const file = path.join(directory, name);
    const modifiedAtMs = ports.modifiedAtMs(file);
    if (modifiedAtMs !== undefined && modifiedAtMs < cutoffMs) {
      ports.removePath(file);
    }
  }
}

/** The text of a file of the statusline's own state, or undefined when it cannot be read or is not a regular file once a final symbolic link is followed (`StatuslinePorts.fileSize` gives it no size), in which case it is not opened, since opening a FIFO waits until something opens it for writing and would hold the render. */
export function readStateText(ports: StatuslinePorts, file: string): string | undefined {
  return ports.fileSize(file) === undefined ? undefined : ports.readText(file);
}

/** What a cache file holds, or undefined when it is absent, is not a regular file (see `readStateText`) or is not JSON of `schema`, so a file another release wrote or a write that was cut short is read as absent, never a failure. What that costs depends on the cache: one rebuilt from the transcript (the transcript reader's) costs a re-read, and one nothing rebuilds (the speed sample, the last good context frame) loses what it carried until its next write replaces it. */
export function loadCache<T>(ports: StatuslinePorts, file: string, schema: z.ZodType<T>): T | undefined {
  const text = readStateText(ports, file);
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Replaces a cache file with `value`, and returns whether anything but an entry that is itself a regular file was at its path before the write was attempted (`StatuslinePorts.entryKind` other than `file`, so nothing at all or a symbolic link, even to a regular file), whether or not the write then succeeds. Every kind of cache file goes through here, so the moment a new file first appears is the one place that forgets the files of sessions that are over: later writes of the same file would only repeat the directory scan. */
export function saveCache(ports: StatuslinePorts, file: string, value: unknown, nowMs: number): boolean {
  const isNew = ports.entryKind(file) !== "file";
  ports.writeText(file, JSON.stringify(value));
  if (isNew) {
    pruneCache(ports, nowMs - CACHE_RETENTION_MS);
  }
  return isNew;
}

import { createHash } from "node:crypto";
import path from "node:path";
import type { z } from "zod";

import type { StatuslinePorts } from "./ports";

/** The directory of what the statusline learns about sessions between refreshes, under its state directory. */
const SESSION_CACHE_DIRECTORY = "session";

function cacheDirectory(ports: StatuslinePorts): string {
  return path.join(ports.stateDirectory, SESSION_CACHE_DIRECTORY);
}

/** The cache file one kind of state about one transcript lives in: named by the kind and a digest of the transcript's path, so two sessions never share a file. */
export function cacheFileFor(ports: StatuslinePorts, kind: string, transcriptPath: string): string {
  return path.join(cacheDirectory(ports), `${kind}-${createHash("sha256").update(transcriptPath).digest("hex")}.json`);
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

/** What a cache file holds, or undefined when it is absent or is not JSON of `schema`: the cache is rebuilt from the transcript, so a file another release wrote or a write that was cut short costs a re-read, never a failure. */
export function loadCache<T>(ports: StatuslinePorts, file: string, schema: z.ZodType<T>): T | undefined {
  const text = ports.readText(file);
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

/** Replaces a cache file with `value`. Every kind of cache file goes through here, so the moment a new file first appears is the one place that forgets the files of sessions that are over: later writes of the same file would only repeat the directory scan. */
export function saveCache(ports: StatuslinePorts, file: string, value: unknown, nowMs: number): void {
  const isNew = ports.entryKind(file) === undefined;
  ports.writeText(file, JSON.stringify(value));
  if (isNew) {
    pruneCache(ports, nowMs - CACHE_RETENTION_MS);
  }
}

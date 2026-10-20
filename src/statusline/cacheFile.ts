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

/** Removes the cache files last written before `cutoffMs` (milliseconds since the epoch), the ones of sessions that are over. */
export function pruneCache(ports: StatuslinePorts, cutoffMs: number): void {
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

/** Replaces a cache file with `value`. */
export function saveCache(ports: StatuslinePorts, file: string, value: unknown): void {
  ports.writeText(file, JSON.stringify(value));
}

import path from "node:path";

import { z } from "zod";

import type { FarmFs } from "../launcher/ports";

/**
 * A file recording, per key, the instant up to which something has been dealt with: the front door's window keeper and job keeper both use one so a restart neither repeats nor skips what they already handled. Keys are identity or job names.
 */

const STAMPS_SCHEMA_VERSION = 1;

const StampsFileSchema = z.strictObject({
  schemaVersion: z.literal(STAMPS_SCHEMA_VERSION),
  handled: z.record(z.string().min(1), z.iso.datetime()),
});
type StampsFile = z.infer<typeof StampsFileSchema>;

/** The filesystem effects a stamps file needs, all owner-only. */
export type StampsFs = Pick<FarmFs, "readFileUtf8" | "writeFilePrivate" | "mkdirPrivate">;

/**
 * The handled instants in `file`, by key. An absent or unreadable file reads as nothing handled: every key is then armed afresh, which loses at most what fell while the file was unreadable and never repeats an action the person did not ask for.
 */
export function readHandled(fs: Pick<FarmFs, "readFileUtf8">, file: string): Record<string, number> {
  const raw = fs.readFileUtf8(file);
  if (raw === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const result = StampsFileSchema.safeParse(parsed);
  return result.success ? Object.fromEntries(Object.entries(result.data.handled).map(([key, at]) => [key, Date.parse(at)])) : {};
}

/** Replaces the file's content with `handled`. */
export function writeHandled(fs: StampsFs, file: string, handled: Readonly<Record<string, number>>): void {
  const next: StampsFile = { schemaVersion: STAMPS_SCHEMA_VERSION, handled: Object.fromEntries(Object.entries(handled).map(([key, at]) => [key, new Date(at).toISOString()])) };
  fs.mkdirPrivate(path.dirname(file));
  fs.writeFilePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
}

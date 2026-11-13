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

/**
 * The stamps file's text with the stamp under key `from` moved to key `to`, replacing any stamp already there: stamps are keyed by identity id, so an identity's stamp follows a `--move` (the one rename that changes the id), and one left under the new id by a removed identity stored there is stale. Undefined when `raw` is not a stamps file this release can read or holds no stamp for `from`.
 */
export function stampsWithKeyRenamed(raw: string, from: string, to: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = StampsFileSchema.safeParse(parsed);
  if (!result.success || !(Object.hasOwn(result.data.handled, from))) {
    return undefined;
  }
  const next: StampsFile = { ...result.data, handled: Object.fromEntries(Object.entries(result.data.handled).filter(([key]) => key !== to).map(([key, at]) => [key === from ? to : key, at])) };
  return `${JSON.stringify(next, null, 2)}\n`;
}

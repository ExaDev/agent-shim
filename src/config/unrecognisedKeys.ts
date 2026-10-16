import type { z } from "zod";

/** Keys a file carries that the schema does not know, and where in the file they sit. */
export interface IgnoredKeys {
  /** The path to the object holding the keys, empty for the file's top level. */
  readonly path: readonly PropertyKey[];
  readonly keys: readonly string[];
  /** What each ignored key held, so a write can put it back. */
  readonly values: Readonly<Record<string, unknown>>;
}

export type TolerantParse<T> =
  | { readonly success: true; readonly data: T; readonly ignored: readonly IgnoredKeys[] }
  | { readonly success: false; readonly issues: readonly z.core.$ZodIssue[] };

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validates `raw` against a schema whose objects are strict, treating a key the schema does not know as ignorable instead of fatal: a file written by a newer release carries keys this one has not heard of, and refusing the whole file for them would stop every launch over a setting that only the newer release reads. Every other violation is still reported. The unknown keys are removed from the data and returned, so a caller can say what was ignored.
 */
export function parseIgnoringUnrecognisedKeys<S extends z.ZodType>(schema: S, raw: unknown): TolerantParse<z.infer<S>> {
  const first = schema.safeParse(raw);
  if (first.success) {
    return { success: true, data: first.data, ignored: [] };
  }
  const unrecognised = first.error.issues.filter((issue) => issue.code === "unrecognized_keys");
  const others = first.error.issues.filter((issue) => issue.code !== "unrecognized_keys");
  if (others.length > 0) {
    return { success: false, issues: others };
  }
  const stripped: unknown = structuredClone(raw);
  const ignored: IgnoredKeys[] = [];
  for (const issue of unrecognised) {
    let holder: unknown = stripped;
    for (const step of issue.path) {
      holder = isRecord(holder) ? holder[step] : undefined;
    }
    if (isRecord(holder)) {
      const values = Object.fromEntries(issue.keys.map((key) => [key, holder[key]]));
      for (const key of issue.keys) {
        Reflect.deleteProperty(holder, key);
      }
      ignored.push({ path: issue.path, keys: issue.keys, values });
    }
  }
  const second = schema.safeParse(stripped);
  return second.success ? { success: true, data: second.data, ignored } : { success: false, issues: second.error.issues };
}

/** The ignored keys as one sentence naming the file and where each sits. */
export function describeIgnoredKeys(filePath: string, ignored: readonly IgnoredKeys[]): string {
  const places = ignored.map(({ path, keys }) => `${path.length === 0 ? "" : `${path.map(String).join(".")}.`}${keys.join(", ")}`);
  return `${filePath} has settings this version of agent-shim does not know and ignores: ${places.join("; ")}. A newer release may read them.`;
}

const warned = new Set<string>();

/** What each file read in this process had ignored, so that writing the file back does not drop what a newer release put there. */
const ignoredByFile = new Map<string, readonly IgnoredKeys[]>();

/**
 * Records what reading `filePath` ignored, and warns once per process and distinct message on standard error, so a daemon that re-reads a file on every request does not repeat itself. A read that ignored nothing clears the record, so a key the person has since removed is not restored.
 */
export function noteIgnoredKeys(filePath: string, ignored: readonly IgnoredKeys[]): void {
  if (ignored.length === 0) {
    ignoredByFile.delete(filePath);
    return;
  }
  ignoredByFile.set(filePath, ignored);
  const message = `agent-shim: warning: ${describeIgnoredKeys(filePath, ignored)}\n`;
  if (!warned.has(message)) {
    warned.add(message);
    process.stderr.write(message);
  }
}

/**
 * `value` about to be written to `filePath`, with the keys that reading that file ignored put back, wherever the object that held them still exists: an older release editing a file a newer one wrote must not delete the newer release's settings.
 */
export function restoreIgnoredKeys(filePath: string, value: unknown): unknown {
  const ignored = ignoredByFile.get(filePath);
  if (ignored === undefined) {
    return value;
  }
  const restored: unknown = structuredClone(value);
  for (const { path, values } of ignored) {
    let holder: unknown = restored;
    for (const step of path) {
      holder = isRecord(holder) ? holder[step] : undefined;
    }
    if (isRecord(holder)) {
      for (const [key, held] of Object.entries(values)) {
        holder[key] = held;
      }
    }
  }
  return restored;
}

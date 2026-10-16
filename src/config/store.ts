import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { z } from "zod";

import { ConfigValidationError } from "./load";
import { noteIgnoredKeys, parseIgnoringUnrecognisedKeys, restoreIgnoredKeys } from "./unrecognisedKeys";

/**
 * Filesystem primitives `store.ts` needs, injected so tests can simulate a crash between the temp-file write and the rename without touching real process semantics (e.g. actually killing the process mid-write). The default implementation (`nodeStoreFs`) is real `node:fs`, used by every CLI adapter in normal operation and by this module's own tests when exercising the real atomic-rename behaviour end to end.
 */
export interface StoreFs {
  /** Reads a file's contents as UTF-8 text, or returns undefined when it does not exist. */
  readonly readFileUtf8: (filePath: string) => string | undefined;
  /** Writes a file's full contents as UTF-8 text, creating or truncating it. */
  readonly writeFileUtf8: (filePath: string, contents: string) => void;
  /** Atomically renames `from` to `to` (same filesystem — both are always in the same directory in this module's own usage). */
  readonly renameSync: (from: string, to: string) => void;
  /** Creates a directory (and any missing parents), succeeding silently if it already exists. */
  readonly mkdirSync: (dirPath: string) => void;
  /** Removes a file, succeeding silently if it does not exist — used to clean up a stray temp file after a failed rename. */
  readonly unlinkSync: (filePath: string) => void;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** The real `node:fs`-backed implementation of `StoreFs`, used by every CLI adapter in normal operation. */
export const nodeStoreFs: StoreFs = {
  readFileUtf8(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  },
  writeFileUtf8(filePath, contents) {
    fs.writeFileSync(filePath, contents, "utf8");
  },
  renameSync(from, to) {
    fs.renameSync(from, to);
  },
  mkdirSync(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  },
  unlinkSync(filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
  },
};

/**
 * Reads and validates one JSON config file against `schema`.
 *
 * Returns undefined when the file does not exist. Throws `ConfigValidationError` (the same error type `src/config/load.ts` throws for every other config file in this project) when it exists but fails validation.
 */
export function readJson<S extends z.ZodType>(
  filePath: string,
  schema: S,
  storeFs: StoreFs = nodeStoreFs,
): z.infer<S> | undefined {
  const raw = storeFs.readFileUtf8(filePath);
  if (raw === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  const result = parseIgnoringUnrecognisedKeys(schema, parsed);
  if (!result.success) {
    throw new ConfigValidationError(filePath, result.issues);
  }
  noteIgnoredKeys(filePath, result.ignored);
  return result.data;
}

/**
 * Writes `contents` as UTF-8 text to `filePath` atomically: writes to a temp file in the *same directory* first, then renames it into place. A crash (or thrown error) between the write and the rename leaves the original file at `filePath` completely untouched — the failure mode this exists to prevent is a config file left half-written after an interrupted process.
 *
 * The temp file's name includes the destination's own basename, the process id, and a random UUID, so two concurrent writers (even to the same file, even from two processes) never collide on the same temp path.
 */
export function writeTextAtomic(filePath: string, contents: string, storeFs: StoreFs = nodeStoreFs): void {
  const dir = path.dirname(filePath);
  storeFs.mkdirSync(dir);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${String(process.pid)}.${randomUUID()}.tmp`);
  storeFs.writeFileUtf8(tempPath, contents);
  try {
    storeFs.renameSync(tempPath, filePath);
  } catch (error) {
    storeFs.unlinkSync(tempPath);
    throw error;
  }
}

/** Writes `data` as pretty-printed JSON to `filePath`, via `writeTextAtomic`, with any keys that reading that file ignored as unknown to this release put back. */
export function writeJsonAtomic(filePath: string, data: unknown, storeFs: StoreFs = nodeStoreFs): void {
  writeTextAtomic(filePath, `${JSON.stringify(restoreIgnoredKeys(filePath, data), null, 2)}\n`, storeFs);
}

/** Inputs to `applyPatch`. */
export interface ApplyPatchOptions<T> {
  /** Used as the base to merge `patch` into when `filePath` does not exist yet. Required for a file that may not exist yet (e.g. a config profile's own first `set` before it was ever written by `create`); omit only when the file is guaranteed to already exist. */
  readonly defaults?: T;
  readonly storeFs?: StoreFs;
}

/**
 * Reads `filePath` (or falls back to `options.defaults` when it does not exist), shallow-merges `patch` over the top-level keys of the result, re-validates the merged object against `schema`, and writes it back atomically.
 *
 * The merge is deliberately shallow — only top-level keys of the parsed config are replaced wholesale by the corresponding key in `patch`. A caller that wants to add one key to a nested object (e.g. one more category inside `categories`) must read the existing nested object itself and pass the already-merged nested object as part of `patch`; `applyPatch` does not recurse into nested objects on its own.
 *
 * Throws when the file does not exist and no `defaults` were given, and re-throws `ConfigValidationError` (via the underlying `schema.parse`) when the merged result does not validate.
 */
export function applyPatch<S extends z.ZodType>(
  filePath: string,
  schema: S,
  patch: Readonly<Partial<z.infer<S>>>,
  options: ApplyPatchOptions<z.infer<S>> = {},
): z.infer<S> {
  const storeFs = options.storeFs ?? nodeStoreFs;
  const existing = readJson(filePath, schema, storeFs) ?? options.defaults;
  if (existing === undefined) {
    throw new Error(`Cannot patch ${filePath}: it does not exist yet and no defaults were provided.`);
  }
  const merged: unknown = { ...existing, ...patch };
  const result = schema.safeParse(merged);
  if (!result.success) {
    throw new ConfigValidationError(filePath, result.error.issues);
  }
  const validated = result.data;
  writeJsonAtomic(filePath, validated, storeFs);
  return validated;
}

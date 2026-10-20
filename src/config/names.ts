import path from "node:path";
import { z } from "zod";

import { CliError } from "../cliError";

/**
 * The longest a name may be, in characters: a filesystem allows a path component up to 255 bytes, and the longest suffix a name gets is `.json`, so a longer name would pass the shape only to fail on creation with a raw system error. Every allowed character is one byte.
 */
const MAX_NAME_CHARS = 250;

/**
 * The shape of a name a project file may use, and a new profile, provider or identity may be given: a letter or digit first, then letters, digits, dots, dashes, underscores and at signs (an email address names its own identity, and an email-shaped identity name is offered as the default name of a profile, so the two share one rule; the first character stays a letter or digit because a leading `@` would collide with the `@name` selector syntax), no more than `MAX_NAME_CHARS`. It can be neither empty, nor `.`, nor `..`, nor a hidden file, and it holds no path separator and no NUL, so it names one file inside the directory it is looked up in. A committed project file arrives with a clone, from whoever wrote the repository, so every name in one is held to this shape.
 */
export const FILE_NAME_PATTERN = `[A-Za-z0-9][A-Za-z0-9._@-]{0,${String(MAX_NAME_CHARS - 1)}}`;

const FILE_NAME = new RegExp(`^${FILE_NAME_PATTERN}$`);

/** What a name that fails `FILE_NAME_PATTERN` is told. */
export const FILE_NAME_RULE = `must start with a letter or digit, contain only letters, digits, dots, dashes, underscores and at signs, and be at most ${String(MAX_NAME_CHARS)} characters`;

/** What a name that fails `isStoredName` is told. */
const STORED_NAME_RULE = `must be non-empty, at most ${String(MAX_NAME_CHARS)} characters, not "." or "..", and contain no path separator or NUL`;

/** Whether `name` has the shape a project file may use and a new profile, provider or identity may be given. */
export function isFileName(name: string): boolean {
  return FILE_NAME.test(name);
}

/**
 * Whether `name`, as a person's own configuration or a file already stored writes it, names one file inside the directory it is looked up in: non-empty, not `.` or `..`, no path separator and no NUL, at most `MAX_NAME_CHARS`. This is the least that keeps a name inside its directory. It is wider than `isFileName` so that a profile or provider stored under an older, looser rule (a space, a leading underscore) keeps working from the person's own files.
 */
export function isStoredName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_CHARS && name !== "." && name !== ".." && !/[/\\]/u.test(name) && !name.includes("\u0000");
}

/** A name in a committed project file, or one a new profile, provider or identity is given. */
export const FileNameSchema = z.string().min(1).regex(FILE_NAME, FILE_NAME_RULE);

/** A name in the person's own configuration (the global config, an identity, a directory rule, a profile), which may be one stored under an older rule but must still stay inside its directory. */
export const StoredNameSchema = z.string().refine(isStoredName, STORED_NAME_RULE);

/** Raised when a name about to be joined into a path would leave its directory, or (for a name being created) does not have the shape new names are given. Names the file or source that referred to it when the caller knows it. */
export class UnsafeNameError extends CliError {
  constructor(
    readonly attemptedName: string,
    readonly kind: string,
    readonly rule: string = STORED_NAME_RULE,
    readonly source?: string,
  ) {
    super(`${source === undefined ? "" : `${source}: `}${JSON.stringify(attemptedName)} is not a valid ${kind} name: a name ${rule}.`);
    this.name = "UnsafeNameError";
  }
}

/** Raised for a provider name that is not usable, with the rule that applied: `FILE_NAME_RULE` for a name being created, the containment rule for one being looked up. */
export class InvalidProviderNameError extends UnsafeNameError {
  constructor(attemptedName: string, rule: string = STORED_NAME_RULE, source?: string) {
    super(attemptedName, "provider", rule, source);
    this.name = "InvalidProviderNameError";
  }
}

/** Throws `InvalidProviderNameError` unless `name` has the shape a new provider is given. */
export function requireNewProviderName(name: string): void {
  if (!isFileName(name)) {
    throw new InvalidProviderNameError(name, FILE_NAME_RULE);
  }
}

/** The path of `<name><extension>` directly inside `directory`, for a configuration profile; throws `UnsafeNameError`, naming `source` (the file or layer that referred to the name) when given, for a name that would leave `directory`. */
export function profileFilePath(directory: string, name: string, source?: string): string {
  if (!isStoredName(name)) {
    throw new UnsafeNameError(name, "configuration profile", STORED_NAME_RULE, source);
  }
  return path.join(directory, `${name}.json`);
}

/** The path of `<name>.json` directly inside `directory`, for a provider; throws `InvalidProviderNameError` for a name that would leave it. */
export function providerFilePath(directory: string, name: string, source?: string): string {
  if (!isStoredName(name)) {
    throw new InvalidProviderNameError(name, STORED_NAME_RULE, source);
  }
  return path.join(directory, `${name}.json`);
}

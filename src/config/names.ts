import path from "node:path";
import { z } from "zod";

import { CliError } from "../cliError";

/**
 * The one shape of a name that becomes a file or directory name under the agent-shim home: a configuration profile, an identity, a provider. It starts with a letter or digit, so it can be neither empty, nor `.`, nor `..`, nor a hidden file, and it holds only letters, digits, dots, dashes, underscores and at signs (an email address names its own identity), so it has no path separator, no NUL and nothing else a path treats specially. A name read from a configuration file, and above all one from a committed project file, is joined into a path, so every such name is held to this shape.
 */
export const FILE_NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9._@-]*";

const FILE_NAME = new RegExp(`^${FILE_NAME_PATTERN}$`);

/** What a name that fails `FILE_NAME_PATTERN` is told. */
const FILE_NAME_RULE = "must start with a letter or digit and contain only letters, digits, dots, dashes, underscores and at signs";

/** Whether `name` is safe to join into a path as one component under the agent-shim home. */
export function isFileName(name: string): boolean {
  return FILE_NAME.test(name);
}

/** A name of a configuration profile, identity or provider, as a configuration file may write it. */
export const FileNameSchema = z.string().min(1).regex(FILE_NAME, FILE_NAME_RULE);

/** Raised when a name about to be joined into a path is not a `FILE_NAME_PATTERN` name, so it cannot leave its directory. */
export class UnsafeNameError extends CliError {
  constructor(
    readonly attemptedName: string,
    readonly kind: string,
  ) {
    super(`${JSON.stringify(attemptedName)} is not a valid ${kind} name: a name ${FILE_NAME_RULE}.`);
    this.name = "UnsafeNameError";
  }
}

/** The path of `<name><extension>` directly inside `directory`, for a `kind` of thing (`configuration profile`); throws `UnsafeNameError` for a name that is not safe as one path component, so no name can reach a file outside `directory`. */
export function namedFilePath(directory: string, name: string, extension: string, kind: string): string {
  if (!isFileName(name)) {
    throw new UnsafeNameError(name, kind);
  }
  return path.join(directory, `${name}${extension}`);
}

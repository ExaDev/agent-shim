import { ConfigFileNotJsonError, ConfigValidationError } from "./config/load";

/**
 * The result of `read`, or `unreadable` when the configuration file it reads is not JSON, fails its schema, or cannot be read at all (a system error with a code: a directory in its place, no permission). Such a file is reported as its own finding by `doctor`, so a caller that must still answer without it (the description of an unfinished rename, the models `doctor` checks references against) treats it as holding nothing. Any other error is thrown.
 */
export function readableOr<T>(read: () => T, unreadable: T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ConfigFileNotJsonError || error instanceof ConfigValidationError || isSystemReadError(error)) {
      return unreadable;
    }
    throw error;
  }
}

/** Whether `error` is a failure the file system raised for a read (one carrying an `E...` code), as against a defect. */
export function isSystemReadError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && /^E[A-Z]+$/u.test(error.code);
}

import { ConfigFileNotJsonError, ConfigValidationError } from "./config/load";

/**
 * The result of `read`, or `unreadable` when the configuration file it reads is not JSON or fails its schema. Such a file is reported as its own finding by `doctor`, so a caller that must still answer without it (the description of an unfinished rename, the models `doctor` checks references against) treats it as holding nothing. Any other error is thrown.
 */
export function readableOr<T>(read: () => T, unreadable: T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ConfigFileNotJsonError || error instanceof ConfigValidationError) {
      return unreadable;
    }
    throw error;
  }
}

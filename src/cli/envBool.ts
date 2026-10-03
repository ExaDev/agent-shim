import { UsageError } from "../cliError";
import { parseBoolWord } from "./bool";

/** Raised when a boolean environment variable holds something outside the shared vocabulary. */
export class InvalidEnvBoolError extends UsageError {
  constructor(readonly variable: string, readonly value: string) {
    super(`${variable} must be one of true, false, 1 or 0, got "${value}".`);
    this.name = "InvalidEnvBoolError";
  }
}

/**
 * Reads a boolean environment variable with the same vocabulary a CLI flag value uses. Unset and the empty string both mean "not given" (undefined), consistent with how every other agent-shim environment variable treats the empty string; anything outside the vocabulary throws `InvalidEnvBoolError` rather than silently reading as false.
 */
export function parseEnvBool(variable: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = parseBoolWord(value);
  if (parsed === undefined) {
    throw new InvalidEnvBoolError(variable, value);
  }
  return parsed;
}

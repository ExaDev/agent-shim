import { UsageError } from "../cliError";
import { NUMERIC_DOTTED_VERSION_RE } from "../versionDiscovery";

/** Where a pinned Claude Code version came from, strongest first: the launch's own flag, then the environment, then the cascade. */
export const CLAUDE_VERSION_SOURCES = ["flag", "environment", "cascade"] as const;
type ClaudeVersionSource = (typeof CLAUDE_VERSION_SOURCES)[number];

/** The pinned version a launch runs, and which of the three forms named it. */
export interface PinnedClaudeVersion {
  readonly version: string;
  readonly source: ClaudeVersionSource;
}

/** Raised when a flag or environment variable names something that is not an exact dotted-numeric version. A cascade value is validated by its schema instead. */
export class InvalidClaudeVersionError extends UsageError {
  constructor(readonly value: string, readonly origin: string) {
    super(`${origin} names Claude Code version "${value}", which is not an exact dotted-numeric version such as 2.1.220.`);
    this.name = "InvalidClaudeVersionError";
  }
}

function validated(value: string, origin: string): string {
  if (!NUMERIC_DOTTED_VERSION_RE.test(value)) {
    throw new InvalidClaudeVersionError(value, origin);
  }
  return value;
}

/**
 * Decides which Claude Code version a launch is pinned to, in the same order as every other launch setting: the `--claude-version` flag outright, then `AGENT_SHIM_CLAUDE_VERSION` (an empty string counts as unset), then the cascade's `launch.claudeVersion`. Undefined when none pins one, which leaves discovery to pick the highest installed version.
 *
 * Throws `InvalidClaudeVersionError` for a flag or environment value that is not an exact version; the cascade's value was validated when its file was read.
 */
export function resolveClaudeVersion(params: Readonly<{ flag?: string; env: Readonly<Record<string, string | undefined>>; cascade?: string }>): PinnedClaudeVersion | undefined {
  if (params.flag !== undefined) {
    return { version: validated(params.flag, "--claude-version"), source: "flag" };
  }
  const fromEnv = params.env.AGENT_SHIM_CLAUDE_VERSION;
  if (fromEnv !== undefined && fromEnv !== "") {
    return { version: validated(fromEnv, "AGENT_SHIM_CLAUDE_VERSION"), source: "environment" };
  }
  return params.cascade === undefined ? undefined : { version: params.cascade, source: "cascade" };
}

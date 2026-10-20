/**
 * A Claude model ID in either naming: family first (`claude-opus-4-7`, `claude-sonnet-4-20250514`, `claude-haiku-4-5-20251001`) or version first (`claude-3-5-sonnet-20241022`). A version is a major number and an optional minor number of at most two digits, so an eight-digit release date after the major is never read as a minor; the date is optional and dropped.
 */
const MODEL_ID = /^(?:claude-)?(?:(\d{1,2})(?:-(\d{1,2}))?-)?(opus|sonnet|haiku)(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:-\d{8})?$/i;

/** The parts of a Claude model ID a person names it by. */
export interface ClaudeModel {
  /** The family in lower case: `opus`, `sonnet` or `haiku`. */
  readonly family: string;
  /** The version as `4.7`, `4` or `3.5`; undefined for a bare family alias. */
  readonly version: string | undefined;
}

/** The family and version of a Claude model ID, or undefined for an ID that is not one (a provider's own name, a Bedrock ARN, an alias that is no family). */
export function parseClaudeModelId(id: string): ClaudeModel | undefined {
  const match = MODEL_ID.exec(id);
  if (match === null) {
    return undefined;
  }
  const [, leadingMajor, leadingMinor, family = "", trailingMajor, trailingMinor] = match;
  const major = leadingMajor ?? trailingMajor;
  const minor = leadingMajor === undefined ? trailingMinor : leadingMinor;
  return { family: family.toLowerCase(), version: major === undefined ? undefined : `${major}${minor === undefined ? "" : `.${minor}`}` };
}

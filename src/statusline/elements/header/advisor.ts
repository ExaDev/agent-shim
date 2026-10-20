import { boundedDisplayText } from "../../sanitise";
import type { RenderContext } from "../context";

/**
 * A Claude model ID in either naming: family first (`claude-opus-4-7`, `claude-sonnet-4-20250514`, `claude-haiku-4-5-20251001`) or version first (`claude-3-5-sonnet-20241022`). A version is a major number and an optional minor number of at most two digits, so an eight-digit release date after the major is never read as a minor; the date is optional and dropped.
 */
const MODEL_ID = /^(?:claude-)?(?:(\d{1,2})(?:-(\d{1,2}))?-)?(opus|sonnet|haiku)(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:-\d{8})?$/i;

/** A model ID written the way a person says it: `claude-opus-4-7` is `Opus 4.7`, `claude-sonnet-4-20250514` is `Sonnet 4`, a bare family alias is capitalised, and any other ID loses only a leading `claude-`. */
function prettifyModelId(id: string): string {
  const match = MODEL_ID.exec(id);
  if (match === null) {
    return id.replace(/^claude-/i, "");
  }
  const [, leadingMajor, leadingMinor, family = "", trailingMajor, trailingMinor] = match;
  const major = leadingMajor ?? trailingMajor;
  const minor = leadingMajor === undefined ? trailingMinor : leadingMinor;
  const version = major === undefined ? "" : ` ${major}${minor === undefined ? "" : `.${minor}`}`;
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()}${version}`;
}

/** The advisor model, as the settings name it or else as the session's transcript records it once `/advisor` is set; undefined when neither does. */
export function advisorSegment({ settings, transcriptIdentity, t }: RenderContext): string | undefined {
  if (settings.advisor.override !== "") {
    return t("advisor.name", { name: settings.advisor.override });
  }
  const recorded = transcriptIdentity().advisor;
  const advisor = recorded === undefined ? "" : boundedDisplayText(prettifyModelId(recorded));
  return advisor === "" ? undefined : t("advisor.name", { name: advisor });
}

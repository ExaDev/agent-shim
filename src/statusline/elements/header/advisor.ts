import { readTranscriptIdentity } from "../../identityTranscript";
import { boundedDisplayText } from "../../sanitise";
import type { RenderContext } from "../context";

/** A model ID in the form `claude-opus-4-7` or `opus-4-7-20251001`: the family, then major and minor version. */
const ADVISOR_ID = /^(?:claude-)?(opus|sonnet|haiku)-(\d+)-(\d+)/i;

/** A model ID written the way a person says it: `claude-opus-4-7` is `Opus 4.7`, a bare family alias is capitalised, and any other ID loses only a leading `claude-`. */
function prettifyModelId(id: string): string {
  const match = ADVISOR_ID.exec(id);
  if (match !== null) {
    const [, family = "", major = "", minor = ""] = match;
    return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}.${minor}`;
  }
  const lower = id.toLowerCase();
  if (lower === "opus" || lower === "sonnet" || lower === "haiku") {
    return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  }
  return id.replace(/^claude-/i, "");
}

/** The advisor model, as the settings name it or else as the session's transcript records it once `/advisor` is set; undefined when neither does. */
export function advisorSegment({ settings, transcriptTail }: RenderContext): string | undefined {
  if (settings.advisor.override !== "") {
    return `Advisor: ${settings.advisor.override}`;
  }
  const recorded = readTranscriptIdentity(transcriptTail()).advisor;
  const advisor = recorded === undefined ? "" : boundedDisplayText(prettifyModelId(recorded));
  return advisor === "" ? undefined : `Advisor: ${advisor}`;
}

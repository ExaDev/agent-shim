import { parseClaudeModelId } from "../../modelId";
import { boundedDisplayText } from "../../sanitise";
import type { RenderContext } from "../context";

/** A model ID written the way a person says it: `claude-opus-4-7` is `Opus 4.7`, `claude-sonnet-4-20250514` is `Sonnet 4`, a bare family alias is capitalised, and any other ID loses only a leading `claude-`. */
function prettifyModelId(id: string): string {
  const model = parseClaudeModelId(id);
  if (model === undefined) {
    return id.replace(/^claude-/i, "");
  }
  return `${model.family.charAt(0).toUpperCase()}${model.family.slice(1)}${model.version === undefined ? "" : ` ${model.version}`}`;
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

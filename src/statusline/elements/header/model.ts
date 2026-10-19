import type { ResolvedStatusline } from "../../../config/statusline";
import type { StatuslineSummary } from "../../enrich";
import { readTranscriptIdentity } from "../../identityTranscript";
import type { RenderContext } from "../context";

/** Whether a dynamic mode's choice names its provider beside the served model: the choice could cross providers, or routing by name left the launch's provider. */
export function choiceNamesProvider(summary: StatuslineSummary): boolean {
  return summary.modelChoice !== undefined && (summary.modelChoice.providers.length > 1 || summary.routedTarget !== undefined);
}

/** The model IDs that name Anthropic's own models, the way the client and a Bedrock route write them: a served model with any other name is a proxy's redirect. */
const CLAUDE_MODEL_ID_PREFIXES = ["claude-", "anthropic."] as const;

function isClaudeModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return CLAUDE_MODEL_ID_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** A model name written as `format` asks: a context-window suffix such as `(1M context)` is dropped for compact and short, and short also drops a leading `Claude`. */
function formatModelName(name: string, format: ResolvedStatusline["model"]["format"]): string {
  if (format === "full") {
    return name;
  }
  const withoutContext = name.replace(/\s*\([^)]*\bcontext\b[^)]*\)/i, "").trim();
  return format === "short" ? withoutContext.replace(/^Claude\s+/i, "") : withoutContext;
}

/** The name the segment draws and where it came from: a name served by the model itself (read from the transcript) already says what answered, which the arrow beside a dynamic mode's choice would only repeat. */
function modelNameOf({ view, settings, transcriptTail }: RenderContext): { readonly name: string; readonly isServed: boolean } | undefined {
  if (settings.model.override !== "") {
    return { name: settings.model.override, isServed: false };
  }
  if (settings.model.source !== "client") {
    const served = readTranscriptIdentity(transcriptTail()).model;
    // A transcript with no assistant record yet has no served model, so the client's name stands in until there is one.
    if (served !== undefined && (settings.model.source === "transcript" || !isClaudeModelId(served))) {
      return { name: formatModelName(served, settings.model.format), isServed: true };
    }
  }
  return view.modelDisplayName === undefined || view.modelDisplayName === "" ? undefined : { name: formatModelName(view.modelDisplayName, settings.model.format), isServed: false };
}

/** The model the session is on, or undefined when no name is known. */
export function modelSegment(context: RenderContext): string | undefined {
  // A dynamic mode's selection draws the model that answered beside the name the session typed (`auto -> glm-5.3`), because the client's own model name alone says nothing about what is actually serving. The provider joins the arrow when the choice could have landed on more than one, or when it left the launch's provider: exactly the cases where the provider is part of the answer.
  const { summary } = context;
  const model = modelNameOf(context);
  if (model === undefined || model.name === "") {
    return undefined;
  }
  if (summary.modelChoice === undefined || model.isServed) {
    return model.name;
  }
  return `${model.name} -> ${choiceNamesProvider(summary) ? `${summary.modelChoice.provider}/${summary.modelChoice.served}` : summary.modelChoice.served}`;
}

import type { StatuslineSummary } from "../../enrich";
import type { RenderContext } from "../context";

/** Whether a dynamic mode's choice names its provider beside the served model: the choice could cross providers, or routing by name left the launch's provider. */
export function choiceNamesProvider(summary: StatuslineSummary): boolean {
  return summary.modelChoice !== undefined && (summary.modelChoice.providers.length > 1 || summary.routedTarget !== undefined);
}

/** The model the session is on, or undefined when the client names none. */
export function modelSegment({ summary, view }: RenderContext): string | undefined {
  // A dynamic mode's selection draws the model that answered beside the name the session typed (`auto -> glm-5.3`), because the client's own model name alone says nothing about what is actually serving. The provider joins the arrow when the choice could have landed on more than one, or when it left the launch's provider: exactly the cases where the provider is part of the answer.
  const namesProvider = choiceNamesProvider(summary);
  const segment =
    summary.modelChoice !== undefined && view.modelDisplayName !== undefined && view.modelDisplayName !== ""
      ? `${view.modelDisplayName} -> ${namesProvider ? `${summary.modelChoice.provider}/${summary.modelChoice.served}` : summary.modelChoice.served}`
      : view.modelDisplayName;
  return segment !== undefined && segment !== "" ? segment : undefined;
}

import type { RenderContext } from "../context";
import { choiceNamesProvider } from "./model";

/** The target the last request was served by, or undefined when routing did not leave the launch's provider or a dynamic mode's arrow already names it. */
export function routeSegment({ summary, t }: RenderContext): string | undefined {
  // The target the last request was served by, when routing by name sent it off the launch's provider: a qualified name's choice, shown where the person is looking rather than only in the usage log. A dynamic mode's arrow already names the provider in this case, so the two never repeat each other.
  return summary.routedTarget !== undefined && !choiceNamesProvider(summary) ? t("route.via", { target: summary.routedTarget }) : undefined;
}

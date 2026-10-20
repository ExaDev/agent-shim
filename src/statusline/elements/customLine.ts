import { truncateToColumns } from "../ansi";
import { visibleDisplayText } from "../sanitise";
import type { RenderContext } from "./context";

/** The line of the person's own text (`customLine.text`) in the custom colour, cut to the usable width; undefined when the text is empty or has nothing visible in it. */
export function customLineOf({ settings, palette, width }: RenderContext): string | undefined {
  const text = visibleDisplayText(settings.customLine.text);
  return text === "" ? undefined : palette.paint("custom", truncateToColumns(text, width));
}

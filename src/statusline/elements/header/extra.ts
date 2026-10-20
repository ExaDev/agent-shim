import { z } from "zod";

import { boundedDisplayText, visibleDisplayText } from "../../sanitise";
import type { RenderContext } from "../context";

/** What a command may print instead of plain text: a JSON object whose `label` is the text to draw. */
const LabelObjectSchema = z.looseObject({ label: z.string() });

/** The text a command printed: the `label` of a JSON object when the whole output is one, else the first line with something on it. */
function labelOf(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  }
  const object = LabelObjectSchema.safeParse(parsed);
  return object.success ? object.data.label : "";
}

/**
 * The output of the command `extra.command` names, as a header segment; undefined when no command is set, or when it fails, outruns the ports' time limit or prints nothing visible. The command is run without a shell, in the session's working directory, through the run port, which bounds both the time it may take and the output it may produce. What it prints is cleaned of escape sequences and of anything that draws nothing before it is drawn, and cut to the length of other text from outside the statusline.
 */
export function extraSegment({ settings, payload, ports }: RenderContext): string | undefined {
  const [program, ...args] = settings.extra.command;
  if (program === undefined) {
    return undefined;
  }
  const output = ports.run(program, args, payload.cwd ?? payload.workspace?.current_dir ?? ports.homeDirectory);
  if (output === undefined) {
    return undefined;
  }
  const label = boundedDisplayText(visibleDisplayText(labelOf(output)));
  return label === "" ? undefined : label;
}

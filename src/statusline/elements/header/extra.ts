import { z } from "zod";

import { boundedVisibleWords, couldShowSomething, stripEscapeSequences } from "../../sanitise";
import type { RenderContext } from "../context";

/** What a command may print instead of plain text: a JSON object whose `label` is the text to draw. */
const LabelObjectSchema = z.looseObject({ label: z.string() });

/** The lines of `text` one at a time, split at line feeds only (a carriage return left at the end of a line is white space to the cleaning). */
function* linesOf(text: string): Generator<string> {
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    if (end === -1) {
      yield text.slice(start);
      return;
    }
    yield text.slice(start, end);
    start = end + 1;
  }
}

/** The byte order mark some programs begin their output with, which is not part of the JSON they print. */
const BYTE_ORDER_MARK = /^\uFEFF/u;

/**
 * The text a command printed, as the line it is drawn as. The escape sequences are removed from the whole output first, and a leading byte order mark, so that colourised JSON (`jq -C`) is read as JSON: a valid JSON text holds no raw escape character, so removing them cannot change what it parses to, and a `\u001b` inside a JSON string is six characters, not an escape. The `label` of a JSON object is then drawn when the whole output is an object with a string `label`; otherwise (plain text, or output that merely parses as JSON, such as `1234`, `true` or `[1]`) the first line that shows something is drawn, so a line of nothing but spaces of any width or zero-width characters is skipped. An operating system command with no terminator removes everything up to the next escape character, or to the end of the output, the line breaks in between included, so the lines after it are gone with it and nothing is drawn when none is left. Empty when no line shows anything.
 */
function labelOf(output: string): string {
  const text = stripEscapeSequences(output).replace(BYTE_ORDER_MARK, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const object = LabelObjectSchema.safeParse(parsed);
  if (object.success) {
    return boundedVisibleWords(object.data.label);
  }
  for (const line of linesOf(text)) {
    // Looking at the line first only saves cleaning it: a line that could show nothing cleans to nothing.
    const label = couldShowSomething(line) ? boundedVisibleWords(line) : "";
    if (label !== "") {
      return label;
    }
  }
  return "";
}

/**
 * The output of the command `extra.command` names, as a header segment; undefined when no command is set, or when it fails, outruns the ports' time limit, writes output as large as the size limit or larger, or prints nothing visible. No shell reads the command's arguments: the run port starts the program with them as they are, and in file mode through `sh -c`, which only sets the file size limit and then `exec`s the program with the arguments untouched. It runs in the session's working directory, through the run port, which bounds the time it may take and, with its output going to a size-limited file, what it may write. The line drawn is chosen as `labelOf` says and cleaned as `visibleWords` does: escape sequences removed first, the text split into words at tabs, line breaks and the like, each word cleaned of the other control characters and of anything that draws nothing, the words that show something joined by single spaces, and the whole cut to the length of other text from outside the statusline.
 */
export function extraSegment({ settings, payload, ports }: RenderContext): string | undefined {
  const [program, ...args] = settings.extra.command;
  if (program === undefined) {
    return undefined;
  }
  const output = ports.run(program, args, payload.cwd ?? payload.workspace?.current_dir ?? ports.homeDirectory, { outputInFile: true });
  if (output === undefined) {
    return undefined;
  }
  const label = labelOf(output);
  return label === "" ? undefined : label;
}

import { MAX_DISPLAY_TEXT_CHARS } from "../config/statusline";
import { ESCAPE } from "./ansi";
import { graphemesOf } from "./graphemes";

const BELL = "\\u0007";

/** An ANSI control sequence: a CSI (`ESC [` parameters, intermediates, a final byte), an OSC (`ESC ]` up to a bell or `ESC \`), or a lone two-byte escape. */
const ESCAPE_SEQUENCES = new RegExp([`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, `${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`, `${ESCAPE}[@-Z\\\\-_]`].join("|"), "g");

/** Control characters, and the characters that reorder or isolate bidirectional text and so can make a path read as another. */
const CONTROL_AND_BIDI = /[\p{Cc}؜‎‏‪-‮⁦-⁩⁪-⁯]/gu;

/** `text` with the escape sequences, control characters and bidirectional controls removed, so a name read from the machine (a path, a branch, a file) cannot move the cursor, recolour the line or disguise itself in the statusline. */
export function sanitiseDisplayText(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "").replace(CONTROL_AND_BIDI, "");
}

/** `text` made safe as `sanitiseDisplayText` does, trimmed, and cut to `MAX_DISPLAY_TEXT_CHARS` graphemes so a cut never splits one: for a model name, an output style or an advisor read from outside the statusline, which must not crowd the header line. Empty when nothing visible is left. */
export function boundedDisplayText(text: string): string {
  return graphemesOf(sanitiseDisplayText(text).trim()).slice(0, MAX_DISPLAY_TEXT_CHARS).join("").trim();
}

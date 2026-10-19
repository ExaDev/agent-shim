import { ESCAPE } from "./ansi";

const BELL = "\\u0007";

/** An ANSI control sequence: a CSI (`ESC [` parameters, intermediates, a final byte), an OSC (`ESC ]` up to a bell or `ESC \`), or a lone two-byte escape. */
const ESCAPE_SEQUENCES = new RegExp([`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, `${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`, `${ESCAPE}[@-Z\\\\-_]`].join("|"), "g");

/** Control characters, and the characters that reorder or isolate bidirectional text and so can make a path read as another. */
const CONTROL_AND_BIDI = /[\p{Cc}؜‎‏‪-‮⁦-⁩⁪-⁯]/gu;

/** `text` with the escape sequences, control characters and bidirectional controls removed, so a name read from the machine (a path, a branch, a file) cannot move the cursor, recolour the line or disguise itself in the statusline. */
export function sanitiseDisplayText(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "").replace(CONTROL_AND_BIDI, "");
}

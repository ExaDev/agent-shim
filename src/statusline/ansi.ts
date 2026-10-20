import stringWidth from "string-width";

import { graphemesOf } from "./graphemes";

const ESCAPE_CHAR_CODE = 27;
/** The escape character that opens every ANSI control sequence. */
export const ESCAPE = String.fromCharCode(ESCAPE_CHAR_CODE);

const BELL = "\\u0007";

/** The pattern of an ANSI control sequence: a CSI (`ESC [` parameters, intermediates, a final byte), an OSC (`ESC ]` up to a bell or `ESC \`, or to the end of the text or the next escape when it has no terminator), or a lone two-byte escape. A string, so a caller builds the expression it needs (global to remove sequences, plain to split text on them). */
export const ESCAPE_SEQUENCE_PATTERN = [`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, `${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)?`, `${ESCAPE}[@-Z\\\\-_]`].join("|");

/** Text split on the escape sequences in it, which a capture group keeps: the parts at odd positions are the sequences. */
const SPLIT_ON_ESCAPES = new RegExp(`(${ESCAPE_SEQUENCE_PATTERN})`);

/** How many terminal columns a string takes: escape sequences draw nothing, a wide (East Asian) character takes two columns, and a combining mark or a joined emoji sequence takes the cells of the character it joins. */
export function visibleLength(text: string): number {
  return stringWidth(text);
}

/**
 * `text` cut to the most characters that take no more than `columns` terminal columns, between characters a person sees: a wide character that would cross the limit is left out whole and a joined emoji sequence is never split. Escape sequences take no column and are never cut, and those after the cut are kept so that a colour that began is also ended; the result measures the same by `visibleLength` as the text it was cut from does up to the limit.
 */
export function truncateToColumns(text: string, columns: number): string {
  let used = 0;
  let full = false;
  let kept = "";
  text.split(SPLIT_ON_ESCAPES).forEach((part, index) => {
    if (index % 2 === 1) {
      kept += part;
      return;
    }
    for (const grapheme of full ? [] : graphemesOf(part)) {
      used += visibleLength(grapheme);
      if (used > columns) {
        full = true;
        return;
      }
      kept += grapheme;
    }
  });
  return kept;
}

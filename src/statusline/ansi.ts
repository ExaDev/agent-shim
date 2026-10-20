import stringWidth from "string-width";

import { graphemesOf } from "./graphemes";

const ESCAPE_CHAR_CODE = 27;
/** The escape character that opens every ANSI control sequence. */
export const ESCAPE = String.fromCharCode(ESCAPE_CHAR_CODE);

/** How many terminal columns a string takes: escape sequences draw nothing, a wide (East Asian) character takes two columns, and a combining mark or a joined emoji sequence takes the cells of the character it joins. */
export function visibleLength(text: string): number {
  return stringWidth(text);
}

/** The longest start of `text` that takes no more than `columns` terminal columns, cut between characters a person sees: a wide character that would cross the limit is left out whole, and a joined emoji sequence is never split. */
export function truncateToColumns(text: string, columns: number): string {
  let used = 0;
  let kept = "";
  for (const grapheme of graphemesOf(text)) {
    used += visibleLength(grapheme);
    if (used > columns) {
      break;
    }
    kept += grapheme;
  }
  return kept;
}

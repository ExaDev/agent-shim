import stringWidth from "string-width";

const ESCAPE_CHAR_CODE = 27;
/** The escape character that opens every ANSI control sequence. */
export const ESCAPE = String.fromCharCode(ESCAPE_CHAR_CODE);

/** How many terminal columns a string takes: escape sequences draw nothing, a wide (East Asian) character takes two columns, and a combining mark or a joined emoji sequence takes the cells of the character it joins. */
export function visibleLength(text: string): number {
  return stringWidth(text);
}

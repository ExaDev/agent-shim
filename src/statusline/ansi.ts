const ESCAPE_CHAR_CODE = 27;
/** The escape character that opens every ANSI control sequence. */
export const ESCAPE = String.fromCharCode(ESCAPE_CHAR_CODE);
const ANSI_REGEX = new RegExp(`${ESCAPE}\\[[0-9;]*[a-zA-Z]`, "g");

/** How many terminal columns a string takes: its length without the ANSI colour sequences, which draw nothing. */
export function visibleLength(text: string): number {
  return text.replace(ANSI_REGEX, "").length;
}

/** How many characters of a text a provider supplied (a model id, a tool name) a log line or an error message keeps. A line is read by a person: an id or a name is a short identifier, so the bound only has to exceed any real one while keeping a hostile one to a line. */
export const MAX_LOGGED_TEXT_CHARS = 64;

/** The characters that can start a line of their own or change how a terminal draws what follows, as the body of a regular expression character class: control characters (the C0 and C1 ranges and DEL, which includes the escape that opens a terminal sequence and U+0085), the line and paragraph separators, and the format characters (bidirectional controls, zero-width characters). One source for the test and the escape, so the two cannot name different sets. */
const UNSAFE_CLASS = "[\\p{Cc}\\p{Zl}\\p{Zp}\\p{Cf}]";
const UNSAFE_IN_A_LINE = new RegExp(UNSAFE_CLASS, "u");
const UNSAFE_CHARACTERS = new RegExp(UNSAFE_CLASS, "gu");

/** Whether `text` holds a character that has no place in a text written into a log line or an error message: the same set `quotedForLog` escapes, so an id that holds none is written as it is and one that holds any is refused or escaped, never half of each. */
export function holdsUnsafeCharacter(text: string): boolean {
  return UNSAFE_IN_A_LINE.test(text);
}

/** The radix and width of the four hexadecimal digits of a `\uXXXX` escape. */
const HEX_RADIX = 16;
const ESCAPE_DIGITS = 4;

/** `\uXXXX` for each UTF-16 code unit of the character `character` (a surrogate pair for one past U+FFFF). */
function escaped(character: string): string {
  return Array.from({ length: character.length }, (_unused, index) => `\\u${character.charCodeAt(index).toString(HEX_RADIX).padStart(ESCAPE_DIGITS, "0")}`).join("");
}

/** `text` as a log line or an error message may carry it: cut to `MAX_LOGGED_TEXT_CHARS` characters and quoted with JSON escapes, with every character `holdsUnsafeCharacter` names written as an escape too (JSON leaves DEL, the C1 controls, the separators and the format characters as they are), so nothing in it can start a line of its own or move a terminal's cursor. */
export function quotedForLog(text: string): string {
  return JSON.stringify(text.slice(0, MAX_LOGGED_TEXT_CHARS)).replace(UNSAFE_CHARACTERS, escaped);
}

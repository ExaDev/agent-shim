import stringWidth from "string-width";

/** Spaces of any width and the characters that draw an empty cell the width of a letter: the Braille blank and the Hangul blanks. They take room on the line and show nothing, so text made only of them is not text. (The Hangul choseong and jungseong fillers are not here: they take no column of their own, and are blank only when they stand apart from a jamo cluster.) */
const BLANK_CELLS = /[\p{Zs}\u2800\u3164\uFFA0]/gu;

/** `BLANK_CELLS` without the plain space, which is a blank cell already and so needs no replacing by one: a text of a million spaces would otherwise be a million replacements. */
export const BLANK_CELLS_BUT_SPACE = new RegExp(`[${BLANK_CELLS.source}--[ ]]`, "gv");

/** Whether `text` shows nothing a person can see: it is empty, or once its blank cells are taken out it takes no terminal column (a lone combining mark, a variation selector, a joiner or any other character the terminal gives no cell). The one definition of "nothing visible" for a name, a label and a bar character. */
export function drawsNothing(text: string): boolean {
  return stringWidth(text.replace(BLANK_CELLS, "")) === 0;
}

import stringWidth from "string-width";

/** Spaces of any width and the characters that draw an empty cell: the Braille blank and the Hangul fillers. They take room on the line and show nothing, so text made only of them is not text. */
export const BLANK_CELLS = /[\p{Zs}\u2800\u115F\u1160\u3164\uFFA0]/gu;

/** Whether `text` shows nothing a person can see: it is empty, or once its blank cells are taken out it takes no terminal column (a lone combining mark, a variation selector, a joiner or any other character the terminal gives no cell). The one definition of "nothing visible" for a name, a label and a bar character. */
export function drawsNothing(text: string): boolean {
  return stringWidth(text.replace(BLANK_CELLS, "")) === 0;
}

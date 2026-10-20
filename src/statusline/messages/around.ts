/** Stands in for a value while a message is written, so the words either side of it can be painted and the value left as it is. */
export const VALUE_MARK = String.fromCharCode(1);

/** `text` passed through `paint` without the spaces at either end, which are left unpainted, so that a colour never runs into the space that separates a label from its value; nothing at all is painted when only spaces are left. */
export function paintCore(text: string, paint: (text: string) => string): string {
  const core = text.trim();
  if (core === "") {
    return text;
  }
  const start = text.indexOf(core);
  return `${text.slice(0, start)}${paint(core)}${text.slice(start + core.length)}`;
}

/** `message`, written with `VALUE_MARK` where the value goes, with `value` in its place and the words before and after it painted (see `paintCore`). */
export function aroundValue(message: string, value: string, paint: (text: string) => string): string {
  const at = message.indexOf(VALUE_MARK);
  if (at === -1) {
    throw new TypeError(`message "${message}" was not written with the value mark`);
  }
  return `${paintCore(message.slice(0, at), paint)}${value}${paintCore(message.slice(at + VALUE_MARK.length), paint)}`;
}

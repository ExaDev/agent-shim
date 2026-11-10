/** Where the top-level `model` field of a JSON request body sits in the text it was found in: the name as the JSON source spells it (escapes included, `a\"b` and not `a"b`), and the offsets of its quoted string, the quotes included. */
export interface TopLevelModel {
  readonly value: string;
  /** The offset of the opening quote. */
  readonly start: number;
  /** The offset after the closing quote. */
  readonly end: number;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** The offset after the string that opens at `from` (a quote), honouring escapes, or undefined when the text ends inside it. */
function endOfString(text: string, from: number): number | undefined {
  for (let at = from + 1; at < text.length; at += 1) {
    if (text[at] === "\\") {
      at += 1;
    } else if (text[at] === '"') {
      return at + 1;
    }
  }
  return undefined;
}

/** The offset of the first character at or after `from` that is not whitespace. */
function skipWhitespace(text: string, from: number): number {
  let at = from;
  while (at < text.length && WHITESPACE.has(text[at] ?? "")) {
    at += 1;
  }
  return at;
}

/**
 * The `model` field of the object a body is, found without parsing it: a walk that knows strings and their escapes and the depth of braces and brackets, taking the field only as a key of the top-level object whose value is a non-empty string. A `model` nested in `messages` or in another object, one inside a string that merely looks like the pair, and one that is no key never count, and a body that is no object, or whose head ends before the field, has none.
 *
 * The one function the request scan reads the name with and both rewrites locate it with, over the decoded text or its bytes viewed one character each: the walk looks only at ASCII structure, which a multi-byte character never contains, so the offsets are right in either view.
 */
export function topLevelModel(text: string): TopLevelModel | undefined {
  let at = skipWhitespace(text, 0);
  if (text[at] !== "{") {
    return undefined;
  }
  let depth = 0;
  while (at < text.length) {
    const character = text[at];
    if (character === '"') {
      const end = endOfString(text, at);
      if (end === undefined) {
        return undefined;
      }
      // A string at depth one that is followed by a colon is a key of the top-level object.
      const afterKey = skipWhitespace(text, end);
      if (depth === 1 && text[afterKey] === ":" && text.slice(at, end) === '"model"') {
        const valueStart = skipWhitespace(text, afterKey + 1);
        if (text[valueStart] === '"') {
          const valueEnd = endOfString(text, valueStart);
          if (valueEnd === undefined) {
            return undefined;
          }
          const value = text.slice(valueStart + 1, valueEnd - 1);
          return value === "" ? undefined : { value, start: valueStart, end: valueEnd };
        }
        return undefined;
      }
      at = end;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        return undefined;
      }
    }
    at += 1;
  }
  return undefined;
}

import { decodedLiteral, skipWhitespace, startOfBody } from "./topLevelModel";

/**
 * The one structural walk over a whole request body, as text edits' coordinates: the members of its top-level object with the offsets of their values. The text is the body's bytes viewed one character each (`latin1`), the view the offsets of `topLevelModel` are in: the walk looks only at ASCII structure, which a multi-byte character never contains, so its offsets are right in that view and a name it decodes is the characters of that view (a multi-byte character is several), which only the ASCII names the door compares against survive.
 */

/** A member of the top-level object: the offsets of its key's opening quote and of its value, as `[valueStart, valueEnd)`. */
export interface Member {
  readonly key: string;
  readonly keyStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

const CLOSERS: Readonly<Record<string, string>> = { "{": "}", "[": "]" };

/** The escapes a JSON string may hold after a backslash: one of eight characters, or `u` and four hexadecimal digits. */
const ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y;

/** A JSON number, or one of the three literals: what a value that is no string, object or array may be. */
const SCALAR = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/y;

/** The offset after the JSON string that opens at `from` (a quote), or undefined when the text ends inside it or holds a character or an escape JSON does not allow in one: a control character (below a space) unescaped, or a backslash not followed by an escape of ESCAPE. */
function endOfStrictString(text: string, from: number): number | undefined {
  for (let at = from + 1; at < text.length; ) {
    const character = text[at] ?? "";
    if (character === '"') {
      return at + 1;
    }
    if (character < " ") {
      return undefined;
    }
    if (character === "\\") {
      ESCAPE.lastIndex = at;
      if (ESCAPE.exec(text) === null) {
        return undefined;
      }
      at = ESCAPE.lastIndex;
    } else {
      at += 1;
    }
  }
  return undefined;
}

/** The key of the member that opens at `from` (a quote), decoded, and the offset of its value after the colon, or undefined when what is there is no key followed by a colon. */
function keyAt(text: string, from: number): { readonly key: string; readonly valueStart: number } | undefined {
  const keyEnd = text[from] === '"' ? endOfStrictString(text, from) : undefined;
  const key = keyEnd === undefined ? undefined : decodedLiteral(text.slice(from, keyEnd));
  if (keyEnd === undefined || key === undefined) {
    return undefined;
  }
  const colon = skipWhitespace(text, keyEnd);
  return text[colon] === ":" ? { key, valueStart: skipWhitespace(text, colon + 1) } : undefined;
}

/**
 * The offset after the JSON value that starts at `from`, or undefined when the text ends inside it or what is there is not JSON: strings, numbers and literals are checked against their grammar, and objects and arrays member by member and element by element, so a text this accepts is one `JSON.parse` accepts. Nesting is tracked on a stack of the open containers, so a body nested deeply costs memory, never call depth.
 */
function endOfValue(text: string, from: number): number | undefined {
  const open: string[] = [];
  let at = from;
  for (;;) {
    const first = text[at];
    let descended = false;
    if (first === "{" || first === "[") {
      const inside = skipWhitespace(text, at + 1);
      if (text[inside] === CLOSERS[first]) {
        at = inside + 1;
      } else {
        open.push(first);
        const next = first === "{" ? keyAt(text, inside)?.valueStart : inside;
        if (next === undefined) {
          return undefined;
        }
        at = next;
        descended = true;
      }
    } else if (first === '"') {
      const end = endOfStrictString(text, at);
      if (end === undefined) {
        return undefined;
      }
      at = end;
    } else {
      SCALAR.lastIndex = at;
      if (SCALAR.exec(text) === null) {
        return undefined;
      }
      at = SCALAR.lastIndex;
    }
    if (descended) {
      continue;
    }
    // A value is complete: close every container it ends, or move to the next member or element of the one it is in.
    for (;;) {
      const container = open.at(-1);
      if (container === undefined) {
        return at;
      }
      at = skipWhitespace(text, at);
      if (text[at] === CLOSERS[container]) {
        open.pop();
        at += 1;
        continue;
      }
      if (text[at] !== ",") {
        return undefined;
      }
      const next = container === "{" ? keyAt(text, skipWhitespace(text, at + 1))?.valueStart : skipWhitespace(text, at + 1);
      if (next === undefined) {
        return undefined;
      }
      at = next;
      break;
    }
  }
}

/** The members of the top-level object `text` is, in order, or undefined when it is not a well-formed object to its end. One pass over the text: the model fields, the tools and the spans an edit replaces or removes are read from its result, not from further walks of the body. */
export function walkTopLevelMembers(text: string): readonly Member[] | undefined {
  let at = startOfBody(text);
  if (text[at] !== "{") {
    return undefined;
  }
  const members: Member[] = [];
  at = skipWhitespace(text, at + 1);
  if (text[at] === "}") {
    return skipWhitespace(text, at + 1) === text.length ? members : undefined;
  }
  for (;;) {
    const opened = keyAt(text, at);
    const valueEnd = opened === undefined ? undefined : endOfValue(text, opened.valueStart);
    if (opened === undefined || valueEnd === undefined) {
      return undefined;
    }
    members.push({ key: opened.key, keyStart: at, valueStart: opened.valueStart, valueEnd });
    const after = skipWhitespace(text, valueEnd);
    if (text[after] === "}") {
      return skipWhitespace(text, after + 1) === text.length ? members : undefined;
    }
    if (text[after] !== ",") {
      return undefined;
    }
    at = skipWhitespace(text, after + 1);
  }
}

/** The `[start, end)` spans of the elements of the array that occupies `[from, to)`. */
export function arrayElements(text: string, from: number, to: number): readonly (readonly [number, number])[] | undefined {
  const spans: [number, number][] = [];
  let at = skipWhitespace(text, from + 1);
  while (at < to - 1) {
    const end = endOfValue(text, at);
    if (end === undefined) {
      return undefined;
    }
    spans.push([at, end]);
    at = skipWhitespace(text, end);
    if (at >= to - 1) {
      break;
    }
    // Another element follows, so a comma must separate it (a missing comma is not JSON), and one must follow the comma (a trailing comma is not JSON).
    if (text[at] !== ",") {
      return undefined;
    }
    at = skipWhitespace(text, at + 1);
    if (at >= to - 1) {
      return undefined;
    }
  }
  return spans;
}

/** A top-level `model` field whose value is a non-empty string, with the string it decodes to and the span of its quoted value. */
export interface ModelField {
  readonly decoded: string;
  readonly start: number;
  readonly end: number;
}

/** The top-level `model` fields among `members` whose value is a non-empty string, in order: the same fields `topLevelModels` finds, read from the walk already made instead of another. */
export function modelFieldsOf(text: string, members: readonly Member[]): readonly ModelField[] {
  return members.flatMap((member) => {
    if (member.key !== "model") {
      return [];
    }
    const decoded = decodedLiteral(text.slice(member.valueStart, member.valueEnd));
    return decoded === undefined || decoded === "" ? [] : [{ decoded, start: member.valueStart, end: member.valueEnd }];
  });
}

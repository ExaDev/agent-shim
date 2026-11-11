import { decodedLiteral, endOfString, skipWhitespace, startOfBody } from "./topLevelModel";

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

/** The offset after the JSON value that starts at `from`, or undefined when the text ends inside it. */
function endOfValue(text: string, from: number): number | undefined {
  const first = text[from];
  if (first === '"') {
    return endOfString(text, from);
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let at = from; at < text.length; at += 1) {
      const character = text[at];
      if (character === '"') {
        const end = endOfString(text, at);
        if (end === undefined) {
          return undefined;
        }
        at = end - 1;
      } else if (character !== undefined && character in CLOSERS) {
        depth += 1;
      } else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          return at + 1;
        }
      }
    }
    return undefined;
  }
  let at = from;
  while (at < text.length && !/[\s,\]}]/.test(text[at] ?? "")) {
    at += 1;
  }
  return at > from ? at : undefined;
}

/** The members of the top-level object `text` is, in order, or undefined when it is not a well-formed object to its end. One pass over the text: the model fields, the tools and the spans an edit replaces or removes are read from its result, not from further walks of the body. */
export function walkTopLevelMembers(text: string): readonly Member[] | undefined {
  let at = startOfBody(text);
  if (text[at] !== "{") {
    return undefined;
  }
  const members: Member[] = [];
  at = skipWhitespace(text, at + 1);
  while (text[at] === '"') {
    const keyEnd = endOfString(text, at);
    const key = keyEnd === undefined ? undefined : decodedLiteral(text.slice(at, keyEnd));
    const colon = keyEnd === undefined ? undefined : skipWhitespace(text, keyEnd);
    if (keyEnd === undefined || key === undefined || colon === undefined || text[colon] !== ":") {
      return undefined;
    }
    const valueStart = skipWhitespace(text, colon + 1);
    const valueEnd = endOfValue(text, valueStart);
    if (valueEnd === undefined) {
      return undefined;
    }
    members.push({ key, keyStart: at, valueStart, valueEnd });
    at = skipWhitespace(text, valueEnd);
    if (text[at] !== ",") {
      break;
    }
    at = skipWhitespace(text, at + 1);
    // A comma promises another member: a trailing one is not JSON, and an edit by spans must never turn a body no parser accepts into one it does.
    if (text[at] !== '"') {
      return undefined;
    }
  }
  return text[at] === "}" ? members : undefined;
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

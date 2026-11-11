/** Where the top-level `model` field of a JSON request body sits in the text it was found in: the name it spells (escapes decoded, so `spark\/auto` is `spark/auto`), and the offsets of its quoted string, the quotes included, which are the only way the source spelling is reached: every decision is made on the decoded name and every rewrite replaces the span. */
export interface TopLevelModel {
  /** The string the quoted value decodes to (`a"b` for the source `a\\"b`). */
  readonly decoded: string;
  /** The offset of the opening quote. */
  readonly start: number;
  /** The offset after the closing quote. */
  readonly end: number;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** The byte order mark a UTF-8 body may open with, as the decoded text spells it and as the bytes viewed one character each spell it. JSON forbids it and a server may refuse the body, but the door must not let it hide a name it rewrites or refuses: a body that names `auto` after one is decided like any other. */
const BYTE_ORDER_MARKS: readonly string[] = ["\uFEFF", "\u00EF\u00BB\u00BF"];

/** The offset where a body's top-level value starts: after an optional byte order mark and any whitespace. */
export function startOfBody(text: string): number {
  const mark = BYTE_ORDER_MARKS.find((candidate) => text.startsWith(candidate));
  return skipWhitespace(text, mark === undefined ? 0 : mark.length);
}

/** The offset after the string that opens at `from` (a quote), honouring escapes, or undefined when the text ends inside it. */
export function endOfString(text: string, from: number): number | undefined {
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
export function skipWhitespace(text: string, from: number): number {
  let at = from;
  while (at < text.length && WHITESPACE.has(text[at] ?? "")) {
    at += 1;
  }
  return at;
}

/** The text of a JSON string literal (quotes included) as the string it spells, or undefined when it is not a valid literal. */
export function decodedLiteral(literal: string): string | undefined {
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** What one walk over a body's top-level object found: the model fields it reached whose value is a non-empty string, how many top-level `model` keys it reached whatever their value (a null, a number or an empty string counts), and how many characters of the text it walked to reach them (the work the walk cost). */
export interface TopLevelWalk {
  readonly models: readonly TopLevelModel[];
  readonly keys: number;
  readonly walked: number;
}

/**
 * The `model` keys of the top-level object a body is whose value is a non-empty string, in order, found without parsing the body: a walk that knows strings and their escapes and the depth of braces and brackets, so a `model` nested in `messages` or in another object, one inside a string that merely looks like the pair, and one that is no key never count. A key spelled with an escape (`"mod\u0065l"`) is the key `model` to any JSON parser and counts. A body that is no object, or whose head ends before a field, has none after it. Each field comes with its value as the JSON source spells it, the string that value decodes to, and the offsets of its quoted literal.
 *
 * The one walk the request scan reads the name with and every rewrite of it locates it with, over the decoded text or the body's bytes viewed one character each (`latin1`). The walk looks only at ASCII structure, which a multi-byte character never contains, so it finds the same fields in either view; the string it decodes a name to is a string of the characters walked (in the `latin1` view a multi-byte character is several characters, so `café` decodes to its bytes read one each), which only the ASCII names the door compares against are right in; the offsets are character offsets of the text walked, so they locate bytes only in the `latin1` view, and the scan, which walks the utf8-decoded text, uses only the name.
 */
function walkTopLevelModels(text: string, firstOnly: boolean): TopLevelWalk {
  const found: TopLevelModel[] = [];
  let keys = 0;
  let at = startOfBody(text);
  if (text[at] !== "{") {
    return { models: found, keys, walked: at };
  }
  let depth = 0;
  while (at < text.length) {
    const character = text[at];
    if (character === '"') {
      const end = endOfString(text, at);
      if (end === undefined) {
        return { models: found, keys, walked: at };
      }
      // A string at depth one that is followed by a colon is a key of the top-level object.
      const afterKey = skipWhitespace(text, end);
      if (depth === 1 && text[afterKey] === ":" && decodedLiteral(text.slice(at, end)) === "model") {
        keys += 1;
        const valueStart = skipWhitespace(text, afterKey + 1);
        if (text[valueStart] === '"') {
          const valueEnd = endOfString(text, valueStart);
          if (valueEnd === undefined) {
            return { models: found, keys, walked: at };
          }
          const decoded = decodedLiteral(text.slice(valueStart, valueEnd));
          if (decoded !== undefined && decoded !== "") {
            found.push({ decoded, start: valueStart, end: valueEnd });
            if (firstOnly) {
              return { models: found, keys, walked: valueEnd };
            }
          }
          at = valueEnd;
          continue;
        }
      }
      at = end;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        return { models: found, keys, walked: at };
      }
    }
    at += 1;
  }
  return { models: found, keys, walked: at };
}

/** Every top-level `model` field of a body, in order, with the work the walk cost: the walk that checks a body for two of them (`topLevelModels` reads only its `models`). */
export function walkAllTopLevelModels(text: string): TopLevelWalk {
  return walkTopLevelModels(text, false);
}

/** The first top-level `model` field of a body with the work it cost: the walk stops at that field, so a body with the field first is walked only as far as it. */
export function walkFirstTopLevelModel(text: string): TopLevelWalk {
  return walkTopLevelModels(text, true);
}

/** Every top-level `model` field of a body whose value is a non-empty string, in order (see `walkTopLevelModels`): where a body is checked for two of them. */
export function topLevelModels(text: string): readonly TopLevelModel[] {
  return walkAllTopLevelModels(text).models;
}

/** The first top-level `model` field of a body, or undefined when it has none; the walk stops at it. */
export function topLevelModel(text: string): TopLevelModel | undefined {
  return walkFirstTopLevelModel(text).models[0];
}

/** The answer to a request that names its model in more than one top-level field where the door would rewrite the name: which field a server reads differs between parsers, so no rewrite can be known to change what it reads. */
export const AMBIGUOUS_MODEL_MESSAGE = "the request has more than one top-level model field, so which model it names is ambiguous";

/** Whether a body has more than one top-level `model` key, whatever the values (`{"model":"auto","model":null}` has two). Which of them a server reads differs between parsers (the last usually wins), so a rewrite of one cannot be known to change what the server reads: such a body is refused where it would be rewritten. */
export function hasSeveralTopLevelModels(text: string): boolean {
  return walkAllTopLevelModels(text).keys > 1;
}

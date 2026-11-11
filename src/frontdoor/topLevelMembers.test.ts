import { describe, expect, it } from "vitest";

import { arrayElements, walkTopLevelMembers } from "./topLevelMembers";

describe("the walk over a body's top-level object", () => {
  it.each([
    ["a trailing comma", '{"a":1,}'],
    ["a trailing comma after a nested value", '{"a":{"b":1},}'],
    ["a comma with no member after it, before whitespace", '{"a":1 , }'],
    ["a trailing comma inside a nested object", '{"a":{"type":"auto",}}'],
    ["a missing colon", '{"a" 1}'],
    ["an object that is never closed", '{"a":1'],
    ["text after an empty object", '{} x'],
    ["text after an empty object, past whitespace", '{ }\n x'],
  ])("is no walk of %s", (_label, text) => {
    expect(walkTopLevelMembers(text)).toBeUndefined();
  });

  it.each(['{}', '{ }', '{"a":"a literal space inside a string"}', '{"a":1}', '{"a":1,"b":[1,2]}', ' { "a" : 1 , "b" : {} } '])("walks the well-formed %s", (text) => {
    expect(walkTopLevelMembers(text)).toBeDefined();
  });
});

describe("what the walk accepts of a well-formed body", () => {
  const SEEDS: readonly (readonly [string, string])[] = [
    ["a space, a tab-free sentence and punctuation inside a string", '{"a":"a literal space, and: punctuation [ ] { } , inside"}'],
    ["every single-character escape", '{"a":"\\" \\\\ \\/ \\b \\f \\n \\r \\t"}'],
    ["a unicode escape in both cases of its digits", '{"a":"\\u00e9\\u00E9\\uD83D\\ude00"}'],
    ["an escaped quote and a backslash at the end of a string", '{"a":"x\\"","b":"y\\\\"}'],
    ["a key with a space and an escape", '{"a key\\n":1,"b":2}'],
    ["a number of each form", '{"a":0,"b":-0,"c":12,"d":-3.5,"e":1e3,"f":2E-2,"g":1.5e+10,"h":1E3,"i":-0.5e+2}'],
    ["each literal", '{"a":true,"b":false,"c":null}'],
    ["non-ASCII characters in a string", '{"a":"caf\u00e9 \u65e5\u672c"}'],
    ["each of the four whitespace characters between tokens", '{ \t"a"\r:\n1 ,\r\n"b"\t:\t[\r1\n,\t2\r]\n}'],
    ["nested objects and arrays with whitespace everywhere", ' { "a" : [ 1 , { "b" : [ ] } , "c" ] , "d" : { } } '],
  ];

  it.each(SEEDS)("walks %s, finding the members a parser finds", (_label, text) => {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(walkTopLevelMembers(text)?.map((member) => member.key)).toEqual(Object.keys(parsed));
  });

  it("finds each member's value at the offsets of its own text", () => {
    const text = '{"a":"x y","b":[1, 2],"c":-1.5e3}';
    const members = walkTopLevelMembers(text) ?? [];
    expect(members.map((member) => text.slice(member.valueStart, member.valueEnd))).toEqual(['"x y"', "[1, 2]", "-1.5e3"]);
  });
});

describe("the elements of an array span", () => {
  const elementsOf = (text: string): readonly (readonly [number, number])[] | undefined => arrayElements(text, 0, text.length);

  it.each([
    ["a missing comma", "[1 2]"],
    ["a missing comma with more elements after it", "[1 2 3]"],
    ["a missing comma between objects", '[{"a":1} {"b":2}]'],
    ["a trailing comma", "[1,]"],
    ["a trailing comma before whitespace", "[1, ]"],
    ["a leading comma", "[,1]"],
  ])("is none for %s", (_label, text) => {
    expect(elementsOf(text)).toBeUndefined();
  });

  it.each([
    ["[]", []],
    ["[1]", ["1"]],
    ["[ 1 , 2 ]", ["1", "2"]],
    ['[{"type":"x"}, 1]', ['{"type":"x"}', "1"]],
    ['[{"type":"x"}, true]', ['{"type":"x"}', "true"]],
  ])("is each element of the well-formed %s, a bare last one included", (text, expected) => {
    expect(elementsOf(text)?.map(([start, end]) => text.slice(start, end))).toEqual(expected);
  });
});

/** The parameters of the linear congruential generator of ISO C's example `rand` (a multiplier, an increment and a modulus of 2^31): any fixed generator would do, it only has to be the same on every run. */
const LCG_MULTIPLIER = 1_103_515_245;
const LCG_INCREMENT = 12_345;
const LCG_MODULUS = 2_147_483_648;

/** The first character code a string may hold raw: everything below it is a control character JSON requires escaped. */
const SPACE_CODE = 0x20;

/** Whether a parser takes `text` as a JSON object, which is what a body must be for the walk to name its members. */
const parsesAsObject = (text: string): boolean => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
};

describe("what the walk accepts is what a JSON parser accepts", () => {
  it.each([
    ['{"model":"auto","a":ue}', "a scalar that is no literal"],
    ['{"a":01}', "a number with a leading zero"],
    ['{"a":1.}', "a number with a bare point"],
    ['{"a":-}', "a bare minus"],
    ['{"a":[}]}', "mismatched brackets"],
    ['{"a":{"b":1]}', "a bracket closing an object"],
    ['{"a":"\\q"}', "an escape JSON does not have"],
    ['{"a":"\\u12"}', "a short unicode escape"],
    ['{"a":"line\nbreak"}', "a raw control character in a string"],
    ['{"a":1}x', "text after the object"],
    ['{"a":1 "b":2}', "a missing comma between members"],
    ['{"a":truex}', "a literal run into a letter"],
    ['{"a":{"b":}}', "a member with no value"],
    ['{"a":[1,,2]}', "an empty element"],
    ['{"a":[1 2]}', "a missing comma inside an array of a member"],
    ['{"a":{"b":1 "c":2}}', "a missing comma inside an object of a member"],
    ['{"a":[{"b":1} {"c":2}]}', "a missing comma between objects inside an array of a member"],
    ['{"a":[[1 2],3]}', "a missing comma inside a nested array"],
        ['{"a":["x	y"]}', "a raw tab in a string inside an array"],
    ['{"k\\nz":1,"a":"\\u00"}', "a short unicode escape after a good escape"],
  ])("refuses %s (%s)", (text) => {
    expect(walkTopLevelMembers(text)).toBeUndefined();
  });

  it.each(Array.from({ length: SPACE_CODE }, (_unused, code) => code))("refuses a raw control character %i in a value, in a key and in a nested string, as a parser does", (code) => {
    const raw = String.fromCharCode(code);
    for (const text of [`{"a":"x${raw}y"}`, `{"a${raw}":1}`, `{"a":["x${raw}"]}`, `{"a":{"b":"${raw}"}}`]) {
      expect(parsesAsObject(text), JSON.stringify(text)).toBe(false);
      expect(walkTopLevelMembers(text), JSON.stringify(text)).toBeUndefined();
    }
  });

  it("walks a body nested far deeper than a call stack allows", () => {
    const depth = 200_000;
    const text = `{"a":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    expect(walkTopLevelMembers(text)).toHaveLength(1);
  });

  describe("against a JSON parser, over seeded edits of valid bodies", () => {
    const SEEDS = ['{\r\n\t"model" : "auto" ,\r\n"x":[1,\r2]}', '{"model":"auto","tools":[{"type":"x","n":1.5e3},true,null],"s":"a\\n\\u00e9"}', '{"a":{"b":[1,2,{"c":-0}]},"d":"x"}', '{ "a" : [ ] , "b" : { } }', '{"a":{"b":1, "c":2},"d":[1, 2, {"e":"f"}], "g":"\\u00e9\\u00E9\\/\\t"}'];
    /** The characters an edit inserts or substitutes: structure, whitespace of every kind and the starts of each literal, number and escape. */
    const ALPHABET = ['"', "\\", ",", ":", "[", "]", "{", "}", " ", "\t", "\r", "\n", "\f", "\v", "\u00a0", "0", "1", "-", "+", ".", "e", "E", "t", "r", "u", "l", "n", "f", "x", "g", "/", "\u0001"];
    const MAX_EDITS = 3;
    /** The kinds of edit: insert a character, replace one, delete one. */
    const EDIT_KINDS = 3;
    /** The share of the mutants (one in this many) that must come out each way for the comparison to say anything about it. */
    const MIN_SHARE = 20;
    const MUTANTS = 40_000;
    let seed = 1;
    const next = (bound: number): number => {
      seed = (seed * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
      return seed % bound;
    };
    const edited = (base: string): string => {
      let text = base;
      for (let count = 1 + next(MAX_EDITS); count > 0; count -= 1) {
        const at = next(text.length + 1);
        const insert = ALPHABET[next(ALPHABET.length)] ?? "";
        const kind = next(EDIT_KINDS);
        text = kind === 0 ? text.slice(0, at) + insert + text.slice(at) : kind === 1 ? text.slice(0, at) + insert + text.slice(at + 1) : text.slice(0, at) + text.slice(at + 1);
      }
      return text;
    };

    it.each(SEEDS)("walks each seed (%#), so the comparison below is not vacuous", (seedText) => {
      expect(walkTopLevelMembers(seedText), seedText).toBeDefined();
    });

    it("agrees with the parser in both directions: nothing it refuses is walked, and every object it accepts is", () => {
      const walkedButRefused: string[] = [];
      const acceptedButNotWalked: string[] = [];
      let bothAccepted = 0;
      let bothRefused = 0;
      for (let count = 0; count < MUTANTS; count += 1) {
        const text = edited(SEEDS[next(SEEDS.length)] ?? "");
        const walked = walkTopLevelMembers(text) !== undefined;
        const parsed = parsesAsObject(text);
        if (walked && !parsed) walkedButRefused.push(text);
        if (parsed && !walked) acceptedButNotWalked.push(text);
        if (walked && parsed) bothAccepted += 1;
        if (!walked && !parsed) bothRefused += 1;
      }
      expect(walkedButRefused).toEqual([]);
      expect(acceptedButNotWalked).toEqual([]);
      // A comparison that never meets one of the two outcomes proves nothing about it.
      expect(bothAccepted).toBeGreaterThan(MUTANTS / MIN_SHARE);
      expect(bothRefused).toBeGreaterThan(MUTANTS / MIN_SHARE);
    });
  });

  it.each([
    ["a missing comma between members after a value", '{"a":1 x"b":2}', false],
    ["a space after a comma inside a nested object", '{"a":{"b":1, "c":2}}', true],
    ["a truncated unicode escape digit", '{"a":"\\u001g"}', false],
    ["a three-digit unicode escape", '{"a":"\\u001"}', false],
    ["a missing comma in a nested object", '{"a":{"b":1 "c":2}}', false],
    ["a missing comma between arrays' elements in a member", '{"a":[1 2]}', false],
  ])("decides %s as a parser does", (_label, text, accepted) => {
    expect(walkTopLevelMembers(text) !== undefined).toBe(accepted);
    expect(parsesAsObject(text)).toBe(accepted);
  });
});

describe("the members of a body that opens with a byte order mark", () => {
  it.each([["decoded", "\uFEFF"], ["viewed one character each", "\u00EF\u00BB\u00BF"]])("are found after the mark, %s", (_label, mark) => {
    const members = walkTopLevelMembers(`${mark}{"model":"auto","a":1}`);
    expect(members?.map((member) => member.key)).toEqual(["model", "a"]);
  });
});

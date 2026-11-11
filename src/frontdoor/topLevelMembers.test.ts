import { describe, expect, it } from "vitest";

import { walkTopLevelMembers } from "./topLevelMembers";

describe("the walk over a body's top-level object", () => {
  it.each([
    ["a trailing comma", '{"a":1,}'],
    ["a trailing comma after a nested value", '{"a":{"b":1},}'],
    ["a comma with no member after it, before whitespace", '{"a":1 , }'],
    ["a missing colon", '{"a" 1}'],
    ["an object that is never closed", '{"a":1'],
  ])("is no walk of %s", (_label, text) => {
    expect(walkTopLevelMembers(text)).toBeUndefined();
  });

  it.each(['{}', '{ }', '{"a":1}', '{"a":1,"b":[1,2]}', ' { "a" : 1 , "b" : {} } '])("walks the well-formed %s", (text) => {
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

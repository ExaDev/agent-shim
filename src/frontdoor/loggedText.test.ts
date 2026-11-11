import { describe, expect, it } from "vitest";

import { MAX_LOGGED_TEXT_CHARS, holdsUnsafeCharacter, quotedForLog } from "./loggedText";

describe("a text a provider supplied, as a log line carries it", () => {
  it("is quoted with JSON escapes, so a newline stays inside it", () => {
    const quoted = quotedForLog("model\nfront door: forged line");
    expect(quoted).not.toContain("\n");
    expect(quoted).toBe('"model\\nfront door: forged line"');
  });

  it("stays well-formed when the cut falls inside a surrogate pair: the half that is left is written as an escape, not as a broken character", () => {
    const quoted = quotedForLog(`${"x".repeat(MAX_LOGGED_TEXT_CHARS - 1)}\u{1F600}`);
    expect(quoted).toMatch(/^"x+\\ud83d"$/u);
    expect(JSON.parse(quoted)).toHaveLength(MAX_LOGGED_TEXT_CHARS);
    // Every character written is printable ASCII, so nothing in it can be taken for a line break.
    expect(quoted).toMatch(/^[\x20-\x7e]*$/u);
  });

  it("is cut to the bound, and a text within it is kept whole", () => {
    expect(JSON.parse(quotedForLog("x".repeat(MAX_LOGGED_TEXT_CHARS * 2)))).toHaveLength(MAX_LOGGED_TEXT_CHARS);
    expect(JSON.parse(quotedForLog("x".repeat(MAX_LOGGED_TEXT_CHARS)))).toHaveLength(MAX_LOGGED_TEXT_CHARS);
  });

  it.each([
    ["DEL", "\u007f", "\\u007f"],
    ["a C1 control (the escape that opens a CSI sequence)", "\u009b", "\\u009b"],
    ["NEL", "\u0085", "\\u0085"],
    ["the line separator", "\u2028", "\\u2028"],
    ["the paragraph separator", "\u2029", "\\u2029"],
    ["a bidirectional override", "\u202e", "\\u202e"],
    ["a zero-width joiner", "\u200d", "\\u200d"],
    ["a tag character past U+FFFF", "\u{e0001}", "\\udb40\\udc01"],
  ])("writes %s as an escape, never as the character", (_label, character, escape) => {
    const quoted = quotedForLog(`a${character}b`);
    expect(quoted).toBe(`"a${escape}b"`);
    expect(quoted).toMatch(/^[\x20-\x7e]*$/u);
    expect(JSON.parse(quoted)).toBe(`a${character}b`);
  });
});

describe("which characters a text written into a line may not hold", () => {
  it.each(["\n", "\u007f", "\u009b", "\u2028", "\u2029", "\u202e", "\u200d"])("names %j", (character) => {
    expect(holdsUnsafeCharacter(`a${character}b`)).toBe(true);
  });

  it.each(["plain", "glm-5.3[1m]", "caf\u00e9", "\u65e5\u672c", "\u{1f600}"])("lets %j through, as it is quoted unchanged", (text) => {
    expect(holdsUnsafeCharacter(text)).toBe(false);
    expect(JSON.parse(quotedForLog(text))).toBe(text);
  });

  it("escapes every unsafe character of a text, not only the first", () => {
    expect(quotedForLog("a\u2028b\u2029c\u202ed")).toBe('"a\\u2028b\\u2029c\\u202ed"');
  });

  it("keeps exactly 64 characters of a longer text", () => {
    const LOGGED = 64;
    expect(MAX_LOGGED_TEXT_CHARS).toBe(LOGGED);
    expect(JSON.parse(quotedForLog("x".repeat(LOGGED + 1)))).toBe("x".repeat(LOGGED));
  });
});

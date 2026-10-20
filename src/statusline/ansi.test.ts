import { describe, expect, it } from "vitest";

import { ESCAPE, truncateToColumns, visibleLength } from "./ansi";

const THREE_COLUMNS = 3;
const SIX_COLUMNS = 6;
const FOUR_COLUMNS = 4;
const TWO_COLUMNS = 2;
const FIVE_COLUMNS = 5;

describe("visibleLength", () => {
  it("counts the columns a string draws, not its code units", () => {
    expect(visibleLength("abc")).toBe(THREE_COLUMNS);
    expect(visibleLength("日本語")).toBe(SIX_COLUMNS);
    expect(visibleLength("\u{1F469}‍\u{1F4BB}")).toBe(2);
    expect(visibleLength("é")).toBe(1);
  });

  it("counts nothing for a colour, a link or any other escape sequence", () => {
    expect(visibleLength(`${ESCAPE}[32mabc${ESCAPE}[0m`)).toBe(THREE_COLUMNS);
    expect(visibleLength(`${ESCAPE}]8;;https://example.com\u0007link${ESCAPE}]8;;\u0007`)).toBe(FOUR_COLUMNS);
  });
});

describe("truncateToColumns", () => {
  it("keeps what fits and cuts between characters a person sees", () => {
    expect(truncateToColumns("abcdef", FOUR_COLUMNS)).toBe("abcd");
    expect(truncateToColumns("abc", FOUR_COLUMNS)).toBe("abc");
    expect(truncateToColumns("e\u0301e\u0301e\u0301", TWO_COLUMNS)).toBe("e\u0301e\u0301");
    expect(truncateToColumns("\u{1F469}\u200D\u{1F4BB}\u{1F469}\u200D\u{1F4BB}", THREE_COLUMNS)).toBe("\u{1F469}\u200D\u{1F4BB}");
  });

  it("leaves out a wide character that would cross the limit instead of splitting it", () => {
    expect(truncateToColumns("\u65E5\u672C\u8A9E", FOUR_COLUMNS)).toBe("\u65E5\u672C");
    expect(truncateToColumns("\u65E5\u672C\u8A9E", FIVE_COLUMNS)).toBe("\u65E5\u672C");
    expect(truncateToColumns("a\u65E5", TWO_COLUMNS)).toBe("a");
  });
});

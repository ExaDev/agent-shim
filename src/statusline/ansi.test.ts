import { describe, expect, it } from "vitest";

import { ESCAPE, truncateToColumns, truncateWithEllipsis, visibleLength } from "./ansi";

const THREE_COLUMNS = 3;
const SIX_COLUMNS = 6;
const FOUR_COLUMNS = 4;
const TWO_COLUMNS = 2;
const FIVE_COLUMNS = 5;

describe("visibleLength", () => {
  it("counts the columns a string draws, not its code units", () => {
    expect(visibleLength("abc")).toBe(THREE_COLUMNS);
    expect(visibleLength("\u65e5\u672c\u8a9e")).toBe(SIX_COLUMNS);
    expect(visibleLength("\u{1F469}\u200D\u{1F4BB}")).toBe(2);
    expect(visibleLength("e\u0301")).toBe(1);
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

  it("never cuts an escape sequence, which takes no column", () => {
    const red = `${ESCAPE}[31m`;
    const reset = `${ESCAPE}[0m`;
    expect(truncateToColumns(`${red}red${reset}`, TWO_COLUMNS)).toBe(`${red}re${reset}`);
    expect(truncateToColumns(`${red}red${reset}`, THREE_COLUMNS)).toBe(`${red}red${reset}`);
    expect(truncateToColumns(`${red}red`, 0)).toBe(red);
    expect(truncateToColumns(`${ESCAPE}]0;title\u0007abc`, TWO_COLUMNS)).toBe(`${ESCAPE}]0;title\u0007ab`);
  });

  it("measures the same as visibleLength, so what it keeps never exceeds the limit", () => {
    const coloured = `${ESCAPE}[32m\u65E5\u672C${ESCAPE}[0m abc`;
    for (let limit = 0; limit <= visibleLength(coloured); limit += 1) {
      expect(visibleLength(truncateToColumns(coloured, limit)), String(limit)).toBeLessThanOrEqual(limit);
    }
    expect(visibleLength(truncateToColumns(coloured, visibleLength(coloured)))).toBe(visibleLength(coloured));
  });
});

describe("truncateWithEllipsis", () => {
  it("leaves text that fits alone, at exactly the limit too", () => {
    expect(truncateWithEllipsis("abcd", FOUR_COLUMNS, "\u2026")).toBe("abcd");
    expect(truncateWithEllipsis("abc", FOUR_COLUMNS, "\u2026")).toBe("abc");
  });

  it("cuts text that does not fit so that the cut text and the ellipsis together fit", () => {
    expect(truncateWithEllipsis("abcde", FOUR_COLUMNS, "\u2026")).toBe("abc\u2026");
    expect(truncateWithEllipsis("abcdef", FIVE_COLUMNS, "...")).toBe("ab...");
  });

  it("counts a wide character as the columns it takes, and never splits one", () => {
    expect(truncateWithEllipsis("\u65e5\u672c\u8a9e", FOUR_COLUMNS, "\u2026")).toBe("\u65e5\u2026");
  });

  it("leaves only the ellipsis when the limit is smaller than it", () => {
    expect(truncateWithEllipsis("abcdef", 1, "...")).toBe("...");
  });
});

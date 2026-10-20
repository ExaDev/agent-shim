import { describe, expect, it } from "vitest";

import { ESCAPE, visibleLength } from "./ansi";

const THREE_COLUMNS = 3;
const SIX_COLUMNS = 6;
const FOUR_COLUMNS = 4;

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

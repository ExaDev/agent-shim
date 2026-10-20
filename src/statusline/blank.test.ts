import { describe, expect, it } from "vitest";

import { drawsNothing } from "./blank";

describe("drawsNothing", () => {
  it("is true for text with no visible cell", () => {
    for (const nothing of ["", " ", "\u00A0\u3000", "\u2800", "\u3164", "\uFFA0", "\u115F\u1160", "\u0301", "\u0301\u0302", "\u034F", "\u180B", "\u{E0100}", "\u200B", "\uFE0F"]) {
      expect(drawsNothing(nothing), JSON.stringify(nothing)).toBe(true);
    }
  });

  it("is false for text with any visible cell, including a mark on a letter", () => {
    for (const something of ["a", "e\u0301", "\u65e5", "\u{1F600}", " a ", "\u2800a"]) {
      expect(drawsNothing(something), JSON.stringify(something)).toBe(false);
    }
  });
});

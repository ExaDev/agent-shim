import { describe, expect, it } from "vitest";

import { ESCAPE } from "./ansi";
import { MAX_DISPLAY_TEXT_CHARS } from "../config/statusline";
import { graphemesOf } from "./graphemes";
import { boundedDisplayText, sanitiseDisplayText, visibleDisplayText } from "./sanitise";

const EXCESS_EMOJI = 5;

describe("sanitiseDisplayText", () => {
  it("leaves ordinary text, including non-ASCII letters and spaces, alone", () => {
    expect(sanitiseDisplayText("feat/na\u00efve branch")).toBe("feat/na\u00efve branch");
  });

  it("removes colour, cursor and hyperlink sequences with the text they would have carried", () => {
    expect(sanitiseDisplayText(`a${ESCAPE}[31mb${ESCAPE}[0mc`)).toBe("abc");
    expect(sanitiseDisplayText(`a${ESCAPE}[2Jb`)).toBe("ab");
    expect(sanitiseDisplayText(`${ESCAPE}]8;;https://example.com${ESCAPE}\\link${ESCAPE}]8;;${ESCAPE}\\`)).toBe("link");
    expect(sanitiseDisplayText(`${ESCAPE}]0;title\u0007x`)).toBe("x");
  });

  it("removes an operating system command that never ends, payload included, up to the next escape", () => {
    expect(sanitiseDisplayText(`a${ESCAPE}]0;never ends`)).toBe("a");
    expect(sanitiseDisplayText(`a${ESCAPE}]0;cut short${ESCAPE}[31mb`)).toBe("ab");
  });

  it("removes control characters and bidirectional overrides", () => {
    expect(sanitiseDisplayText("a\nb\tc\u0000d\u007fe")).toBe("abcde");
    expect(sanitiseDisplayText("gpj\u202etxt.exe")).toBe("gpjtxt.exe");
    expect(sanitiseDisplayText("a\u2066b\u200ec")).toBe("abc");
  });
});

describe("boundedDisplayText", () => {
  it("sanitises, then trims, so an escape sequence leaves nothing behind and edge whitespace goes", () => {
    expect(boundedDisplayText(`  ${ESCAPE}[31mopus${ESCAPE}[0m \n`)).toBe("opus");
  });

  it("leaves nothing for text with nothing visible", () => {
    expect(boundedDisplayText(` \t${ESCAPE}[2J `)).toBe("");
  });

  it("cuts to the most characters allowed, counting a character outside the basic plane once", () => {
    const long = "\u{1F600}".repeat(MAX_DISPLAY_TEXT_CHARS + EXCESS_EMOJI);
    expect(graphemesOf(boundedDisplayText(long))).toHaveLength(MAX_DISPLAY_TEXT_CHARS);
  });
});

describe("sanitiseDisplayText on every code point", () => {
  /** The characters the control and bidirectional class removes, as ranges written out apart from the expression that implements it: the control characters, the Arabic letter mark, the left-to-right and right-to-left marks, the embeddings and overrides, the isolates, and the deprecated format controls. */
  const REMOVED_RANGES: readonly (readonly [string, string])[] = [
    ["\u0000", "\u001f"],
    ["\u007f", "\u009f"],
    ["\u061c", "\u061c"],
    ["\u200e", "\u200f"],
    ["\u202a", "\u202e"],
    ["\u2066", "\u2069"],
    ["\u206a", "\u206f"],
  ];
  const HEX = 16;
  const LAST_CODE_POINT = 0x10ffff;

  it("removes exactly the code points listed, and leaves every other one alone", () => {
    const wrong: string[] = [];
    for (let codePoint = 0; codePoint <= LAST_CODE_POINT; codePoint += 1) {
      const text = String.fromCodePoint(codePoint);
      // Every range lies below the surrogates, so comparing single-character strings orders them by code point.
      const expectedRemoved = REMOVED_RANGES.some(([low, high]) => text >= low && text <= high);
      // An escape on its own is a control character, so it is removed with or without the sequence rule; every other code point stands alone and starts no sequence.
      if ((sanitiseDisplayText(text) === "") !== expectedRemoved) {
        wrong.push(codePoint.toString(HEX));
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("visibleDisplayText", () => {
  const ENGLAND = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";

  it("leaves a name alone, including its letters, emoji and the joiners its script needs", () => {
    expect(visibleDisplayText("Claude Opus 5")).toBe("Claude Opus 5");
    expect(visibleDisplayText("Fa\u200Crsi")).toBe("Fa\u200Crsi");
    expect(visibleDisplayText("\u{1F469}\u200D\u{1F4BB} dev")).toBe("\u{1F469}\u200D\u{1F4BB} dev");
    expect(visibleDisplayText("\u2764\uFE0F ok")).toBe("\u2764\uFE0F ok");
  });

  it("turns a space of any width into a plain space rather than joining the words", () => {
    expect(visibleDisplayText("Claude\u00A0Opus")).toBe("Claude Opus");
    expect(visibleDisplayText("a\u2003b\u3000c")).toBe("a b c");
    expect(visibleDisplayText("  padded \u00A0")).toBe("padded");
  });

  it("keeps the tag characters of a flag and removes tag characters that spell no flag", () => {
    expect(visibleDisplayText(`${ENGLAND} team`)).toBe(`${ENGLAND} team`);
    expect(visibleDisplayText("a\u{E0067}\u{E0062}b")).toBe("ab");
  });

  it("removes zero-width and invisible format characters and line separators from a name that has more", () => {
    expect(visibleDisplayText("Fa\u200Bble\u2060\uFEFF\u00AD")).toBe("Fable");
    expect(visibleDisplayText("two\u2028lines\u2029")).toBe("twolines");
  });

  it("is empty when nothing visible is left", () => {
    for (const nothing of ["\u0301", "\u0301\u0302", "\u115F", "\u1160", "\u115F\u1160", "\u180B", "\u034F", "\u{E0100}", "", "   ", "\u200B", "\u2060\u200B", "\u200D", "\u200C\u200D", "\uFE0F", "\u2800", "\u2800\u2800", "\u3164", "\u00A0\u2003", `${ESCAPE}]0;title`, "\u{E0067}\u{E007F}"]) {
      expect(visibleDisplayText(nothing), JSON.stringify(nothing)).toBe("");
    }
  });

  it("gives the same result when applied to its own result", () => {
    const inputs = ["Claude\u00A0Opus", "\u0301abc", "a\u200B\u0301", "\u{1F3F4}\u{E0067}\u{E0062}\u{E007F} x", "Fa\u200Crsi", "a\u2800\u115Fb", "\u0301\u0302", " \u034F ", `${ESCAPE}[31mred${ESCAPE}[0m`, "\u{1F469}\u200D\u{1F4BB}\u200D"];
    for (const input of inputs) {
      const once = visibleDisplayText(input);
      expect(visibleDisplayText(once), JSON.stringify(input)).toBe(once);
    }
  });

  it("drops a mark that stands alone before a name and keeps a mark on a letter", () => {
    expect(visibleDisplayText("\u0301abc")).toBe("abc");
    expect(visibleDisplayText("e\u0301abc")).toBe("e\u0301abc");
  });

  it("keeps the word break when a shaping character is attached to a space", () => {
    for (const shaping of ["\u200D", "\u200C", "\uFE0F", "\u0301", "\u034F"]) {
      expect(visibleDisplayText(`Claude ${shaping}Opus`), JSON.stringify(shaping)).toBe("Claude Opus");
    }
    expect(visibleDisplayText("a \u0301b")).toBe("a b");
    expect(visibleDisplayText("a\u00A0\u200Db")).toBe("a b");
  });

  it("leaves a Hangul filler that belongs to a decomposed syllable, and turns one that stands apart into a space", () => {
    expect(visibleDisplayText("x\u115F\u1161")).toBe("x\u115F\u1161");
    expect(visibleDisplayText("\u1100\u1160\u11A8")).toBe("\u1100\u1160\u11A8");
    expect(visibleDisplayText("\uA960\u1160\uD7CB")).toBe("\uA960\u1160\uD7CB");
    expect(visibleDisplayText("a\u115Fb")).toBe("a b");
    expect(visibleDisplayText("a\u1160 b")).toBe("a  b");
    expect(visibleDisplayText("a\u115F\u1160b")).toBe("a  b");
  });

  it("looks at the jamo before a filler as well as the one after it", () => {
    expect(visibleDisplayText("\u1100\u115Fb")).toBe("\u1100\u115Fb");
    expect(visibleDisplayText("\u1100\u1160b")).toBe("\u1100\u1160b");
    expect(visibleDisplayText("\u115F\u1161b")).toBe("\u115F\u1161b");
  });

  describe("the jamo that keep a filler in its cluster", () => {
    /** The first and last code point of each range of Hangul jamo other than the fillers. */
    const INSIDE = ["\u1100", "\u115E", "\u1161", "\u11FF", "\uA960", "\uA97F", "\uD7B0", "\uD7FF"];
    /** The code points just outside those ranges (the surrogates between the last two blocks cannot stand alone, so the next code point after them is used). */
    const OUTSIDE = ["\u10FF", "\u1200", "\uA95F", "\uA980", "\uD7AF", "\uE000"];
    const FILLERS = ["\u115F", "\u1160"];

    it("leaves a filler beside the end of any jamo range as part of the cluster, on either side", () => {
      for (const jamo of INSIDE) {
        for (const filler of FILLERS) {
          expect(visibleDisplayText(`a${jamo}${filler}b`), `${JSON.stringify(jamo)} then ${JSON.stringify(filler)}`).not.toContain(" ");
          expect(visibleDisplayText(`a${filler}${jamo}b`), `${JSON.stringify(filler)} then ${JSON.stringify(jamo)}`).not.toContain(" ");
        }
      }
    });

    it("turns a filler beside the code point just outside any jamo range into a space, on either side", () => {
      for (const other of OUTSIDE) {
        for (const filler of FILLERS) {
          expect(visibleDisplayText(`a${other}${filler}b`), `${JSON.stringify(other)} then ${JSON.stringify(filler)}`).toContain(" ");
          expect(visibleDisplayText(`a${filler}${other}b`), `${JSON.stringify(filler)} then ${JSON.stringify(other)}`).toContain(" ");
        }
      }
    });
  });

  it("treats a blank cell inside a name as a space", () => {
    expect(visibleDisplayText("a\u2800b")).toBe("a b");
    for (const filler of ["\u115F", "\u1160", "\u3164", "\uFFA0"]) {
      expect(visibleDisplayText(`a${filler}b`), JSON.stringify(filler)).toBe("a b");
    }
  });
});

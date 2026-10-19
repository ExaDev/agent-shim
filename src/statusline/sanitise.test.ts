import { describe, expect, it } from "vitest";

import { ESCAPE } from "./ansi";
import { MAX_DISPLAY_TEXT_CHARS } from "../config/statusline";
import { graphemesOf } from "./graphemes";
import { boundedDisplayText, sanitiseDisplayText } from "./sanitise";

const EXCESS_EMOJI = 5;

describe("sanitiseDisplayText", () => {
  it("leaves ordinary text, including non-ASCII letters and spaces, alone", () => {
    expect(sanitiseDisplayText("feat/naïve branch")).toBe("feat/naïve branch");
  });

  it("removes colour, cursor and hyperlink sequences with the text they would have carried", () => {
    expect(sanitiseDisplayText(`a${ESCAPE}[31mb${ESCAPE}[0mc`)).toBe("abc");
    expect(sanitiseDisplayText(`a${ESCAPE}[2Jb`)).toBe("ab");
    expect(sanitiseDisplayText(`${ESCAPE}]8;;https://example.com${ESCAPE}\\link${ESCAPE}]8;;${ESCAPE}\\`)).toBe("link");
    expect(sanitiseDisplayText(`${ESCAPE}]0;title\u0007x`)).toBe("x");
  });

  it("removes control characters and bidirectional overrides", () => {
    expect(sanitiseDisplayText("a\nb\tc\u0000d\u007fe")).toBe("abcde");
    expect(sanitiseDisplayText("gpj‮txt.exe")).toBe("gpjtxt.exe");
    expect(sanitiseDisplayText("a⁦b‎c")).toBe("abc");
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

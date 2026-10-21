import { describe, expect, it, vi } from "vitest";

import { ESCAPE, ESCAPE_SEQUENCE_PATTERN } from "./ansi";
import { MAX_DISPLAY_TEXT_CHARS } from "../config/statusline";
import { graphemesOf } from "./graphemes";
import { boundedDisplayText, boundedVisibleWords, couldShowSomething, sanitiseDisplayText, visibleDisplayText, visibleWords } from "./sanitise";

const EXCESS_EMOJI = 5;

describe("visibleWords", () => {
  it("joins the words a white space control or a line or paragraph separator separates with one plain space", () => {
    expect(visibleWords("a\tb")).toBe("a b");
    expect(visibleWords("a  \t\r\n \u000b\f\u0085  b")).toBe("a b");
    expect(visibleWords("a\u2028b\u2029c")).toBe("a b c");
  });

  it("keeps the words apart however much that draws nothing sits between them", () => {
    expect(visibleWords("a\t\u200b\tb")).toBe("a b");
    expect(visibleWords(`a\t${ESCAPE}[31m\tb`)).toBe("a b");
    expect(visibleWords("a \tb")).toBe("a b");
    expect(visibleWords("a\t\u2800\u3164\tb")).toBe("a b");
  });

  it("removes an escape sequence whole even when a separator stands inside it, leaving the spaces around it as they were", () => {
    expect(visibleWords(`a ${ESCAPE}]0;ti\ttle\u0007 b`)).toBe("a  b");
    expect(visibleWords(`a ${ESCAPE}]0;ti\ntle\u0007 b`)).toBe("a  b");
    expect(visibleWords(`a ${ESCAPE}]0;ti\u2028tle${ESCAPE}\\ b`)).toBe("a  b");
    expect(visibleWords(`a\t${ESCAPE}]0;ti\ttle\u0007\tb`)).toBe("a b");
  });

  it("drops the other control characters, so their neighbours join, and leaves spaces inside a word group alone", () => {
    expect(visibleWords("a\u0000b\u0007c")).toBe("abc");
    expect(visibleWords("a  b\tc")).toBe("a  b c");
  });

  it("draws nothing for text of separators and invisible characters alone", () => {
    expect(visibleWords("\t\u2028 \u200b\n")).toBe("");
    expect(visibleWords("")).toBe("");
  });
});

/** The pieces the texts of the exhaustive tests are made of, with the most of them in a row in one text: words, separators, spaces, things that draw nothing, an escape sequence with a separator inside it, and combining characters; then regional indicators round a lone surrogate, and Hangul jamo round a character that draws nothing, which join once what lay between them is dropped. */
const TEXT_SETS: readonly { readonly pieces: readonly string[]; readonly length: number }[] = [
  { pieces: ["a", "bc", "\t", " ", "\u200b", "\u0301", `${ESCAPE}[31m`, `${ESCAPE}]0;t\tt\u0007`, "\u2028", "\u0000", "\u2800", "\u{1F44D}\u{1F3FD}"], length: 3 },
  { pieces: ["a", "\t", " ", "\u200b", `${ESCAPE}]0;t\tt\u0007`, "\u0301"], length: 5 },
  { pieces: ["\u{1F1E7}", "\u{1F1EC}", "\ud800"], length: 7 },
  { pieces: ["\u1161", "\u115f", "\u200c"], length: 5 },
  { pieces: ["a", " ", "\u00a0", "\u0301", "\u200d", "\u200c", "\ufe0f", "\t"], length: 4 },
  { pieces: ["a", " ", "\ud800", "\udc00"], length: 5 },
  { pieces: ["a", " ", "\t"], length: 7 },
  { pieces: ["a", "\t", "\u093e", "\u0e33", "\u0eb3", "\ufe0f"], length: 5 },
  { pieces: ["a", " ", "\u0301", "\u200d", "\u200c", "\u20dd", "\u{1f3fb}", "\uff9e", "\uff9f"], length: 3 },
  { pieces: ["a", "\t", "\u0d4e", "\u093e"], length: 6 },
  { pieces: ["a", " ", "\u0d4e", "\u0301", "\u200d"], length: 4 },
];
const ESCAPE_SEQUENCES = new RegExp(ESCAPE_SEQUENCE_PATTERN, "g");

/** Each text made of up to `length` of `pieces` in a row, the empty one included, once each. */
function allTexts(pieces: readonly string[], length: number): string[] {
  const levels: string[][] = [[""]];
  for (let size = 1; size <= length; size += 1) {
    levels.push((levels[size - 1] ?? []).flatMap((text) => pieces.map((piece) => text + piece)));
  }
  return levels.flat();
}

/** The limits tried, from none up: enough that a limit falls short of, meets and passes what the short texts show, and falls inside the characters that join once something between them is dropped. */
const LIMITS = Array.from({ length: 5 }, (_, index) => index);

/** The first `count` characters of `text`, trimmed, as a caller that cuts to a limit sees them. */
function cut(text: string, count: number): string {
  return graphemesOf(text).slice(0, count).join("").trim();
}

/** What `visibleWords` is to give without a limit, written the plain way: all pieces cleaned, then joined. */
function everyPieceCleaned(text: string): string {
  return text
    .replaceAll(ESCAPE_SEQUENCES, "")
    .split(/[\t-\r\u0085\u2028\u2029]+/u)
    .map((piece) => visibleDisplayText(piece))
    .filter((piece) => piece !== "")
    .join(" ");
}

/** `run`'s result, how many graphemes it pulled from the segmenter and how many characters of text it handed the segmenter, counted there: a function that reads a text whole shows as the text's length, and one that stops early as what it read. */
function readingGraphemes<Result>(run: () => Result): { readonly result: Result; readonly read: number; readonly segmented: number } {
  const probe = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const original = probe.segment.bind(probe);
  let read = 0;
  let segmented = 0;
  const spy = vi.spyOn(Intl.Segmenter.prototype, "segment").mockImplementation((input) => {
    const segments = original(input);
    segmented += input.length;
    return {
      containing: (index) => segments.containing(index),
      *[Symbol.iterator](): Generator<Intl.SegmentData, undefined, undefined> {
        for (const part of segments) {
          read += 1;
          yield part;
        }
        return undefined;
      },
    };
  });
  try {
    return { result: run(), read, segmented };
  } finally {
    spy.mockRestore();
  }
}

/** A cleaner that records the pieces and the limits it is given, and cleans as `visibleDisplayText` does. */
function counting(): { readonly pieces: string[]; readonly limits: number[]; readonly clean: (piece: string, limit: number) => string } {
  const pieces: string[] = [];
  const limits: number[] = [];
  return {
    pieces,
    limits,
    clean: (piece, limit) => {
      pieces.push(piece);
      limits.push(limit);
      return visibleDisplayText(piece, limit);
    },
  };
}

/** The characters whose every run cleans to nothing, written out again here rather than read from the code, and the same as a text of them alone. */
const SKIPPED_CHARACTER = /^[\p{Cf}\p{Cc}\p{Cs}\p{Zs}\p{Zl}\p{Zp}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}\u2800]$/u;
const NOTHING_TO_SHOW = new RegExp(`^${SKIPPED_CHARACTER.source.slice(1, -1)}*$`, "u");
const HEX = 16;
const LAST_CODE_POINT = 0x10ffff;

/** Every character, each lone surrogate included, as a string. */
function everyCharacter(): string[] {
  return Array.from({ length: LAST_CODE_POINT + 1 }, (_, codePoint) => String.fromCodePoint(codePoint));
}

describe("what lets a text be skipped or shortened", () => {
  const characters = everyCharacter();
  const hex = (character: string): string => (character.codePointAt(0) ?? 0).toString(HEX);

  it("is, for the characters that cannot show anything, true of each of them alone: they clean to nothing", () => {
    expect(characters.filter((character) => SKIPPED_CHARACTER.test(character) && visibleDisplayText(character) !== "").map(hex)).toEqual([]);
  });

  it("is named by couldShowSomething for every character, and by nothing else", () => {
    expect(characters.filter((character) => couldShowSomething(character) === SKIPPED_CHARACTER.test(character)).map(hex)).toEqual([]);
  });

  // Cleaning every character is the costly part, so the planes where characters are assigned or default-ignorable are cleaned whole, and every other plane by a sample of its characters.
  const BASIC_PLANE = 0;
  const MULTILINGUAL_PLANE = 1;
  const TAGS_PLANE = 14;
  const WHOLE_PLANES = [BASIC_PLANE, MULTILINGUAL_PLANE, TAGS_PLANE];
  const PLANE = 0x10000;
  const SAMPLE_STEP = 0x100;
  const inspected = characters.filter((_character, index) => WHOLE_PLANES.includes(Math.floor(index / PLANE)) || index % SAMPLE_STEP === 0);

  it("leaves out no character that cleans to nothing alone: each is one that cannot show anything", () => {
    expect(inspected.filter((character) => !SKIPPED_CHARACTER.test(character) && visibleDisplayText(character) === "").map(hex)).toEqual([]);
  });

  it("counts a lone surrogate as able to show something only when only what cleaning removes lies between a high one and a low one after it", () => {
    const cannot = ["\ud800", "\udc00", "\udc00\ud800", "\ud800\ud800", "\udc00\udc00\ud800", "\ud800\t\u200b", "\ud800 \udc00", "\ud800\u0301\udc00", "\ud800\u200d\udc00", "\ud800\u3164\udc00"];
    const can = ["\ud800\u200b\udc00", "\ud800\ud800\udc00", "\ud800\u200b\udc00\ud800", "\ud800\u0000\u2060\udc00", "\udbff\u200b\udfff", "\ud800 \ud800\u200b\udc00"];
    expect(cannot.filter((text) => couldShowSomething(text))).toEqual([]);
    expect(can.filter((text) => !couldShowSomething(text))).toEqual([]);
    // A tag character is a surrogate pair: one character, which cannot show, and not two lone surrogates, alone or beside one.
    expect(couldShowSomething("\u{e0020}")).toBe(false);
    expect(couldShowSomething("\u{e0020}\ud800")).toBe(false);
    expect(couldShowSomething("\u{e0020}\udc00")).toBe(false);
    expect(couldShowSomething("\ud800\u{e0020}")).toBe(false);
  });

  it("holds of every pair and triple of characters that cannot show anything: the text cleans to nothing, whichever way it is cleaned", () => {
    const sample = ["\u0000", "\u0007", " ", "\u00a0", "\u00ad", "\u0301", "\u20dd", "\u200b", "\u200c", "\u200d", "\u2028", "\u2029", "\u2060", "\u2065", "\u2800", "\u3000", "\u3164", "\uffa0", "\u115f", "\u1160", "\ufe0f", "\ufeff", "\u061c", "\u202e", "\u{e0001}", "\u{e0020}", "\u{e0080}", "\u{e01f0}", "\u{fff0}"];
    const SAMPLE_FOR_TRIPLES = 12;
    expect(sample.filter((character) => couldShowSomething(character))).toEqual([]);
    const pairs = sample.flatMap((first) => sample.map((second) => first + second));
    const triples = sample.slice(0, SAMPLE_FOR_TRIPLES).flatMap((first) => sample.slice(0, SAMPLE_FOR_TRIPLES).flatMap((second) => sample.map((third) => first + second + third)));
    expect([...pairs, ...triples].filter((text) => visibleDisplayText(text) !== "" || boundedVisibleWords(text) !== "")).toEqual([]);
  });

  it("agrees on a surrogate pair that something removable splits: the removal joins them into the character they spell, and it is drawn", () => {
    for (const between of ["\u200b", "\u0000", "\u2060"]) {
      const text = `\ud83d${between}\ude00`;
      expect(visibleDisplayText(text), JSON.stringify(text)).toBe("\u{1F600}");
      expect(boundedVisibleWords(text), JSON.stringify(text)).toBe("\u{1F600}");
    }
  });

  it("differs, for a surrogate pair that a separator splits, only as the separator makes two words of the halves, which are lone and draw nothing", () => {
    expect(visibleDisplayText("\ud83d\u2028\ude00")).toBe("\u{1F600}");
    expect(boundedVisibleWords("\ud83d\u2028\ude00")).toBe("");
  });

  /** A limit well past the length of the short texts below, so that reading to it takes the characters the text rewrites. */
  const LIMIT_PAST_THE_TEXT = 10;

  it("keeps, when a spacing mark follows them, the zero-width characters attached to a space, since the mark makes the whole draw", () => {
    for (const text of ["a \u093e", "a \ufe0f\u093e", "a \u200d\u093e", "a \u200c\u093e", "a \u0301\u093e", "a \u20dd\u093e", "a \u1b44\u093e", "a \u0301\u0301\u093e", "a \u0301\u0e33"]) {
      expect(visibleDisplayText(text, LIMIT_PAST_THE_TEXT), JSON.stringify(text)).toBe(visibleDisplayText(text));
    }
    expect(visibleDisplayText("a \u093e", LIMIT_PAST_THE_TEXT)).toBe("a \u093e");
  });

  it("keeps every character when any character that extends the grapheme follows a space and what is attached to it, because it makes the whole draw", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const extenders = inspected.filter((character) => Array.from(segmenter.segment(` \u0301${character}`)).length === 1);
    // Single attachments, and runs of them that end in a joiner, which is the one attachment that no following character class covers.
    const attachments = ["\u0301", "\u200d", "\u200c", "\u20dd", "\ufe0f", "\u0301\u200d", "\u200d\u0301"];
    expect(extenders.length).toBeGreaterThan(attachments.length);
    const differing = attachments.flatMap((attachment) => extenders.filter((extender) => visibleDisplayText(`x ${attachment}${extender}y`, LIMIT_PAST_THE_TEXT) !== visibleDisplayText(`x ${attachment}${extender}y`)).map((extender) => `${Array.from(attachment, hex).join(" ")} then ${hex(extender)}`));
    expect(differing).toEqual([]);
  });

  it("keeps the attachments of a space that a Prepend letter begins a grapheme with, for every letter the segmenter joins to the space after it", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    // The format characters among them are removed before the rewrite, so only the others are the letters the rewrite must leave alone.
    const prepending = inspected.filter((character) => !/^\p{Cf}$/u.test(character) && Array.from(segmenter.segment(`${character} `)).length === 1);
    expect(prepending.length).toBeGreaterThan(0);
    const attachments = ["\u0301", "\u200d", "\u200c", "\u20dd", "\ufe0f"];
    const differing = attachments.flatMap((attachment) => prepending.filter((letter) => visibleDisplayText(`${letter} ${attachment}y`, LIMIT_PAST_THE_TEXT) !== visibleDisplayText(`${letter} ${attachment}y`)).map((letter) => `${hex(letter)} then ${hex(attachment)}`));
    expect(differing).toEqual([]);
  });

  it("counts the joined words from the character the last of them ends in, a space that a Prepend letter joins included", () => {
    const text = "x\t\u0d4e\t\u093e\tyz";
    // A limit that falls inside the words: the letter, its space and the mark that the next word begins with join into two characters, not three.
    const LIMIT_INSIDE_THE_WORDS = 4;
    expect(visibleWords(text)).toBe("x \u0d4e \u093e yz");
    expect(cut(visibleWords(text, LIMIT_INSIDE_THE_WORDS), LIMIT_INSIDE_THE_WORDS)).toBe(cut(visibleWords(text), LIMIT_INSIDE_THE_WORDS));
  });

  it("is, for the zero-width characters that attach to a space, true of each of them: the space with it draws as the space alone", () => {
    const attaching = characters.filter((character) => /^[\p{Mn}\p{Me}\u200c\u200d]$/u.test(character));
    expect(attaching.filter((character) => visibleDisplayText(`x ${character}y`) !== "x y").map(hex)).toEqual([]);
  });
});

describe("what a limit lets it leave unread", () => {
  const REPEATS = 1000;
  /** Texts several limits long, and texts that many times longer again, are read to the same extent when the limit is what bounds the reading. */
  const SEVERAL = 5;
  const MANY_TIMES_THAT = 100;
  const SEPARATOR_RUN = /[\t-\r\u0085\u2028\u2029]+/u;
  const SHAPES: Readonly<Record<string, (repeats: number) => string>> = {
    "words separated by tabs": (repeats) => "a\t".repeat(repeats),
    "words on lines": (repeats) => "word\n".repeat(repeats),
    "one long run of spaces": (repeats) => `a${" ".repeat(repeats)}b`,
    "one long run of tabs": (repeats) => `a${"\t".repeat(repeats)}b`,
    "spaces and tabs in turn": (repeats) => `a${" \t".repeat(repeats)}b`,
    "invisible characters between separators": (repeats) => `${"\t\u200b".repeat(repeats)}\tb`,
    "escape sequences between separators": (repeats) => `a${`\t${ESCAPE}[31m`.repeat(repeats)}\tb`,
    "spaces with zero-width joiners": (repeats) => `a${" \u200d".repeat(repeats)}b`,
    "spaces with marks": (repeats) => `a${" \u0301".repeat(repeats)}b`,
    "spaces with variation selectors": (repeats) => `a${" \ufe0f".repeat(repeats)}b`,
    "marks on lines": (repeats) => `${"\u0301\n".repeat(repeats)}word`,
    "marks between tabs": (repeats) => `${"\u0301\t".repeat(repeats)}word`,
    "variation selectors on lines": (repeats) => `${"\ufe0f\n".repeat(repeats)}word`,
    "spaces on lines": (repeats) => `${" \n".repeat(repeats)}word`,
    "line separators on lines": (repeats) => `${"\u2028\n".repeat(repeats)}word`,
    "spaces with zero-width non-joiners": (repeats) => `a${" \u200c".repeat(repeats)}b`,
    "spaces with enclosing marks": (repeats) => `a${" \u20dd".repeat(repeats)}b`,
    "words that begin with a spacing mark": (repeats) => "\u093e\t".repeat(repeats),
    "one long word": (repeats) => "x".repeat(repeats),
    "invisible characters before a long word": (repeats) => `${"\u200b".repeat(repeats)}${"x".repeat(repeats)}`,
  };
  /**
   * Shapes made of pieces that draw nothing and are each a grapheme of their own, which `visibleWords` skips without reading, but which a single word of them would be read one by one. They are tried on the functions that split into words only.
   */
  const WORD_SHAPES: Readonly<Record<string, (repeats: number) => string>> = {
    "unassigned default-ignorable characters between tabs": (repeats) => `${"\u2065\t".repeat(repeats)}word`,
    "unassigned default-ignorable characters on lines": (repeats) => `${"\u{e0000}\n".repeat(repeats)}word`,
    "lone surrogates a space keeps apart": (repeats) => "\ud800 \udc00".repeat(repeats),
    "lone surrogates between tabs": (repeats) => `${"\ud800\t".repeat(repeats)}word`,
    "tag characters between tabs": (repeats) => `${"\u{e0020}\t".repeat(repeats)}word`,
  };

  describe.each(TEXT_SETS)("for every text of up to $length of these $pieces.length pieces", ({ pieces, length }) => {
    const texts = allTexts(pieces, length);

    it("gives, without a limit, the pieces cleaned one by one and joined", () => {
      expect(texts.filter((text) => visibleWords(text) !== everyPieceCleaned(text))).toEqual([]);
    });

    it("gives from visibleWords, with a limit, the first characters of what it gives without one", () => {
      const differing = texts.flatMap((text) => LIMITS.filter((limit) => cut(visibleWords(text, limit), limit) !== cut(visibleWords(text), limit)).map((limit) => `${JSON.stringify(text)} at ${String(limit)}`));
      expect(differing).toEqual([]);
    });

    it("gives from visibleDisplayText, with a limit, the first characters of what it gives without one", () => {
      const differing = texts.flatMap((text) => LIMITS.filter((limit) => cut(visibleDisplayText(text, limit), limit) !== cut(visibleDisplayText(text), limit)).map((limit) => `${JSON.stringify(text)} at ${String(limit)}`));
      expect(differing).toEqual([]);
    });
  });

  it("keeps a character that joins the one before it once something between them is dropped, however far the limit falls", () => {
    expect(cut(visibleDisplayText("\u{1F1E7}\ud800\u{1F1EC}", 1), 1)).toBe("\u{1F1E7}\u{1F1EC}");
    expect(cut(visibleDisplayText("\u1161\u115f\u200c\u1161", 1), 1)).toBe("\u1161\u1161");
  });

  it("keeps, at a limit the words so far land on, the characters of the next word that merge into one grapheme of the joined text", () => {
    // Two regional indicators pair once the lone surrogate between them is dropped, so the second character of the unbounded result holds the pair whole; a word asked for only the one character that is left of the limit stops one short of the pair.
    const torn = "\u{11A84}\t\u093e\u{1F1EC}\ud800\u{1F1E7}";
    expect(cut(visibleWords(torn, 2), 2)).toBe(cut(visibleWords(torn), 2));
    // The same shape at the production limit: the letters take the limit less the space and the letter of the second word (two) less one, so the word of the mark and the indicators would be asked for the one that is left, and stop inside the pair.
    const AT_THE_LIMIT = MAX_DISPLAY_TEXT_CHARS - 2 - 1;
    const atTheLimit = "x".repeat(AT_THE_LIMIT) + "\t\u0d4e\t\u093e\u{1F1EC}\ud800\u{1F1E7}";
    expect(boundedVisibleWords(atTheLimit)).toBe(boundedDisplayText(visibleWords(atTheLimit)));
  });

  it("keeps the whole of a run of marks that merge into the grapheme before them, at a limit of one", () => {
    /** How many pairs of a mark and a default-ignorable precede the last mark of the run: a run of some length, so that a stop at its first mark falls short of the unbounded result by more than the mark alone. */
    const MARK_PAIRS = 19;
    // The Prepend letter takes the space and every mark of the word after it into one character of the unbounded result; a word asked for nothing hands back the first mark alone.
    const chain = "\u0d4e\t" + "\u093e\u2065".repeat(MARK_PAIRS) + "\u093e";
    expect(cut(visibleWords(chain, 1), 1)).toBe(cut(visibleWords(chain), 1));
  });

  it.each(Object.entries({ ...SHAPES, ...WORD_SHAPES }))("cleans, without a limit, each piece between the separators that could show something, once and as it stands (%s)", (_shape, make) => {
    const { pieces, clean } = counting();
    const text = make(REPEATS);
    visibleWords(text, Number.POSITIVE_INFINITY, clean);
    // Nothing is rewritten before the split, so a pass that retried from every space would show as a piece that is not in the text, and a piece cleaned twice or not at all as a different list.
    expect(pieces).toEqual(text.replaceAll(ESCAPE_SEQUENCES, "").split(SEPARATOR_RUN).filter((piece) => !NOTHING_TO_SHOW.test(piece)));
  });

  it("hands the cleaner exactly the pieces that bring the result to the limit, each with what is left of it", () => {
    const { pieces, limits, clean } = counting();
    boundedVisibleWords("a\t".repeat(MAX_DISPLAY_TEXT_CHARS * SEVERAL), clean);
    // Each word of one character, and the space before every word but the first, takes two; the limit is reached on the word that brings the total to it or past it. Each word is asked for one more than what is still wanted of the joined text, which is the limit plus one less what the words so far, with their spaces, come to: twice their number less one, and nothing before the first.
    const needed = Math.ceil((MAX_DISPLAY_TEXT_CHARS + 1) / 2);
    expect(pieces).toHaveLength(needed);
    expect(limits).toEqual(Array.from({ length: needed }, (_, index) => (index === 0 ? MAX_DISPLAY_TEXT_CHARS + 1 : MAX_DISPLAY_TEXT_CHARS + 2 - 2 * index)));
  });

  it("draws as many characters as the limit asks for from words that each begin with a spacing mark, which join the space before them", () => {
    const text = "\u093e\t".repeat(MAX_DISPLAY_TEXT_CHARS + SEVERAL);
    expect(graphemesOf(boundedVisibleWords(text))).toHaveLength(MAX_DISPLAY_TEXT_CHARS);
    expect(boundedVisibleWords(text)).toBe(cut(everyPieceCleaned(text), MAX_DISPLAY_TEXT_CHARS));
  });

  it("hands the cleaner one more piece when the limit is met exactly, because the space and the next word can join the last character", () => {
    // Each word of two characters takes two, and the space before every word but the first takes one more, so the words bring the total to 3k - 1 and the limit is met exactly on word k when it is one less than a multiple of three; the next word is then wanted too.
    const WORD_AND_SPACE = 3;
    expect((MAX_DISPLAY_TEXT_CHARS + 1) % WORD_AND_SPACE).toBe(0);
    const { pieces, clean } = counting();
    visibleWords("ab\t".repeat(MAX_DISPLAY_TEXT_CHARS), MAX_DISPLAY_TEXT_CHARS, clean);
    expect(pieces).toHaveLength((MAX_DISPLAY_TEXT_CHARS + 1) / WORD_AND_SPACE + 1);
  });

  it("keeps a space that lies between two lone surrogates when nothing more is asked for, because without it they would join", () => {
    expect(visibleDisplayText("\ud800 \udc00", 0)).toBe("");
    expect(visibleDisplayText("\ud800 \udc00")).toBe("");
  });

  it("does not hand the cleaner the invisible pieces that come after the limit is reached", () => {
    const { pieces, clean } = counting();
    visibleWords(`${"word\t".repeat(MAX_DISPLAY_TEXT_CHARS)}${"\u200b\t".repeat(REPEATS)}`, MAX_DISPLAY_TEXT_CHARS, clean);
    expect(pieces.every((piece) => piece === "word")).toBe(true);
  });

  it("reads as many graphemes from a text as the limit needs, and no more however much follows", () => {
    // A word of more than the limit, read by `visibleDisplayText` itself, is read up to one past the limit and again to count them. Through `visibleWords` it is asked for one more than the limit (never nothing, so that it reads past a run that merges into one grapheme), read up to one past the ask and again to count them, then counted once more as the words joined so far, and the cut reads the limit's worth again; the pieces are exact numbers, so that reading more than needed shows.
    const PAST_THE_ASK = MAX_DISPLAY_TEXT_CHARS + 2;
    const READS_OF_A_WORD_WITH_ITS_COUNT = 3;
    const reading: readonly (readonly [string, (text: string) => unknown, number, boolean])[] = [
      ["boundedDisplayText", boundedDisplayText, MAX_DISPLAY_TEXT_CHARS, false],
      ["visibleDisplayText", (text) => visibleDisplayText(text, MAX_DISPLAY_TEXT_CHARS), 2 * (MAX_DISPLAY_TEXT_CHARS + 1), false],
      ["visibleWords", (text) => visibleWords(text, MAX_DISPLAY_TEXT_CHARS), READS_OF_A_WORD_WITH_ITS_COUNT * PAST_THE_ASK, true],
      ["boundedVisibleWords", (text) => boundedVisibleWords(text), READS_OF_A_WORD_WITH_ITS_COUNT * PAST_THE_ASK + MAX_DISPLAY_TEXT_CHARS, true],
    ];
    const few = MAX_DISPLAY_TEXT_CHARS * SEVERAL;
    const many = few * MANY_TIMES_THAT;
    const failures = reading.flatMap(([name, run, exactly, splitsIntoWords]) =>
      Object.entries(splitsIntoWords ? { ...SHAPES, ...WORD_SHAPES } : SHAPES).flatMap(([shape, make]) => {
        const small = readingGraphemes(() => run(make(few))).read;
        const large = readingGraphemes(() => run(make(many))).read;
        const expected = shape === "one long word" ? exactly : small;
        return large === small && small === expected ? [] : [`${name} on ${shape}: ${String(small)} then ${String(large)}`];
      }),
    );
    expect(failures).toEqual([]);
  });

  it("segments, to count the words joined so far, only each new word and the character before it, so that the work follows the words taken", () => {
    // Each word is a letter and a great many marks, which together are one character of a great many code units, so that segmenting the joined text again for each word would show in the characters handed to the segmenter.
    const MARKS = 400;
    const WORDS = 200;
    const text = `a${"\u0301".repeat(MARKS)}\t`.repeat(WORDS);
    const { pieces, clean } = counting();
    const { segmented } = readingGraphemes(() => boundedVisibleWords(text, clean));
    const consumed = pieces.reduce((total, piece) => total + piece.length, 0);
    // The cleaner reads each word, the count reads it again beside the character before it, and the cut reads what is kept: a few times what was taken, where a count of the whole joined text each time is a multiple of the words taken as well.
    const TIMES_CONSUMED = 6;
    expect(pieces.length).toBeLessThan(WORDS);
    expect(segmented).toBeLessThanOrEqual(TIMES_CONSUMED * consumed);
  });

  it("does not segment the words of a text without a limit for a count", () => {
    const WORDS = MAX_DISPLAY_TEXT_CHARS * SEVERAL;
    expect(readingGraphemes(() => visibleWords("a\t".repeat(WORDS))).read).toBe(WORDS);
  });
});

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

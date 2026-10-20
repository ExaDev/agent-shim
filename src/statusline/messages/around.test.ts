import { describe, expect, it } from "vitest";

import { AROUND_VALUE_IDS, aroundValue, namesCount, paintCore, VALUE_MARK, writeAround } from "./around";
import { CATALOGUES, translatorFor } from "./catalogues";
import { STATUSLINE_LANGUAGES } from "./languages";

const COUNT = 7;
const bracket = (text: string): string => `[${text}]`;

describe("paintCore", () => {
  it("paints the text without the spaces at either end", () => {
    expect(paintCore("Started: ", bracket)).toBe("[Started:] ");
    expect(paintCore(" ago", bracket)).toBe(" [ago]");
    expect(paintCore("  a b  ", bracket)).toBe("  [a b]  ");
  });

  it("paints nothing when only spaces, or nothing, are left", () => {
    expect(paintCore("", bracket)).toBe("");
    expect(paintCore("   ", bracket)).toBe("   ");
  });
});

describe("aroundValue", () => {
  it("paints the words after a value at the start, and leaves the value as it is", () => {
    expect(aroundValue(`${VALUE_MARK} ago`, "3m", bracket)).toBe("3m [ago]");
  });

  it("paints the words before a value at the end", () => {
    expect(aroundValue(`Started: ${VALUE_MARK}`, "10:00", bracket)).toBe("[Started:] 10:00");
  });

  it("paints the words either side of a value in the middle", () => {
    expect(aroundValue(`in ${VALUE_MARK} ago`, "3m", bracket)).toBe("[in] 3m [ago]");
  });

  it("paints no side that is empty or only spaces, so no colour is left with nothing to colour", () => {
    expect(aroundValue(VALUE_MARK, "3m", bracket)).toBe("3m");
    expect(aroundValue(` ${VALUE_MARK} `, "3m", bracket)).toBe(" 3m ");
  });

  it("fails loudly when the value mark is absent, instead of drawing no value", () => {
    expect(() => aroundValue("Started:", "10:00", bracket)).toThrow(/exactly once, and holds it 0 times/);
    expect(() => aroundValue("", "10:00", bracket)).toThrow(/holds it 0 times/);
  });

  it("fails loudly when the value mark is repeated, instead of leaking it or drawing the value once", () => {
    expect(() => aroundValue(`${VALUE_MARK} and ${VALUE_MARK}`, "3m", bracket)).toThrow(/holds it 2 times/);
  });
});

describe("the messages written around a value", () => {
  for (const language of STATUSLINE_LANGUAGES) {
    describe(language, () => {
      for (const id of AROUND_VALUE_IDS) {
        const counted = namesCount(id);

        it(`${id} holds a placeholder for the value, and one for the count when it names one, and no other`, () => {
          expect(CATALOGUES[language][id].match(/\{\w+\}/g)).toHaveLength(counted ? 2 : 1);
        });

        it(`${id} draws its value once, with its words painted and the mark gone`, () => {
          const written = writeAround(translatorFor(language), id, "VALUE", bracket, counted ? COUNT : undefined);
          expect(written.split("VALUE")).toHaveLength(2);
          expect(written).not.toContain(VALUE_MARK);
          expect(written).toContain("[");
          expect(written.includes(String(COUNT))).toBe(counted);
        });
      }
    });
  }

  it("are all that the statusline paints around a value: the registry names every message that is", () => {
    expect([...AROUND_VALUE_IDS].sort()).toEqual(["addedDirs.label", "mcp.label", "sessionTime.lastReply", "sessionTime.started", "skills.label"]);
  });

  it("fails loudly when a message that names a count is written without one", () => {
    expect(() => writeAround(translatorFor("en"), "skills.label", "VALUE", bracket)).toThrow(/names a count, and none was given/);
  });
});

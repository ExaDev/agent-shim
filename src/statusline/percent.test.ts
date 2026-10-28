import { describe, expect, it } from "vitest";

import { writtenPercent } from "./percent";

/** Figures whole already. */
const NONE_USED = 0;
const A_FEW = 4;
const MOST = 37;
const ALL = 100;
/** Figures with a decimal that stay. */
const A_TENTH = 0.1;
const MOST_AND_FOUR_TENTHS = 37.4;
const ALL_BUT_A_TENTH = 99.9;
/** Figures that round to a whole number at one decimal, and ones that round up a tenth. */
const MOST_AND_BELOW_HALF_A_TENTH = 37.04;
const BELOW_HALF_A_TENTH = 0.04;
const ALL_BUT_BELOW_HALF_A_TENTH = 99.96;
const MOST_BUT_BELOW_HALF_A_TENTH = 36.96;
const MOST_AND_OVER_HALF_A_TENTH = 37.06;
const NEGATIVE_BELOW_HALF_A_TENTH = -0.04;
const SIXTY_BUT_A_TENTH_AND_A_HALF = 59.7;
/** The figure written for a fraction, whole or to one decimal. */
const MOST_AND_A_TENTH = "37.1";

describe("writtenPercent", () => {
  it("writes a whole number without a decimal", () => {
    expect(writtenPercent(NONE_USED)).toBe("0");
    expect(writtenPercent(A_FEW)).toBe("4");
    expect(writtenPercent(MOST)).toBe("37");
    expect(writtenPercent(ALL)).toBe("100");
  });

  it("writes any other figure to one decimal", () => {
    expect(writtenPercent(MOST_AND_FOUR_TENTHS)).toBe("37.4");
    expect(writtenPercent(A_TENTH)).toBe("0.1");
    expect(writtenPercent(ALL_BUT_A_TENTH)).toBe("99.9");
  });

  it("rounds to one decimal first, so a figure that rounds to a whole number is written as one", () => {
    expect(writtenPercent(MOST_AND_BELOW_HALF_A_TENTH)).toBe("37");
    expect(writtenPercent(BELOW_HALF_A_TENTH)).toBe("0");
    expect(writtenPercent(ALL_BUT_BELOW_HALF_A_TENTH)).toBe("100");
    expect(writtenPercent(MOST_BUT_BELOW_HALF_A_TENTH)).toBe("37");
    expect(writtenPercent(MOST_AND_OVER_HALF_A_TENTH)).toBe(MOST_AND_A_TENTH);
  });

  it("writes a negative figure that rounds to zero as 0, not -0", () => {
    expect(writtenPercent(NEGATIVE_BELOW_HALF_A_TENTH)).toBe("0");
  });

  it("gives a number whose value is the percentage to one decimal", () => {
    expect(Number(writtenPercent(SIXTY_BUT_A_TENTH_AND_A_HALF))).toBe(SIXTY_BUT_A_TENTH_AND_A_HALF);
    expect(Number(writtenPercent(BELOW_HALF_A_TENTH))).toBe(NONE_USED);
  });
});

import { describe, expect, it } from "vitest";

import { candidateHeading } from "./candidateText";

describe("candidateHeading", () => {
  it("names the class alone for a member with no score", () => {
    expect(candidateHeading({ class: "unknown", feasible: true })).toBe("[unknown]");
  });

  it("adds the score and the reset it divides by", () => {
    expect(candidateHeading({ class: "scored", score: 0.5, scoreWindow: "sevenDay", feasible: true })).toBe("[scored score 0.50 by 7d reset]");
    expect(candidateHeading({ class: "scored", score: 1.234, scoreWindow: "fiveHour", feasible: true })).toBe("[scored score 1.23 by 5h reset]");
  });

  it("notes a five-hour window that would run dry", () => {
    expect(candidateHeading({ class: "scored", score: 0.5, scoreWindow: "sevenDay", feasible: false })).toBe("[scored score 0.50 by 7d reset] (5h would run dry)");
  });
});

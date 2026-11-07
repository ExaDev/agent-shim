import { describe, expect, it } from "vitest";

import { activeGoalOfTranscript } from "./sessionGoal";

/** One transcript row carrying a `goal_status` attachment, in the shape the 2.1.319 CLI writes. */
function status(attachment: Record<string, unknown>): string {
  return JSON.stringify({ type: "attachment", attachment: { type: "goal_status", ...attachment } });
}

describe("the goal a transcript records", () => {
  it("is none when the transcript records no goal change", () => {
    expect(activeGoalOfTranscript([JSON.stringify({ type: "user", message: { content: "goal_status talk" } }), "not json goal_status"].join("\n"))).toBeNull();
  });

  it("follows a set, its evaluations, a clear and a replacement, the last change winning", () => {
    const set = status({ met: false, sentinel: true, condition: "the build is green\nand stays green" });
    const checked = status({ met: false, condition: "the build is green\nand stays green", reason: "one test fails" });
    expect(activeGoalOfTranscript([set].join("\n"))).toEqual({ condition: "the build is green\nand stays green", iterations: 0 });
    expect(activeGoalOfTranscript([set, checked, checked].join("\n"))).toEqual({ condition: "the build is green\nand stays green", iterations: 2, lastCheck: "one test fails" });
    expect(activeGoalOfTranscript([set, checked, status({ met: true, sentinel: true, condition: "the build is green\nand stays green" })].join("\n"))).toBeNull();
    const replaced = status({ met: false, sentinel: true, condition: "docs are updated" });
    expect(activeGoalOfTranscript([set, checked, replaced, checked].join("\n"))).toEqual({ condition: "docs are updated", iterations: 0 });
  });

  it("ends a goal the check found met or failed", () => {
    const set = status({ met: false, sentinel: true, condition: "done" });
    expect(activeGoalOfTranscript([set, status({ met: true, condition: "done", iterations: 3 })].join("\n"))).toBeNull();
    expect(activeGoalOfTranscript([set, status({ met: false, failed: true, condition: "done", reason: "impossible" })].join("\n"))).toBeNull();
  });
});

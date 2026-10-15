import { describe, expect, it } from "vitest";

import { renderStatuslineLine } from "./render";
import type { StatuslineSummary } from "./enrich";

const NOW_MS = Date.parse("2026-10-15T20:15:00.000Z");

const SUMMARY: StatuslineSummary = {
  identity: "antigravity",
  provider: "Antigravity",
  providerAccountEmail: "ada@example.com",
  fiveHourUsed: 9.4,
  fiveHourResetAt: "2026-10-15T20:45:00.000Z",
  sevenDayUsed: 28.2,
  sevenDayResetAt: "2026-10-22T13:52:54.000Z",
};

describe("renderStatuslineLine", () => {
  it("renders model, context, both windows with their resets, and the provider account", () => {
    expect(renderStatuslineLine(SUMMARY, { modelDisplayName: "gemini-3.8-flash", contextUsedPercentage: 63.4 }, NOW_MS)).toBe(
      "gemini-3.8-flash │ ctx 63% │ 5h 9% (30m) │ 7d 28% (6d 17h) │ Antigravity · ada@example.com",
    );
  });

  it("omits what is unknown, down to the bare model", () => {
    expect(
      renderStatuslineLine(
        { identity: undefined, provider: "z.ai", providerAccountEmail: undefined, fiveHourUsed: undefined, fiveHourResetAt: undefined, sevenDayUsed: undefined, sevenDayResetAt: undefined },
        { modelDisplayName: "glm-5.3", contextUsedPercentage: undefined },
        NOW_MS,
      ),
    ).toBe("glm-5.3 │ z.ai");
  });
});

import { describe, expect, it } from "vitest";

import { formatSpan } from "./sessionFormat";

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const HALF_SECOND = 500;
const TWELVE_SECONDS = 12_000;
const FIVE_MINUTES_FIVE_SECONDS = 305_000;
const TWO_HOURS_ELEVEN_MINUTES = 7_919_000;

describe("formatSpan", () => {
  it("writes a span under a second as less than one", () => {
    expect(formatSpan(0)).toBe("<1s");
    expect(formatSpan(HALF_SECOND)).toBe("<1s");
  });

  it("writes seconds under a minute, minutes with their seconds under an hour, and hours with their minutes", () => {
    expect(formatSpan(SECOND)).toBe("1s");
    expect(formatSpan(TWELVE_SECONDS)).toBe("12s");
    expect(formatSpan(MINUTE - 1)).toBe("59s");
    expect(formatSpan(MINUTE)).toBe("1m 0s");
    expect(formatSpan(FIVE_MINUTES_FIVE_SECONDS)).toBe("5m 5s");
    expect(formatSpan(HOUR)).toBe("1h 0m");
    expect(formatSpan(TWO_HOURS_ELEVEN_MINUTES)).toBe("2h 11m");
  });
});

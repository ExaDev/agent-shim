import { describe, expect, it } from "vitest";

import { translatorFor } from "../messages/catalogues";
import { formatAgo, formatElapsed, formatSpan } from "./sessionFormat";

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const HALF_SECOND = 500;
const TWELVE_SECONDS = 12_000;
const FIVE_MINUTES_FIVE_SECONDS = 305_000;
const TWO_HOURS_ELEVEN_MINUTES = 7_919_000;
const DAY = 86_400_000;
const FIVE_MINUTES = 300_000;

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

describe("formatElapsed", () => {
  it("writes less than a minute as less than one, minutes under an hour, and hours with their minutes", () => {
    expect(formatElapsed(0)).toBe("<1m");
    expect(formatElapsed(MINUTE - 1)).toBe("<1m");
    expect(formatElapsed(MINUTE)).toBe("1m");
    expect(formatElapsed(HOUR - 1)).toBe("59m");
    expect(formatElapsed(HOUR)).toBe("1h 0m");
    expect(formatElapsed(HOUR + FIVE_MINUTES)).toBe("1h 5m");
  });
});

describe("formatAgo", () => {
  const ago = (ms: number): string => formatAgo(ms, translatorFor("en"));

  it("says just now for a time that has not come yet, and counts from zero", () => {
    expect(ago(-1)).toBe(translatorFor("en")("time.justNow"));
    expect(ago(0)).toBe("0s ago");
  });

  it("writes seconds under a minute, minutes under an hour, hours with their minutes under a day, and days with their hours", () => {
    expect(ago(MINUTE - 1)).toBe("59s ago");
    expect(ago(MINUTE)).toBe("1m ago");
    expect(ago(HOUR - 1)).toBe("59m ago");
    expect(ago(HOUR)).toBe("1h ago");
    expect(ago(HOUR + FIVE_MINUTES)).toBe("1h 5m ago");
    expect(ago(DAY - 1)).toBe("23h 59m ago");
    expect(ago(DAY)).toBe("1d ago");
    expect(ago(DAY + HOUR)).toBe("1d 1h ago");
  });
});

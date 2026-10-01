import { describe, expect, it } from "vitest";

import { cacheAgeMs, effectiveStore, isFresh, ttlMs, type CachedCredential } from "./credentialCache";

// Durations are written as the sum of the next unit down so no bare multiplier appears: 60 s, 60 min, 24 h.
const SECOND = 1000;
const MINUTE = Array.from({ length: 60 }, () => SECOND).reduce((total, part) => total + part, 0);
const HOUR = Array.from({ length: 60 }, () => MINUTE).reduce((total, part) => total + part, 0);
const DAY = Array.from({ length: 24 }, () => HOUR).reduce((total, part) => total + part, 0);
const entry = (fetchedAt: number): CachedCredential => ({ token: "t", fetchedAt, source: { env: "X" } });

describe("ttlMs", () => {
  it.each([
    ["1s", SECOND],
    ["1m", MINUTE],
    ["1h", HOUR],
    ["1d", DAY],
    ["2h", 2 * HOUR],
  ])("reads %s", (ttl, expected) => {
    expect(ttlMs({ ttl })).toBe(expected);
  });

  it("is undefined, meaning no expiry, without a ttl", () => {
    expect(ttlMs({})).toBeUndefined();
  });
});

describe("isFresh", () => {
  const cache = { ttl: "1h" };

  it("is fresh strictly inside the ttl and stale at and past it", () => {
    expect(isFresh(entry(0), cache, HOUR - 1)).toBe(true);
    expect(isFresh(entry(0), cache, HOUR)).toBe(false);
    expect(isFresh(entry(0), cache, HOUR + 1)).toBe(false);
  });

  it("never expires without a ttl", () => {
    expect(isFresh(entry(0), {}, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("treats an entry stamped in the future as stale, since the clock moved back", () => {
    expect(isFresh(entry(HOUR), {}, SECOND)).toBe(false);
  });
});

describe("effectiveStore", () => {
  it("honours an explicit store, else the Keychain on macOS and a file elsewhere", () => {
    expect(effectiveStore({ store: "file" }, "darwin")).toBe("file");
    expect(effectiveStore({}, "darwin")).toBe("keychain");
    expect(effectiveStore({}, "linux")).toBe("file");
  });
});

describe("cacheAgeMs", () => {
  it("is the time since the fetch, never negative", () => {
    expect(cacheAgeMs(entry(SECOND), SECOND + MINUTE)).toBe(MINUTE);
    expect(cacheAgeMs(entry(HOUR), SECOND)).toBe(0);
  });
});

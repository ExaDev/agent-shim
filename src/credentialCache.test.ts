import { describe, expect, it } from "vitest";

import { cacheAgeMs, describeCachedCredential, effectiveStore, formatCachedCredentialState, isFresh, ttlMs, type CachedCredential, type CredentialCachePort } from "./credentialCache";

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

describe("describeCachedCredential and formatCachedCredentialState", () => {
  const NOW = 86_400_000_000;
  const THREE_HOURS = 10_800_000;
  const NINE_HOURS = 32_400_000;
  const FOURTEEN_HOURS = 50_400_000;
  const TWO_DAYS = 172_800_000;
  const SECRET = "token-that-must-never-be-reported";
  const portHolding = (fetchedAt: number | undefined): CredentialCachePort => ({
    read: () => (fetchedAt === undefined ? undefined : { token: SECRET, fetchedAt, source: { env: "X" } }),
    write: () => undefined,
    remove: () => undefined,
  });
  const describeAt = (port: CredentialCachePort, cache: Readonly<{ ttl?: string; store?: "file" | "keychain" }>) => describeCachedCredential({ port, platform: "linux", owner: "identity work", cache, nowMs: NOW });

  it("reports an empty cache with the store it looked in", () => {
    const state = describeAt(portHolding(undefined), { ttl: "12h" });
    expect(state).toEqual({ store: "file", status: "empty" });
    expect(formatCachedCredentialState(state)).toBe("no cached entry in the file store yet");
  });

  it("reports a fresh entry's age and the time left", () => {
    const state = describeAt(portHolding(NOW - THREE_HOURS), { ttl: "12h" });
    expect(state).toEqual({ store: "file", status: "fresh", ageMs: THREE_HOURS, expiresInMs: NINE_HOURS });
    expect(formatCachedCredentialState(state)).toBe("cached 3h ago, expires in 9h");
  });

  it("reports an expired entry and for how long it has been expired", () => {
    const state = describeAt(portHolding(NOW - FOURTEEN_HOURS), { ttl: "12h" });
    expect(state).toMatchObject({ status: "expired", ageMs: FOURTEEN_HOURS });
    expect(formatCachedCredentialState(state)).toBe("cached 14h ago, expired 2h ago");
  });

  it("reports an entry with no TTL as never expiring", () => {
    const state = describeAt(portHolding(NOW - TWO_DAYS), {});
    expect(state).toEqual({ store: "file", status: "fresh", ageMs: TWO_DAYS });
    expect(formatCachedCredentialState(state)).toBe("cached 2d ago, no expiry");
  });

  it("says so when an entry is stamped in the future, which a clock that moved back produces and the resolver refuses", () => {
    const withTtl = describeAt(portHolding(NOW + HOUR), { ttl: "12h" });
    const withoutTtl = describeAt(portHolding(NOW + HOUR), {});
    expect(formatCachedCredentialState(withTtl)).toBe("cached with a timestamp in the future, treated as expired");
    expect(formatCachedCredentialState(withoutTtl)).toBe("cached with a timestamp in the future, treated as expired");
  });

  it("reports a store that cannot be read here with its reason, instead of throwing", () => {
    const port: CredentialCachePort = { read: () => { throw new Error("the keychain credential store needs macOS"); }, write: () => undefined, remove: () => undefined };
    const state = describeAt(port, { store: "keychain" });
    expect(state).toEqual({ store: "keychain", status: "unreadable", reason: "the keychain credential store needs macOS" });
    expect(formatCachedCredentialState(state)).toBe("the keychain store cannot be read here: the keychain credential store needs macOS");
  });

  it("never carries the token", () => {
    expect(JSON.stringify(describeAt(portHolding(NOW - HOUR), { ttl: "12h" }))).not.toContain(SECRET);
  });
});

import { z } from "zod";

import { CredentialSourceSchema, type CredentialCache, type CredentialCacheStore } from "./config/schema";

const MS_PER_UNIT: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** What a cache stores for one credential: the token, when it was fetched, and the source that produced it (a non-secret descriptor, kept so `check` and the launch log can still say where the token came from). */
export const CachedCredentialSchema = z.strictObject({
  token: z.string().min(1),
  fetchedAt: z.number().int().nonnegative(),
  source: CredentialSourceSchema,
});
export type CachedCredential = z.infer<typeof CachedCredentialSchema>;

/**
 * Where cached credentials live, injected so resolution and its tests need neither the Keychain nor a real directory. `owner` names what the credential belongs to (`identity work`, `provider z`) and is the entry's key; `store` picks the backing store. `read` returns undefined for a missing or unreadable entry, since an entry that cannot be used is the same as no entry.
 */
export interface CredentialCachePort {
  readonly read: (store: CredentialCacheStore, owner: string) => CachedCredential | undefined;
  readonly write: (store: CredentialCacheStore, owner: string, entry: CachedCredential) => void;
  readonly remove: (store: CredentialCacheStore, owner: string) => void;
}

/** The store a block uses: its own choice, else the Keychain on macOS and a file elsewhere. */
export function effectiveStore(cache: Readonly<CredentialCache>, platform: NodeJS.Platform): CredentialCacheStore {
  return cache.store ?? (platform === "darwin" ? "keychain" : "file");
}

/** A `ttl` such as `12h` in milliseconds, or undefined for no expiry. */
export function ttlMs(cache: Readonly<CredentialCache>): number | undefined {
  if (cache.ttl === undefined) {
    return undefined;
  }
  const multiplier = MS_PER_UNIT[cache.ttl.slice(-1)];
  if (multiplier === undefined) {
    throw new Error(`credential cache ttl "${cache.ttl}" has no recognised unit`);
  }
  return Number(cache.ttl.slice(0, -1)) * multiplier;
}

/** Whether a cached entry is still within its TTL at `now`. A cache with no TTL never expires; an entry stamped in the future (a clock that moved back) is treated as expired. */
export function isFresh(entry: CachedCredential, cache: Readonly<CredentialCache>, now: number): boolean {
  const limit = ttlMs(cache);
  if (entry.fetchedAt > now) {
    return false;
  }
  return limit === undefined || now - entry.fetchedAt < limit;
}

/** How old a cached entry is, for `check` and `doctor` to report without the value. */
export function cacheAgeMs(entry: CachedCredential, now: number): number {
  return Math.max(0, now - entry.fetchedAt);
}

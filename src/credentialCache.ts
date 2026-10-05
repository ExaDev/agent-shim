import { z } from "zod";

import { CredentialSourceSchema, type CredentialCache, type CredentialCacheStore } from "./config/schema";
import { formatAge } from "./usage/preflight";

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

/**
 * What the cache holds for one credential, without the token: whether there is an entry, how old it is, and whether it is still within the block's TTL. `expiresInMs` is absent for a block with no expiry.
 */
export type CachedCredentialState =
  | { readonly store: CredentialCacheStore; readonly status: "empty" }
  /** The store cannot be read here (the keychain store configured on a platform without a Keychain): reported with its reason rather than failing the whole report. */
  | { readonly store: CredentialCacheStore; readonly status: "unreadable"; readonly reason: string }
  | { readonly store: CredentialCacheStore; readonly status: "fresh" | "expired"; readonly ageMs: number; readonly expiresInMs?: number };

/** Reads the cache for `owner` (`identity work`, `provider z`) and reports its state at `nowMs`. Never returns the token. */
export function describeCachedCredential(params: Readonly<{ port: CredentialCachePort; platform: NodeJS.Platform; owner: string; cache: CredentialCache; nowMs: number }>): CachedCredentialState {
  const store = effectiveStore(params.cache, params.platform);
  let entry: CachedCredential | undefined;
  try {
    entry = params.port.read(store, params.owner);
  } catch (error) {
    return { store, status: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
  if (entry === undefined) {
    return { store, status: "empty" };
  }
  const limit = ttlMs(params.cache);
  const ageMs = cacheAgeMs(entry, params.nowMs);
  return {
    store,
    status: isFresh(entry, params.cache, params.nowMs) ? "fresh" : "expired",
    ageMs,
    ...(limit === undefined ? {} : { expiresInMs: limit - ageMs }),
  };
}

/** The state on one line for `check` and `doctor`: `cached 3h ago, expires in 9h`, `cached 14h ago, expired 2h ago`, `no cached entry yet`. */
export function formatCachedCredentialState(state: CachedCredentialState): string {
  if (state.status === "empty") {
    return `no cached entry in the ${state.store} store yet`;
  }
  if (state.status === "unreadable") {
    return `the ${state.store} store cannot be read here: ${state.reason}`;
  }
  // An entry only reads as expired with time to spare, or with no TTL at all, when it is stamped in the future: a clock that moved back, which `isFresh` refuses.
  if (state.status === "expired" && (state.expiresInMs === undefined || state.expiresInMs > 0)) {
    return "cached with a timestamp in the future, treated as expired";
  }
  const age = `cached ${formatAge(state.ageMs)} ago`;
  if (state.expiresInMs === undefined) {
    return `${age}, no expiry`;
  }
  return state.status === "fresh" ? `${age}, expires in ${formatAge(state.expiresInMs)}` : `${age}, expired ${formatAge(-state.expiresInMs)} ago`;
}

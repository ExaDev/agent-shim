import { UsageError } from "./cliError";
import { CredentialCacheSchema, type CredentialCache, type CredentialCacheStore } from "./config/schema";

/** What a `set` asks for of a credential block's cache: an explicit on or off, and the new `ttl` and `store` it names. */
export interface CredentialCacheRequest {
  /** `false` removes the cache; `true` enables it with whatever `ttl` and `store` follow. */
  readonly enabled?: boolean;
  readonly ttl?: string;
  readonly store?: CredentialCacheStore;
}

/**
 * The cache block a request asks for, merged over `existing`: undefined when it asks for nothing (leave the block alone), false to remove the cache, otherwise the existing block with the named `ttl` and `store` replaced. Throws `UsageError` when the merged block fails the schema (a malformed `ttl`), naming the schema's reason.
 *
 * The one implementation `identity set`, `provider set` and the typed API's `config.identity.set` and `config.provider.set` share.
 */
export function mergeCredentialCache(request: CredentialCacheRequest, existing: CredentialCache | undefined): CredentialCache | false | undefined {
  if (request.enabled === false) {
    return false;
  }
  if (request.ttl === undefined && request.store === undefined && request.enabled !== true) {
    return undefined;
  }
  const parsed = CredentialCacheSchema.safeParse({
    ...existing,
    ...(request.ttl === undefined ? {} : { ttl: request.ttl }),
    ...(request.store === undefined ? {} : { store: request.store }),
  });
  if (!parsed.success) {
    throw new UsageError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}

import { isCodexProvider } from "../config/schema";
import { resolveCredential, type CredentialPort } from "../credential";
import type { FsPort } from "../launcher/ports";
import { loadProvider } from "../providersStore";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { adapterFor, quotaFreshnessMs, type ProviderQuotaAdapter, type QuotaHttpGet } from "./providerQuota";
import type { ProviderQuota, UsageRecord } from "./schema";

/** The longest one usage-endpoint request may take. Also the earliest a failed automatic refresh is tried again, so an endpoint that is down costs at most one attempt per this period. */
export const QUOTA_REQUEST_TIMEOUT_MS = 10_000;

/** A provider the refresher can fetch for: its base URL, and its API key resolved only when a fetch is actually due (resolving may run a credential command). */
export interface QuotaProviderLookup {
  readonly baseUrl: string;
  /** Throws an error whose message says why no key could be resolved. Never include the key in any message. */
  readonly apiKey: () => string;
}

/** Everything the refresher depends on, injected so it runs against fakes. */
export interface QuotaRefresherDeps {
  /** The provider named `name`, or undefined when there is none or it is not an HTTP provider. */
  readonly lookup: (name: string) => QuotaProviderLookup | undefined;
  readonly http: QuotaHttpGet;
  /** The identity's current quota for the provider, for the freshness check. */
  readonly readQuota: (identity: string, provider: string) => ProviderQuota | undefined;
  /** Attaches a fetched quota to the identity's state for the provider; false when the identity has none. */
  readonly record: (identity: string, provider: string, quota: ProviderQuota) => boolean;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/** How one refresh ended. */
type RefreshOutcome =
  | { readonly status: "refreshed"; readonly quota: ProviderQuota }
  /** Not fetched: the stored quota is still current (or a failure was too recent to retry). */
  | { readonly status: "fresh" }
  /** The provider has no usage endpoint this project can read. */
  | { readonly status: "unsupported" }
  /** The identity has no state for the provider to attach a quota to. */
  | { readonly status: "no-usage" }
  | { readonly status: "failed"; readonly message: string };

/** Refreshes provider quotas from their usage endpoints. */
export interface QuotaRefresher {
  /** Fetches the quota unless it is still current. `force` fetches regardless of freshness (an explicit request), though never twice at once for the same identity and provider. */
  readonly refresh: (identity: string, provider: string, options?: { readonly force?: boolean }) => Promise<RefreshOutcome>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds the refresher. One fetch per identity and provider is in flight at a time, so a burst of requests produces one call, and a failure suppresses further automatic attempts for one request timeout. */
export function createQuotaRefresher(deps: QuotaRefresherDeps): QuotaRefresher {
  const inFlight = new Map<string, Promise<RefreshOutcome>>();
  const failedAt = new Map<string, number>();

  const fetchNow = async (identity: string, provider: string, lookup: QuotaProviderLookup, adapter: ProviderQuotaAdapter): Promise<RefreshOutcome> => {
    const key = `${identity}\u0000${provider}`;
    try {
      const apiKey = lookup.apiKey();
      const quota = await adapter.fetch(apiKey, deps.http, AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS), deps.now());
      if (!deps.record(identity, provider, quota)) {
        return { status: "no-usage" };
      }
      failedAt.delete(key);
      return { status: "refreshed", quota };
    } catch (error) {
      failedAt.set(key, deps.now());
      const message = describeError(error);
      deps.log(`usage: quota refresh for ${identity} via ${provider} failed: ${message}`);
      return { status: "failed", message };
    }
  };

  return {
    refresh: async (identity, provider, options = {}) => {
      let lookup: QuotaProviderLookup | undefined;
      try {
        lookup = deps.lookup(provider);
      } catch (error) {
        const message = describeError(error);
        deps.log(`usage: quota refresh for ${identity} via ${provider} failed: ${message}`);
        return { status: "failed", message };
      }
      const adapter = lookup === undefined ? undefined : adapterFor(lookup.baseUrl);
      if (lookup === undefined || adapter === undefined) {
        return { status: "unsupported" };
      }
      const key = `${identity}\u0000${provider}`;
      const running = inFlight.get(key);
      if (running !== undefined) {
        return await running;
      }
      if (options.force !== true) {
        const failed = failedAt.get(key);
        if (failed !== undefined && deps.now() - failed < QUOTA_REQUEST_TIMEOUT_MS) {
          return { status: "fresh" };
        }
        let stored: ProviderQuota | undefined;
        try {
          stored = deps.readQuota(identity, provider);
        } catch (error) {
          const message = describeError(error);
          deps.log(`usage: quota refresh for ${identity} via ${provider} failed: ${message}`);
          return { status: "failed", message };
        }
        if (stored !== undefined && deps.now() - Date.parse(stored.observedAt) < quotaFreshnessMs(stored)) {
          return { status: "fresh" };
        }
      }
      const started = fetchNow(identity, provider, lookup, adapter).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, started);
      return await started;
    },
  };
}

/** The ports a provider lookup reads configuration and credentials through. */
export interface ProviderLookupPorts {
  readonly fs: FsPort;
  readonly providersDir: string;
  /** Where `env` credential sources are read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly credentials: CredentialPort;
}

/**
 * Looks providers up the way a launch does: the provider file is read fresh on every call, and the API key comes from the provider's own credential block (through the credential cache when it caches), so a refresh authenticates with exactly what a session of that provider does. Only HTTP providers qualify; a Codex provider has no API key to fetch quota with.
 */
export function createProviderLookup(ports: ProviderLookupPorts): (name: string) => QuotaProviderLookup | undefined {
  return (name) => {
    const definition = loadProvider(ports.providersDir, name, ports.fs);
    if (definition === undefined || isCodexProvider(definition)) {
      return undefined;
    }
    return {
      baseUrl: definition.baseUrl,
      apiKey: () => {
        const resolution = resolveCredential({ credential: definition.credential, env: ports.env, port: ports.credentials, subject: `provider ${name}` });
        if (!resolution.ok) {
          throw new Error(resolution.message);
        }
        return resolution.credential.token;
      },
    };
  };
}

/**
 * Wraps the usage store's `record` so that recording a provider's request also refreshes that provider's quota when it is stale: the refresh is started and not awaited, and its outcome is logged by the refresher, so a slow or failing usage endpoint never touches a request. OAuth sessions (Anthropic's own API) carry their quota in response headers and are skipped.
 */
export function withQuotaRefresh(record: (record: UsageRecord) => void, refresher: QuotaRefresher): (record: UsageRecord) => void {
  return (usageRecord) => {
    record(usageRecord);
    if (usageRecord.identity !== undefined && usageRecord.provider !== ANTHROPIC_PROVIDER) {
      void refresher.refresh(usageRecord.identity, usageRecord.provider);
    }
  };
}

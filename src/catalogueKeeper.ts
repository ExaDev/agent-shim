import { holdFrom } from "./elapsedWindow";
import { CATALOGUE_RETRY_MS, catalogueMatchesSettings, catalogueSettingsFingerprint, isCatalogueStale, isRedirectedFailure, isUnlocatedRedirect, parseCatalogueCache, parseCatalogueSettings, type CatalogueCache } from "./providerCatalogue";
import { isHttpProvider, type Provider } from "./config/schema";
import { UnreadableCatalogueError, catalogueReadFault } from "./storedCatalogue";

/** What the keeper needs from its surroundings; every effect is injected so the schedule can be tested without a door, a clock or a network. */
export interface CatalogueKeeperDeps {
  readonly supervisorPid: number;
  /** Every provider definition that is currently readable, by name. */
  readonly providers: () => readonly (readonly [string, Provider])[];
  /** The text of `name`'s catalogue cache file, or undefined when it has none. A file that exists and cannot be read throws: the keeper records that against the one provider and goes on with the others. */
  readonly readCache: (name: string, provider: Provider) => string | undefined;
  /** The text of the file holding the digest of the settings `name`'s catalogue was fetched under, or undefined when it has none (an `http` provider's catalogue is used only with a digest that matches the provider's own). */
  readonly readSettings: (name: string) => string | undefined;
  /** Fetches `name`'s catalogue and stores it; rejects when it cannot. Runs outside the door's own process. */
  readonly refresh: (name: string) => Promise<void>;
  readonly credentialFingerprint?: (provider: Provider) => string | undefined;
  readonly nowMs: () => number;
  readonly log: (message: string) => void;
  /** Records a provider's refresh state; a failed refresh also gives why (the error message), and its `failure` says whether it was a redirect and under which settings, which `doctor` and the launcher's wait read. */
  readonly publishStatus?: (name: string, status: "running" | "ready" | "failed", fingerprint?: string, reason?: string, failure?: Readonly<{ readonly redirected?: true; readonly unlocated?: true; readonly settings?: string }>) => void;
}

/** A tick of the catalogue keeper: starts a refresh for every provider whose catalogue is missing or stale. */
export interface CatalogueKeeper {
  readonly tick: () => void;
  readonly status: (name: string) => "running" | "failed" | undefined;
}

/** The provider names that opted into a catalogue, which are the only ones the keeper fetches. */
function cataloguedProviders(providers: readonly (readonly [string, Provider])[]): readonly (readonly [string, Provider])[] {
  return providers.filter(([, provider]) => provider.kind === "codex" || ((provider.kind === undefined || provider.kind === "http") && provider.catalogue !== undefined));
}

/**
 * Keeps each opted-in provider's catalogue current: a tick starts a refresh for every provider with no usable cache or a stale one, one at a time per provider, and a failed refresh is not retried until `CATALOGUE_RETRY_MS` has passed. A failure is logged and never ends the tick, since every session routed through the door depends on the door's own loop.
 */
export function createCatalogueKeeper(deps: Readonly<CatalogueKeeperDeps>): CatalogueKeeper {
  const running = new Set<string>();
  const credentialFailures = new Set<string>();
  const unreadable = new Set<string>();
  // What a failed refresh recorded, so the failure can be published again exactly as it was.
  const failedAt = new Map<string, { readonly at: number; readonly fingerprint: string | undefined; readonly settings: string | undefined; readonly reason: string; readonly redirected: boolean; readonly unlocated: boolean }>();
  return {
    status: (name) => running.has(name) ? "running" : failedAt.has(name) || credentialFailures.has(name) || unreadable.has(name) ? "failed" : undefined,
    tick: () => {
      const now = deps.nowMs();
      for (const [name, provider] of cataloguedProviders(deps.providers())) {
        if (provider.kind === "codex" && deps.credentialFingerprint === undefined) throw new Error("Codex catalogue needs an account fingerprint reader");
        let cache: CatalogueCache | undefined;
        let digestMatches: boolean;
        try {
          cache = parseCatalogueCache(deps.readCache(name, provider));
          digestMatches = cache === undefined || !isHttpProvider(provider) || catalogueMatchesSettings(parseCatalogueSettings(deps.readSettings(name)), cache, provider);
        } catch (error) {
          // One provider's stored files that cannot be read (permissions, a directory in their place) are that provider's failure alone: the fault's class or code is recorded, never the error's message, which names a path, and the other providers are still refreshed.
          const fault = catalogueReadFault(error);
          unreadable.add(name);
          deps.publishStatus?.(name, "failed", undefined, `stored catalogue cannot be read (${fault})`);
          deps.log(`catalogue files of provider ${name} cannot be read (${fault})`);
          continue;
        }
        const wasUnreadable = unreadable.delete(name);
        const recordedFailure = failedAt.get(name);
        // A failure's backoff restarts when the clock has stepped back behind it, so a failing provider is refreshed once a window and not on every tick for as long as the step lasts.
        const backoff = recordedFailure === undefined ? undefined : holdFrom(recordedFailure.at, now, CATALOGUE_RETRY_MS);
        const lastFailure = recordedFailure === undefined || backoff === undefined ? undefined : { ...recordedFailure, at: backoff.sinceMs };
        if (recordedFailure !== undefined && lastFailure !== undefined && lastFailure.at !== recordedFailure.at) {
          failedAt.set(name, lastFailure);
        }
        // What the refresh depends on besides the account: a failure of the provider as it was says nothing about the provider as it is edited now.
        const settings = isHttpProvider(provider) ? catalogueSettingsFingerprint(provider) : undefined;
        let current: string | undefined;
        try {
          current = deps.credentialFingerprint?.(provider);
        } catch (error) {
          credentialFailures.add(name);
          deps.publishStatus?.(name, "failed");
          deps.log(`catalogue credential for provider ${name} failed: ${error instanceof UnreadableCatalogueError ? `its login cannot be read (${catalogueReadFault(error)})` : error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        credentialFailures.delete(name);
        const changed = provider.kind === "codex" && deps.credentialFingerprint !== undefined && (current === undefined || cache?.credentialFingerprint !== current || cache.supervisorPid !== deps.supervisorPid);
        // Whether the stored catalogue can be used as it is: it is current, belongs to the account and fits the provider as it is now.
        const usable = cache !== undefined && digestMatches && !isCatalogueStale(cache, now) && !changed;
        const due = (cache === undefined || isCatalogueStale(cache, now) || changed || !digestMatches) && (lastFailure === undefined || lastFailure.fingerprint !== current || lastFailure.settings !== settings || backoff?.held !== true);
        if (!due || running.has(name)) {
          if (!running.has(name)) {
            if (usable && (wasUnreadable || recordedFailure !== undefined)) {
              // A catalogue that is current and fits the provider as it is now is not refreshed, so nothing would else replace what was recorded for the provider before: a failure recorded while its files could not be read, or a refresh that failed under settings it no longer has. Its status is ready.
              failedAt.delete(name);
              if (current === undefined) deps.publishStatus?.(name, "ready");
              else deps.publishStatus?.(name, "ready", current);
            } else if (wasUnreadable && recordedFailure !== undefined) {
              // The files are readable again but there is no catalogue to use and the refresh's failure is still being waited out: the failure it recorded is its status again, not ready.
              deps.publishStatus?.(name, "failed", recordedFailure.fingerprint, recordedFailure.reason, { ...(recordedFailure.redirected ? { redirected: true as const } : {}), ...(recordedFailure.unlocated ? { unlocated: true as const } : {}), ...(recordedFailure.settings === undefined ? {} : { settings: recordedFailure.settings }) });
            }
          }
          continue;
        }
        running.add(name);
        if (current === undefined) deps.publishStatus?.(name, "running");
        else deps.publishStatus?.(name, "running", current);
        deps
          .refresh(name)
          .then(() => {
            failedAt.delete(name);
            deps.publishStatus?.(name, "ready");
          })
          .catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            failedAt.set(name, { at: deps.nowMs(), fingerprint: current, settings, reason, redirected: isRedirectedFailure(error), unlocated: isUnlocatedRedirect(error) });
            deps.publishStatus?.(name, "failed", current, reason, { ...(isRedirectedFailure(error) ? { redirected: true as const } : {}), ...(isUnlocatedRedirect(error) ? { unlocated: true as const } : {}), ...(settings === undefined ? {} : { settings }) });
            deps.log(`catalogue refresh for provider ${name} failed: ${reason}`);
          })
          .finally(() => {
            running.delete(name);
          });
      }
    },
  };
}

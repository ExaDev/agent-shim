import { CATALOGUE_RETRY_MS, isCatalogueStale, parseCatalogueCache } from "./providerCatalogue";
import type { Provider } from "./config/schema";

/** What the keeper needs from its surroundings; every effect is injected so the schedule can be tested without a door, a clock or a network. */
export interface CatalogueKeeperDeps {
  readonly supervisorPid: number;
  /** Every provider definition that is currently readable, by name. */
  readonly providers: () => readonly (readonly [string, Provider])[];
  /** The text of `name`'s catalogue cache file, or undefined when it has none. */
  readonly readCache: (name: string, provider: Provider) => string | undefined;
  /** Fetches `name`'s catalogue and stores it; rejects when it cannot. Runs outside the door's own process. */
  readonly refresh: (name: string) => Promise<void>;
  readonly credentialFingerprint?: (provider: Provider) => string | undefined;
  readonly nowMs: () => number;
  readonly log: (message: string) => void;
  readonly publishStatus?: (name: string, status: "running" | "ready" | "failed", fingerprint?: string) => void;
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
  const failedAt = new Map<string, { readonly at: number; readonly fingerprint: string | undefined }>();
  return {
    status: (name) => running.has(name) ? "running" : failedAt.has(name) || credentialFailures.has(name) ? "failed" : undefined,
    tick: () => {
      const now = deps.nowMs();
      for (const [name, provider] of cataloguedProviders(deps.providers())) {
        if (provider.kind === "codex" && deps.credentialFingerprint === undefined) throw new Error("Codex catalogue needs an account fingerprint reader");
        const cache = parseCatalogueCache(deps.readCache(name, provider));
        const lastFailure = failedAt.get(name);
        let current: string | undefined;
        try {
          current = deps.credentialFingerprint?.(provider);
        } catch (error) {
          credentialFailures.add(name);
          deps.publishStatus?.(name, "failed");
          deps.log(`catalogue credential for provider ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        credentialFailures.delete(name);
        const changed = provider.kind === "codex" && deps.credentialFingerprint !== undefined && (current === undefined || cache?.credentialFingerprint !== current || cache.supervisorPid !== deps.supervisorPid);
        const due = (cache === undefined || isCatalogueStale(cache, now) || changed) && (lastFailure === undefined || lastFailure.fingerprint !== current || now - lastFailure.at >= CATALOGUE_RETRY_MS);
        if (!due || running.has(name)) {
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
            failedAt.set(name, { at: deps.nowMs(), fingerprint: current });
            if (current === undefined) deps.publishStatus?.(name, "failed");
            else deps.publishStatus?.(name, "failed", current);
            deps.log(`catalogue refresh for provider ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => {
            running.delete(name);
          });
      }
    },
  };
}

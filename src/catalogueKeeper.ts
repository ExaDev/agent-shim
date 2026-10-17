import { CATALOGUE_RETRY_MS, isCatalogueStale, parseCatalogueCache } from "./providerCatalogue";
import type { Provider } from "./config/schema";

/** What the keeper needs from its surroundings; every effect is injected so the schedule can be tested without a door, a clock or a network. */
export interface CatalogueKeeperDeps {
  /** Every provider definition that is currently readable, by name. */
  readonly providers: () => readonly (readonly [string, Provider])[];
  /** The text of `name`'s catalogue cache file, or undefined when it has none. */
  readonly readCache: (name: string) => string | undefined;
  /** Fetches `name`'s catalogue and stores it; rejects when it cannot. Runs outside the door's own process. */
  readonly refresh: (name: string) => Promise<void>;
  readonly nowMs: () => number;
  readonly log: (message: string) => void;
}

/** A tick of the catalogue keeper: starts a refresh for every provider whose catalogue is missing or stale. */
export interface CatalogueKeeper {
  readonly tick: () => void;
}

/** The provider names that opted into a catalogue, which are the only ones the keeper fetches. */
function cataloguedNames(providers: readonly (readonly [string, Provider])[]): readonly string[] {
  return providers.flatMap(([name, provider]) => ((provider.kind === undefined || provider.kind === "http") && provider.catalogue !== undefined ? [name] : []));
}

/**
 * Keeps each opted-in provider's catalogue current: a tick starts a refresh for every provider with no usable cache or a stale one, one at a time per provider, and a failed refresh is not retried until `CATALOGUE_RETRY_MS` has passed. A failure is logged and never ends the tick, since every session routed through the door depends on the door's own loop.
 */
export function createCatalogueKeeper(deps: Readonly<CatalogueKeeperDeps>): CatalogueKeeper {
  const running = new Set<string>();
  const failedAt = new Map<string, number>();
  return {
    tick: () => {
      const now = deps.nowMs();
      for (const name of cataloguedNames(deps.providers())) {
        const cache = parseCatalogueCache(deps.readCache(name));
        const lastFailure = failedAt.get(name);
        const due = (cache === undefined || isCatalogueStale(cache, now)) && (lastFailure === undefined || now - lastFailure >= CATALOGUE_RETRY_MS);
        if (!due || running.has(name)) {
          continue;
        }
        running.add(name);
        deps
          .refresh(name)
          .then(() => {
            failedAt.delete(name);
          })
          .catch((error: unknown) => {
            failedAt.set(name, deps.nowMs());
            deps.log(`catalogue refresh for provider ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => {
            running.delete(name);
          });
      }
    },
  };
}

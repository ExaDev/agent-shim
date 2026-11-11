import { HTTP_STATUS } from "../codex/http";
import { holdFrom, within } from "../elapsedWindow";
import type { HttpProvider } from "../config/schema";
import type { CredentialResolution } from "../credential";
import { CATALOGUE_REFRESH_TIMEOUT_MS, CatalogueFetchError, fetchCatalogue, filterCatalogue, type CatalogueFetch } from "../providerCatalogue";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/**
 * How long a provider's served model, once read from its live model list, is used before the list is read again. A session sends a request every few seconds while it works, so reading the list per request would double the traffic to a server that may be busy serving a single long generation; a minute bounds the list reads of ordinary lookups to one per provider per minute, and a refresh adds at most one more in the same minute. It can be this long because a server swapping its model is caught earlier by the request itself: the server answers the old name with an unknown-model error, which refreshes the list once and retries once (see `editingHttpRequest`).
 */
export const SERVED_MODEL_MAX_AGE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;

/** The model a provider serves, or why it cannot be named: `status` is the HTTP status the request is answered with. */
type ServedModelOutcome = { readonly ok: true; readonly model: string } | { readonly ok: false; readonly status: number; readonly message: string };

/** What one lookup reads about the provider whose served model is asked for. */
interface ServedModelSource {
  /** The provider's name, for the cache key and for every message. */
  readonly name: string;
  readonly provider: Pick<HttpProvider, "baseUrl" | "catalogue">;
  /** Resolves the provider's own credential, the one its requests carry. */
  readonly credential: () => Promise<CredentialResolution>;
}

/** The served-model lookup: the model a provider's server serves, from its live model list. */
export interface ServedModels {
  /** The model `source`'s server serves: the only entry of its list, or the first when it lists several. `refresh` skips the cache, for a request the server has just refused as an unknown model, at most once per cache age for each provider: a refresh within it of one already made answers with the cached model. A refresh whose read fails does not count. */
  readonly resolve: (source: Readonly<ServedModelSource>, options?: Readonly<{ readonly refresh?: boolean }>) => Promise<ServedModelOutcome>;
}

/** What the lookup needs from its surroundings; the fetch is the catalogue machinery's own port, so the list is read exactly as the catalogue is. */
export interface ServedModelPorts {
  readonly fetch: CatalogueFetch;
  readonly now: () => number;
}

/** Whether a cached read is still fresh at `nowMs`: stamped no later than `nowMs` and less than `maxAgeMs` before it, so a clock stepped back since the read never keeps it fresh. */
function fresh(cached: Readonly<{ readonly at: number }>, nowMs: number, maxAgeMs = SERVED_MODEL_MAX_AGE_MS): boolean {
  return within(cached.at, nowMs, maxAgeMs);
}

/** The settings that change what a provider's list names, so an edit to any of them is a different entry. The credential is not one: it decides whether the server answers at all, never which models it lists, and a read it made possible is as good for the next lookup whichever login the next one presents. */
function cacheKeyOf(source: Readonly<ServedModelSource>): string {
  const { name, provider } = source;
  return JSON.stringify([name, provider.baseUrl, provider.catalogue?.url, provider.catalogue?.include, provider.catalogue?.exclude]);
}

/**
 * Reads each provider's served model from the same `/v1/models` list the catalogue reads (`fetchCatalogue` and the provider's `catalogue` filters). A lookup is served from memory for `SERVED_MODEL_MAX_AGE_MS`. Lookups of one provider that arrive while a read is in flight share it (a refresh shares only a read that is itself a refresh, below), so a hung server is asked once however many ordinary requests wait on it. Every window is counted on the wall clock from the stamp of the read, and one that has not begun (the clock has stepped back since the stamp) is over, so a read or a failure is never kept past its window. A failed read is remembered, when it is the server's failure and not a credential that did not resolve or one that every failing candidate URL refused (a 401 or 403), for `CATALOGUE_REFRESH_TIMEOUT_MS`, a fixed two request limits (the two candidate URLs a provider with no `catalogue.url` is asked, each for up to the limit; a provider with one asks a single URL and has the same budget), so a server that is down costs one such budget per period and not one per request. A lookup joins a read already in flight, except a refresh, which joins only a read that is itself a refresh: a refresh waits for any other read to end and then decides afresh, since that read began before the answer being refreshed and may hold the old model. Two reads of one provider never overlap, so the result of a read is never older than the read that was in flight when it was asked for. A cached failure answers a refresh too, for up to that one read budget: a server that has just recovered can still be answered with the failure, a deliberate trade-off that keeps a down server from being asked once per request.
 */
export function createServedModels(ports: Readonly<ServedModelPorts>): ServedModels {
  // The `cache`, `failures` and `refreshedAt` maps hold one entry for each distinct provider name, base URL and catalogue setting the door is asked about, and none is evicted (`inFlight` empties as its reads end): they are bounded by the providers a person defines and the edits made to them while the door runs, never by requests.
  const cache = new Map<string, { readonly at: number; readonly model: string }>();
  const failures = new Map<string, { readonly at: number; readonly outcome: ServedModelOutcome }>();
  const inFlight = new Map<string, { readonly promise: Promise<ServedModelOutcome>; readonly refresh: boolean }>();
  // When each provider's list was last read for a refresh: a refresh is honoured once per `SERVED_MODEL_MAX_AGE_MS`, so a server that answers every request as an unknown model it lists itself cannot turn each request into a list read.
  const refreshedAt = new Map<string, number>();
  const read = async (source: Readonly<ServedModelSource>, key: string, refresh: boolean): Promise<ServedModelOutcome> => {
    // A failure is remembered only when it is the server's: a credential that did not resolve asked no server, and one that every failing candidate refused (a 401 or 403) ends when the credential is fixed, so neither may outlive that fix for the length of the failure window.
    const failed = (status: number, message: string, remembered = true): ServedModelOutcome => {
      const outcome: ServedModelOutcome = { ok: false, status, message };
      if (!remembered) {
        return outcome;
      }
      // Stamped when the read ends, not when it began: a read that hangs for its whole budget would otherwise be born expired and every request behind it would read again.
      failures.set(key, { at: ports.now(), outcome });
      return outcome;
    };
    const credential = await source.credential();
    if (!credential.ok) {
      return failed(HTTP_STATUS.badGateway, `the model "auto" follows the model provider "${source.name}"'s server serves, but its live model list could not be read because the provider's credential did not resolve: ${credential.message}`, false);
    }
    let models;
    try {
      const listed = await fetchCatalogue({ provider: source.provider, catalogue: source.provider.catalogue ?? {}, credential: credential.credential, fetch: ports.fetch, now: ports.now });
      models = source.provider.catalogue === undefined ? listed.models : filterCatalogue(listed.models, source.provider.catalogue);
    } catch (error) {
      return failed(HTTP_STATUS.badGateway, `the model "auto" follows the model provider "${source.name}"'s server serves, but its live model list could not be read (${error instanceof Error ? error.message : String(error)})`, !(error instanceof CatalogueFetchError && error.unauthorised));
    }
    const [first] = models;
    if (first === undefined) {
      // A list with no model never reaches here (`fetchCatalogue` refuses it as a failed read): the server did list models and the provider's own catalogue patterns admit none, which is the person's configuration and is said so.
      return failed(HTTP_STATUS.badGateway, `the model "auto" follows the model provider "${source.name}"'s server serves, but no model it lists passes the provider's catalogue include and exclude`);
    }
    const readAt = ports.now();
    // A read that gave a model ends the failure remembered before it, so a clock stepped back behind that failure's stamp cannot bring it back for a server that is healthy.
    failures.delete(key);
    cache.set(key, { at: readAt, model: first.id });
    // A refresh uses up its allowance only when its read gave a model: one that failed leaves the next refresh free to try again once the failure window has passed.
    if (refresh) {
      refreshedAt.set(key, readAt);
    }
    return { ok: true, model: first.id };
  };
  const resolve: ServedModels["resolve"] = async (source, options) => {
    const key = cacheKeyOf(source);
    const now = ports.now();
    const cached = cache.get(key);
    const refresh = options?.refresh === true;
    if (!refresh && cached !== undefined && fresh(cached, now)) {
      return { ok: true, model: cached.model };
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      if (!refresh || pending.refresh) {
        return await pending.promise;
      }
      // A refresh is asked for after a request was refused under the model it had, and a read already in flight began before that answer: it may hold the model the server has since left. The refresh waits for that read to end and then decides afresh, so it never takes the stale model back as the newest.
      await pending.promise;
      return await resolve(source, options);
    }
    const failure = failures.get(key);
    if (failure !== undefined) {
      // A failure window restarts when the clock has stepped back behind its stamp, so a server that is down is not read on every lookup for as long as the step lasts.
      const backoff = holdFrom(failure.at, now, CATALOGUE_REFRESH_TIMEOUT_MS);
      if (backoff.sinceMs !== failure.at) {
        failures.set(key, { ...failure, at: backoff.sinceMs });
      }
      if (backoff.held) {
        return failure.outcome;
      }
    }
    if (refresh) {
      const last = refreshedAt.get(key);
      if (last !== undefined && cached !== undefined) {
        // The same for a refresh's allowance: stepped back behind the last one, it restarts, so refreshes are not read on every request for as long as the step lasts.
        const allowance = holdFrom(last, now, SERVED_MODEL_MAX_AGE_MS);
        if (allowance.sinceMs !== last) {
          refreshedAt.set(key, allowance.sinceMs);
        }
        if (allowance.held) {
          return { ok: true, model: cached.model };
        }
      }
    }
    const promise = read(source, key, refresh).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, { promise, refresh });
    return await promise;
  };
  return { resolve };
}

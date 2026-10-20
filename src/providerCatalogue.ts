
import picomatch from "picomatch";
import { z } from "zod";

import type { ResolvedCredential } from "./credential";
import type { HttpProvider, ProviderCatalogue } from "./config/schema";
import type { LayoutPaths } from "./paths";
import { namedFilePath } from "./config/names";

/** The URLs a provider with no configured catalogue URL is asked: under its base URL, then under its host. */
const DEFAULT_CANDIDATE_URLS = 2;
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;
const HOURS_BETWEEN_RETRIES = 1;
const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;

/**
 * How long a fetched catalogue is used before the door fetches it again. A provider adds and retires models on a release timescale, so a day-old list is current enough, and a refresh costs one request per provider per day.
 */
export const CATALOGUE_MAX_AGE_MS = HOURS_PER_DAY * MS_PER_HOUR;

/**
 * How long after a failed fetch the door tries again. An unreachable or refusing endpoint is retried hourly: often enough to recover within the hour, rarely enough not to press on a provider that is down.
 */
export const CATALOGUE_RETRY_MS = HOURS_BETWEEN_RETRIES * MS_PER_HOUR;

/** How long one catalogue request may take before it is abandoned and the next candidate URL is tried. */
const CATALOGUE_REQUEST_SECONDS = 10;
const CATALOGUE_REQUEST_TIMEOUT_MS = CATALOGUE_REQUEST_SECONDS * MS_PER_SECOND;

/** How long one refresh child may run: the two candidate URLs a provider without a configured one is asked, each for up to the request limit. The runner adds its own grace for the child's start-up and for resolving the credential. */
export const CATALOGUE_REFRESH_TIMEOUT_MS = DEFAULT_CANDIDATE_URLS * CATALOGUE_REQUEST_TIMEOUT_MS;

/** One model the provider's catalogue lists. `name` is its display name when the endpoint gives one. */
const CatalogueModelSchema = z.strictObject({ id: z.string().min(1), name: z.string().min(1).optional() });
export type CatalogueModel = z.infer<typeof CatalogueModelSchema>;

/** A fetched catalogue as the door stores it: when and where it came from, and the models it listed. */
const CatalogueCacheSchema = z.strictObject({ fetchedAt: z.number(), url: z.string().min(1), models: z.array(CatalogueModelSchema) });
export type CatalogueCache = z.infer<typeof CatalogueCacheSchema>;

/** Where the door stores `name`'s fetched catalogue. */
export function catalogueCachePath(paths: LayoutPaths, name: string): string {
  return namedFilePath(paths.catalogueDir, name, ".json", "provider");
}

/** The catalogue a cache file holds, or `undefined` when the text is not one (missing, unparsable, or from a release that stored a different shape). */
export function parseCatalogueCache(text: string | undefined): CatalogueCache | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = CatalogueCacheSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `cache` is old enough that the door should fetch it again at `nowMs`. */
export function isCatalogueStale(cache: Readonly<CatalogueCache>, nowMs: number): boolean {
  return nowMs - cache.fetchedAt >= CATALOGUE_MAX_AGE_MS;
}

/**
 * The URLs to ask for `provider`'s catalogue, in order: the configured one alone, else `/v1/models` under the base URL (Anthropic-compatible hosts that mount the API beneath a prefix) and then under the host (hosts that serve the catalogue only at its root).
 */
export function catalogueUrls(provider: Readonly<Pick<HttpProvider, "baseUrl">>, catalogue: Readonly<Pick<ProviderCatalogue, "url">>): readonly string[] {
  if (catalogue.url !== undefined) {
    return [catalogue.url];
  }
  const base = provider.baseUrl.replace(/\/+$/, "");
  return [...new Set([`${base}/v1/models`, `${new URL(base).origin}/v1/models`])];
}

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One catalogue entry as a model, or `undefined` when it names none: a bare id string, or an object with an `id` and optionally a `display_name` (Anthropic's shape) or `name`. */
function modelOf(entry: unknown): CatalogueModel | undefined {
  if (typeof entry === "string") {
    return entry.trim() === "" ? undefined : { id: entry.trim() };
  }
  if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "") {
    return undefined;
  }
  const label = typeof entry.display_name === "string" ? entry.display_name : typeof entry.name === "string" ? entry.name : undefined;
  const name = label?.trim();
  return name === undefined || name === "" ? { id: entry.id.trim() } : { id: entry.id.trim(), name };
}

/**
 * The models a catalogue response lists, each once, in the order given: `{ "data": [...] }` (Anthropic and OpenAI), `{ "models": [...] }`, or the list itself, whose entries are ids or objects with an `id`. A body that holds no such list yields none.
 */
export function parseCatalogueBody(body: unknown): readonly CatalogueModel[] {
  const list = Array.isArray(body) ? body : isRecord(body) ? (Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []) : [];
  const seen = new Set<string>();
  const models: CatalogueModel[] = [];
  for (const entry of list) {
    const model = modelOf(entry);
    if (model !== undefined && !seen.has(model.id)) {
      seen.add(model.id);
      models.push(model);
    }
  }
  return models;
}

/** The models of `models` the catalogue's `include` patterns admit (all, when it names none) and its `exclude` patterns do not. */
export function filterCatalogue(models: readonly CatalogueModel[], catalogue: Readonly<Pick<ProviderCatalogue, "include" | "exclude">>): readonly CatalogueModel[] {
  const included = catalogue.include === undefined ? undefined : picomatch(catalogue.include, { dot: true });
  const excluded = catalogue.exclude === undefined ? undefined : picomatch(catalogue.exclude, { dot: true });
  return models.filter((model) => included?.(model.id) !== false && excluded?.(model.id) !== true);
}

/** The headers that authenticate a catalogue request the way the provider's own requests are: the token where its credential target puts it, with the API version Anthropic-compatible hosts expect. */
export function catalogueHeaders(credential: Readonly<Pick<ResolvedCredential, "target" | "token">>): Readonly<Record<string, string>> {
  return credential.target === "apiKey"
    ? { "x-api-key": credential.token, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${credential.token}`, "anthropic-version": "2023-06-01" };
}

/** What a catalogue request needs from the network: one GET returning its status and parsed JSON body, or throwing. */
export type CatalogueFetch = (url: string, headers: Readonly<Record<string, string>>, timeoutMs: number) => Promise<{ readonly status: number; readonly body: unknown }>;

/** Inputs to `fetchCatalogue`. */
export interface FetchCatalogueParams {
  readonly provider: Pick<HttpProvider, "baseUrl">;
  readonly catalogue: Pick<ProviderCatalogue, "url">;
  readonly credential: Readonly<Pick<ResolvedCredential, "target" | "token">>;
  readonly fetch: CatalogueFetch;
  readonly now: () => number;
}

/** Raised when no candidate URL returned a catalogue; the message names each URL and what it answered, never the credential. */
export class CatalogueFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueFetchError";
  }
}

/**
 * Asks each candidate URL for the catalogue in order and returns the first that lists at least one model. Throws `CatalogueFetchError` naming every URL's outcome when none does, so a misconfigured provider says which endpoints it tried.
 */
export async function fetchCatalogue(params: Readonly<FetchCatalogueParams>): Promise<CatalogueCache> {
  const headers = catalogueHeaders(params.credential);
  const outcomes: string[] = [];
  for (const url of catalogueUrls(params.provider, params.catalogue)) {
    try {
      const response = await params.fetch(url, headers, CATALOGUE_REQUEST_TIMEOUT_MS);
      const succeeded = response.status >= HTTP_OK && response.status < HTTP_MULTIPLE_CHOICES;
      const models = succeeded ? parseCatalogueBody(response.body) : [];
      if (models.length > 0) {
        return { fetchedAt: params.now(), url, models: [...models] };
      }
      outcomes.push(`${url}: ${succeeded ? "no models listed" : `status ${String(response.status)}`}`);
    } catch (error) {
      outcomes.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new CatalogueFetchError(`no catalogue from ${outcomes.join("; ")}`);
}

import picomatch from "picomatch";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { displayBaseUrl, redactUrlIn } from "./baseUrlDisplay";
import { within } from "./elapsedWindow";
import { canonicalJson } from "./canonicalJson";
import type { ResolvedCredential } from "./credential";
import type { HttpProvider, ProviderCatalogue } from "./config/schema";
import type { LayoutPaths } from "./paths";
import { providerFilePath } from "./config/names";
import { BLOCKING_STEP_TIMEOUTS_MS, DOOR_WORKER_START_ALLOWANCE_MS } from "./doorBounds";

/** The URLs a provider with no configured catalogue URL is asked: under its base URL, then under its host. */
const DEFAULT_CANDIDATE_URLS = 2;
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;
const HOURS_BETWEEN_RETRIES = 1;
const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;
/** The statuses that name another address to ask: 300 (a choice) and 304 (not modified) do not, and are plain failures of the read. */
const HTTP_MOVED_PERMANENTLY = 301;
const HTTP_FOUND = 302;
const HTTP_SEE_OTHER = 303;
const HTTP_TEMPORARY_REDIRECT = 307;
const HTTP_PERMANENT_REDIRECT = 308;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([HTTP_MOVED_PERMANENTLY, HTTP_FOUND, HTTP_SEE_OTHER, HTTP_TEMPORARY_REDIRECT, HTTP_PERMANENT_REDIRECT]);
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/**
 * How long a fetched catalogue is used before the door fetches it again. A provider adds and retires models on a release timescale, so a day-old list is current enough, and a refresh costs one request per provider per day.
 */
export const CATALOGUE_MAX_AGE_MS = HOURS_PER_DAY * MS_PER_HOUR;

/**
 * How long after a failed fetch the door tries again. An unreachable or refusing endpoint is retried hourly: often enough to recover within the hour, rarely enough not to press on a provider that is down.
 */
export const CATALOGUE_RETRY_MS = HOURS_BETWEEN_RETRIES * MS_PER_HOUR;

/** What a failed catalogue read says of a redirect it did not follow: the refresh outcome the door records and `doctor` recognises it by. */
export const CATALOGUE_REDIRECT_NOTE = "a redirect, which is not followed";

/** How long one catalogue request may take before it is abandoned and the next candidate URL is tried. */
const CATALOGUE_REQUEST_SECONDS = 10;
const CATALOGUE_REQUEST_TIMEOUT_MS = CATALOGUE_REQUEST_SECONDS * MS_PER_SECOND;

/** How long one catalogue fetch may take: the two candidate URLs a provider without a configured one is asked, each for up to the request limit. */
export const CATALOGUE_REFRESH_TIMEOUT_MS = DEFAULT_CANDIDATE_URLS * CATALOGUE_REQUEST_TIMEOUT_MS;

/** The number of models a provider's list is taken to have at most, from which the body limit below is derived: a very large aggregator lists a few thousand, so ten thousand leaves room well past that. The count is not enforced on its own: it is the byte bound that stops a read, so a list of more, smaller entries that still fits that bound is read in full. */
const CATALOGUE_MAX_MODELS = 10_000;

/** The bytes one model's entry is taken to take in a list, the other factor of the body limit below (an id, a display name and a few capability fields, well under a kibibyte for any real list). */
const CATALOGUE_ENTRY_MAX_BYTES = 1024;

/** The most bytes of a model-list response that are read: the list bound above times the entry bound. A larger body is not a model list, and a server must not be able to make the door buffer it. */
export const CATALOGUE_BODY_LIMIT_BYTES = CATALOGUE_MAX_MODELS * CATALOGUE_ENTRY_MAX_BYTES;

/** What a refresh needs beyond the fetch itself: the worker thread starting and evaluating the bundle (`DOOR_WORKER_START_ALLOWANCE_MS`), resolving the provider's credential (a credential command, which may take its whole timeout) and, for a Codex provider, asking the Codex CLI its version. */
export const CATALOGUE_WORKER_ALLOWANCE_MS = DOOR_WORKER_START_ALLOWANCE_MS + BLOCKING_STEP_TIMEOUTS_MS.credentialCommand + BLOCKING_STEP_TIMEOUTS_MS.codexVersion;

/** How long the door lets one refresh run in all, and so how long a launch that waits for the door's catalogues waits for one: the fetch plus what the worker needs around it. */
export const CATALOGUE_REFRESH_DEADLINE_MS = CATALOGUE_REFRESH_TIMEOUT_MS + CATALOGUE_WORKER_ALLOWANCE_MS;

/** One model the provider's catalogue lists. `name` is its display name when the endpoint gives one. */
const CatalogueModelSchema = z.strictObject({ id: z.string().min(1), name: z.string().min(1).optional() });
export type CatalogueModel = z.infer<typeof CatalogueModelSchema>;

/** A fetched catalogue as the door stores it: when and where it came from, and the models it listed. */
const CatalogueCacheSchema = z.strictObject({ fetchedAt: z.number(), url: z.string().min(1), models: z.array(CatalogueModelSchema), credentialFingerprint: z.string().optional(), supervisorPid: z.number().int().positive().optional() });
export type CatalogueCache = z.infer<typeof CatalogueCacheSchema>;

/** Where the door stores `name`'s fetched catalogue. */
export function catalogueCachePath(paths: LayoutPaths, name: string, supervisorPid?: number, generation?: string): string {
  if ((supervisorPid === undefined) !== (generation === undefined)) throw new Error("A supervisor cache needs both its PID and generation");
  const directory = supervisorPid === undefined || generation === undefined ? paths.catalogueDir : catalogueGenerationDir(paths, supervisorPid, generation);
  return providerFilePath(directory, name);
}

/**
 * Where the digest of the settings `name`'s catalogue was fetched under is stored: a file of its own in a `settings` directory beside the catalogue, not a key of the catalogue, since an older release reads a catalogue file with a closed schema and would take one with a new key for none. Only an `http` provider's catalogue has one (a codex provider's is tied to its account instead). The writer removes the digest, stores the catalogue and then stores the digest, so a reader that finds no digest (a refresh that stopped in between, or a catalogue an older door wrote) uses no list, and a digest never describes a list fetched under other settings.
 */
export function catalogueSettingsPath(paths: LayoutPaths, name: string): string {
  return path.join(path.dirname(catalogueCachePath(paths, name)), "settings", `${name}.json`);
}

/** What a digest file holds: the digest of the settings the catalogue was fetched under and the `fetchedAt` of that catalogue, which binds the two. A release before the digest rewrites a catalogue and never touches this file, so a catalogue it rewrote has another `fetchedAt` and its older digest, which could match the settings again after an edit and revert, no longer does. */
const CatalogueDigestSchema = z.strictObject({ settings: z.string().min(1), fetchedAt: z.number() });
export type CatalogueDigest = z.infer<typeof CatalogueDigestSchema>;

/** The text a digest file holds for a catalogue fetched at `fetchedAt` under the settings of `settings`. */
export function catalogueSettingsText(settings: string, fetchedAt: number): string {
  return JSON.stringify({ settings, fetchedAt } satisfies CatalogueDigest);
}

/** The digest a digest file holds, or `undefined` when the text is not one (missing, unparsable or of another shape, such as one written before the file named its catalogue). */
export function parseCatalogueSettings(text: string | undefined): CatalogueDigest | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = CatalogueDigestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The catalogue directory owned by one supervisor generation. */
export function catalogueGenerationDir(paths: LayoutPaths, supervisorPid: number, generation: string): string {
  return path.join(paths.catalogueDir, "supervisors", String(supervisorPid), z.uuid().parse(generation));
}

/** The account binding adjacent to a provider's catalogue. */
export function catalogueBindingPath(paths: LayoutPaths, name: string, supervisorPid?: number, generation?: string): string {
  return path.join(path.dirname(catalogueCachePath(paths, name, supervisorPid, generation)), `${name}.binding.json`);
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

/** Whether `cache` is old enough that the door should fetch it again at `nowMs`: a cache stamped after `nowMs` (the clock has stepped back since) is stale too, since its age cannot be told. */
export function isCatalogueStale(cache: Readonly<CatalogueCache>, nowMs: number): boolean {
  return !within(cache.fetchedAt, nowMs, CATALOGUE_MAX_AGE_MS);
}

/**
 * The URLs to ask for `provider`'s catalogue, in order: the configured one alone, else `/v1/models` under the base URL (Anthropic-compatible hosts that mount the API beneath a prefix) and then under the host (hosts that serve the catalogue only at its root).
 */
export function catalogueUrls(provider: Readonly<Pick<HttpProvider, "baseUrl">>, catalogue: Readonly<Pick<ProviderCatalogue, "url">>): readonly string[] {
  if (catalogue.url !== undefined) {
    return [catalogue.url];
  }
  // The catalogue path belongs to the URL's path, never to its query, which stays on the request because a base URL may carry the provider's key there.
  const base = new URL(provider.baseUrl);
  const underBase = new URL(base);
  underBase.pathname = `${base.pathname.replace(/\/+$/, "")}/v1/models`;
  const underHost = new URL(base);
  underHost.pathname = "/v1/models";
  return [...new Set([underBase.href, underHost.href])];
}

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The longest a model id a catalogue lists may be, in characters: a bound no real id comes near (aggregator ids are a few dozen characters) that keeps one a server made up from being cached, logged and written into every request body at any length. */
export const CATALOGUE_MODEL_ID_MAX_CHARS = 256;

/** Whether `id` can be a model id: non-empty, within `CATALOGUE_MODEL_ID_MAX_CHARS`, and free of control characters, which no model id holds and which could start a line of a log or an error message. */
function isModelId(id: string): boolean {
  return id !== "" && id.length <= CATALOGUE_MODEL_ID_MAX_CHARS && !/\p{Cc}/u.test(id);
}

/** One catalogue entry as a model, or `undefined` when it names none: a bare id string, or an object with an `id` and optionally a `display_name` (Anthropic's shape) or `name`. */
function modelOf(entry: unknown): CatalogueModel | undefined {
  if (typeof entry === "string") {
    return isModelId(entry.trim()) ? { id: entry.trim() } : undefined;
  }
  if (isRecord(entry) && typeof entry.slug === "string" && "visibility" in entry) {
    return entry.visibility === "list" ? modelOf({ id: entry.slug, display_name: entry.display_name }) : undefined;
  }
  if (!isRecord(entry) || typeof entry.id !== "string" || !isModelId(entry.id.trim())) {
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
export type CatalogueFetch = (url: string, headers: Readonly<Record<string, string>>, timeoutMs: number) => Promise<{ readonly status: number; readonly body: unknown; /** Whether the answer carried a `Location` header; absent when the fetch cannot tell, which is read as it did. */ readonly located?: boolean }>;

/** Inputs to `fetchCatalogue`. */
export interface FetchCatalogueParams {
  readonly provider: Pick<HttpProvider, "baseUrl">;
  readonly catalogue: Pick<ProviderCatalogue, "url">;
  readonly credential: Readonly<Pick<ResolvedCredential, "target" | "token">>;
  readonly fetch: CatalogueFetch;
  readonly now: () => number;
}

/**
 * What the list `fetchCatalogue` reads from an `http` provider depends on, as a SHA-256 digest (hex) of a canonical JSON form of: whether the provider has a catalogue at all, the base URL, the catalogue's own URL and the whole credential block (every source with its whole command line, path, variable or item, the target and the cache settings). The tier and the filters are not in it: they are applied over the stored list when it is read, so an edit to them changes neither what is fetched nor how a fetch fails. Only the digest is compared and stored (the base URL can carry userinfo and the credential block names its sources), so nothing it was made from leaves the provider file. A failure recorded, and a list stored, under one fingerprint say nothing about a provider whose fingerprint has since changed.
 */
export function catalogueSettingsFingerprint(provider: Readonly<Pick<HttpProvider, "baseUrl" | "catalogue" | "credential">>): string {
  return createHash("sha256").update(canonicalJson([provider.baseUrl, provider.catalogue === undefined ? false : (provider.catalogue.url ?? null), provider.credential])).digest("hex");
}

/** Whether `cache` was fetched under the settings `provider` has now, given the digest stored beside it (`recorded`, `undefined` when there is none): one fetched under another base URL, catalogue URL or credential block lists the models of another server, one whose digest names another catalogue (`fetchedAt`) was rewritten since it was stored, and one with no digest cannot be told from either, so none is used for the provider as it is. */
export function catalogueMatchesSettings(recorded: CatalogueDigest | undefined, cache: Readonly<Pick<CatalogueCache, "fetchedAt">>, provider: Readonly<Parameters<typeof catalogueSettingsFingerprint>[0]>): boolean {
  return recorded?.fetchedAt === cache.fetchedAt && recorded.settings === catalogueSettingsFingerprint(provider);
}

/** Whether `error` says a catalogue read met a redirect: a `CatalogueFetchError` in the thread that made the read, or the `DoorWorkerFailedError` the door raises for a read made in a worker, which carries the same fact beside its text because nothing else of the worker's error crosses the thread. */
export function isRedirectedFailure(error: unknown): boolean {
  return error instanceof Error && "redirected" in error && error.redirected === true;
}

/** Raised when no candidate URL returned a catalogue; the message names each URL (as `displayBaseUrl` shows it, without userinfo or query) and what it answered, never the credential. */
export class CatalogueFetchError extends Error {
  /** Whether a candidate URL answered with a redirect, which the read never follows: a fact about the failure carried beside its message, so nothing decides it by searching a message that may have been cut. */
  readonly redirected: boolean;
  /** Whether every candidate URL that failed refused the provider's credential (a 401 or a 403): the failure is then the credential's and ends when the credential is fixed. A candidate that failed another way (a timeout, a server error) makes it the server's failure, which ends with the server's own recovery. */
  readonly unauthorised: boolean;

  constructor(message: string, flags: Readonly<{ readonly redirected?: boolean; readonly unauthorised?: boolean }> = {}) {
    super(message);
    this.name = "CatalogueFetchError";
    this.redirected = flags.redirected === true;
    this.unauthorised = flags.unauthorised === true;
  }
}

/**
 * Asks each candidate URL for the catalogue in order and returns the first that lists at least one model, recording its URL as `displayBaseUrl` shows it. Throws `CatalogueFetchError` naming every URL's outcome when none does, so a misconfigured provider says which endpoints it tried.
 */
export async function fetchCatalogue(params: Readonly<FetchCatalogueParams>): Promise<CatalogueCache> {
  const headers = catalogueHeaders(params.credential);
  const outcomes: string[] = [];
  let redirected = false;
  let failedCandidates = 0;
  let refusedCandidates = 0;
  for (const url of catalogueUrls(params.provider, params.catalogue)) {
    try {
      const response = await params.fetch(url, headers, CATALOGUE_REQUEST_TIMEOUT_MS);
      const succeeded = response.status >= HTTP_OK && response.status < HTTP_MULTIPLE_CHOICES;
      const models = succeeded ? parseCatalogueBody(response.body) : [];
      if (models.length > 0) {
        return { fetchedAt: params.now(), url: displayBaseUrl(url), models: [...models] };
      }
      // A redirect is named as one: the read never follows it, since its request carries the provider's credential and a redirect target is another origin. Its `Location` is not repeated, because it can carry a credential of its own.
      const redirect = REDIRECT_STATUSES.has(response.status);
      redirected ||= redirect;
      failedCandidates += 1;
      refusedCandidates += response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN ? 1 : 0;
      // The advice names an address to set, so it is given only for an answer that carried a `Location`.
      const refused = redirect ? `status ${String(response.status)}, ${CATALOGUE_REDIRECT_NOTE}${response.located === false ? " (with no Location)" : ": set the provider's base URL (or its catalogue.url) to the address it redirects to"}` : `status ${String(response.status)}`;
      outcomes.push(`${displayBaseUrl(url)}: ${succeeded ? "no models listed" : refused}`);
    } catch (error) {
      failedCandidates += 1;
      outcomes.push(`${displayBaseUrl(url)}: ${redactUrlIn(error instanceof Error ? error.message : String(error), url)}`);
    }
  }
  throw new CatalogueFetchError(`no catalogue from ${outcomes.join("; ")}`, { redirected, unauthorised: refusedCandidates === failedCandidates });
}

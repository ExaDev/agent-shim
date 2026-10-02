import { describe, expect, it, vi } from "vitest";

import { fakeCredentials, fakeFs, paths } from "../test-helpers";
import { ANTHROPIC_PROVIDER } from "./middleware";
import type { QuotaHttpGet } from "./providerQuota";
import { createProviderLookup, createQuotaRefresher, QUOTA_REQUEST_TIMEOUT_MS, withQuotaRefresh, type QuotaProviderLookup, type QuotaRefresherDeps, type QuotaRefresher } from "./quotaRefresh";
import type { ProviderQuota, UsageRecord } from "./schema";

const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const IDENTITY = "work";
const OTHER_IDENTITY = "personal";
const PROVIDER = "glm";
const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";
const OTHER_BASE_URL = "https://api.synthetic.new/anthropic";
const API_KEY = "REDACTED";
const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;
const PERCENT = 100;
const MS_PER_HOUR = 3_600_000;
const FIVE = 5;
const FIVE_HOURS_MS = FIVE * MS_PER_HOUR;
const FRESHNESS_MS = FIVE_HOURS_MS / PERCENT;
const TOKENS_PERCENTAGE = 13;
const HOURS_UNIT = 3;
const ONE_MS = 1;
const THIRD_CALL = 3;

const zaiText = JSON.stringify({
  success: true,
  data: { level: "max", limits: [{ type: "TOKENS_LIMIT", unit: HOURS_UNIT, number: FIVE, percentage: TOKENS_PERCENTAGE, nextResetTime: NOW_MS + FIVE_HOURS_MS }] },
});

function storedQuota(observedAtMs: number): ProviderQuota {
  return { observedAt: new Date(observedAtMs).toISOString(), source: "z.ai", windows: [{ measures: "tokens", periodMs: FIVE_HOURS_MS, utilization: TOKENS_PERCENTAGE / PERCENT }] };
}

interface Harness {
  readonly deps: QuotaRefresherDeps;
  readonly http: ReturnType<typeof vi.fn<QuotaHttpGet>>;
  readonly lookup: ReturnType<typeof vi.fn<QuotaRefresherDeps["lookup"]>>;
  readonly apiKey: ReturnType<typeof vi.fn<QuotaProviderLookup["apiKey"]>>;
  readonly readQuota: ReturnType<typeof vi.fn<QuotaRefresherDeps["readQuota"]>>;
  readonly record: ReturnType<typeof vi.fn<QuotaRefresherDeps["record"]>>;
  readonly log: ReturnType<typeof vi.fn<QuotaRefresherDeps["log"]>>;
  readonly clock: { nowMs: number };
  readonly refresher: QuotaRefresher;
}

function harness(overrides: Partial<QuotaRefresherDeps> = {}): Harness {
  const clock = { nowMs: NOW_MS };
  const apiKey = vi.fn<QuotaProviderLookup["apiKey"]>().mockReturnValue(API_KEY);
  const lookup = vi.fn<QuotaRefresherDeps["lookup"]>().mockReturnValue({ baseUrl: ZAI_BASE_URL, apiKey });
  const http = vi.fn<QuotaHttpGet>().mockResolvedValue({ status: HTTP_OK, text: zaiText });
  const readQuota = vi.fn<QuotaRefresherDeps["readQuota"]>().mockReturnValue(undefined);
  const record = vi.fn<QuotaRefresherDeps["record"]>().mockReturnValue(true);
  const log = vi.fn<QuotaRefresherDeps["log"]>();
  const deps: QuotaRefresherDeps = { lookup, http, readQuota, record, now: () => clock.nowMs, log, ...overrides };
  return { deps, http, lookup, apiKey, readQuota, record, log, clock, refresher: createQuotaRefresher(deps) };
}

describe("createQuotaRefresher", () => {
  it("fetches and records the quota when nothing is stored", async () => {
    const { refresher, http, record } = harness();

    const outcome = await refresher.refresh(IDENTITY, PROVIDER);

    expect(outcome.status).toBe("refreshed");
    expect(http).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    const recorded = record.mock.calls[0]?.[2];
    expect(record).toHaveBeenCalledWith(IDENTITY, PROVIDER, expect.objectContaining({ source: "z.ai", level: "max", observedAt: new Date(NOW_MS).toISOString() }));
    expect(outcome).toEqual({ status: "refreshed", quota: recorded });
  });

  it("authenticates the request with the resolved key and an unaborted signal", async () => {
    const { refresher, http } = harness();

    await refresher.refresh(IDENTITY, PROVIDER);

    const [url, headers, signal] = http.mock.calls[0] ?? [];
    expect(url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(headers).toMatchObject({ authorization: API_KEY });
    expect(signal?.aborted).toBe(false);
  });

  it("returns fresh without fetching while the stored quota is younger than its freshness, and fetches once it is older", async () => {
    const { refresher, http, readQuota, clock } = harness();
    readQuota.mockReturnValue(storedQuota(NOW_MS));

    clock.nowMs = NOW_MS + FRESHNESS_MS - ONE_MS;
    expect(await refresher.refresh(IDENTITY, PROVIDER)).toEqual({ status: "fresh" });
    expect(http).not.toHaveBeenCalled();

    clock.nowMs = NOW_MS + FRESHNESS_MS;
    expect((await refresher.refresh(IDENTITY, PROVIDER)).status).toBe("refreshed");
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("reads the stored quota for the identity and provider it was asked about", async () => {
    const { refresher, readQuota } = harness();

    await refresher.refresh(IDENTITY, PROVIDER);

    expect(readQuota).toHaveBeenCalledWith(IDENTITY, PROVIDER);
  });

  it("fetches regardless of freshness when forced", async () => {
    const { refresher, http, readQuota } = harness();
    readQuota.mockReturnValue(storedQuota(NOW_MS));

    const outcome = await refresher.refresh(IDENTITY, PROVIDER, { force: true });

    expect(outcome.status).toBe("refreshed");
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("makes one call for concurrent refreshes of the same identity and provider and gives both the same outcome", async () => {
    let release: (value: Readonly<{ status: number; text: string }>) => void = () => undefined;
    const pending = new Promise<{ status: number; text: string }>((resolve) => {
      release = resolve;
    });
    const { refresher, http, record } = harness();
    http.mockReturnValue(pending);

    const first = refresher.refresh(IDENTITY, PROVIDER);
    const second = refresher.refresh(IDENTITY, PROVIDER, { force: true });
    release({ status: HTTP_OK, text: zaiText });
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(http).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(firstOutcome.status).toBe("refreshed");
    expect(secondOutcome).toBe(firstOutcome);
  });

  it("fetches separately for a different identity", async () => {
    const { refresher, http } = harness();

    await Promise.all([refresher.refresh(IDENTITY, PROVIDER), refresher.refresh(OTHER_IDENTITY, PROVIDER)]);

    expect(http).toHaveBeenCalledTimes(2);
  });

  it("starts a new fetch once the previous one has finished", async () => {
    const { refresher, http } = harness();

    await refresher.refresh(IDENTITY, PROVIDER);
    await refresher.refresh(IDENTITY, PROVIDER);

    expect(http).toHaveBeenCalledTimes(2);
  });

  describe("after a failed fetch", () => {
    function failingHarness(): Harness {
      const built = harness();
      built.http.mockResolvedValueOnce({ status: HTTP_SERVER_ERROR, text: "" });
      return built;
    }

    it("returns fresh without fetching for an automatic refresh within the request timeout, and fetches again after it", async () => {
      const { refresher, http, clock } = failingHarness();
      expect((await refresher.refresh(IDENTITY, PROVIDER)).status).toBe("failed");

      clock.nowMs = NOW_MS + QUOTA_REQUEST_TIMEOUT_MS - ONE_MS;
      expect(await refresher.refresh(IDENTITY, PROVIDER)).toEqual({ status: "fresh" });
      expect(http).toHaveBeenCalledTimes(1);

      clock.nowMs = NOW_MS + QUOTA_REQUEST_TIMEOUT_MS;
      expect((await refresher.refresh(IDENTITY, PROVIDER)).status).toBe("refreshed");
      expect(http).toHaveBeenCalledTimes(2);
    });

    it("ignores the backoff for a forced refresh", async () => {
      const { refresher, http } = failingHarness();
      await refresher.refresh(IDENTITY, PROVIDER);

      const outcome = await refresher.refresh(IDENTITY, PROVIDER, { force: true });

      expect(outcome.status).toBe("refreshed");
      expect(http).toHaveBeenCalledTimes(2);
    });

    it("keeps the backoff per identity", async () => {
      const { refresher, http } = failingHarness();
      await refresher.refresh(IDENTITY, PROVIDER);

      const outcome = await refresher.refresh(OTHER_IDENTITY, PROVIDER);

      expect(outcome.status).toBe("refreshed");
      expect(http).toHaveBeenCalledTimes(2);
    });

    it("clears the backoff once a fetch succeeds", async () => {
      const { refresher, http, clock } = failingHarness();
      await refresher.refresh(IDENTITY, PROVIDER);
      await refresher.refresh(IDENTITY, PROVIDER, { force: true });

      clock.nowMs = NOW_MS + ONE_MS;
      const outcome = await refresher.refresh(IDENTITY, PROVIDER);

      expect(outcome.status).toBe("refreshed");
      expect(http).toHaveBeenCalledTimes(THIRD_CALL);
    });
  });

  describe("when the provider has no readable endpoint", () => {
    it("is unsupported without a lookup result, and never calls http or apiKey", async () => {
      const { refresher, http, apiKey, lookup } = harness();
      lookup.mockReturnValue(undefined);

      expect(await refresher.refresh(IDENTITY, PROVIDER)).toEqual({ status: "unsupported" });
      expect(http).not.toHaveBeenCalled();
      expect(apiKey).not.toHaveBeenCalled();
    });

    it("is unsupported for a base URL no adapter matches, and never calls http or apiKey", async () => {
      const { refresher, http, apiKey, lookup } = harness();
      lookup.mockReturnValue({ baseUrl: OTHER_BASE_URL, apiKey });

      expect(await refresher.refresh(IDENTITY, PROVIDER, { force: true })).toEqual({ status: "unsupported" });
      expect(http).not.toHaveBeenCalled();
      expect(apiKey).not.toHaveBeenCalled();
    });
  });

  it("resolves the key only when a fetch is due", async () => {
    const { refresher, apiKey, readQuota } = harness();
    readQuota.mockReturnValue(storedQuota(NOW_MS));

    await refresher.refresh(IDENTITY, PROVIDER);
    expect(apiKey).not.toHaveBeenCalled();

    await refresher.refresh(IDENTITY, PROVIDER, { force: true });
    expect(apiKey).toHaveBeenCalledTimes(1);
  });

  it("reports no-usage when the identity has no state to attach the quota to", async () => {
    const { refresher, record } = harness();
    record.mockReturnValue(false);

    expect(await refresher.refresh(IDENTITY, PROVIDER)).toEqual({ status: "no-usage" });
  });

  describe("a dependency that throws", () => {
    const FAILURE = "dependency exploded";

    it.each([
      ["lookup", (built: Harness) => built.lookup.mockImplementation(() => { throw new Error(FAILURE); })],
      ["apiKey", (built: Harness) => built.apiKey.mockImplementation(() => { throw new Error(FAILURE); })],
      ["http", (built: Harness) => built.http.mockRejectedValue(new Error(FAILURE))],
      ["readQuota", (built: Harness) => built.readQuota.mockImplementation(() => { throw new Error(FAILURE); })],
      ["record", (built: Harness) => built.record.mockImplementation(() => { throw new Error(FAILURE); })],
    ])("gives a failed outcome with the message and a log line from %s, never a rejection, and never the key", async (_name, breakIt) => {
      const built = harness();
      breakIt(built);

      const outcome = await built.refresher.refresh(IDENTITY, PROVIDER);

      expect(outcome).toEqual({ status: "failed", message: FAILURE });
      expect(built.log).toHaveBeenCalledTimes(1);
      const line = built.log.mock.calls[0]?.[0] ?? "";
      expect(line).toContain(FAILURE);
      expect(line).toContain(IDENTITY);
      expect(line).toContain(PROVIDER);
      expect(JSON.stringify(outcome) + line).not.toContain(API_KEY);
    });

    it("gives a failed outcome from the adapter when the endpoint refuses, with a message free of the key", async () => {
      const built = harness();
      built.http.mockResolvedValue({ status: HTTP_SERVER_ERROR, text: `refused ${API_KEY}` });

      const outcome = await built.refresher.refresh(IDENTITY, PROVIDER);

      expect(outcome.status).toBe("failed");
      expect(JSON.stringify(outcome)).not.toContain(API_KEY);
      expect(built.log.mock.calls[0]?.[0]).not.toContain(API_KEY);
    });

    it("describes a thrown non-error by its string form", async () => {
      const built = harness();
      built.http.mockRejectedValue("plain string failure");

      expect(await built.refresher.refresh(IDENTITY, PROVIDER)).toEqual({ status: "failed", message: "plain string failure" });
    });
  });
});

describe("createProviderLookup", () => {
  const ENV_VARIABLE = "Z_API_TOKEN";
  const ENV_TOKEN = "env-token-value";

  function lookupOver(files: Readonly<Record<string, unknown>>, env: Readonly<Record<string, string | undefined>> = { [ENV_VARIABLE]: ENV_TOKEN }) {
    return createProviderLookup({ fs: fakeFs(files), providersDir: paths.providersDir, env, credentials: fakeCredentials() });
  }

  const httpProvider = { displayName: "GLM", baseUrl: ZAI_BASE_URL, credential: { sources: [{ env: ENV_VARIABLE }] } };

  it("resolves an http provider's base URL and, on demand, its env token", () => {
    const found = lookupOver({ [`${paths.providersDir}/${PROVIDER}.json`]: httpProvider })(PROVIDER);

    expect(found?.baseUrl).toBe(ZAI_BASE_URL);
    expect(found?.apiKey()).toBe(ENV_TOKEN);
  });

  it("does not resolve the credential until apiKey is called", () => {
    const credentials = fakeCredentials();
    const lookup = createProviderLookup({ fs: fakeFs({ [`${paths.providersDir}/${PROVIDER}.json`]: { ...httpProvider, credential: { sources: [{ command: ["op", "read", "ref"] }] } } }), providersDir: paths.providersDir, env: {}, credentials });

    lookup(PROVIDER);

    expect(credentials.runCommand).not.toHaveBeenCalled();
  });

  it("gives undefined for a provider with no file", () => {
    expect(lookupOver({})("missing")).toBeUndefined();
  });

  it("gives undefined for a codex provider", () => {
    const codex = { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "codex" }] } };

    expect(lookupOver({ [`${paths.providersDir}/codex.json`]: codex })("codex")).toBeUndefined();
  });

  it("makes apiKey throw the resolver's message when no credential resolves, naming the provider and never a token", () => {
    const found = lookupOver({ [`${paths.providersDir}/${PROVIDER}.json`]: httpProvider }, {})(PROVIDER);

    expect(() => found?.apiKey()).toThrow(new RegExp(`provider ${PROVIDER} has no usable credential.*${ENV_VARIABLE}`));
  });
});

describe("withQuotaRefresh", () => {
  const anonymousRecord: UsageRecord = {
    schemaVersion: 1,
    at: new Date(NOW_MS).toISOString(),
    provider: PROVIDER,
    route: "frontdoor",
    method: "POST",
    endpoint: "/v1/messages",
    status: HTTP_OK,
    latencyMs: 0,
    durationMs: 0,
    outcome: "completed",
  };
  const usageRecord: UsageRecord = { ...anonymousRecord, identity: IDENTITY };

  function wrapped() {
    const record = vi.fn<(record: UsageRecord) => void>();
    const refresh = vi.fn<QuotaRefresher["refresh"]>().mockResolvedValue({ status: "fresh" });
    return { record, refresh, wrap: withQuotaRefresh(record, { refresh }) };
  }

  it("records first, then refreshes the provider's quota for the record's identity", () => {
    const { record, refresh, wrap } = wrapped();

    wrap(usageRecord);

    expect(record).toHaveBeenCalledWith(usageRecord);
    expect(refresh).toHaveBeenCalledWith(IDENTITY, PROVIDER);
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0] ?? 0);
  });

  it("records but does not refresh for the anthropic provider", () => {
    const { record, refresh, wrap } = wrapped();

    wrap({ ...usageRecord, provider: ANTHROPIC_PROVIDER });

    expect(record).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("records but does not refresh for a record without an identity", () => {
    const { record, refresh, wrap } = wrapped();

    wrap(anonymousRecord);

    expect(record).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});

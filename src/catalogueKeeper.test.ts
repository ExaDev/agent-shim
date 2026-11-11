import { describe, expect, it, vi } from "vitest";

import { createCatalogueKeeper, type CatalogueKeeperDeps } from "./catalogueKeeper";
import type { HttpProvider, Provider } from "./config/schema";
import { errorWithCode } from "./test-helpers";
import { CATALOGUE_MAX_AGE_MS, CATALOGUE_RETRY_MS, CatalogueFetchError, catalogueSettingsFingerprint, catalogueSettingsText, parseCatalogueCache } from "./providerCatalogue";

const CREDENTIAL = { sources: [{ env: "TOKEN" }] };
const withCatalogue: HttpProvider = { displayName: "A", baseUrl: "https://a.example", credential: CREDENTIAL, catalogue: { tier: "sonnet" } };
/** What a refresh of provider `a` depends on, as the keeper publishes it with a failure. */
const HTTP_SETTINGS = catalogueSettingsFingerprint(withCatalogue);
const withoutCatalogue: Provider = { displayName: "B", baseUrl: "https://b.example", credential: CREDENTIAL };
const codex: Provider = { kind: "codex", displayName: "C", credential: CREDENTIAL };
const START_MS = CATALOGUE_MAX_AGE_MS * 2;
const cacheAt = (fetchedAt: number): string => JSON.stringify({ fetchedAt, url: "https://a.example/v1/models", models: [{ id: "m" }] });
/** The digest file of the catalogue `cache` holds, fetched under `HTTP_SETTINGS` (the provider `a` of these tests as it stands), or none when there is no catalogue. */
const ownSettings = (cache: string | undefined): string | undefined => {
  const parsed = parseCatalogueCache(cache);
  return parsed === undefined ? undefined : catalogueSettingsText(HTTP_SETTINGS, parsed.fetchedAt);
};

/** A keeper over a clock the test moves, whose refresh the test settles. */
function setup(overrides: Partial<CatalogueKeeperDeps> = {}) {
  const clock = { now: START_MS };
  const refresh = vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined);
  const log = vi.fn<(message: string) => void>();
  const keeper = createCatalogueKeeper({
    supervisorPid: 2,
    providers: () => [["a", withCatalogue], ["b", withoutCatalogue]],
    readCache: () => undefined,
    readSettings: (name) => ownSettings((overrides.readCache ?? (() => undefined))(name, withCatalogue)),
    credentialFingerprint: () => undefined,
    refresh,
    nowMs: () => clock.now,
    log,
    ...overrides,
  });
  return { keeper, clock, refresh, log };
}

/** Lets the keeper's promise chains settle. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** How far the wall clock steps back in the tests that step it: twice the retry period, so waiting out the step as well would be visible. */
const STEP_BACK_MS = 2 * CATALOGUE_RETRY_MS;
/** How many ticks fall while the clock is behind the failure: several, so a refresh on every tick would show. */
const TICKS_DURING_STEP = 5;

describe("createCatalogueKeeper", () => {
  describe("a provider whose stored files cannot be read", () => {
    const SECRET_PATH = "/home/someone/.agent-shim/catalogues/bad.json";
    const readFailure = (): never => {
      throw errorWithCode(`EACCES: permission denied, open '${SECRET_PATH}'`, "EACCES");
    };
    /** Each way a provider's stored files can fail to read, with the providers it leaves due for a refresh: `good` has no catalogue where the failing reader is the catalogue's, and a current one (so is not due) where it is the digest's. */
    const BROKEN_READERS: readonly (readonly [string, Partial<CatalogueKeeperDeps>, readonly string[]])[] = [
      ["catalogue", { readCache: (name) => (name === "bad" ? readFailure() : undefined) }, ["good"]],
      ["settings digest", { readCache: () => cacheAt(START_MS), readSettings: (name) => (name === "bad" ? readFailure() : catalogueSettingsText(HTTP_SETTINGS, START_MS)) }, []],
    ];

    it.each(BROKEN_READERS)("is recorded with the fault's code and no path when its %s throws, while the others are still refreshed", (_label, readers, due) => {
      const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
      const { keeper, refresh, log } = setup({ providers: () => [["bad", withCatalogue], ["good", withCatalogue]], ...readers, publishStatus });
      expect(() => {
        keeper.tick();
      }).not.toThrow();
      expect(publishStatus).toHaveBeenCalledWith("bad", "failed", undefined, "stored catalogue cannot be read (EACCES)");
      expect(log).toHaveBeenCalledWith("catalogue files of provider bad cannot be read (EACCES)");
      expect(JSON.stringify([...log.mock.calls, ...publishStatus.mock.calls])).not.toContain("someone");
      expect(keeper.status("bad")).toBe("failed");
      expect(refresh.mock.calls.map(([name]) => name)).toEqual(due);
    });

    it("is not reported ready while a refresh of it is still running when its files are readable again", () => {
      let broken = false;
      const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
      const { keeper } = setup({ publishStatus, refresh: async () => new Promise<void>(() => undefined), readCache: () => (broken ? readFailure() : undefined) });
      keeper.tick();
      broken = true;
      keeper.tick();
      broken = false;
      keeper.tick();
      expect(publishStatus.mock.calls.map(([name, status]) => `${name} ${status}`)).toEqual(["a running", "a failed"]);
    });

    it("is ready again under the login its catalogue is bound to, when it is a Codex provider's", () => {
      let broken = false;
      const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
      const bound = JSON.stringify({ fetchedAt: START_MS, url: "https://c.example/models", models: [{ id: "m" }], credentialFingerprint: "account-1", supervisorPid: 2 });
      const { keeper } = setup({ providers: () => [["c", codex]], publishStatus, credentialFingerprint: () => "account-1", readCache: () => (broken ? readFailure() : bound) });
      broken = true;
      keeper.tick();
      broken = false;
      keeper.tick();
      expect(publishStatus.mock.calls).toEqual([["c", "failed", undefined, "stored catalogue cannot be read (EACCES)"], ["c", "ready", "account-1"]]);
    });

    it("is reported failed again, with the failure it recorded, when its files are readable again inside the backoff of a refresh that failed and there is no catalogue", async () => {
      let broken = false;
      const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
      const { keeper, refresh } = setup({ publishStatus, readCache: () => (broken ? readFailure() : undefined) });
      refresh.mockRejectedValue(new Error("server down"));
      keeper.tick();
      await settle();
      broken = true;
      keeper.tick();
      broken = false;
      keeper.tick();
      expect(publishStatus.mock.calls.map(([name, status, , reason]) => `${name} ${status}${reason === undefined ? "" : `:${reason}`}`)).toEqual(["a running", "a failed:server down", "a failed:stored catalogue cannot be read (EACCES)", "a failed:server down"]);
      expect(keeper.status("a")).toBe("failed");
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("keeps the settings and the redirect of the failure it publishes again", async () => {
      let broken = false;
      const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
      const { keeper, refresh } = setup({ publishStatus, readCache: () => (broken ? readFailure() : undefined) });
      refresh.mockRejectedValue(new CatalogueFetchError("no catalogue: status 308", { redirected: true, unauthorised: false }));
      keeper.tick();
      await settle();
      broken = true;
      keeper.tick();
      broken = false;
      keeper.tick();
      const failures = publishStatus.mock.calls.filter(([, status, , reason]) => status === "failed" && reason?.includes("308") === true);
      expect(failures).toHaveLength(2);
      expect(failures[1]).toEqual(failures[0]);
      expect(failures[0]?.[4]).toEqual({ redirected: true, settings: HTTP_SETTINGS });
    });

    it("is ready, and its failure forgotten, when its files are readable again and its catalogue is current", async () => {
      let broken = false;
      const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
      const stored: { cache: string | undefined } = { cache: undefined };
      const { keeper, refresh } = setup({ publishStatus, readCache: () => (broken ? readFailure() : stored.cache) });
      refresh.mockRejectedValue(new Error("server down"));
      keeper.tick();
      await settle();
      broken = true;
      keeper.tick();
      broken = false;
      stored.cache = cacheAt(START_MS);
      keeper.tick();
      expect(publishStatus.mock.calls.at(-1)?.slice(0, 2)).toEqual(["a", "ready"]);
      expect(keeper.status("a")).toBeUndefined();
    });

    it("forgets a failure recorded under settings the provider no longer has once its stored catalogue is current for the settings it has", async () => {
      const edited: HttpProvider = { ...withCatalogue, baseUrl: "https://moved.example" };
      const stored: { provider: HttpProvider; cache: string | undefined; digest: string | undefined } = { provider: withCatalogue, cache: undefined, digest: undefined };
      const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
      const { keeper, refresh } = setup({ publishStatus, providers: () => [["a", stored.provider]], readCache: () => stored.cache, readSettings: () => stored.digest });
      refresh.mockRejectedValue(new Error("server down"));
      keeper.tick();
      await settle();
      expect(keeper.status("a")).toBe("failed");
      stored.provider = edited;
      stored.cache = cacheAt(START_MS);
      stored.digest = catalogueSettingsText(catalogueSettingsFingerprint(edited), START_MS);
      keeper.tick();
      expect(publishStatus.mock.calls.at(-1)?.slice(0, 2)).toEqual(["a", "ready"]);
      expect(keeper.status("a")).toBeUndefined();
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    /** A catalogue that cannot be used as it is leaves a failed refresh recorded while its backoff holds: it is never reported ready, and the failure stays. */
    const NOT_USABLE: readonly (readonly [string, () => Partial<CatalogueKeeperDeps>])[] = [
      ["is stale", () => ({ readCache: () => cacheAt(START_MS - CATALOGUE_MAX_AGE_MS) })],
      ["was fetched under other settings than the provider has", () => ({ readCache: () => cacheAt(START_MS), readSettings: () => catalogueSettingsText("settings-of-another-server", START_MS) })],
      ["has no digest", () => ({ readCache: () => cacheAt(START_MS), readSettings: () => undefined })],
    ];

    it.each(NOT_USABLE)("is not reported ready, nor its failure forgotten, while a failed refresh is waited out and its catalogue %s", async (_label, files) => {
      const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
      const { keeper, refresh } = setup({ publishStatus, ...files() });
      refresh.mockRejectedValue(new Error("server down"));
      keeper.tick();
      await settle();
      keeper.tick();
      expect(publishStatus.mock.calls.map(([name, status]) => `${name} ${status}`)).toEqual(["a running", "a failed"]);
      expect(keeper.status("a")).toBe("failed");
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("is not reported ready while a failed refresh is waited out and its catalogue is bound to another account than the one it has now", async () => {
      const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
      const bound = JSON.stringify({ fetchedAt: START_MS, url: "https://c.example/models", models: [{ id: "m" }], credentialFingerprint: "account-1", supervisorPid: 2 });
      const { keeper, refresh } = setup({ providers: () => [["c", codex]], publishStatus, credentialFingerprint: () => "account-2", readCache: () => bound });
      refresh.mockRejectedValue(new Error("server down"));
      keeper.tick();
      await settle();
      keeper.tick();
      expect(publishStatus.mock.calls.map(([name, status]) => `${name} ${status}`)).toEqual(["c running", "c failed"]);
      expect(keeper.status("c")).toBe("failed");
    });

    it("is refreshed again once its files can be read, and no longer reported as failed", async () => {
      let broken = true;
      const { keeper, refresh } = setup({ readCache: () => (broken ? readFailure() : undefined) });
      keeper.tick();
      expect(keeper.status("a")).toBe("failed");
      broken = false;
      keeper.tick();
      await settle();
      expect(refresh.mock.calls.map(([name]) => name)).toEqual(["a"]);
      expect(keeper.status("a")).toBeUndefined();
    });
  });

  it("reports a refresh while it is running", () => {
    const { keeper } = setup({ refresh: async () => new Promise<void>(() => undefined) });
    keeper.tick();
    expect("status" in keeper && typeof keeper.status === "function" ? keeper.status("a") : undefined).toBe("running");
  });

  it("publishes when a refresh starts", () => {
    const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
    const { keeper } = setup({ refresh: async () => new Promise<void>(() => undefined), publishStatus });
    keeper.tick();
    expect(publishStatus).toHaveBeenCalledWith("a", "running");
  });

  it("publishes the account fingerprint with a Codex refresh", () => {
    const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
    const { keeper } = setup({ publishStatus, providers: () => [["c", codex]], credentialFingerprint: () => "account", refresh: async () => new Promise<void>(() => undefined) });
    keeper.tick();
    expect(publishStatus).toHaveBeenCalledWith("c", "running", "account");
  });

  it("publishes the account fingerprint with a failed Codex refresh", async () => {
    const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
    const { keeper } = setup({ publishStatus, providers: () => [["c", codex]], credentialFingerprint: () => "account", refresh: async () => { await Promise.reject(new Error("unreachable")); } });
    keeper.tick();
    await settle();
    expect(publishStatus).toHaveBeenCalledWith("c", "failed", "account", "unreachable", {});
  });

  it("publishes when a refresh succeeds", async () => {
    const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
    const { keeper } = setup({ publishStatus });
    keeper.tick();
    await settle();
    expect(publishStatus).toHaveBeenCalledWith("a", "ready");
  });

  it("publishes when a refresh fails", async () => {
    const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
    const { keeper } = setup({ publishStatus, refresh: async () => { await Promise.reject(new Error("unreachable")); } });
    keeper.tick();
    await settle();
    expect(publishStatus).toHaveBeenCalledWith("a", "failed", undefined, "unreachable", { settings: HTTP_SETTINGS });
  });

  it("publishes an unreadable credential as a failure", () => {
    const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
    const { keeper } = setup({ publishStatus, providers: () => [["c", codex]], credentialFingerprint: () => { throw new Error("invalid login"); } });
    keeper.tick();
    expect(publishStatus).toHaveBeenCalledWith("c", "failed");
  });

  it("reports a failed refresh", async () => {
    const { keeper } = setup({ refresh: async () => { await Promise.reject(new Error("unreachable")); } });
    keeper.tick();
    await settle();
    expect(keeper.status("a")).toBe("failed");
  });

  it("reports an unreadable credential as a failed refresh", () => {
    const { keeper } = setup({ providers: () => [["c", codex]], credentialFingerprint: () => { throw new Error("invalid login"); } });
    keeper.tick();
    expect(keeper.status("c")).toBe("failed");
  });

  it("retries when an unreadable credential becomes readable without a login", async () => {
    let broken = true;
    const { keeper, refresh } = setup({ providers: () => [["c", codex]], credentialFingerprint: () => { if (broken) throw new Error("invalid login"); return undefined; } });
    keeper.tick();
    broken = false;
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledWith("c");
  });
  it("refreshes only a provider that opted into a catalogue, and only one with no cache", async () => {
    const { keeper, refresh } = setup();

    keeper.tick();
    await settle();

    expect(refresh.mock.calls).toEqual([["a"]]);
  });

  it("refreshes a Codex provider's account catalogue", async () => {
    const { keeper, refresh } = setup({ providers: () => [["c", codex]] });
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledWith("c");
  });

  it("reads the cache using the current provider definition", () => {
    const readCache = vi.fn(() => undefined);
    const { keeper } = setup({ providers: () => [["c", codex]], readCache });
    keeper.tick();
    expect(readCache).toHaveBeenCalledWith("c", codex);
  });

  it("refreshes a fresh Codex cache when the selected account changes", async () => {
    const overrides = { providers: () => [["c", codex] as const], readCache: () => JSON.stringify({ fetchedAt: START_MS, url: "https://example.test", models: [{ id: "old" }], credentialFingerprint: "old-account" }), credentialFingerprint: () => "new-account" };
    const { keeper, refresh } = setup(overrides);
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledWith("c");
  });

  it("refreshes a fresh Codex cache written by a superseded supervisor", async () => {
    const overrides = { providers: () => [["c", codex] as const], readCache: () => JSON.stringify({ fetchedAt: START_MS, url: "https://example.test", models: [{ id: "old" }], credentialFingerprint: "account", supervisorPid: 1 }), credentialFingerprint: () => "account", supervisorPid: 2 };
    const { keeper, refresh } = setup(overrides);
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledWith("c");
  });

  it("leaves a fresh Codex cache of the current account and supervisor alone though it records no http settings, which only an http provider's list does", async () => {
    const overrides = { providers: () => [["c", codex] as const], readCache: () => JSON.stringify({ fetchedAt: START_MS, url: "https://example.test", models: [{ id: "m" }], credentialFingerprint: "account", supervisorPid: 2 }), credentialFingerprint: () => "account", supervisorPid: 2 };
    const { keeper, refresh } = setup(overrides);
    keeper.tick();
    await settle();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not treat an unbound Codex cache as valid when the login is missing", async () => {
    const overrides = { providers: () => [["c", codex] as const], readCache: () => cacheAt(START_MS), credentialFingerprint: () => undefined };
    const { keeper, refresh } = setup(overrides);
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledWith("c");
  });

  it("checks the credential belonging to the current provider definition", () => {
    const fingerprint = vi.fn(() => "account");
    const overrides = { providers: () => [["c", codex] as const], credentialFingerprint: fingerprint };
    const { keeper } = setup(overrides);
    keeper.tick();
    expect(fingerprint).toHaveBeenCalledWith(codex);
  });

  it("refuses to manage a Codex provider without an account fingerprint reader", () => {
    const { keeper } = setup({ providers: () => [["c", codex]], credentialFingerprint: undefined });
    expect(() => { keeper.tick(); }).toThrow("Codex catalogue needs an account fingerprint reader");
  });

  it("reports an unreadable Codex login without stopping other catalogue refreshes", async () => {
    const overrides = { providers: () => [["c", codex] as const, ["a", withCatalogue] as const], credentialFingerprint: (provider: Provider) => { if (provider.kind === "codex") throw new Error("invalid login"); return undefined; } };
    const { keeper, refresh, log } = setup(overrides);
    expect(() => { keeper.tick(); }).not.toThrow();
    await settle();
    expect(log).toHaveBeenCalledWith("catalogue credential for provider c failed: invalid login");
    expect(refresh).toHaveBeenCalledWith("a");
  });

  it("retries immediately for a different account after the previous account failed", async () => {
    let account = "first";
    const refresh = vi.fn<(name: string) => Promise<void>>().mockRejectedValueOnce(new Error("refused")).mockResolvedValue(undefined);
    const { keeper } = setup({ providers: () => [["c", codex]], credentialFingerprint: () => account, refresh });
    keeper.tick();
    await settle();
    account = "second";
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("leaves a fresh cache alone and refreshes a stale one", async () => {
    const { keeper, clock, refresh } = setup({ readCache: () => cacheAt(START_MS - CATALOGUE_MAX_AGE_MS + 1) });

    keeper.tick();
    await settle();
    expect(refresh).not.toHaveBeenCalled();

    clock.now += 1;
    keeper.tick();
    await settle();
    expect(refresh.mock.calls).toEqual([["a"]]);
  });

  it("treats a cache it cannot read as missing", async () => {
    const { keeper, refresh } = setup({ readCache: () => "not a cache" });

    keeper.tick();
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not start a second refresh while one runs, and starts again once it has finished", async () => {
    let finish: () => void = () => undefined;
    const refresh = vi.fn<(name: string) => Promise<void>>(
      async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    const { keeper } = setup({ refresh });

    keeper.tick();
    keeper.tick();
    expect(refresh).toHaveBeenCalledTimes(1);

    finish();
    await settle();
    keeper.tick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("publishes a failure as a redirect when the refresh error says so, and as an ordinary one otherwise", async () => {
    const publishStatus = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
    const { keeper } = setup({ publishStatus, refresh: async () => { await Promise.reject(new CatalogueFetchError("no catalogue from x: status 308", { redirected: true })); } });
    keeper.tick();
    await settle();
    expect(publishStatus).toHaveBeenCalledWith("a", "failed", undefined, "no catalogue from x: status 308", { redirected: true, settings: HTTP_SETTINGS });
    const plain = vi.fn<NonNullable<CatalogueKeeperDeps["publishStatus"]>>();
    const second = setup({ publishStatus: plain, refresh: async () => { await Promise.reject(new CatalogueFetchError("no catalogue from x: status 500")); } });
    second.keeper.tick();
    await settle();
    expect(plain).toHaveBeenCalledWith("a", "failed", undefined, "no catalogue from x: status 500", { settings: HTTP_SETTINGS });
  });

  /** The provider a failure was recorded for in the rows below, with every credential source kind and the settings around the sources, so an edit to any part of the block is one row. */
  const COMMAND_PROVIDER: HttpProvider = { ...withCatalogue, credential: { sources: [{ env: "TOKEN" }, { file: "/run/secrets/a" }, { command: ["op", "read", "A"] }, { keychain: { service: "svc" } }, { op: "op://v/i/f" }, { literal: "p" }], target: "bearer" } };
  const withSources = (sources: HttpProvider["credential"]["sources"], extra: Partial<HttpProvider["credential"]> = {}): HttpProvider => ({ ...COMMAND_PROVIDER, credential: { ...COMMAND_PROVIDER.credential, sources, ...extra } });
  /** The sources of `COMMAND_PROVIDER` with the one of the given kind replaced by `source`. */
  const replaceSource = (kind: string, source: HttpProvider["credential"]["sources"][number]): HttpProvider["credential"]["sources"] => COMMAND_PROVIDER.credential.sources.map((kept) => (kind in kept ? source : kept));

  it.each([
    ["the base URL", withCatalogue, { ...withCatalogue, baseUrl: "https://fixed.example" }],
    ["the catalogue's own URL", withCatalogue, { ...withCatalogue, catalogue: { tier: "sonnet" as const, url: "https://a.example/models" } }],
    ["the variable of an env source", COMMAND_PROVIDER, withSources(replaceSource("env", { env: "OTHER_TOKEN" }))],
    ["the path of a file source", COMMAND_PROVIDER, withSources(replaceSource("file", { file: "/run/secrets/b" }))],
    ["the program of a command source", COMMAND_PROVIDER, withSources(replaceSource("command", { command: ["gpg", "read", "A"] }))],
    ["an argument of a command source", COMMAND_PROVIDER, withSources(replaceSource("command", { command: ["op", "read", "B"] }))],
    ["the service of a keychain source", COMMAND_PROVIDER, withSources(replaceSource("keychain", { keychain: { service: "other" } }))],
    ["the account of a keychain source", COMMAND_PROVIDER, withSources(replaceSource("keychain", { keychain: { service: "svc", account: "me" } }))],
    ["the reference of an op source", COMMAND_PROVIDER, withSources(replaceSource("op", { op: "op://v/i/g" }))],
    ["the placeholder of a literal source", COMMAND_PROVIDER, withSources(replaceSource("literal", { literal: "q" }))],
    ["the kind of a source", COMMAND_PROVIDER, withSources(replaceSource("env", { file: "TOKEN" }))],
    ["the order of the sources", COMMAND_PROVIDER, withSources([...COMMAND_PROVIDER.credential.sources].reverse())],
    ["the credential's target", COMMAND_PROVIDER, withSources(COMMAND_PROVIDER.credential.sources, { target: "apiKey" })],
    ["the timeout of a command source", COMMAND_PROVIDER, withSources(replaceSource("command", { command: ["op", "read", "A"], timeoutMs: 1000 }))],
  ] satisfies readonly (readonly [string, HttpProvider, HttpProvider])[])("refreshes again at the next tick, not after the retry period, when %s was edited after a failure", async (_label, original, edited) => {
    let provider: Provider = original;
    const refresh = vi.fn<(name: string) => Promise<void>>().mockRejectedValueOnce(new CatalogueFetchError("no catalogue from x: status 308", { redirected: true })).mockResolvedValue(undefined);
    const { keeper, clock } = setup({ refresh, providers: () => [["a", provider]] });
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    clock.now += 1;
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    provider = edited;
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("waits out the retry period when only the catalogue's filters were edited after a failure, since a fetch does not depend on them", async () => {
    let provider: Provider = withCatalogue;
    const refresh = vi.fn<(name: string) => Promise<void>>().mockRejectedValue(new CatalogueFetchError("no catalogue from x: status 500"));
    const { keeper, clock } = setup({ refresh, providers: () => [["a", provider]] });
    keeper.tick();
    await settle();
    clock.now += 1;
    provider = { ...withCatalogue, catalogue: { tier: "sonnet", include: ["m*"], exclude: ["x"] } };
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("asks for the digest of the provider it is judging, by name", async () => {
    const readSettings = vi.fn<(name: string) => string | undefined>(() => catalogueSettingsText(HTTP_SETTINGS, START_MS));
    const { keeper } = setup({ readCache: () => cacheAt(START_MS), readSettings });
    keeper.tick();
    await settle();
    expect(readSettings.mock.calls.map(([name]) => name)).toEqual(["a"]);
  });

  it("asks for the digest under the name of each provider, whichever it is", async () => {
    const readSettings = vi.fn<(name: string) => string | undefined>(() => undefined);
    const { keeper } = setup({ providers: () => [["first", withCatalogue], ["second", withCatalogue]], readCache: () => cacheAt(START_MS), readSettings });
    keeper.tick();
    await settle();
    expect(readSettings.mock.calls.map(([name]) => name)).toEqual(["first", "second"]);
  });

  it.each([
    ["were recorded for another server", () => catalogueSettingsText("settings-of-another-server", START_MS)],
    ["belong to another catalogue, as a release that rewrote the catalogue and left the digest leaves them", () => catalogueSettingsText(HTTP_SETTINGS, START_MS - 1)],
    ["are not recorded at all, as an older door's catalogue has none", () => undefined],
    ["are in a file that is not a digest file", () => "{ not json"],
  ])("refreshes at the next tick a fresh stored list whose settings %s, and leaves one fetched under the provider's own", async (_label, recorded) => {
    let digest: () => string | undefined = recorded;
    const { keeper, refresh } = setup({ readCache: () => cacheAt(START_MS), readSettings: () => digest() });
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    digest = () => catalogueSettingsText(HTTP_SETTINGS, START_MS);
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("logs a failure, waits out the retry period, then tries again", async () => {
    const refresh = vi.fn<(name: string) => Promise<void>>().mockRejectedValueOnce(new Error("unreachable")).mockResolvedValue(undefined);
    const { keeper, clock, log } = setup({ refresh });

    keeper.tick();
    await settle();
    expect(log).toHaveBeenCalledWith("catalogue refresh for provider a failed: unreachable");

    clock.now += CATALOGUE_RETRY_MS - 1;
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    clock.now += 1;
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("holds a failed refresh for a whole retry period from the step when the clock has stepped back since the failure, not refreshing on every tick for as long as the step lasts", async () => {
    const refresh = vi.fn<(name: string) => Promise<void>>().mockRejectedValue(new Error("unreachable"));
    const { keeper, clock } = setup({ refresh });

    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    clock.now -= STEP_BACK_MS;
    for (let tick = 0; tick < TICKS_DURING_STEP; tick += 1) {
      clock.now += 1;
      keeper.tick();
      await settle();
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    clock.now += CATALOGUE_RETRY_MS;
    keeper.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

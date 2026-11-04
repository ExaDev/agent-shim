import { describe, expect, it, vi } from "vitest";

import { createCatalogueKeeper, type CatalogueKeeperDeps } from "./catalogueKeeper";
import type { Provider } from "./config/schema";
import { CATALOGUE_MAX_AGE_MS, CATALOGUE_RETRY_MS } from "./providerCatalogue";

const CREDENTIAL = { sources: [{ env: "TOKEN" }] };
const withCatalogue: Provider = { displayName: "A", baseUrl: "https://a.example", credential: CREDENTIAL, catalogue: { tier: "sonnet" } };
const withoutCatalogue: Provider = { displayName: "B", baseUrl: "https://b.example", credential: CREDENTIAL };
const codex: Provider = { kind: "codex", displayName: "C", credential: CREDENTIAL };
const START_MS = CATALOGUE_MAX_AGE_MS * 2;
const cacheAt = (fetchedAt: number): string => JSON.stringify({ fetchedAt, url: "https://a.example/v1/models", models: [{ id: "m" }] });

/** A keeper over a clock the test moves, whose refresh the test settles. */
function setup(overrides: Partial<CatalogueKeeperDeps> = {}) {
  const clock = { now: START_MS };
  const refresh = vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined);
  const log = vi.fn<(message: string) => void>();
  const keeper = createCatalogueKeeper({
    supervisorPid: 2,
    providers: () => [["a", withCatalogue], ["b", withoutCatalogue]],
    readCache: () => undefined,
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

describe("createCatalogueKeeper", () => {
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
    expect(publishStatus).toHaveBeenCalledWith("c", "failed", "account");
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
    expect(publishStatus).toHaveBeenCalledWith("a", "failed");
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
});

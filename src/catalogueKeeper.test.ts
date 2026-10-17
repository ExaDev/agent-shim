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
    providers: () => [["a", withCatalogue], ["b", withoutCatalogue], ["c", codex]],
    readCache: () => undefined,
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
  it("refreshes only a provider that opted into a catalogue, and only one with no cache", async () => {
    const { keeper, refresh } = setup();

    keeper.tick();
    await settle();

    expect(refresh.mock.calls).toEqual([["a"]]);
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

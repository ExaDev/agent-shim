import { describe, expect, it, vi } from "vitest";

import type { CatalogueFetch } from "../providerCatalogue";
import { CATALOGUE_REFRESH_TIMEOUT_MS } from "../providerCatalogue";
import { createServedModels, SERVED_MODEL_MAX_AGE_MS, type ServedModels } from "./servedModel";

type ServedModelSource = Parameters<ServedModels["resolve"]>[0];

const OK = 200;
const UNAUTHORIZED = 401;
/** A lookup a moment after the failure, well inside the failure window. */
const A_SECOND_MS = 1000;
const FORBIDDEN = 403;
const BAD_GATEWAY = 502;
const NOT_FOUND = 404;
const READ_URLS = 2;
const CONCURRENT = 8;
const SLOW_READ_MS = 5000;
const READS_AFTER_EXPIRY = 2;
/** The reads the cache-key test makes: the first provider, the moved one, the other name, and the filtered one. */
const READS_WITH_FILTERS = 4;
/** The age a read stays fresh for, as the lookup documents it: one minute. */
const SERVED_AGE_MS = 60_000;

const source = (extra: Partial<ServedModelSource["provider"]> = {}): ServedModelSource => ({
  name: "spark",
  provider: { baseUrl: "https://spark.example/anthropic", ...extra },
  credential: async () => await Promise.resolve({ ok: true, credential: { token: "t", target: "bearer", source: { literal: "t" }, warnings: [] } } as const),
});

const listing = (id: string): { readonly status: number; readonly body: unknown } => ({ status: OK, body: { data: [{ id }] } });

/** A fetch whose answers the test releases by hand, in call order. */
function deferredFetch(): { readonly fetch: CatalogueFetch; readonly calls: () => number; readonly release: (index: number, answer: { readonly status: number; readonly body: unknown }) => void } {
  const pending: ((answer: { readonly status: number; readonly body: unknown }) => void)[] = [];
  return {
    fetch: async () => await new Promise((resolve) => { pending.push(resolve); }),
    calls: () => pending.length,
    release: (index, answer) => {
      pending[index]?.(answer);
    },
  };
}

describe("the served-model lookup", () => {
  it.each([["ordinary lookups", undefined], ["refreshes", { refresh: true }]])("makes one read for any number of concurrent %s of a hung server", async (_label, options) => {
    const deferred = deferredFetch();
    const served = createServedModels({ fetch: deferred.fetch, now: () => 0 });
    const lookups = Array.from({ length: CONCURRENT }, async () => await served.resolve(source(), options));
    await vi.waitFor(() => {
      expect(deferred.calls()).toBe(1);
    });
    deferred.release(0, listing("m"));
    for (const outcome of await Promise.all(lookups)) {
      expect(outcome).toEqual({ ok: true, model: "m" });
    }
    expect(deferred.calls()).toBe(1);
  });

  it("starts a new read for a lookup that arrives after the earlier one finished, and keeps the newer result", async () => {
    const deferred = deferredFetch();
    let now = 0;
    const served = createServedModels({ fetch: deferred.fetch, now: () => now });
    const first = served.resolve(source());
    await vi.waitFor(() => {
      expect(deferred.calls()).toBe(1);
    });
    deferred.release(0, listing("old"));
    await first;
    now += 1;
    const second = served.resolve(source(), { refresh: true });
    await vi.waitFor(() => {
      expect(deferred.calls()).toBe(2);
    });
    deferred.release(1, listing("new"));
    expect(await second).toEqual({ ok: true, model: "new" });
    expect(await served.resolve(source())).toEqual({ ok: true, model: "new" });
  });

  it("does not read again within the failure window, and reads again once a whole read budget has passed", async () => {
    let now = 0;
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status: NOT_FOUND, body: undefined });
    const served = createServedModels({ fetch, now: () => now });
    const first = await served.resolve(source());
    expect(first.ok).toBe(false);
    const callsAfterFirst = fetch.mock.calls.length;
    expect(callsAfterFirst).toBe(READ_URLS);
    expect(await served.resolve(source())).toEqual(first);
    expect(await served.resolve(source(), { refresh: true })).toEqual(first);
    expect(fetch.mock.calls.length).toBe(callsAfterFirst);
    now += CATALOGUE_REFRESH_TIMEOUT_MS;
    await served.resolve(source());
    expect(fetch.mock.calls.length).toBe(callsAfterFirst + READ_URLS);
  });

  it("keeps a failure for exactly one read budget: still answered a millisecond before it ends, read again at its end", async () => {
    let now = 0;
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status: NOT_FOUND, body: undefined });
    const served = createServedModels({ fetch, now: () => now });
    await served.resolve(source());
    const afterFirst = fetch.mock.calls.length;
    now = CATALOGUE_REFRESH_TIMEOUT_MS - 1;
    await served.resolve(source());
    await served.resolve(source(), { refresh: true });
    expect(fetch.mock.calls.length).toBe(afterFirst);
    now = CATALOGUE_REFRESH_TIMEOUT_MS;
    await served.resolve(source(), { refresh: true });
    expect(fetch.mock.calls.length).toBe(afterFirst + READ_URLS);
  });

  it("keys the cache on the catalogue settings that change what is listed", async () => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue(listing("m"));
    const served = createServedModels({ fetch, now: () => 0 });
    await served.resolve(source());
    await served.resolve(source({ catalogue: { tier: "sonnet", exclude: ["m"] } }));
    await served.resolve(source({ catalogue: { tier: "sonnet", url: "https://other.example/v1/models" } }));
    expect(fetch.mock.calls.length).toBe(READ_URLS - 1 + READ_URLS - 1 + READ_URLS - 1);
  });

  describe("a failure that is not the server's", () => {
    it("is not remembered when the credential did not resolve: a lookup a second later, once it does, reads the list", async () => {
      const fetch = vi.fn<CatalogueFetch>().mockResolvedValue(listing("m"));
      let unlocked = false;
      let now = 0;
      const locked: ServedModelSource = { ...source(), credential: async () => await Promise.resolve(unlocked ? ({ ok: true, credential: { token: "t", target: "bearer", source: { literal: "t" }, warnings: [] } } as const) : ({ ok: false, message: "the vault is locked" } as const)) };
      const served = createServedModels({ fetch, now: () => now });
      const first = await served.resolve(locked);
      expect(first.ok).toBe(false);
      expect(!first.ok && first.message).toContain("the vault is locked");
      expect(fetch).not.toHaveBeenCalled();
      unlocked = true;
      now += A_SECOND_MS;
      expect(await served.resolve(locked)).toEqual({ ok: true, model: "m" });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([[UNAUTHORIZED], [FORBIDDEN]])("is not remembered when the server refused the credential (%i): the next lookup reads the list again", async (status) => {
      const fetch = vi.fn<CatalogueFetch>().mockResolvedValueOnce({ status, body: undefined }).mockResolvedValueOnce({ status, body: undefined }).mockResolvedValue(listing("m"));
      let now = 0;
      const served = createServedModels({ fetch, now: () => now });
      expect((await served.resolve(source())).ok).toBe(false);
      const callsAfterFirst = fetch.mock.calls.length;
      now += A_SECOND_MS;
      expect(await served.resolve(source())).toEqual({ ok: true, model: "m" });
      expect(fetch.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it.each([[["403", "timeout"]], [["timeout", "403"]]] as const)("is the server's failure, and remembered for the window, when one candidate refused the credential and the other timed out (%j)", async (order) => {
      let asked = 0;
      const fetch = vi.fn<CatalogueFetch>(async () => {
        const answer = order[asked % READ_URLS];
        asked += 1;
        if (answer === "timeout") throw new Error("timed out");
        return await Promise.resolve({ status: FORBIDDEN, body: undefined });
      });
      let now = 0;
      const served = createServedModels({ fetch, now: () => now });
      expect((await served.resolve(source())).ok).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(READ_URLS);
      now += A_SECOND_MS;
      expect((await served.resolve(source())).ok).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(READ_URLS);
      now += CATALOGUE_REFRESH_TIMEOUT_MS;
      expect((await served.resolve(source())).ok).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(READ_URLS * 2);
    });

    it.each([["a list the server left empty", { data: [] }, undefined], ["a list the provider's filters leave empty", { data: [{ id: "m" }] }, { tier: "sonnet" as const, exclude: ["m"] }]])("is remembered for the window when the server answered with %s: a lookup a second later does not read again", async (_label, body, catalogue) => {
      const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status: OK, body });
      let now = 0;
      const served = createServedModels({ fetch, now: () => now });
      const emptied = catalogue === undefined ? source() : source({ catalogue });
      expect((await served.resolve(emptied)).ok).toBe(false);
      const calls = fetch.mock.calls.length;
      now += A_SECOND_MS;
      expect((await served.resolve(emptied)).ok).toBe(false);
      expect(fetch.mock.calls.length).toBe(calls);
    });

    it("reads each candidate URL once for concurrent lookups under a bad credential: a 401 then a second URL still answering, and both lookups wait on that one read", async () => {
      const seen: string[] = [];
      let finish: (value: { readonly status: number; readonly body: unknown }) => void = () => undefined;
      const fetch = vi.fn<CatalogueFetch>(async (url) => {
        seen.push(url);
        if (seen.length % 2 === 1) return await Promise.resolve({ status: UNAUTHORIZED, body: undefined });
        return await new Promise((resolve) => { finish = resolve; });
      });
      const served = createServedModels({ fetch, now: () => 0 });
      const first = served.resolve(source());
      const second = served.resolve(source());
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(READ_URLS);
      });
      // Both lookups wait on the one read of the two candidate URLs; the second answers only when released.
      finish({ status: UNAUTHORIZED, body: undefined });
      expect((await first).ok).toBe(false);
      expect((await second).ok).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(READ_URLS);
    });

    it("is remembered when the server is the one that failed, for the whole window", async () => {
      const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status: BAD_GATEWAY, body: undefined });
      let now = 0;
      const served = createServedModels({ fetch, now: () => now });
      await served.resolve(source());
      const calls = fetch.mock.calls.length;
      now += A_SECOND_MS;
      await served.resolve(source());
      expect(fetch.mock.calls.length).toBe(calls);
    });
  });

  describe("under a clock that steps back", () => {
    /** The hour the clock is set back by: far past the read's age and the failure window. */
    const STEP_BACK_MS = 3_600_000;
    /** How many lookups fall while the clock is behind the stamp: several, so a read on each would show. */
    const LOOKUPS_DURING_STEP = 5;
    /** A little past the failure window, so the failed read is read again. */
    const FAILURE_WINDOW_PASSED_MS = CATALOGUE_REFRESH_TIMEOUT_MS + 1;

    it("reads again when the clock steps back behind a cached read, instead of keeping it for as long as the step", async () => {
      const fetch = vi.fn<CatalogueFetch>().mockResolvedValueOnce(listing("old")).mockResolvedValue(listing("new"));
      let now = STEP_BACK_MS;
      const served = createServedModels({ fetch, now: () => now });
      expect(await served.resolve(source())).toEqual({ ok: true, model: "old" });
      now -= STEP_BACK_MS;
      expect(await served.resolve(source())).toEqual({ ok: true, model: "new" });
    });

    it("forgets a failure once a later read gives a model, so a clock stepped back behind the failure's stamp does not answer it for a healthy server", async () => {
      let answer: { readonly status: number; readonly body: unknown } = { status: BAD_GATEWAY, body: {} };
      const fetch = vi.fn<CatalogueFetch>(async () => await Promise.resolve(answer));
      let now = STEP_BACK_MS;
      const served = createServedModels({ fetch, now: () => now });
      expect((await served.resolve(source())).ok).toBe(false);
      answer = listing("m");
      now += FAILURE_WINDOW_PASSED_MS;
      expect(await served.resolve(source())).toEqual({ ok: true, model: "m" });
      // The cached read expires, then the clock steps back behind the failure's stamp: the healthy server is read, not answered with the old failure.
      now += SERVED_MODEL_MAX_AGE_MS;
      now -= STEP_BACK_MS + SERVED_MODEL_MAX_AGE_MS;
      expect(await served.resolve(source())).toEqual({ ok: true, model: "m" });
    });

    it("holds a cached failure for a whole window from the step when the clock steps back behind it, not reading the list on every lookup for as long as the step lasts", async () => {
      const fetch = vi.fn<CatalogueFetch>(async () => await Promise.resolve({ status: BAD_GATEWAY, body: {} }));
      let now = STEP_BACK_MS;
      const served = createServedModels({ fetch, now: () => now });
      expect((await served.resolve(source())).ok).toBe(false);
      const readsAtFailure = fetch.mock.calls.length;
      now -= STEP_BACK_MS;
      for (let lookup = 0; lookup < LOOKUPS_DURING_STEP; lookup += 1) {
        now += 1;
        expect((await served.resolve(source())).ok).toBe(false);
      }
      expect(fetch.mock.calls.length).toBe(readsAtFailure);
      now += CATALOGUE_REFRESH_TIMEOUT_MS;
      await served.resolve(source());
      expect(fetch.mock.calls.length).toBeGreaterThan(readsAtFailure);
    });

    it("holds a refresh's allowance for a whole cache age from the step when the clock steps back behind the last one, so refreshes are not read on every request for as long as the step lasts", async () => {
      const fetch = vi.fn<CatalogueFetch>().mockResolvedValueOnce(listing("a")).mockResolvedValueOnce(listing("b")).mockResolvedValue(listing("c"));
      let now = STEP_BACK_MS;
      const served = createServedModels({ fetch, now: () => now });
      expect(await served.resolve(source())).toEqual({ ok: true, model: "a" });
      expect(await served.resolve(source(), { refresh: true })).toEqual({ ok: true, model: "b" });
      now -= STEP_BACK_MS;
      for (let request = 0; request < LOOKUPS_DURING_STEP; request += 1) {
        now += 1;
        expect(await served.resolve(source(), { refresh: true })).toEqual({ ok: true, model: "b" });
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      now += SERVED_MODEL_MAX_AGE_MS;
      expect(await served.resolve(source(), { refresh: true })).toEqual({ ok: true, model: "c" });
    });
  });

  it("keys the cache on the provider's name, base URL and filters, each alone", async () => {
    // The listing names the URL it was read from, so a lookup answered from another provider's entry names the wrong server.
    const fetch = vi.fn<CatalogueFetch>(async (url) => await Promise.resolve(listing(new URL(url).host)));
    const served = createServedModels({ fetch, now: () => 0 });
    expect(await served.resolve(source())).toEqual({ ok: true, model: "spark.example" });
    expect(await served.resolve(source())).toEqual({ ok: true, model: "spark.example" });
    expect(await served.resolve({ ...source(), provider: { baseUrl: "https://moved.example/anthropic" } })).toEqual({ ok: true, model: "moved.example" });
    expect(await served.resolve({ ...source(), name: "other" })).toEqual({ ok: true, model: "spark.example" });
    expect(fetch.mock.calls.map(([url]) => new URL(url).host)).toEqual(["spark.example", "moved.example", "spark.example"]);
    expect(await served.resolve(source({ catalogue: { tier: "sonnet", include: ["spark.example"] } }))).toEqual({ ok: true, model: "spark.example" });
    expect(fetch).toHaveBeenCalledTimes(READS_WITH_FILTERS);
  });

  it("takes the first model the list names, and the first that passes the filters", async () => {
    const fetch = vi.fn<CatalogueFetch>().mockResolvedValue({ status: OK, body: { data: [{ id: "first" }, { id: "second" }, { id: "third" }] } });
    const served = createServedModels({ fetch, now: () => 0 });
    expect(await served.resolve(source())).toEqual({ ok: true, model: "first" });
    expect(await served.resolve(source({ catalogue: { tier: "sonnet", exclude: ["first"] } }))).toEqual({ ok: true, model: "second" });
  });

  it("stamps a failed read when it ends, so a read that hangs for its whole budget does not make each later request read again", async () => {
    let now = 0;
    let attempts = 0;
    const hanging: CatalogueFetch = async () => {
      attempts += 1;
      now += CATALOGUE_REFRESH_TIMEOUT_MS;
      return await Promise.reject(new Error("timed out"));
    };
    const served = createServedModels({ fetch: hanging, now: () => now });
    const first = await served.resolve(source());
    expect(first.ok).toBe(false);
    const readAttempts = attempts;
    for (let request = 0; request < CONCURRENT; request += 1) {
      expect((await served.resolve(source())).ok).toBe(false);
    }
    expect(attempts).toBe(readAttempts);
  });

  it("stamps a successful read when it ends, so it stays fresh for a whole age from the moment it was learnt", async () => {
    let now = 0;
    let attempts = 0;
    const slow: CatalogueFetch = async () => {
      attempts += 1;
      now += SLOW_READ_MS;
      return await Promise.resolve(listing("m"));
    };
    const served = createServedModels({ fetch: slow, now: () => now });
    await served.resolve(source());
    now += SERVED_AGE_MS - 1;
    await served.resolve(source());
    expect(attempts).toBe(1);
    now += 1;
    await served.resolve(source());
    expect(attempts).toBe(READS_AFTER_EXPIRY);
  });

  it("honours a refresh once per cache age: any number at one instant make one read, and the next age one more", async () => {
    let now = 0;
    let attempts = 0;
    const same: CatalogueFetch = async () => {
      attempts += 1;
      return await Promise.resolve(listing("m"));
    };
    const served = createServedModels({ fetch: same, now: () => now });
    await served.resolve(source());
    const afterFirst = attempts;
    for (let refresh = 0; refresh < CONCURRENT; refresh += 1) {
      expect(await served.resolve(source(), { refresh: true })).toEqual({ ok: true, model: "m" });
    }
    expect(attempts).toBe(afterFirst + 1);
    now += SERVED_AGE_MS - 1;
    await served.resolve(source(), { refresh: true });
    expect(attempts).toBe(afterFirst + 1);
    now += 1;
    await served.resolve(source(), { refresh: true });
    expect(attempts).toBe(afterFirst + READS_AFTER_EXPIRY);
  });

  it("does not spend a refresh's allowance on a read that fails: once the failure window has passed and the server is back, the next refresh reads and takes the new model", async () => {
    let now = 0;
    let answer: "down" | "old" | "new" = "old";
    let attempts = 0;
    const changing: CatalogueFetch = async () => {
      attempts += 1;
      return answer === "down" ? await Promise.reject(new Error("down")) : await Promise.resolve(listing(answer));
    };
    const served = createServedModels({ fetch: changing, now: () => now });
    expect(await served.resolve(source())).toEqual({ ok: true, model: "old" });
    answer = "down";
    expect((await served.resolve(source(), { refresh: true })).ok).toBe(false);
    answer = "new";
    now += CATALOGUE_REFRESH_TIMEOUT_MS;
    const before = attempts;
    expect(await served.resolve(source(), { refresh: true })).toEqual({ ok: true, model: "new" });
    expect(attempts).toBeGreaterThan(before);
    // That one succeeded, so it now is the allowance for the age.
    const after = attempts;
    await served.resolve(source(), { refresh: true });
    expect(attempts).toBe(after);
  });

  it("makes one read for refreshes that arrive together, and counts that read as the one refresh of the age", async () => {
    const deferred = deferredFetch();
    const served = createServedModels({ fetch: deferred.fetch, now: () => 0 });
    const first = served.resolve(source());
    await vi.waitFor(() => {
      expect(deferred.calls()).toBe(1);
    });
    deferred.release(0, listing("m"));
    await first;
    const together = Array.from({ length: CONCURRENT }, async () => await served.resolve(source(), { refresh: true }));
    await vi.waitFor(() => {
      expect(deferred.calls()).toBe(READS_AFTER_EXPIRY);
    });
    deferred.release(1, listing("m2"));
    for (const outcome of await Promise.all(together)) {
      expect(outcome).toEqual({ ok: true, model: "m2" });
    }
    await served.resolve(source(), { refresh: true });
    expect(deferred.calls()).toBe(READS_AFTER_EXPIRY);
  });

  it.each([
    ["a plain lookup joins a plain read", undefined, undefined],
    ["a refresh joins a refresh", { refresh: true }, { refresh: true }],
    ["a plain lookup joins a refresh", { refresh: true }, undefined],
  ])("hands the very result of the read in flight to a lookup that joins it, never a second look at the cache: %s", async (_label, readOptions, joinerOptions) => {
    // The clock moves a whole cache age on every look, so a joiner that re-resolved after the read ended would find the read it was waiting for already stale and read again.
    let ticks = 0;
    const deferred = deferredFetch();
    const served = createServedModels({ fetch: deferred.fetch, now: () => (ticks += SERVED_AGE_MS) });
    const reading = served.resolve(source(), readOptions);
    await vi.waitFor(() => {
      expect(deferred.calls()).toBe(1);
    });
    const joiner = served.resolve(source(), joinerOptions);
    deferred.release(0, listing("m"));
    expect(await reading).toEqual({ ok: true, model: "m" });
    expect(await joiner).toEqual({ ok: true, model: "m" });
    expect(deferred.calls()).toBe(1);
  });

  it("does not give a refresh the stale model of a read that was already in flight, but reads again after it", async () => {
    const deferred = deferredFetch();
    const served = createServedModels({ fetch: deferred.fetch, now: () => 0 });
    const ordinary = served.resolve(source());
    await vi.waitFor(() => {
      expect(deferred.calls()).toBe(1);
    });
    const refreshing = served.resolve(source(), { refresh: true });
    // The ordinary read was started before the server swapped; it answers the old model.
    deferred.release(0, listing("old"));
    expect(await ordinary).toEqual({ ok: true, model: "old" });
    await vi.waitFor(() => {
      expect(deferred.calls()).toBe(READS_AFTER_EXPIRY);
    });
    deferred.release(1, listing("new"));
    expect(await refreshing).toEqual({ ok: true, model: "new" });
  });

  it("lets refreshes that arrive together share the one read made after a read that was in flight", async () => {
    const deferred = deferredFetch();
    const served = createServedModels({ fetch: deferred.fetch, now: () => 0 });
    const ordinary = served.resolve(source());
    await vi.waitFor(() => {
      expect(deferred.calls()).toBe(1);
    });
    const refreshes = Array.from({ length: CONCURRENT }, async () => await served.resolve(source(), { refresh: true }));
    deferred.release(0, listing("old"));
    await ordinary;
    await vi.waitFor(() => {
      expect(deferred.calls()).toBe(READS_AFTER_EXPIRY);
    });
    deferred.release(1, listing("new"));
    for (const outcome of await Promise.all(refreshes)) {
      expect(outcome).toEqual({ ok: true, model: "new" });
    }
    expect(deferred.calls()).toBe(READS_AFTER_EXPIRY);
  });

  it("answers an empty list and an unreadable one as the same upstream failure, each saying what failed for the model auto", async () => {
    // A list the provider's own filters empty is the server's state too: the server lists models and the catalogue patterns admit none.
    const empty = createServedModels({ fetch: async () => await Promise.resolve(listing("m")), now: () => 0 });
    const emptied = await empty.resolve(source({ catalogue: { tier: "sonnet", include: ["no-such-*"] } }));
    expect(emptied).toMatchObject({ ok: false, status: BAD_GATEWAY });
    expect(emptied.ok ? "" : emptied.message).toContain('the model "auto" follows the model provider "spark"\'s server serves, but no model it lists passes the provider\'s catalogue include and exclude');
    expect(emptied.ok ? "" : emptied.message).not.toContain("is empty");
    // A server that lists no model at all is an unreadable list, whatever the patterns say.
    const noneListed = createServedModels({ fetch: async () => await Promise.resolve({ status: OK, body: { data: [] } }), now: () => 0 });
    const nothing = await noneListed.resolve(source({ catalogue: { tier: "sonnet", include: ["no-such-*"] } }));
    expect(nothing.ok ? "" : nothing.message).toContain("its live model list could not be read (");
    const unreadable = createServedModels({ fetch: async () => await Promise.reject(new Error("down")), now: () => 0 });
    const failed = await unreadable.resolve(source());
    expect(failed).toMatchObject({ ok: false, status: BAD_GATEWAY });
    expect(failed.ok ? "" : failed.message).toContain("its live model list could not be read (");
  });
});

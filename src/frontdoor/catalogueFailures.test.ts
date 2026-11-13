import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import path from "node:path";

import { createCatalogueKeeper } from "../catalogueKeeper";
import type { HttpProvider } from "../config/schema";
import { CATALOGUE_REDIRECT_NOTE, CatalogueFetchError, catalogueCachePath } from "../providerCatalogue";
import { createFakeFarmFs } from "../test-helpers";
import { providersWithRedirectedCatalogue } from "./catalogueFailures";
import * as catalogueState from "./catalogueState";
import { catalogueStatusPublisher, readCatalogueFailure, readCatalogueStatus, writeCatalogueFailureReason, writeCatalogueStatus } from "./catalogueState";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");
const SUPERVISOR = 4242;
/** The settings fingerprint every provider of these tests has, both when its refresh failed and as the provider reads now. */
const SETTINGS = "settings-v1";
/** The providers as they read now, each with those settings. */
const current = (names: readonly string[], settings: string | undefined = SETTINGS): ReadonlyMap<string, string | undefined> => new Map(names.map((name) => [name, settings] as const));
const GENERATION = "10000000-0000-4000-8000-000000000001";
/** The clock the publisher is given. */
const RECORDED_AT = 7;
const OTHER_GENERATION = "10000000-0000-4000-8000-000000000002";
const REDIRECT_TEXT = `no catalogue from http://spark.example/v1/models: status 308, ${CATALOGUE_REDIRECT_NOTE}: set the provider's base URL (or its catalogue.url) to the address it redirects to`;
/** A recorded failure that was a redirect: the text and the fact. */
const REDIRECT_REASON: { readonly reason: string; readonly redirected: true } = { reason: REDIRECT_TEXT, redirected: true };

/** A file system holding the serving door's state and codex record, and the status each provider has in each generation. */
function world(statuses: readonly (readonly [generation: string, name: string, status: "ready" | "failed", reason: string | { readonly reason: string; readonly redirected: true } | undefined])[], serving: boolean | "without a generation" = true) {
  const fs = createFakeFarmFs({
    ...(serving === false ? {} : { [paths.frontdoorStateFile]: JSON.stringify({ port: 1234, supervisorPid: SUPERVISOR }) }),
    ...(serving === true ? { [`${paths.frontdoorDir}/codex-homes/${String(SUPERVISOR)}.json`]: JSON.stringify({ codexHome: "/home/testuser/.codex", generation: GENERATION }) } : {}),
  });
  for (const [generation, name, status, reason] of statuses) {
    writeCatalogueStatus(fs, paths, SUPERVISOR, generation, name, status, undefined, 1);
    writeCatalogueFailureReason(fs, paths, SUPERVISOR, generation, name, typeof reason === "object" ? reason.reason : reason, typeof reason === "object" ? { redirected: reason.redirected, settings: SETTINGS } : { settings: SETTINGS });
  }
  return fs;
}

describe("the providers whose catalogue refresh met a redirect", () => {
  it("names a provider whose serving door recorded a failure that says so, and no other", () => {
    const fs = world([[GENERATION, "spark", "failed", REDIRECT_REASON], [GENERATION, "other", "failed", "no catalogue from http://o.example/v1/models: status 500"], [GENERATION, "fine", "ready", undefined]]);
    expect([...providersWithRedirectedCatalogue(fs, paths, current(["spark", "other", "fine", "unrecorded"])).keys()]).toEqual(["spark"]);
  });

  it("leaves out a provider whose redirect failure was recorded by another generation, or that has since refreshed", () => {
    const stale = world([[OTHER_GENERATION, "spark", "failed", REDIRECT_REASON]]);
    expect([...providersWithRedirectedCatalogue(stale, paths, current(["spark"])).keys()]).toEqual([]);
    const recovered = world([[GENERATION, "spark", "failed", REDIRECT_REASON], [GENERATION, "spark", "ready", undefined]]);
    expect([...providersWithRedirectedCatalogue(recovered, paths, current(["spark"])).keys()]).toEqual([]);
  });

  it("names no provider that has no current settings (not an http provider, or an invalid file), whatever was recorded", () => {
    const fs = world([[GENERATION, "spark", "failed", { ...REDIRECT_REASON }]]);
    writeCatalogueFailureReason(fs, paths, SUPERVISOR, GENERATION, "spark", REDIRECT_TEXT, { redirected: true });
    expect([...providersWithRedirectedCatalogue(fs, paths, new Map([["spark", undefined]])).keys()]).toEqual([]);
  });

  it("names no provider whose latest status is not a failure, even when a failure file recording a redirect under the same settings is left beside it", () => {
    const fs = world([[GENERATION, "spark", "failed", REDIRECT_REASON]]);
    writeCatalogueStatus(fs, paths, SUPERVISOR, GENERATION, "spark", "ready", undefined, 2);
    expect(readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")?.reason).toBeDefined();
    expect([...providersWithRedirectedCatalogue(fs, paths, current(["spark"])).keys()]).toEqual([]);
  });

  it("names none when no door serves", () => {
    expect([...providersWithRedirectedCatalogue(world([[GENERATION, "spark", "failed", REDIRECT_REASON]], false), paths, current(["spark"])).keys()]).toEqual([]);
  });

  it("names none when the serving door has recorded no catalogue generation, whatever failures other files hold", () => {
    const fs = world([[GENERATION, "spark", "failed", REDIRECT_REASON]], "without a generation");
    expect([...providersWithRedirectedCatalogue(fs, paths, current(["spark"])).keys()]).toEqual([]);
  });
});

describe("a redirect recorded beside a reason too long to keep whole", () => {
  it("is still named, since the verdict is a field of the failure and not a search of its text", () => {
    const long = `no catalogue from http://spark.example/${"p".repeat(catalogueState.CATALOGUE_FAILURE_REASON_MAX_CHARS * 2)}/v1/models: status 308, ${CATALOGUE_REDIRECT_NOTE}`;
    const fs = world([[GENERATION, "spark", "failed", { reason: long, redirected: true }]]);
    expect(readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")?.reason).not.toContain(CATALOGUE_REDIRECT_NOTE);
    expect([...providersWithRedirectedCatalogue(fs, paths, current(["spark"])).keys()]).toEqual(["spark"]);
  });

  it("is not named for a failure that only mentions one", () => {
    const fs = world([[GENERATION, "spark", "failed", `no catalogue: ${CATALOGUE_REDIRECT_NOTE}`]]);
    expect([...providersWithRedirectedCatalogue(fs, paths, current(["spark"])).keys()]).toEqual([]);
  });
});

describe("the keeper's status publisher", () => {
  it("records a redirect as the failure's own field, and drops it with the failure", () => {
    const fs = createFakeFarmFs({});
    const publish = catalogueStatusPublisher(fs, paths, SUPERVISOR, GENERATION, () => RECORDED_AT);
    publish("spark", "failed", undefined, "no catalogue: status 308", { redirected: true, settings: SETTINGS });
    expect(catalogueState.readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")).toEqual({ reason: "no catalogue: status 308", redirected: true, unlocated: false, settings: SETTINGS });
    publish("spark", "failed", undefined, "no catalogue: status 500");
    expect(catalogueState.readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")).toEqual({ reason: "no catalogue: status 500", redirected: false, unlocated: false, settings: undefined });
    publish("spark", "running", undefined, "x", { redirected: true });
    expect(catalogueState.readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")).toBeUndefined();
  });

  it("records that a redirect carried no Location only beside the redirect, and reads it back as the failure's own field", () => {
    const fs = createFakeFarmFs({});
    const publish = catalogueStatusPublisher(fs, paths, SUPERVISOR, GENERATION, () => RECORDED_AT);
    publish("spark", "failed", undefined, "no catalogue: status 301", { redirected: true, unlocated: true, settings: SETTINGS });
    expect(catalogueState.readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")).toEqual({ reason: "no catalogue: status 301", redirected: true, unlocated: true, settings: SETTINGS });
    publish("spark", "failed", undefined, "no catalogue: status 500", { unlocated: true });
    expect(catalogueState.readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")).toEqual({ reason: "no catalogue: status 500", redirected: false, unlocated: false, settings: undefined });
  });

  it("reads a failure file that says a redirect carried no Location without saying it met one as no redirect and no such fact", () => {
    const fs = createFakeFarmFs({ [`${paths.catalogueDir}/supervisors/${String(SUPERVISOR)}/${GENERATION}/failures/spark.json`]: JSON.stringify({ reason: "no catalogue: status 500", unlocated: true }) });
    expect(catalogueState.readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")).toEqual({ reason: "no catalogue: status 500", redirected: false, unlocated: false, settings: undefined });
  });

  it("names the redirect a provider's failure recorded with whether it carried a Location", () => {
    const fs = world([[GENERATION, "spark", "failed", REDIRECT_REASON]]);
    catalogueState.writeCatalogueFailureReason(fs, paths, SUPERVISOR, GENERATION, "spark", REDIRECT_TEXT, { redirected: true, unlocated: true, settings: SETTINGS });
    expect(providersWithRedirectedCatalogue(fs, paths, current(["spark"])).get("spark")).toEqual({ reason: REDIRECT_TEXT, unlocated: true });
    catalogueState.writeCatalogueFailureReason(fs, paths, SUPERVISOR, GENERATION, "spark", REDIRECT_TEXT, { redirected: true, settings: SETTINGS });
    expect(providersWithRedirectedCatalogue(fs, paths, current(["spark"])).get("spark")).toEqual({ reason: REDIRECT_TEXT, unlocated: false });
  });

  it("records a failure with its reason, and clears the reason when the provider refreshes or runs again", () => {
    const fs = createFakeFarmFs({});
    const publish = catalogueStatusPublisher(fs, paths, SUPERVISOR, GENERATION, () => RECORDED_AT);
    publish("spark", "failed", undefined, "no catalogue: status 308");
    expect(readCatalogueStatus(fs, paths, SUPERVISOR, GENERATION, "spark")).toEqual({ status: "failed", recordedAt: RECORDED_AT });
    expect(readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")?.reason).toBe("no catalogue: status 308");
    publish("spark", "running", undefined, "a reason a state that is no failure may not keep");
    expect(readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")?.reason).toBeUndefined();
    publish("spark", "failed", undefined, "again");
    publish("spark", "ready");
    expect(readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")?.reason).toBeUndefined();
  });
});

describe("a failure the keeper records through the publisher", () => {
  it("holds the settings only as a digest: no userinfo or query of the base URL, nothing of the credential block", async () => {
    const provider: HttpProvider = { displayName: "Spark", baseUrl: "https://user:hunter2@spark.example/v1?key=queryvalue", credential: { sources: [{ command: ["op", "read", "op://vault/item/field"] }, { env: "SPARK_SECRET_VARIABLE" }] }, catalogue: { tier: "sonnet" } };
    const fs = createFakeFarmFs({});
    const keeper = createCatalogueKeeper({
      supervisorPid: SUPERVISOR,
      providers: () => [["spark", provider]],
      readCache: () => undefined,
      readSettings: () => undefined,
      credentialFingerprint: () => undefined,
      refresh: async () => { await Promise.reject(new CatalogueFetchError("no catalogue: status 308", { redirected: true })); },
      nowMs: () => RECORDED_AT,
      log: () => undefined,
      publishStatus: catalogueStatusPublisher(fs, paths, SUPERVISOR, GENERATION, () => RECORDED_AT),
    });
    keeper.tick();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const file = fs.readFileUtf8(path.join(path.dirname(catalogueCachePath(paths, "spark", SUPERVISOR, GENERATION)), "failures", "spark.json"));
    expect(file).toBeDefined();
    for (const material of ["hunter2", "queryvalue", "user:", "op://", "SPARK_SECRET_VARIABLE", "vault"]) {
      expect(file).not.toContain(material);
    }
    expect(catalogueState.readCatalogueFailure(fs, paths, SUPERVISOR, GENERATION, "spark")?.settings).toMatch(/^[0-9a-f]{64}$/);
  });
});

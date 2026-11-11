import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { currentCatalogueSettings } from "./doctorCatalogueRedirect";
import { collectDoctorReport, runDoctor } from "./doctorReport";
import { baseParams, findingsFor, provider } from "./doctorTestFixtures";
import { writeFrontDoorCodexHome, writeFrontDoorState } from "./frontdoor/state";
import { catalogueStatusPublisher } from "./frontdoor/catalogueState";
import { buildLayoutPaths } from "./paths";
import { providerFilePath } from "./config/names";
import type { HttpProvider } from "./config/schema";
import { CATALOGUE_REDIRECT_NOTE, catalogueSettingsFingerprint } from "./providerCatalogue";
import type { BaseUrlBatchProbe, BaseUrlTarget } from "./providerReachability";
import { addProvider, readProvider, updateProvider } from "./providersStore";
import { realFarmFs } from "./realPorts";

/** A provider's own connect timeout, distinct from the default so a probe given the default would be caught. */
const OWN_CONNECT_TIMEOUT_MS = 1_500;

const SPARK = { displayName: "Spark", baseUrl: "http://192.0.2.1:8000", connectTimeoutMs: OWN_CONNECT_TIMEOUT_MS, credential: { sources: [{ literal: "placeholder" }] } };

/** A batch probe that records each batch it was asked and answers `verdict` for every target. */
function recordingProbe(verdict: ReturnType<BaseUrlBatchProbe>[number]): { readonly probe: BaseUrlBatchProbe; readonly batches: (readonly BaseUrlTarget[])[] } {
  const batches: (readonly BaseUrlTarget[])[] = [];
  return {
    batches,
    probe: (targets) => {
      batches.push(targets);
      return targets.map(() => verdict);
    },
  };
}

describe("doctor and a provider's base URL", () => {
  it("fails an http provider whose base URL accepts no connection, naming the provider and URL, probed within the provider's own bound", () => {
    const { probe, batches } = recordingProbe({ ok: false, reason: "no connection accepted within 1500ms" });
    const report = runDoctor(baseParams({ providers: [provider("spark", SPARK)], probeBaseUrls: probe }));
    expect(batches).toEqual([[{ baseUrl: "http://192.0.2.1:8000", timeoutMs: OWN_CONNECT_TIMEOUT_MS }]]);
    expect(findingsFor(report, "provider")).toContainEqual(expect.objectContaining({ severity: "fail", subject: "spark", message: "provider spark could not connect to http://192.0.2.1:8000: no connection accepted within 1500ms" }));
    expect(report.ok).toBe(false);
  });

  it("probes every http provider in one batch, so their bounds run at once rather than adding up", () => {
    const { probe, batches } = recordingProbe({ ok: true });
    runDoctor(baseParams({ providers: [provider("spark", SPARK), provider("local", { ...SPARK, baseUrl: "http://127.0.0.1:9" })], probeBaseUrls: probe }));
    expect(batches).toEqual([
      [
        { baseUrl: "http://192.0.2.1:8000", timeoutMs: OWN_CONNECT_TIMEOUT_MS },
        { baseUrl: "http://127.0.0.1:9", timeoutMs: OWN_CONNECT_TIMEOUT_MS },
      ],
    ]);
  });

  it("reports every unreachable provider, each under its own name and URL, and none for a reachable one between them", () => {
    const verdicts = [{ ok: false, reason: "refused by the first" }, { ok: true }, { ok: false, reason: "refused by the third" }] as const;
    const providers = [
      provider("first", { ...SPARK, baseUrl: "http://user:hunter2@192.0.2.1:1/v1?key=abc123" }),
      provider("middle", { ...SPARK, baseUrl: "http://192.0.2.1:2" }),
      provider("third", { ...SPARK, baseUrl: "http://192.0.2.1:3" }),
    ];
    const report = runDoctor(baseParams({ providers, probeBaseUrls: (targets) => targets.map((_target, index) => verdicts[index] ?? { ok: false, reason: "unexpected target" }) }));
    const failures = findingsFor(report, "provider").filter((finding) => finding.severity === "fail");
    expect(failures.map((finding) => [finding.subject, finding.message])).toEqual([
      ["first", "provider first could not connect to http://192.0.2.1:1/v1: refused by the first"],
      ["third", "provider third could not connect to http://192.0.2.1:3: refused by the third"],
    ]);
  });

  it("adds nothing for a reachable one", () => {
    const report = runDoctor(baseParams({ providers: [provider("spark", SPARK)], probeBaseUrls: recordingProbe({ ok: true }).probe }));
    expect(findingsFor(report, "provider").filter((finding) => finding.severity === "fail")).toEqual([]);
  });

  it("never probes a provider kind that dials no base URL", () => {
    const { probe, batches } = recordingProbe({ ok: false, reason: "unused" });
    runDoctor(baseParams({ providers: [provider("codex", { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "codex" }] } }), provider("router", { kind: "router", displayName: "Router" })], probeBaseUrls: probe }));
    expect(batches.flat()).toEqual([]);
  });

  it("names the base URL without its userinfo or query in every finding", () => {
    const report = runDoctor(baseParams({ providers: [provider("spark", { ...SPARK, baseUrl: "http://user:hunter2@192.0.2.1:8000/v1?key=abc123" })], probeBaseUrls: recordingProbe({ ok: false, reason: "no connection accepted within 1500ms" }).probe }));
    const printed = findingsFor(report, "provider").map((finding) => finding.message).join("\n");
    expect(printed).toContain("http://192.0.2.1:8000/v1");
    expect(printed).not.toContain("hunter2");
    expect(printed).not.toContain("abc123");
  });
});

describe("doctor and a provider whose catalogue refresh met a redirect", () => {
  it("warns of it by name, saying where to set the address, and not of a provider that did not", () => {
    const report = runDoctor(baseParams({ providers: [provider("spark", SPARK), provider("local", { ...SPARK, baseUrl: "http://127.0.0.1:9" })], catalogueRedirects: new Map([["spark", "no catalogue from http://192.0.2.1:8000/v1/models: status 308"]]) }));
    const findings = findingsFor(report, "provider");
    const redirectFindings = findings.filter((finding) => finding.message.includes("reached a redirect, which a catalogue read never follows"));
    expect(redirectFindings.map((finding) => [finding.severity, finding.subject])).toEqual([["warn", "spark"]]);
    expect(redirectFindings[0]?.message).toContain(JSON.stringify("no catalogue from http://192.0.2.1:8000/v1/models: status 308"));
  });

  it("says nothing when the recorded failures are not read", () => {
    const report = runDoctor(baseParams({ providers: [provider("spark", SPARK)] }));
    expect(findingsFor(report, "provider").filter((finding) => finding.message.includes("redirect"))).toEqual([]);
  });
});

describe("collectDoctorReport and a provider whose catalogue refresh met a redirect", () => {
  const SUPERVISOR = 4242;
  const GENERATION = "10000000-0000-4000-8000-000000000001";
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /** A state root with the provider `spark`, a serving door recorded for generation `GENERATION`, and `spark`'s last refresh recorded as `outcome`. */
  function rootWith(outcome: { readonly status: "failed" | "ready"; readonly reason: string | undefined; readonly redirected?: true }): ReturnType<typeof buildLayoutPaths> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-catalogue-redirect-test-"));
    roots.push(root);
    const paths = buildLayoutPaths(root);
    addProvider(paths, "spark", { displayName: "Spark", baseUrl: "http://192.0.2.1:8000", sources: [{ literal: "placeholder" }], catalogue: { tier: "sonnet" } });
    writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { supervisorPid: SUPERVISOR });
    writeFrontDoorCodexHome(realFarmFs, paths.frontdoorDir, SUPERVISOR, path.join(root, "codex"), GENERATION);
    catalogueStatusPublisher(realFarmFs, paths, SUPERVISOR, GENERATION, () => 1)("spark", outcome.status, undefined, outcome.reason, { ...(outcome.redirected === true ? { redirected: true as const } : {}), settings: catalogueSettingsFingerprint(readProvider(paths, "spark") as HttpProvider) });
    return paths;
  }

  const redirectFindings = (paths: ReturnType<typeof buildLayoutPaths>): readonly string[] => findingsFor(collectDoctorReport({ paths, env: { PATH: "" } }), "provider").filter((finding) => finding.message.includes("reached a redirect")).map((finding) => String(finding.subject));

  it("warns of it when the serving door recorded the failure, and not when the last refresh succeeded", () => {
    expect(redirectFindings(rootWith({ status: "failed", reason: `status 308, ${CATALOGUE_REDIRECT_NOTE}: set the provider's base URL`, redirected: true }))).toEqual(["spark"]);
    expect(redirectFindings(rootWith({ status: "ready", reason: undefined }))).toEqual([]);
  });

  it("warns of nothing for a provider edited since its refresh failed on a redirect, until a refresh fails again", () => {
    const paths = rootWith({ status: "failed", reason: `status 308, ${CATALOGUE_REDIRECT_NOTE}: set the provider's base URL`, redirected: true });
    expect(redirectFindings(paths)).toEqual(["spark"]);
    updateProvider(paths, "spark", { baseUrl: "https://192.0.2.1:8000" });
    expect(redirectFindings(paths)).toEqual([]);
  });

  it("reads each provider's own settings, so a second provider's recorded failure is matched against that provider and not the first", () => {
    const paths = rootWith({ status: "failed", reason: `status 308, ${CATALOGUE_REDIRECT_NOTE}: set the provider's base URL`, redirected: true });
    addProvider(paths, "other", { displayName: "Other", baseUrl: "http://192.0.2.2:8000", sources: [{ literal: "placeholder" }], catalogue: { tier: "sonnet" } });
    catalogueStatusPublisher(realFarmFs, paths, SUPERVISOR, GENERATION, () => 1)("other", "failed", undefined, `status 308, ${CATALOGUE_REDIRECT_NOTE}: set the provider's base URL`, { redirected: true, settings: catalogueSettingsFingerprint(readProvider(paths, "other") as HttpProvider) });
    expect([...redirectFindings(paths)].sort()).toEqual(["other", "spark"]);
  });

  it("has no current settings for a provider that is no http provider or whose file is invalid, and the fingerprint of an http one", () => {
    const paths = rootWith({ status: "ready", reason: undefined });
    fs.writeFileSync(providerFilePath(paths.providersDir, "codexed"), JSON.stringify({ kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "placeholder" }] } }));
    fs.writeFileSync(providerFilePath(paths.providersDir, "broken"), "{ not json");
    expect(currentCatalogueSettings(paths, "codexed")).toBeUndefined();
    expect(currentCatalogueSettings(paths, "broken")).toBeUndefined();
    expect(currentCatalogueSettings(paths, "absent")).toBeUndefined();
    expect(currentCatalogueSettings(paths, "spark")).toBe(catalogueSettingsFingerprint(readProvider(paths, "spark") as HttpProvider));
  });

  it("warns of nothing for a provider whose catalogue was unset since its refresh failed on a redirect, and again once the catalogue is set back (the same settings the failure was recorded under)", () => {
    const paths = rootWith({ status: "failed", reason: `status 308, ${CATALOGUE_REDIRECT_NOTE}: set the provider's base URL`, redirected: true });
    expect(redirectFindings(paths)).toEqual(["spark"]);
    const stored = readProvider(paths, "spark") as HttpProvider;
    fs.writeFileSync(providerFilePath(paths.providersDir, "spark"), JSON.stringify({ ...stored, catalogue: undefined }));
    expect(currentCatalogueSettings(paths, "spark")).toBeUndefined();
    expect(redirectFindings(paths)).toEqual([]);
    fs.writeFileSync(providerFilePath(paths.providersDir, "spark"), JSON.stringify(stored));
    expect(redirectFindings(paths)).toEqual(["spark"]);
  });

  it("warns of nothing when the failure was another one", () => {
    expect(redirectFindings(rootWith({ status: "failed", reason: "no catalogue from http://192.0.2.1:8000/v1/models: status 500" }))).toEqual([]);
  });
});

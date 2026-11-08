import { describe, expect, it } from "vitest";

import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor, provider } from "./doctorTestFixtures";
import type { BaseUrlProbe } from "./providerReachability";

/** A provider's own connect timeout, distinct from the default so a probe given the default would be caught. */
const OWN_CONNECT_TIMEOUT_MS = 1_500;

const SPARK = { displayName: "Spark", baseUrl: "http://192.0.2.1:8000", connectTimeoutMs: OWN_CONNECT_TIMEOUT_MS, credential: { sources: [{ literal: "placeholder" }] } };

/** A probe that records what it was asked and answers `verdict`. */
function recordingProbe(verdict: ReturnType<BaseUrlProbe>): { readonly probe: BaseUrlProbe; readonly asked: [string, number][] } {
  const asked: [string, number][] = [];
  return {
    asked,
    probe: (baseUrl, timeoutMs) => {
      asked.push([baseUrl, timeoutMs]);
      return verdict;
    },
  };
}

describe("doctor and a provider's base URL", () => {
  it("fails an http provider whose base URL accepts no connection, naming the provider and URL, probed within the provider's own bound", () => {
    const { probe, asked } = recordingProbe({ ok: false, reason: "no connection accepted within 1500ms" });
    const report = runDoctor(baseParams({ providers: [provider("spark", SPARK)], probeBaseUrl: probe }));
    expect(asked).toEqual([["http://192.0.2.1:8000", OWN_CONNECT_TIMEOUT_MS]]);
    expect(findingsFor(report, "provider")).toContainEqual(expect.objectContaining({ severity: "fail", subject: "spark", message: "provider spark could not connect to http://192.0.2.1:8000: no connection accepted within 1500ms" }));
    expect(report.ok).toBe(false);
  });

  it("adds nothing for a reachable one", () => {
    const report = runDoctor(baseParams({ providers: [provider("spark", SPARK)], probeBaseUrl: recordingProbe({ ok: true }).probe }));
    expect(findingsFor(report, "provider").filter((finding) => finding.severity === "fail")).toEqual([]);
  });

  it("never probes a provider kind that dials no base URL", () => {
    const { probe, asked } = recordingProbe({ ok: false, reason: "unused" });
    runDoctor(baseParams({ providers: [provider("codex", { kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "codex" }] } }), provider("router", { kind: "router", displayName: "Router" })], probeBaseUrl: probe }));
    expect(asked).toEqual([]);
  });
});

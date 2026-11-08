import { describe, expect, it } from "vitest";

import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor, provider } from "./doctorTestFixtures";
import type { BaseUrlBatchProbe, BaseUrlTarget } from "./providerReachability";

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

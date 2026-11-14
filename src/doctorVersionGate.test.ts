import { describe, expect, it } from "vitest";

import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor } from "./doctorTestFixtures";
import { UNVERIFIED_MINOR_VERSION, UNVERIFIED_PATCH_VERSION } from "./supervise/verifiedVersionsTestWorld";

describe("runDoctor: the goal, compaction and turn version gate on the discovered binary", () => {
  it("warns, beside the pass, that a patch release of a verified minor has not been verified for goal, compaction and turn control, without failing", () => {
    const report = runDoctor(baseParams({ binaryDiscovery: { ok: true, binary: { path: `/opt/claude/${UNVERIFIED_PATCH_VERSION}`, source: "versions-dir", version: UNVERIFIED_PATCH_VERSION } } }));
    const findings = findingsFor(report, "binary-discovery");
    expect(findings.map((finding) => finding.severity)).toEqual(["pass", "warn"]);
    expect(findings[1]?.message).toContain(`Claude Code ${UNVERIFIED_PATCH_VERSION} has not been verified`);
    expect(report.ok).toBe(true);
  });

  it("adds no gate finding for a version of an unverified minor, which the verbs refuse with their own reason, or for a binary of unknown version", () => {
    for (const binary of [{ path: `/opt/claude/${UNVERIFIED_MINOR_VERSION}`, source: "versions-dir", version: UNVERIFIED_MINOR_VERSION }, { path: "/usr/bin/claude", source: "path-fallback" }] as const) {
      expect(findingsFor(runDoctor(baseParams({ binaryDiscovery: { ok: true, binary } })), "binary-discovery").map((finding) => finding.severity)).toEqual(["pass"]);
    }
  });
});

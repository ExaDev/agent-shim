import { describe, expect, it } from "vitest";

import { RC_SESSION_COMMAND_VERIFIED_VERSIONS, claudeCodeVersionGate, claudeCodeVersionsGated, parseReleaseVersion } from "./verifiedVersions";
import { UNVERIFIED_MINOR_VERSION, UNVERIFIED_PATCH_VERSION, VERIFIED_VERSION } from "./verifiedVersionsTestWorld";

describe("the Claude Code version gate", () => {
  it("passes every listed version as verified, with no warning", () => {
    for (const version of RC_SESSION_COMMAND_VERIFIED_VERSIONS) {
      expect(claudeCodeVersionGate(version)).toEqual({ kind: "verified" });
    }
  });

  it("passes a patch release of a verified minor that is not listed, with a warning naming the version as unverified and the versions that are", () => {
    const gate = claudeCodeVersionGate(UNVERIFIED_PATCH_VERSION);
    expect(gate.kind).toBe("unverified-patch");
    const warning = gate.kind === "unverified-patch" ? gate.warning : "";
    expect(warning).toContain(`Claude Code ${UNVERIFIED_PATCH_VERSION} has not been verified`);
    expect(warning).toContain(VERIFIED_VERSION);
  });

  it("refuses a version of an unverified minor or major, one that is not a plain release version, and none at all", () => {
    const parts = parseReleaseVersion(VERIFIED_VERSION);
    expect(parts).toBeDefined();
    const otherMajor = `${String((parts?.major ?? 0) + 1)}.${String(parts?.minor ?? 0)}.${String(parts?.patch ?? 0)}`;
    for (const version of [UNVERIFIED_MINOR_VERSION, otherMajor, `${UNVERIFIED_PATCH_VERSION}-beta.1`, `${VERIFIED_VERSION}.1`, "", undefined]) {
      expect(claudeCodeVersionGate(version)).toEqual({ kind: "refused" });
    }
  });

  it("names the verified versions and the minors whose other patches it lets through", () => {
    const parts = parseReleaseVersion(VERIFIED_VERSION);
    expect(claudeCodeVersionsGated()).toContain(`Claude Code ${RC_SESSION_COMMAND_VERIFIED_VERSIONS.join(", ")}`);
    expect(claudeCodeVersionsGated()).toContain(`another patch release of ${String(parts?.major)}.${String(parts?.minor)}`);
  });
});

describe("release version parsing", () => {
  it("reads a plain release version's parts, and nothing else", () => {
    expect(parseReleaseVersion("2.10.300")).toEqual({ major: 2, minor: 10, patch: 300 });
    for (const version of ["2.1", "2.1.3.4", "02.1.3", "2.1.3-rc.1", "v2.1.3", " 2.1.3"]) {
      expect(parseReleaseVersion(version)).toBeUndefined();
    }
  });
});

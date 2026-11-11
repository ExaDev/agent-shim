import { describe, expect, it } from "vitest";

import { pushNameFinding } from "./doctorNameFinding";
import type { DoctorSection, DoctorSeverity } from "./doctorReport";

/** The findings one entry produces: the section, severity and subject of each. */
function findingsOf(section: DoctorSection, name: string): string[] {
  const lines: string[] = [];
  pushNameFinding((where, severity: DoctorSeverity, _message, subject) => {
    lines.push(`${where}:${severity}:${subject ?? ""}`);
  }, section, "thing", { name, path: `/dir/${name}.json` });
  return lines;
}

describe("the finding for a stored file named like a bare model name", () => {
  it("warns of a provider file with that name", () => {
    expect(findingsOf("provider", "opus")).toEqual(["provider:warn:opus"]);
  });

  it.each(["identity", "config-profile"] as const)("does not warn of a %s with that name: only a provider is claimed by a bare name", (section) => {
    expect(findingsOf(section, "opus")).toEqual([]);
  });
});

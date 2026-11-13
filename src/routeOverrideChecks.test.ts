import { describe, expect, it } from "vitest";

import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor } from "./doctorTestFixtures";
import { overrideTargetProblem, routeOverrideFindings, type OverrideNames } from "./routeOverrideChecks";
import type { RouteOverrides } from "./routeOverridesSchema";

const NAMES: OverrideNames = {
  providers: new Set(["z", "subs"]),
  identities: new Set(["work"]),
  profiles: new Set(["zprof"]),
  pools: new Set(["subs"]),
  virtualModels: new Set(["fast"]),
  family: (key) => key === "glm-5-1",
};

describe("what an override's target may name", () => {
  it.each(["z/glm-5.3", "anthropic/claude-opus-5-5", "fast", "z", "claude-sonnet-5-5", "family:glm-5-1", "acct:work/opus", "auto/zprof/sonnet", "auto/pool:subs/sonnet", "auto/provider:subs", "auto/glm-5-1"])("accepts %j", (target) => {
    expect(overrideTargetProblem(target, NAMES)).toBeUndefined();
  });

  it.each<[string, string]>([
    ["nowhere/glm", 'no provider "nowhere"'],
    ["ghost", "names no provider, virtual model"],
    ["family:nothing", "no target the providers offer"],
    ["acct:ghost/opus", 'no identity "ghost"'],
    ["acct:work", "acct:<identity>/<model>"],
    ["auto", "<provider>/auto"],
    ["auto/nothing", "names nothing"],
    ["auto/subs/sonnet", "ambiguous"],
    ["auto//x", "names no selector"],
    ["auto/pool:zprof", "no pool"],
  ])("refuses %j: %s", (target, fragment) => {
    expect(overrideTargetProblem(target, NAMES)).toContain(fragment);
  });
});

/** The findings as `severity: message` lines. */
const over = (overrides: RouteOverrides): readonly string[] => routeOverrideFindings(overrides, NAMES).map((finding) => `${finding.severity}: ${finding.message}`);

describe("the route overrides check", () => {
  it("finds nothing in a consistent file, a class pinned to one of its own models included", () => {
    expect(over({ schemaVersion: 1, global: { opus: "z/glm", haiku: "claude-haiku-5-1" }, identities: { work: { sonnet: "auto/zprof/sonnet" } }, providers: { z: { haiku: "fast" } }, sessions: { abc: { opus: "acct:work/opus" } } })).toEqual([]);
  });

  it("fails a key that is no Claude name, a scope naming nothing, and a dangling target", () => {
    const findings = over({ schemaVersion: 1, global: { "z/opus": "z/glm", opus: "nowhere/glm" }, identities: { ghost: { opus: "z/glm" } }, providers: { gone: { opus: "z/glm" } } });
    // One failure for each of the four faults the file holds.
    expect(findings.filter((line) => line.startsWith("fail: "))).toHaveLength(["z/opus", "nowhere", "ghost", "gone"].length);
    expect(findings.join("\n")).toContain('"z/opus", which is no bare Claude name');
    expect(findings.join("\n")).toContain('no provider "nowhere"');
    expect(findings.join("\n")).toContain('no identity "ghost"');
    expect(findings.join("\n")).toContain('no provider "gone"');
  });

  it("warns of a chain, which the door does not follow, and fails a cycle", () => {
    const chain = over({ schemaVersion: 1, global: { opus: "claude-sonnet-5-5", sonnet: "z/glm" } });
    expect(chain).toEqual([expect.stringMatching(/^warn: .*opus -> sonnet/)]);
    const cycle = over({ schemaVersion: 1, global: { opus: "claude-sonnet-5-5", sonnet: "claude-opus-5-5" } });
    expect(cycle.filter((line) => line.startsWith("fail: ") && line.includes("come back round"))).toHaveLength(2);
  });

  it("follows a chain through the scopes a request of the entry's scope is covered by", () => {
    expect(over({ schemaVersion: 1, identities: { work: { opus: "claude-sonnet-5-5" } }, global: { sonnet: "z/glm" } })).toEqual([expect.stringMatching(/^warn: .*identity table for "work".*opus -> sonnet/)]);
  });
});

describe("the doctor's route overrides section", () => {
  it("passes no file, fails a file that cannot be used, and reports what the check finds", () => {
    const sectionOf = (raw: string | undefined) => findingsFor(runDoctor(baseParams({ routeOverrides: { path: "/state/route-overrides.json", raw } })), "route-overrides").map((finding) => `${finding.severity}: ${finding.message}`);
    expect(sectionOf(undefined)).toEqual(["pass: No route overrides are set."]);
    expect(sectionOf("{")[0]).toMatch(/^fail: .*not valid JSON.*refuses every main-loop request/);
    expect(sectionOf(JSON.stringify({ schemaVersion: 2 }))[0]).toMatch(/^fail: /);
    expect(sectionOf(JSON.stringify({ schemaVersion: 1, global: { opus: "nowhere/x" } }))[0]).toMatch(/^fail: .*no provider "nowhere"/);
    expect(sectionOf(JSON.stringify({ schemaVersion: 1 }))).toEqual(["pass: /state/route-overrides.json is consistent."]);
  });
});

import { describe, expect, it } from "vitest";

import type { ModelsConfig } from "../config/schema";
import { modelsFindings } from "./doctor";

const over = (models: ModelsConfig): readonly string[] => modelsFindings({ models, providers: ["z", "m"], identities: ["work"] }).map((finding) => `${finding.severity}: ${finding.message}`);

describe("modelsFindings", () => {
  it("passes a consistent block with nothing to report", () => {
    expect(over({ virtual: { fast: { mode: "cheapest", members: ["z/glm-5.3", "m/MiniMax-M3"] } }, prices: { "z/glm-5.3": { input: 1, output: 2 }, "m/MiniMax-M3": { input: 1, output: 2 } }, tiers: { opus: "fast" } })).toEqual([]);
  });

  it("fails a member naming no defined provider, virtual model or identity", () => {
    const findings = over({ virtual: { a: { mode: "ordered", members: ["nope/other-model", "ghost", "acct:nobody/x", "z/glm-5.3"] } } });
    expect(findings.some((line) => line.includes('no provider "nope"'))).toBe(true);
    expect(findings.some((line) => line.includes('neither a defined virtual model nor a provider model'))).toBe(true);
    expect(findings.some((line) => line.includes('no identity "nobody"'))).toBe(true);
    expect(findings.some((line) => line.includes('"z/glm-5.3"'))).toBe(false);
  });

  it("fails a virtual model that cannot be expanded, naming the cycle", () => {
    expect(over({ virtual: { a: { mode: "ordered", members: ["b"] }, b: { mode: "ordered", members: ["a"] } } })[0]).toContain("cycle");
  });

  it("warns when a cheapest member has no prices", () => {
    const findings = over({ virtual: { cheap: { mode: "cheapest", members: ["z/glm-5.3"] } } });
    expect(findings[0]).toMatch(/^warn: .*no prices are set/);
  });

  it("fails a tier pointer naming nothing defined and a ref both hidden and shown", () => {
    const findings = over({ tiers: { opus: "ghost/x" }, hide: ["z/glm-5.3"], show: ["z/glm-5.3"] });
    expect(findings.some((line) => line.includes('Tier opus points at "ghost/x"'))).toBe(true);
    expect(findings.some((line) => line.includes("both hidden and in the show-only list"))).toBe(true);
  });

  it("warns when a virtual model lists targets that look like one model, naming the family member that covers them", () => {
    const findings = over({ virtual: { mirror: { mode: "ordered", members: ["z/glm-5.1", "m/hf:zai-org/GLM-5.1"] } } });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^warn: .*look like one model; a member family:glm-5-1 names every target of it/);
  });

  it("warns on a same assertion the names contradict, and fails one that is also asserted distinct", () => {
    expect(over({ same: [["z/glm-5.1", "m/MiniMax-M3"]] })[0]).toMatch(/^warn: .*asserted to be one model, but their names say they are different/);
    expect(over({ same: [["z/glm-5.1", "m/glm-5.1"]], distinct: [["m/glm-5.1", "z/glm-5.1"]] })[0]).toMatch(/^fail: .*both one model and two models/);
  });

  it("warns on a family member no offered target belongs to, only when targets are given", () => {
    const models: ModelsConfig = { virtual: { across: { mode: "ordered", members: ["family:glm-5-1", "family:ghost-9"] } } };
    expect(modelsFindings({ models, providers: ["z", "m"], identities: [] })).toEqual([]);
    const findings = modelsFindings({ models, providers: ["z", "m"], identities: [], targets: ["z/glm-5.1", "m/hf:zai-org/GLM-5.1"] }).map((finding) => finding.message);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("family:ghost-9");
  });
});

import { describe, expect, it } from "vitest";

import type { ModelsConfig } from "../config/schema";
import { modelsFindings } from "./doctor";

const over = (models: ModelsConfig): readonly string[] => modelsFindings({ models, providers: ["z", "m"], identities: ["work"] }).map((finding) => `${finding.severity}: ${finding.message}`);

describe("modelsFindings", () => {
  it("passes a consistent block with nothing to report", () => {
    expect(over({ virtual: { fast: { mode: "cheapest", members: ["z/glm-5.3", "m/MiniMax-M3"] } }, prices: { "z/glm-5.3": { input: 1, output: 2 }, "m/MiniMax-M3": { input: 1, output: 2 } }, tiers: { opus: "fast" } })).toEqual([]);
  });

  it("fails a member naming no defined provider, virtual model or identity", () => {
    const findings = over({ virtual: { a: { mode: "ordered", members: ["nope/glm-5.3", "ghost", "acct:nobody/x", "z/glm-5.3"] } } });
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
});

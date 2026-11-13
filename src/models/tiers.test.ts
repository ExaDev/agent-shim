import { describe, expect, it } from "vitest";

import { CLAUDE_TIERS, MODEL_ENV_VARIABLES, OTHER_MODEL_ENV_VARIABLES, TIER_MODEL_ENV_VARIABLES } from "../config/schema";
import { TIER_ENV_VARIABLES, claudeNameTier, claudeTierOf, isBareClaudeName } from "./tiers";

describe("claudeTierOf", () => {
  it("selects the tier a model name names, case-insensitively", () => {
    expect(claudeTierOf("claude-haiku-5-5")).toBe("haiku");
    expect(claudeTierOf("CLAUDE-SONNET-5-5")).toBe("sonnet");
    expect(claudeTierOf("Claude-Opus-5-5")).toBe("opus");
    expect(claudeTierOf("claude-fable-5-1")).toBe("fable");
  });

  it("selects the tier of a name with a context-window suffix or a provider qualifier", () => {
    expect(claudeTierOf("claude-opus-5-5[1m]")).toBe("opus");
    expect(claudeTierOf("anthropic/claude-sonnet-5-5")).toBe("sonnet");
  });

  it("selects none for a name that names no tier", () => {
    expect(claudeTierOf("gpt-5")).toBeUndefined();
    expect(claudeTierOf("")).toBeUndefined();
  });

  it("takes the first tier in the shared order when a name holds more than one, fable before opus before sonnet before haiku", () => {
    expect(CLAUDE_TIERS).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(claudeTierOf("fable-opus")).toBe("fable");
    expect(claudeTierOf("opus-sonnet")).toBe("opus");
    expect(claudeTierOf("sonnet-haiku")).toBe("sonnet");
    expect(claudeTierOf("haiku-opus")).toBe("opus");
  });
});

describe("claudeNameTier", () => {
  const NAMES: readonly (readonly [string, string | undefined])[] = [
    ["claude-opus-5-5", "opus"],
    ["claude-sonnet-5-5", "sonnet"],
    ["claude-haiku-5-5", "haiku"],
    ["claude-fable-5-1", "fable"],
    ["claude-3-5-haiku-20241022", "haiku"],
    ["claude-3-opus-20240229", "opus"],
    ["claude-sonnet-4-5-20250929", "sonnet"],
    ["Claude-Opus-5-5", "opus"],
    ["claude-opus-5-5[1m]", "opus"],
    ["claude-sonnet-5-5[1m]", "sonnet"],
    ["opus", "opus"],
    ["sonnet", "sonnet"],
    ["haiku", "haiku"],
    ["fable", "fable"],
    ["Sonnet", "sonnet"],
    ["opus[1m]", "opus"],
    ["magnum-opus", undefined],
    ["opus-magnum", undefined],
    ["sonnetta", undefined],
    ["haikuu", undefined],
    ["gpt-5", undefined],
    ["claude-sonet-5", undefined],
    ["claude", undefined],
    ["claude-3-5", undefined],
    ["z/glm-5.3", undefined],
    ["anthropic/claude-opus-5-5", undefined],
    ["fast", undefined],
    ["", undefined],
    ["opusplan", undefined],
  ];

  it.each(NAMES)("selects the tier of %j as %s", (name, tier) => {
    expect(claudeNameTier(name)).toBe(tier);
  });

  it("is never wider than the substring match the translators keep: whatever it selects, claudeTierOf selects the same", () => {
    for (const [name] of NAMES) {
      const tier = claudeNameTier(name);
      if (tier !== undefined) {
        expect(claudeTierOf(name)).toBe(tier);
      }
    }
  });
});

describe("the env variables that name a model", () => {
  it("are one set, wherever a tier's variable is listed: every tier's variable is a model variable, and the model variables are the tiers' with ANTHROPIC_MODEL and ANTHROPIC_SMALL_FAST_MODEL", () => {
    const tierVariables = CLAUDE_TIERS.map((tier) => TIER_ENV_VARIABLES[tier]);
    expect([...MODEL_ENV_VARIABLES].sort()).toEqual([...tierVariables, "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"].sort());
    expect([...TIER_MODEL_ENV_VARIABLES, ...OTHER_MODEL_ENV_VARIABLES].sort()).toEqual([...MODEL_ENV_VARIABLES].sort());
    expect(new Set(MODEL_ENV_VARIABLES).size).toBe(MODEL_ENV_VARIABLES.length);
  });
});

describe("isBareClaudeName", () => {
  it.each<[string, boolean]>([["claude-opus-5-5", true], ["opus", true], ["z/claude-opus-5-5", false], ["z/opus", false], ["glm-5", false]])("says %j is a bare Claude name: %j", (name, bare) => {
    expect(isBareClaudeName(name)).toBe(bare);
  });
});

import { describe, expect, it } from "vitest";

import { FAKE_HOME } from "../test-helpers";
import { flattenLayers, matchingRules } from "./flatten";
import type { Layer } from "./types";

function layer(id: number, overrides: Partial<Layer> = {}): Layer {
  return { id, kind: "config-profile", source: `layer-${String(id)}`, ...overrides };
}

describe("phase one: categories", () => {
  it("plain-overwrites a later layer's value for the same category over an earlier one", () => {
    const flattened = flattenLayers(
      [layer(0, { categories: { history: true } }), layer(1, { categories: { history: false } })],
      { home: FAKE_HOME },
    );
    expect(flattened.categories.get("history")).toBe(false);
  });

  it("leaves a category no layer touched absent, so the shipped default still applies", () => {
    const flattened = flattenLayers([layer(0, { categories: { history: true } })], { home: FAKE_HOME });
    expect(flattened.categories.has("knowledge")).toBe(false);
  });

  it("keeps categories from different layers side by side when they do not collide", () => {
    const flattened = flattenLayers(
      [layer(0, { categories: { history: true } }), layer(1, { categories: { knowledge: false } })],
      { home: FAKE_HOME },
    );
    expect(flattened.categories.get("history")).toBe(true);
    expect(flattened.categories.get("knowledge")).toBe(false);
  });
});

describe("phase one: entries", () => {
  it("keys the accumulator by canonical pattern, so equivalent keys from different layers collapse into one rule", () => {
    const flattened = flattenLayers(
      [
        layer(0, { entries: { "history/projects/~/work/x": true } }),
        layer(1, { entries: { [`history/projects/${FAKE_HOME}/work/x`]: false } }),
      ],
      { home: FAKE_HOME },
    );
    expect(flattened.rules.size).toBe(1);
    const rule = flattened.rules.get("projects/-home-testuser-work-x");
    expect(rule?.value).toBe(false);
    expect(rule?.layer).toBe(1);
  });

  it("records each rule's own layer and ordinal, which is what lets phase two tell same-layer from cross-layer", () => {
    const layerId = 3;
    const flattened = flattenLayers(
      [layer(layerId, { entries: { "knowledge/skills/a": true, "knowledge/skills/b": false } })],
      { home: FAKE_HOME },
    );
    expect(flattened.rules.get("skills/a")?.ordinal).toBe(0);
    expect(flattened.rules.get("skills/b")?.ordinal).toBe(1);
    expect(flattened.rules.get("skills/b")?.layer).toBe(layerId);
  });

  it("uses the explicitly captured entry order rather than whatever order the validated object happens to have", () => {
    const flattened = flattenLayers(
      [
        layer(0, {
          entries: { "knowledge/skills/a": true, "knowledge/skills/b": true },
          entryOrder: ["knowledge/skills/b", "knowledge/skills/a"],
        }),
      ],
      { home: FAKE_HOME },
    );
    expect(flattened.rules.get("skills/b")?.ordinal).toBe(0);
    expect(flattened.rules.get("skills/a")?.ordinal).toBe(1);
  });

  it("appends a key missing from the captured order rather than silently dropping it", () => {
    const flattened = flattenLayers(
      [layer(0, { entries: { "knowledge/skills/a": true, "knowledge/skills/b": true }, entryOrder: ["knowledge/skills/b"] })],
      { home: FAKE_HOME },
    );
    expect(flattened.rules.size).toBe(2);
    expect(flattened.rules.get("skills/b")?.ordinal).toBe(0);
    expect(flattened.rules.get("skills/a")?.ordinal).toBe(1);
  });

  it("compiles a conditional value into a rule that keeps its condition", () => {
    const flattened = flattenLayers(
      [layer(0, { entries: { "history/projects/~/work/*": { value: true, when: { newerThan: "90d" } } } })],
      { home: FAKE_HOME },
    );
    expect(flattened.rules.get("projects/-home-testuser-work-*")?.when).toEqual({ newerThan: "90d" });
  });
});

describe("phase one: the secret prefix", () => {
  it("rejects a deliberate secret/ key outright and contributes no rule at all", () => {
    const flattened = flattenLayers([layer(0, { entries: { "secret/.credentials.json": true } })], { home: FAKE_HOME });
    expect(flattened.rules.size).toBe(0);
    const diagnostic = flattened.diagnostics.find((entry) => entry.code === "SECRET_ENTRY_KEY");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.subject).toBe("secret/.credentials.json");
  });

  it("does not reject a key under another prefix at compile time — the resolve-time floor catches that one", () => {
    const flattened = flattenLayers([layer(0, { entries: { "runtime/.credentials.json": true } })], { home: FAKE_HOME });
    expect(flattened.rules.size).toBe(1);
    expect(flattened.diagnostics.filter((entry) => entry.code === "SECRET_ENTRY_KEY")).toEqual([]);
  });
});

describe("phase one: malformed keys", () => {
  it("reports an unrooted history/projects/ fragment", () => {
    const flattened = flattenLayers([layer(0, { entries: { "history/projects/work/acme": true } })], { home: FAKE_HOME });
    expect(flattened.diagnostics.map((entry) => entry.code)).toEqual(["UNROOTED_PROJECT_PATH"]);
    expect(flattened.rules.size).toBe(0);
  });

  it("reports a key with no category prefix", () => {
    const flattened = flattenLayers([layer(0, { entries: { "skills/commit": true } })], { home: FAKE_HOME });
    expect(flattened.diagnostics.map((entry) => entry.code)).toEqual(["MALFORMED_ENTRY_KEY"]);
  });

  it("warns about an empty when object, which is vacuously true", () => {
    const flattened = flattenLayers([layer(0, { entries: { "knowledge/skills/a": { value: true, when: {} } } })], { home: FAKE_HOME });
    expect(flattened.diagnostics.map((entry) => entry.code)).toEqual(["EMPTY_WHEN"]);
    expect(flattened.rules.size).toBe(1);
  });
});

describe("phase one: models", () => {
  const withModels = (models: unknown): Layer => layer(0, { models: models as Layer["models"] });

  it("merges definitions per name, the deeper layer winning, and hides and shows replace wholesale", () => {
    const flattened = flattenLayers(
      [
        withModels({ virtual: { fast: { mode: "ordered", members: ["z/1"] }, slow: { mode: "spread", members: ["m/2"] } }, tiers: { opus: "fast" }, hide: ["a", "b"] }),
        withModels({ virtual: { fast: { mode: "cheapest", members: ["z/3"] } }, show: ["fast"] }),
      ],
      { home: FAKE_HOME },
    );
    expect(flattened.models).toEqual({
      virtual: { fast: { mode: "cheapest", members: ["z/3"] }, slow: { mode: "spread", members: ["m/2"] } },
      tiers: { opus: "fast" },
      hide: ["a", "b"],
      show: ["fast"],
    });
  });

  it("removes what a null in a deeper layer names, and drops the piece nothing fills", () => {
    const flattened = flattenLayers(
      [
        withModels({ virtual: { fast: { mode: "ordered", members: ["z/1"] }, gone: { mode: "ordered", members: ["m/2"] } }, tiers: { opus: "fast", sonnet: "gone" } }),
        withModels({ virtual: { gone: null }, tiers: { sonnet: null } }),
      ],
      { home: FAKE_HOME },
    );
    expect(flattened.models).toEqual({ virtual: { fast: { mode: "ordered", members: ["z/1"] } }, tiers: { opus: "fast" } });
  });

  it("accumulates identity assertions across layers without repeating one, and merges family settings per key with null removing", () => {
    const flattened = flattenLayers(
      [
        withModels({ same: [["a/x", "b/y"]], distinct: [["a/x", "c/z"]], families: { "glm-5-1": { mode: "ordered" }, gone: { vision: false } } }),
        withModels({ same: [["a/x", "b/y"], ["d/p", "e/q"]], distinct: [["a/x", "c/z"], ["f/m", "g/n"]], families: { "glm-5-1": { mode: "cheapest", names: ["o/odd"] }, gone: null } }),
      ],
      { home: FAKE_HOME },
    );
    expect(flattened.models).toEqual({
      same: [["a/x", "b/y"], ["d/p", "e/q"]],
      distinct: [["a/x", "c/z"], ["f/m", "g/n"]],
      families: { "glm-5-1": { mode: "cheapest", names: ["o/odd"] } },
    });
  });

  it("is absent when no layer carries models, and a layer removing everything empties the block", () => {
    expect(flattenLayers([layer(0)], { home: FAKE_HOME }).models).toBeUndefined();
    expect(
      flattenLayers([withModels({ virtual: { only: { mode: "ordered", members: ["z/1"] } } }), withModels({ virtual: { only: null } })], { home: FAKE_HOME }).models,
    ).toBeUndefined();
  });
});

describe("phase one: launch explain", () => {
  it("takes the last layer's value", () => {
    const flattened = flattenLayers([layer(0, { launch: { explain: true } }), layer(1, { launch: { explain: false } })], { home: FAKE_HOME });
    expect(flattened.launch).toEqual({ explain: false });
  });
});

describe("phase one: launch delay and pause", () => {
  it("takes the last layer's delay and pause, each decided on its own", () => {
    const flattened = flattenLayers(
      [layer(0, { launch: { delay: "5s", pause: true } }), layer(1, { launch: { delay: "1s" } }), layer(2, { launch: { skipPermissions: true } })],
      { home: FAKE_HOME },
    );
    expect(flattened.launch).toEqual({ delay: "1s", pause: true, skipPermissions: true });
  });
});

describe("phase one: launch flags", () => {
  it("resolves each flag independently, last layer wins", () => {
    const flattened = flattenLayers(
      [layer(0, { launch: { skipPermissions: true, remoteControl: true } }), layer(1, { launch: { remoteControl: false } })],
      { home: FAKE_HOME },
    );
    expect(flattened.launch).toEqual({ skipPermissions: true, remoteControl: false });
  });

  it("resolves the provider selection last-layer-wins alongside the other flags", () => {
    const flattened = flattenLayers(
      [
        layer(0, { launch: { provider: "z" } }),
        layer(1, { launch: { skipPermissions: true } }),
        layer(2, { launch: { provider: "o" } }),
      ],
      { home: FAKE_HOME },
    );
    expect(flattened.launch).toEqual({ skipPermissions: true, provider: "o" });
  });

  it("resolves headroom last-layer-wins like every other launch flag", () => {
    const flattened = flattenLayers(
      [layer(0, { launch: { headroom: true } }), layer(1, { launch: { headroom: false } })],
      { home: FAKE_HOME },
    );
    expect(flattened.launch).toEqual({ headroom: false });
  });

  it("resolves trackUsage last-layer-wins, independently of headroom", () => {
    const flattened = flattenLayers(
      [layer(0, { launch: { trackUsage: true, headroom: true } }), layer(1, { launch: { trackUsage: false } })],
      { home: FAKE_HOME },
    );
    expect(flattened.launch).toEqual({ trackUsage: false, headroom: true });
  });
});

describe("matchingRules", () => {
  it("returns every matching rule ranked most-specific first", () => {
    const flattened = flattenLayers(
      [layer(0, { entries: { "knowledge/skills/*": true, "knowledge/skills/commit": false } })],
      { home: FAKE_HOME },
    );
    const ranked = matchingRules(flattened, "skills/commit");
    expect(ranked.map((rule) => rule.canonicalPattern)).toEqual(["skills/commit", "skills/*"]);
  });

  it("returns nothing for a path no rule matches", () => {
    const flattened = flattenLayers([layer(0, { entries: { "knowledge/skills/*": true } })], { home: FAKE_HOME });
    expect(matchingRules(flattened, "agents/foo")).toEqual([]);
  });
});

describe("phase one: launch proxyBypass", () => {
  it("takes the deepest layer's list whole, and an empty list clears the shallower ones", () => {
    const hosts = flattenLayers([layer(0, { launch: { proxyBypass: ["a.example.com"] } }), layer(1, { launch: { proxyBypass: ["b.example.com", "c.example.com"] } })], { home: FAKE_HOME });
    expect(hosts.launch).toEqual({ proxyBypass: ["b.example.com", "c.example.com"] });
    const cleared = flattenLayers([layer(0, { launch: { proxyBypass: ["a.example.com"] } }), layer(1, { launch: { proxyBypass: [] } })], { home: FAKE_HOME });
    expect(cleared.launch).toEqual({ proxyBypass: [] });
  });
});

describe("phase one: launch statusline", () => {
  it("merges key by key, so a deeper layer that sets the labels leaves a shallower layer's thresholds alone", () => {
    const flattened = flattenLayers(
      [
        layer(0, { launch: { statusline: { warnAt: 60, criticalAt: 85, barWidth: 8 } } }),
        layer(1, { launch: { statusline: { barWidth: 6, fiveHourLabel: "Session" } } }),
      ],
      { home: FAKE_HOME },
    );
    expect(flattened.launch.statusline).toEqual({ warnAt: 60, criticalAt: 85, barWidth: 6, fiveHourLabel: "Session" });
  });

  it("takes the deepest layer's list whole", () => {
    const flattened = flattenLayers([layer(0, { launch: { statusline: { header: ["model", "provider"] } } }), layer(1, { launch: { statusline: { header: ["identity"] } } })], { home: FAKE_HOME });
    expect(flattened.launch.statusline).toEqual({ header: ["identity"] });
  });

  it("leaves the setting absent when no layer sets it", () => {
    expect(flattenLayers([layer(0, { launch: { headroom: true } })], { home: FAKE_HOME }).launch).not.toHaveProperty("statusline");
  });
});

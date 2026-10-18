import { describe, expect, it } from "vitest";
import type { CatalogueModel } from "../providerCatalogue";

import type { Provider, ProviderCatalogue } from "../config/schema";
import { modelPickerSettings, modelPickerSettingsFromRows, providerModelRows, routedModelRows } from "./modelPicker";

const CREDENTIAL = { sources: [{ env: "PROVIDER_TOKEN" }] };

const codex = (config?: Extract<Provider, { kind: "codex" }>["codex"]): Provider => ({ kind: "codex", displayName: "Codex", credential: CREDENTIAL, ...(config === undefined ? {} : { codex: config }) });
const antigravity = (config?: Extract<Provider, { kind: "antigravity" }>["antigravity"]): Provider => ({ kind: "antigravity", displayName: "Antigravity", credential: CREDENTIAL, ...(config === undefined ? {} : { antigravity: config }) });
const http = (env?: Record<string, string>): Extract<Provider, { kind?: "http" }> => ({ kind: "http", displayName: "Z", baseUrl: "https://z.example/api", credential: CREDENTIAL, ...(env === undefined ? {} : { env }) });

const AUTO_DESCRIPTION = "Routes each request to a backend model with quota left, best first (4 models)";

/** An http provider carrying declared picker models. */
const withPicker = (pickerModels: readonly { model: string; tier: "fable" | "opus" | "sonnet" | "haiku"; label?: string; description?: string }[]): Provider => ({ ...http(), pickerModels: [...pickerModels] });

describe("providerModelRows", () => {
  it("lists a codex provider's distinct models once each, naming the tiers that reach them", () => {
    const rows = providerModelRows(codex({ models: { fable: "big", opus: "big", sonnet: "mid", haiku: "small" } }));
    expect(rows.map((row) => row.model)).toEqual(["big", "mid", "small"]);
    expect(rows.map((row) => row.label)).toEqual(["big", "mid", "small"]);
    expect(rows.map((row) => row.description)).toEqual(["Serves the fable and opus tiers", "Serves the sonnet tier", "Serves the haiku tier"]);
  });

  it("borrows each row's client-side handling from the highest tier that reaches it", () => {
    const rows = providerModelRows(codex({ models: { fable: "big", opus: "big", sonnet: "mid", haiku: "small" } }));
    expect(rows.map((row) => row.behavesAs)).toEqual(["claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  });

  it("applies the shipped codex mapping when the provider configures none", () => {
    const rows = providerModelRows(codex());
    expect(new Set(rows.map((row) => row.model)).size).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(1);
  });

  it("lists every backend model across an antigravity provider's tiers, marking a fallback as one", () => {
    const rows = providerModelRows(antigravity({ models: { fable: ["a", "b"], opus: ["b", "c"], sonnet: "c", haiku: "d" } }));
    expect(rows.map((row) => row.model)).toEqual(["auto", "a", "b", "c", "d"]);
    expect(rows.map((row) => row.description)).toEqual([
      AUTO_DESCRIPTION,
      "Serves the fable tier",
      "Serves the opus tier; fallback for fable",
      "Serves the sonnet tier; fallback for opus",
      "Serves the haiku tier",
    ]);
  });

  it("leads an antigravity provider's rows with the virtual auto model, which borrows the handling of its first candidate's tier", () => {
    const [first] = providerModelRows(antigravity({ models: { fable: "a", opus: "b", sonnet: "c", haiku: "d" } }));
    expect(first).toEqual({ model: "auto", label: "auto", description: AUTO_DESCRIPTION, behavesAs: "claude-fable-5-1" });
  });

  it("lists a configured alias under auto's own name once, first", () => {
    const rows = providerModelRows(antigravity({ models: { fable: "a", opus: "b", sonnet: "c", haiku: "d", auto: ["c", "d"] } }));
    expect(rows.filter((row) => row.model === "auto")).toHaveLength(1);
    expect(rows[0]?.model).toBe("auto");
  });

  it("takes the highest tier a model is the first choice of for its handling, and the highest reaching tier when it is only a fallback", () => {
    const rows = providerModelRows(antigravity({ models: { fable: ["a", "only-fallback"], opus: ["b", "only-fallback"], sonnet: "c", haiku: "d" } }));
    const fallback = rows.find((row) => row.model === "only-fallback");
    expect(fallback?.description).toBe("Fallback for fable and opus");
    expect(fallback?.behavesAs).toBe("claude-fable-5-1");
  });

  it("adds an antigravity alias as a row that resolves to its own candidates", () => {
    const rows = providerModelRows(antigravity({ models: { fable: "a", opus: "a", sonnet: "c", haiku: "d", flash: ["c", "d"] } }));
    const alias = rows.find((row) => row.model === "flash");
    expect(alias).toEqual({ model: "flash", label: "flash", description: "Alias for c, then d", behavesAs: "claude-sonnet-5-5" });
  });

  it("lists the distinct models an http provider's own env names for the tiers", () => {
    const rows = providerModelRows(http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5", ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5", ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-air" }));
    expect(rows.map((row) => [row.model, row.description, row.behavesAs])).toEqual([
      ["glm-5", "Serves the opus and sonnet tiers", "claude-opus-5-5"],
      ["glm-air", "Serves the haiku tier", "claude-haiku-5-5"],
    ]);
  });

  it("offers nothing for an http provider that names no tier model", () => {
    expect(providerModelRows(http())).toEqual([]);
    expect(providerModelRows(http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "" }))).toEqual([]);
  });
});

describe("declared picker models", () => {
  it("lists a declared model after the derived ones, with its tier's handling and its own label and description", () => {
    const rows = providerModelRows({ ...http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5" }), pickerModels: [{ model: "glm-air", tier: "haiku", label: "GLM Air", description: "Fast and cheap" }] });
    expect(rows.map((row) => row.model)).toEqual(["glm-5", "glm-air"]);
    expect(rows[1]).toEqual({ model: "glm-air", label: "GLM Air", description: "Fast and cheap", behavesAs: "claude-haiku-5-5" });
  });

  it("lists declared models for a provider whose tier settings name none, so the picker stops keeping Claude's own", () => {
    expect(providerModelRows(withPicker([{ model: "deepseek/r1", tier: "opus" }])).map((row) => row.model)).toEqual(["deepseek/r1"]);
    expect(modelPickerSettings(withPicker([{ model: "deepseek/r1", tier: "opus" }]))).toBeDefined();
  });

  it("lets a declared entry replace the derived row for the same model", () => {
    const rows = providerModelRows({ ...codex({ models: { fable: "big", opus: "big", sonnet: "mid", haiku: "small" } }), pickerModels: [{ model: "mid", tier: "opus", label: "Mid" }] } as Provider);
    expect(rows.map((row) => row.model)).toEqual(["big", "small", "mid"]);
    expect(rows.find((row) => row.model === "mid")).toMatchObject({ label: "Mid", behavesAs: "claude-opus-5-5" });
  });

  it("describes a declared model by its tier when it gives no description", () => {
    expect(providerModelRows({ ...http(), pickerModels: [{ model: "m", tier: "sonnet" }] })[0]?.description).toBe("Declared by the provider for the sonnet tier");
  });
});

describe("catalogue rows", () => {
  const catalogued = (catalogue: ProviderCatalogue, env?: Record<string, string>): Provider => ({ displayName: "Z", baseUrl: "https://z.example/api", credential: CREDENTIAL, ...(env === undefined ? {} : { env }), catalogue });
  const listed = [{ id: "zeta" }, { id: "alpha", name: "Alpha One" }, { id: "big[1m]" }];

  it("lists what the catalogue last listed, sorted, each borrowing the catalogue's tier", () => {
    const rows = providerModelRows(catalogued({ tier: "haiku" }), listed);
    expect(rows).toEqual([
      { model: "alpha", label: "alpha", description: "Listed by the provider as Alpha One", behavesAs: "claude-haiku-5-5" },
      { model: "big[1m]", label: "big", description: "Listed by the provider; 1M context", behavesAs: "claude-haiku-5-5" },
      { model: "zeta", label: "zeta", description: "Listed by the provider", behavesAs: "claude-haiku-5-5" },
    ]);
  });

  it("applies the include and exclude patterns", () => {
    expect(providerModelRows(catalogued({ tier: "sonnet", include: ["a*", "z*"], exclude: ["zeta"] }), listed).map((row) => row.model)).toEqual(["alpha"]);
  });

  it("lists tier models and declared models first and does not list a catalogue model they already name", () => {
    const provider: Provider = { ...catalogued({ tier: "sonnet" }, { ANTHROPIC_DEFAULT_OPUS_MODEL: "alpha" }), pickerModels: [{ model: "zeta", tier: "haiku" }] } as Provider;
    expect(providerModelRows(provider, listed).map((row) => row.model)).toEqual(["alpha", "zeta", "big[1m]"]);
  });

  it("does not repeat a model the provider names with the context marker when its catalogue lists it without", () => {
    const provider = catalogued({ tier: "sonnet" }, { ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5[1m]" });
    expect(providerModelRows(provider, [{ id: "glm-5" }, { id: "glm-4" }]).map((row) => row.model)).toEqual(["glm-5[1m]", "glm-4"]);
  });

  it("lists nothing from a catalogue the provider has not opted into, or that has not been fetched", () => {
    expect(providerModelRows(http(), listed)).toEqual([]);
    expect(providerModelRows(catalogued({ tier: "sonnet" }), [])).toEqual([]);
    expect(modelPickerSettings(catalogued({ tier: "sonnet" }))).toBeUndefined();
  });

  it("is passed to the settings the launch carries", () => {
    expect(JSON.parse(modelPickerSettings(catalogued({ tier: "sonnet" }), listed) ?? "")).toMatchObject({ modelPicker: { replaceBuiltInOptions: true, options: [{ model: "alpha" }, { model: "big[1m]" }, { model: "zeta" }] } });
  });
});

describe("the one-million-token context marker", () => {
  it("is dropped from a row's title, kept in the name it sends, and noted in its description", () => {
    const [row] = providerModelRows(http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3[1m]" }));
    expect(row).toEqual({ model: "glm-5.3[1m]", label: "glm-5.3", description: "Serves the opus tier; 1M context", behavesAs: "claude-opus-5-5" });
  });

  it("applies to declared models and aliases as well", () => {
    expect(providerModelRows(withPicker([{ model: "x[1m]", tier: "opus" }]))[0]).toMatchObject({ label: "x", description: "Declared by the provider for the opus tier; 1M context" });
  });
});

describe("modelPickerSettings", () => {
  it("replaces the built-in lineup with the provider's rows, as the JSON --settings takes", () => {
    const settings = modelPickerSettings(codex({ models: { fable: "big", opus: "big", sonnet: "mid", haiku: "small" } }));
    expect(JSON.parse(settings ?? "")).toEqual({
      modelPicker: {
        replaceBuiltInOptions: true,
        options: providerModelRows(codex({ models: { fable: "big", opus: "big", sonnet: "mid", haiku: "small" } })),
      },
    });
  });

  it("is undefined when the provider names no model, so the picker keeps its own", () => {
    expect(modelPickerSettings(http())).toBeUndefined();
  });

  it("appends the rows after Claude Code's own for a provider-less session that routes by name, whose bare names still reach Anthropic", () => {
    const rows = routedModelRows({ virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } } }, [["z", http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3" }), []] as const]);
    expect(JSON.parse(modelPickerSettingsFromRows(rows, false) ?? "")).toMatchObject({ modelPicker: { replaceBuiltInOptions: false } });
  });
});

describe("routedModelRows", () => {
  const providers: readonly (readonly [string, Provider, readonly CatalogueModel[]])[] = [
    ["z", http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3" }), []],
    ["m", http({ ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M2.7" }), []],
  ];

  it("lists the virtual models first, then every provider's models qualified with the provider's name", () => {
    const rows = routedModelRows({ virtual: { fast: { mode: "soonest-reset", members: ["z/glm-5.3"] } } }, providers);
    expect(rows.map((row) => row.model)).toEqual(["fast", "z/glm-5.3", "m/MiniMax-M2.7"]);
    expect(rows[0]).toMatchObject({ description: "Virtual (soonest-reset)", behavesAs: "claude-opus-5-5" });
    expect(rows[1]).toMatchObject({ label: "z / glm-5.3", description: "z: Serves the opus tier" });
  });

  it("lists one row per family offered by more than one target between the virtual models and the qualified rows, naming every target in its description", () => {
    const two: readonly (readonly [string, Provider, readonly CatalogueModel[]])[] = [
      ["z", http({ ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.1" }), []],
      ["s", http({ ANTHROPIC_DEFAULT_SONNET_MODEL: "hf:zai-org/GLM-5.1" }), []],
    ];
    const rows = routedModelRows({ virtual: { fast: { mode: "ordered", members: ["z/glm-5.1"] } }, families: { "glm-5-1": { mode: "cheapest" } } }, two);
    expect(rows.map((row) => row.model)).toEqual(["fast", "family:glm-5-1", "z/glm-5.1", "s/hf:zai-org/GLM-5.1"]);
    expect(rows[1]).toMatchObject({ label: "glm-5-1", description: "Family (cheapest): z/glm-5.1, s/hf:zai-org/GLM-5.1", behavesAs: "claude-haiku-5-5" });
  });

  it("lists no row for a family one target offers, and honours hide for a family row", () => {
    const one: readonly (readonly [string, Provider, readonly CatalogueModel[]])[] = [["z", http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3" }), []]];
    expect(routedModelRows({}, one).map((row) => row.model)).toEqual(["z/glm-5.3"]);
    const two: readonly (readonly [string, Provider, readonly CatalogueModel[]])[] = [["z", http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1" }), []], ["s", http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "hf:zai-org/GLM-5.1" }), []]];
    expect(routedModelRows({ hide: ["family:glm-5-1"] }, two).map((row) => row.model)).not.toContain("family:glm-5-1");
  });

  it("omits the bare virtual and family rows for a session that has not asked to route by name, keeping the qualified rows every session can serve", () => {
    const rows = routedModelRows({ virtual: { fast: { mode: "ordered", members: ["z/glm-5.1"] } }, families: { "glm-5-1": { mode: "cheapest" } } }, [["z", http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1" }), []], ["s", http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "hf:zai-org/GLM-5.1" }), []]], false);
    expect(rows.map((row) => row.model)).toEqual(["z/glm-5.1", "s/hf:zai-org/GLM-5.1"]);
  });

  it("keeps a virtual model's row when no member names a tier, handled as a sonnet, and one over a family takes its targets' handling", () => {
    const offered: readonly (readonly [string, Provider, readonly CatalogueModel[]])[] = [["z", http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1" }), []], ["s", http({ ANTHROPIC_DEFAULT_OPUS_MODEL: "hf:zai-org/GLM-5.1" }), []]];
    const rows = routedModelRows({ virtual: { unknown: { mode: "ordered", members: ["ghost/x"] }, across: { mode: "ordered", members: ["family:glm-5-1"] } } }, offered);
    expect(rows.find((row) => row.model === "unknown")?.behavesAs).toBe("claude-sonnet-5-5");
    expect(rows.find((row) => row.model === "across")?.behavesAs).toBe("claude-opus-5-5");
  });

  it("hides what the block hides and, when show is set, lists only what it names", () => {
    expect(routedModelRows({ hide: ["z/glm-5.3"] }, providers).map((row) => row.model)).not.toContain("z/glm-5.3");
    expect(routedModelRows({ show: ["fast"] , virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } } }, providers).map((row) => row.model)).toEqual(["fast"]);
  });

  it("keeps a virtual model's row when the provider's default-model env holds the same value as its tier default", () => {
    const rows = routedModelRows({ virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } } }, [["z", http({ ANTHROPIC_MODEL: "glm-5.3", ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3" }), []] as const]);
    expect(rows.map((row) => row.model)).toContain("fast");
  });
});

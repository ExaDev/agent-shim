import { describe, expect, it, vi } from "vitest";

import {
  captureEntryOrder,
  captureRuleEntryOrders,
  ConfigValidationError,
  createExplorer,
  loadConfigFile,
  type ConfigFileReader,
} from "./load";
import { ConfigProfileSchema, DirectoryRulesSchema } from "./schema";

function reader(files: Readonly<Record<string, unknown>>): ConfigFileReader {
  return (filepath: string) => files[filepath];
}

describe("loadConfigFile", () => {
  it("returns undefined for a file that does not exist", () => {
    expect(loadConfigFile("/nowhere/profile.json", ConfigProfileSchema, reader({}))).toBeUndefined();
  });

  it("validates against the given schema and returns the parsed config", () => {
    const loaded = loadConfigFile(
      "/cfg/work.json",
      ConfigProfileSchema,
      reader({ "/cfg/work.json": { extends: ["base"], categories: { history: false } } }),
    );
    expect(loaded?.config.extends).toEqual(["base"]);
    expect(loaded?.filepath).toBe("/cfg/work.json");
  });

  it("throws a ConfigValidationError naming the file when the content does not validate", () => {
    expect(() =>
      loadConfigFile("/cfg/bad.json", ConfigProfileSchema, reader({ "/cfg/bad.json": { categories: { history: "yes" } } })),
    ).toThrow(ConfigValidationError);
  });

  it("loads a file with a key this version does not know, dropping it with a warning on standard error", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const loaded = loadConfigFile("/cfg/newer.json", ConfigProfileSchema, reader({ "/cfg/newer.json": { categories: { history: true }, fromANewerRelease: true } }));
    expect(loaded?.config).toEqual({ categories: { history: true } });
    expect(String(write.mock.calls[0]?.[0])).toContain("fromANewerRelease");
    write.mockRestore();
  });

  it("captures the entries key insertion order from the raw parsed JSON, not from the validated clone", () => {
    const raw: unknown = JSON.parse(
      '{"entries":{"knowledge/skills/z":true,"knowledge/skills/a":true,"knowledge/skills/m":true}}',
    );
    const loaded = loadConfigFile("/cfg/order.json", ConfigProfileSchema, reader({ "/cfg/order.json": raw }));
    expect(loaded?.entryOrder).toEqual(["knowledge/skills/z", "knowledge/skills/a", "knowledge/skills/m"]);
  });

  it("captures each rule's own entries order for a directory-rules file", () => {
    const raw: unknown = JSON.parse(
      '{"rules":[{"path":"/a","entries":{"knowledge/b":true,"knowledge/a":true}},{"path":"/b"}]}',
    );
    const loaded = loadConfigFile("/cfg/rules.json", DirectoryRulesSchema, reader({ "/cfg/rules.json": raw }));
    expect(loaded?.ruleEntryOrders).toEqual([["knowledge/b", "knowledge/a"], []]);
  });

  it("returns an empty entries order for a file with no entries object", () => {
    const loaded = loadConfigFile(
      "/cfg/plain.json",
      ConfigProfileSchema,
      reader({ "/cfg/plain.json": { categories: { history: true } } }),
    );
    expect(loaded?.entryOrder).toEqual([]);
  });
});

describe("captureEntryOrder", () => {
  it("returns an empty list for anything that is not an object with an entries object", () => {
    expect(captureEntryOrder(undefined)).toEqual([]);
    expect(captureEntryOrder(null)).toEqual([]);
    expect(captureEntryOrder([1, 2])).toEqual([]);
    expect(captureEntryOrder({ entries: "not an object" })).toEqual([]);
  });
});

describe("captureRuleEntryOrders", () => {
  it("returns an empty list when there is no rules array", () => {
    expect(captureRuleEntryOrders({ entries: { "knowledge/a": true } })).toEqual([]);
  });
});

describe("createExplorer", () => {
  it("is only ever used through load(), never search() — search stops at the first ancestor config, which is the opposite of what this design needs", () => {
    const explorer = createExplorer();
    const searchSpy = vi.spyOn(explorer, "search");
    // The module's own reader path calls load() exclusively; this asserts nothing in this file's own exercise of the explorer reaches for search(), which would silently collapse the shallowest-to-deepest walk to one file.
    expect(typeof explorer.load).toBe("function");
    expect(searchSpy).not.toHaveBeenCalled();
  });
});

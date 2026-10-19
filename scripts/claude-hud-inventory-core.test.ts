import { describe, expect, it } from "vitest";

import { readClaudeHudInventory } from "./claude-hud-inventory-core";

const SOURCE = `
export type HudElement = 'project' | 'context';
export type FirstLineSegment = 'model' | 'project';
export const DEFAULT_CONFIG: HudConfig = {
  language: 'en',
  elementOrder: [...DEFAULT_ELEMENT_ORDER],
  gitStatus: { enabled: true, showDirty: true },
  display: { showModel: true, mergeGroups: [['context', 'usage']] },
};
`;

describe("readClaudeHudInventory", () => {
  it("lists every leaf of the default config by dotted path, treating a list as one leaf", () => {
    expect(readClaudeHudInventory(SOURCE).settings).toEqual(["language", "elementOrder", "gitStatus.enabled", "gitStatus.showDirty", "display.showModel", "display.mergeGroups"]);
  });

  it("reads the members of the element and first-line segment unions", () => {
    const inventory = readClaudeHudInventory(SOURCE);
    expect(inventory.elements).toEqual(["project", "context"]);
    expect(inventory.firstLineSegments).toEqual(["model", "project"]);
  });

  it("fails loudly when the default config or a union is missing", () => {
    expect(() => readClaudeHudInventory("export const x = 1;")).toThrow(/no DEFAULT_CONFIG/);
    expect(() => readClaudeHudInventory("export const DEFAULT_CONFIG = {};")).toThrow(/no union type named HudElement/);
  });
});

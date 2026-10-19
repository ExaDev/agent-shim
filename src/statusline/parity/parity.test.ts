import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { statuslineKeys } from "../keys";
import { CLAUDE_HUD_COMMIT } from "./inventory";
import { inventoryKeys, PARITY, parityGaps } from "./map";

const PARITY_DOC = path.join(__dirname, "..", "..", "..", "docs", "statusline-claude-hud-parity.md");

describe("the claude-hud parity map", () => {
  it("accounts only for keys the inventory holds", () => {
    const held = new Set(inventoryKeys());
    expect(Object.keys(PARITY).filter((key) => !held.has(key))).toEqual([]);
  });

  it("points every counterpart at a statusline setting that exists", () => {
    const settings = new Set(statuslineKeys().map((key) => key.path));
    const missing = Object.entries(PARITY).flatMap(([key, entry]) => ("setting" in entry && !settings.has(entry.setting) ? [`${key} -> ${entry.setting}`] : []));
    expect(missing).toEqual([]);
  });

  it("gives every not-applicable key a reason", () => {
    const unexplained = Object.entries(PARITY).flatMap(([key, entry]) => ("notApplicable" in entry && entry.notApplicable.trim() === "" ? [key] : []));
    expect(unexplained).toEqual([]);
  });

  it("lists the keys still to do as exactly the inventory keys with no entry", () => {
    expect(new Set(parityGaps())).toEqual(new Set(inventoryKeys().filter((key) => !(key in PARITY))));
  });

  it("records every accounted key, and the commit it was checked against, in the parity document", () => {
    const doc = fs.readFileSync(PARITY_DOC, "utf8");
    expect(doc).toContain(CLAUDE_HUD_COMMIT);
    expect(Object.keys(PARITY).filter((key) => !doc.includes(`\`${key}\``))).toEqual([]);
  });
});

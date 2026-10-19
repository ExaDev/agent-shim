import fs from "node:fs";
import path from "node:path";

import { CLAUDE_HUD_INVENTORY } from "../src/statusline/parity/inventory";
import { readClaudeHudInventory } from "./claude-hud-inventory-core";

/**
 * Prints the inventory of a claude-hud checkout (`src/config.ts`) as JSON, or with `--check` compares it with the inventory agent-shim's parity test holds and lists what differs. Usage: `node scripts/claude-hud-inventory.mts <claude-hud checkout> [--check]`, which bundles this file first.
 */
const [checkout, flag] = process.argv.slice(2);
if (checkout === undefined) {
  throw new Error("usage: node scripts/claude-hud-inventory.mts <claude-hud checkout> [--check]");
}
const inventory = readClaudeHudInventory(fs.readFileSync(path.join(checkout, "src", "config.ts"), "utf8"));
if (flag !== "--check") {
  console.log(JSON.stringify(inventory, null, 2));
} else {
  const differences = (name: string, held: readonly string[], read: readonly string[]): string[] => [
    ...read.filter((item) => !held.includes(item)).map((item) => `${name}: ${item} is in claude-hud and not in the inventory`),
    ...held.filter((item) => !read.includes(item)).map((item) => `${name}: ${item} is in the inventory and not in claude-hud`),
  ];
  const problems = [
    ...differences("settings", CLAUDE_HUD_INVENTORY.settings, inventory.settings),
    ...differences("elements", CLAUDE_HUD_INVENTORY.elements, inventory.elements),
    ...differences("firstLineSegments", CLAUDE_HUD_INVENTORY.firstLineSegments, inventory.firstLineSegments),
  ];
  console.log(problems.length === 0 ? "the inventory matches the checkout" : problems.join("\n"));
  process.exitCode = problems.length === 0 ? 0 : 1;
}

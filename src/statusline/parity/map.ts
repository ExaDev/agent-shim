import { CLAUDE_HUD_INVENTORY } from "./inventory";

/** What accounts for one claude-hud setting, element, segment or flag. */
export type ParityEntry =
  /** The agent-shim setting (a path `agent-shim statusline keys` lists) that does the same job, with how the two differ when they do. */
  | { readonly setting: string; readonly note?: string }
  /** Why agent-shim has no counterpart and needs none. */
  | { readonly notApplicable: string };

/**
 * Every claude-hud setting, element, first-line segment and flag that agent-shim's built-in statusline has dealt with: keys of the form `display.showModel`, `element:project`, `segment:model` and `flag:--extra-cmd`. One entry per key; the keys of `CLAUDE_HUD_INVENTORY` with no entry are the work still to do (`parityGaps`).
 */
export const PARITY: Readonly<Record<string, ParityEntry>> = {
  "display.showModel": { setting: "layout.header", note: "the model segment is drawn when the list names `model`" },
  "display.showProvider": { setting: "layout.header", note: "the provider segment is drawn when the list names `provider`" },
  "display.showUsage": { setting: "layout.rows", note: "the quota row is drawn when the list names `quota`" },
  "colors.context": { setting: "colours.context", note: "the colour below the warning threshold" },
  "colors.usage": { setting: "colours.usage", note: "the colour below the warning threshold; the default is green, as the bands have always drawn it" },
  "colors.warning": { setting: "colours.warning" },
  "colors.usageWarning": { setting: "colours.usageWarning", note: "the colour from bands.warnAt, where claude-hud's is from a fixed 75%" },
  "colors.critical": { setting: "colours.critical", note: "the colour from bands.criticalAt, where claude-hud's is from a fixed 90% for quota" },
  "colors.model": { setting: "colours.model" },
  "colors.label": { setting: "colours.label" },
  "colors.barFilled": { setting: "bar.filled" },
  "colors.barEmpty": { setting: "bar.empty" },
  "display.externalUsagePath": { notApplicable: "claude-hud reads a usage snapshot a separate tool writes; agent-shim computes the usage windows itself and draws them" },
  "display.externalUsageWritePath": { notApplicable: "claude-hud writes a snapshot for other tools to read; the built-in statusline is the consumer of agent-shim's usage data, not a producer for others" },
  "display.externalUsageFreshnessMs": { notApplicable: "it bounds the age of the snapshot claude-hud reads, and agent-shim reads none" },
};

/** Every key the inventory holds, in the form `PARITY` uses. */
export function inventoryKeys(): readonly string[] {
  return [
    ...CLAUDE_HUD_INVENTORY.settings,
    ...CLAUDE_HUD_INVENTORY.elements.map((element) => `element:${element}`),
    ...CLAUDE_HUD_INVENTORY.firstLineSegments.map((segment) => `segment:${segment}`),
    ...CLAUDE_HUD_INVENTORY.flags.map((flag) => `flag:${flag}`),
  ];
}

/** The inventory's keys that `PARITY` has no entry for: what remains to be built or ruled out. */
export function parityGaps(): readonly string[] {
  return inventoryKeys().filter((key) => !(key in PARITY));
}

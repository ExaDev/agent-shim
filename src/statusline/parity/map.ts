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
  "display.showProject": { setting: "layout.header", note: "the project segment is drawn when the list names `project`" },
  "display.showAddedDirs": { setting: "layout.rows", note: "with `project.addedDirsLayout` `row`, the added directories are drawn when the list names `addedDirs`; with `inline` they ride on the project segment, so they are drawn when `layout.header` names `project`, and claude-hud's way of drawing them with no project path is not offered (choose `row`)" },
  "display.addedDirsLayout": { setting: "project.addedDirsLayout", note: "`inline` or `row`, where claude-hud's second value is `line`" },
  pathLevels: { setting: "project.pathLevels", note: "written as text (`\"1\"`, `\"2\"`, `\"3\"` or `\"full\"`), because every choice setting takes a closed set of strings" },
  "gitStatus.enabled": { setting: "git.enabled", note: "turns git off for the vcs segment and the gitFiles row; the segment is still drawn for a Jujutsu repository when `jj.enabled` is on" },
  "gitStatus.showDirty": { setting: "git.showDirty" },
  "gitStatus.showAheadBehind": { setting: "git.showAheadBehind" },
  "gitStatus.showFileStats": { setting: "layout.rows", note: "the changed-files line is drawn when the list names `gitFiles`; the total lines changed that claude-hud also draws in the branch block under this flag is its own setting, `git.showLineDiff`" },
  "gitStatus.branchOverflow": { setting: "git.branchOverflow", note: "under `truncate` a vcs segment listed straight after the project segment joins it into one unit, and under `wrap` the two are separate segments" },
  "gitStatus.pushWarningThreshold": { setting: "git.pushWarnAt", note: "0 turns it off, as in claude-hud" },
  "gitStatus.pushCriticalThreshold": { setting: "git.pushCriticalAt", note: "0 turns it off, as in claude-hud" },
  "jjStatus.enabled": { setting: "jj.enabled" },
  "jjStatus.showDirty": { setting: "jj.showDirty" },
  "jjStatus.showConflicts": { setting: "jj.showConflicts" },
  "colors.project": { setting: "colours.project" },
  "colors.git": { setting: "colours.git" },
  "colors.gitBranch": { setting: "colours.gitBranch" },
  "element:project": { setting: "layout.header", note: "claude-hud's project line is the `project` segment (the path and, inline, the added directories) and the `vcs` segment (git or jj), listed in the order the line should draw them" },
  "element:addedDirs": { setting: "layout.rows", note: "the `addedDirs` row, drawn when `project.addedDirsLayout` is `row`" },
  "segment:project": { setting: "layout.header", note: "claude-hud's first-line project segment holds the path, the added directories and the branch; here that is the `project` and `vcs` segments, positioned by `layout.header`" },
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

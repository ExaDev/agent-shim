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
  "display.usageValue": { setting: "usage.value", note: "`used` and `remaining` where claude-hud's are `percent` and `remaining`; the bar and the colour follow the share used either way, as in claude-hud" },
  "display.usageBarEnabled": { setting: "usage.bar", note: "text alone is one line with the windows joined by a separator, as in claude-hud" },
  "display.showResetLabel": { setting: "usage.resetLabel", note: "off by default, where claude-hud's is on, so the default row is unchanged; a window with nothing still to reset is never introduced with `resets in`, and an elapsed share is never introduced either" },
  "display.usageCompact": { setting: "usage.compact", note: "takes precedence over `usage.bar`; the windows are named by `labels.fiveHour` and `labels.sevenDay` where claude-hud's are a fixed `5h` and `7d`, and the reset label is never drawn, as in claude-hud" },
  "display.showModelScopedUsage": { setting: "usage.modelScoped", note: "off by default, where claude-hud's is on, so the default row is unchanged; the windows come from the client's `rate_limits.model_scoped` and describe the signed-in account, so a session that selected a provider never draws them, and each is named by the client's own display name" },
  "display.timeFormat": { setting: "usage.timeFormat", note: "the same forms under the same names; `relative` is agent-shim's own duration form (`1h 30m`, `4d 1h`, `45s` under a minute, and `available`) and the default, and an elapsed share is drawn only for a window whose length is known (the five-hour and weekly windows and a provider's own windows, not a model family's)" },
  "display.hourCycle": { setting: "clock.hourCycle", note: "a group of its own, since claude-hud applies it to every wall-clock time its display draws, not only the usage windows'; written as `Intl.DateTimeFormat`'s hour cycles, `auto` following the system locale" },
  "display.showClockSeconds": { setting: "clock.seconds", note: "a group of its own for the same reason as `clock.hourCycle`" },
  "display.sevenDayThreshold": { setting: "usage.sevenDayThreshold", note: "0 by default, which always draws the weekly window, where claude-hud's default is 80; a weekly window with no five-hour window beside it is always drawn, as in claude-hud, and the hidden window still counts towards `usage.threshold`" },
  "display.usageThreshold": { setting: "usage.threshold", note: "hides the whole row until a window has reached it, counting the weekly window and the per-model windows; the colour bands (`bands.warnAt`, `bands.criticalAt`) are a separate setting that only colours what is drawn, where claude-hud's usage colours are fixed at 75% and 90%" },
  "element:usage": { setting: "layout.rows", note: "the quota row is drawn when the list names `quota`; claude-hud's `limit reached` notice is not drawn: a window at its limit is a full bar, or a figure of 100% in the critical colour" },
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
  "display.modelFormat": { setting: "model.format", note: "the same three formats: full, compact and short" },
  "display.modelOverride": { setting: "model.override", note: "replaces the client's name only: a dynamic mode's served model still follows it, since that says what is answering" },
  "display.modelSource": { setting: "model.source", note: "`client` is claude-hud's `stdin`; the transcript is read backwards a chunk at a time until the newest assistant record is found, so the work follows how far back that record is and not the transcript's length, and a record further back than a fixed read budget leaves the client's name in place" },
  "display.providerName": { setting: "provider.name", note: "a label shown in place of the launch's provider name, or alone for a launch with no provider; agent-shim does not detect Bedrock, Vertex, MiniMax or enterprise model aliases from the environment, because the provider segment names the provider the launch selected" },
  "display.showAuth": { setting: "account.parts", note: "the account segment already draws the login's plan, so the plan is the `plan` part of that segment, drawn when the list names it and the segment is in `layout.header`; there is no separate auth segment, and an ambient `ANTHROPIC_API_KEY` is not reported as `API Key`, since a launch with one is refused unless the person opts in" },
  "display.showAuthUser": { setting: "account.parts", note: "the `user` part of the account segment, which is the login's whole email address where claude-hud shows its local part" },
  "display.authUserLength": { setting: "account.userLength", note: "cuts the whole email address, not its local part, and `0` is no limit as in claude-hud; the default shows the address whole, as the account segment always has" },
  "display.showEffortLevel": { setting: "layout.header", note: "the effort segment is drawn when the list names `effort`, as its own segment where claude-hud writes it inside the model badge; claude-hud's `ultracode(<level>)`, which it infers from `/effort` wording in the transcript, is not drawn, because a bounded read of the transcript's end cannot say whether ultracode is still on" },
  "display.effortFormat": { setting: "effort.format", note: "the same three formats: full, symbol and text" },
  "display.showAdvisor": { setting: "layout.header", note: "the advisor segment is drawn when the list names `advisor`" },
  "display.advisorOverride": { setting: "advisor.override" },
  "display.showClaudeCodeVersion": { setting: "layout.header", note: "the version segment is drawn when the list names `version`; it reads the version the client puts in its payload, where claude-hud runs `claude --version`" },
  "display.showOutputStyle": { setting: "layout.header", note: "the outputStyle segment is drawn when the list names `outputStyle`, in the header where claude-hud puts it in its environment line; the style is read from the same four settings files in the same order" },
  "segment:model": { setting: "layout.header", note: "claude-hud's model badge holds the provider, the model and the effort; the `provider`, `model` and `effort` segments are listed in the order they should draw, and the context bar is its own row" },
  "segment:advisor": { setting: "layout.header", note: "the `advisor` segment, placed in the list" },
  "segment:version": { setting: "layout.header", note: "the `version` segment, placed in the list" },
  "segment:auth": { setting: "layout.header", note: "the `account` segment, placed in the list; `account.parts` chooses what it says" },
  "display.showSessionName": { setting: "layout.header", note: "the session name segment is drawn when the list names `sessionName`: the title `/rename` gave the session, else the name Claude Code generated for it" },
  "display.showDuration": { setting: "layout.header", note: "the duration segment is drawn when the list names `duration`, counted from the first timestamp in the transcript" },
  "display.showSessionStartDate": { setting: "sessionTime.parts", note: "the start is drawn when the list names `started`, on the `sessionTime` row (`layout.rows`)" },
  "display.showLastResponseAt": { setting: "sessionTime.parts", note: "the time since the last response is drawn when the list names `lastReply`, on the `sessionTime` row (`layout.rows`)" },
  "display.showCompactions": { setting: "layout.rows", note: "the compactions row is drawn when the list names `compactions`; it stays hidden until the first compaction, and its count ends in a plus when the transcript was too big to count in full" },
  "display.showSpeed": { setting: "layout.header", note: "the speed segment is drawn when the list names `speed`; it measures against the previous refresh's sample, kept in the statusline cache, and estimates from the transcript's growth when the client reports no output tokens" },
  "display.showPromptCache": { setting: "layout.rows", note: "the prompt cache row is drawn when the list names `promptCache`; the expiry is a clock time written under `clock.hourCycle` and `clock.seconds`, in the machine's locale and time zone" },
  "display.promptCacheTtlSeconds": { setting: "promptCache.ttlSeconds", note: "the lifetime used until the transcript shows which tier the session writes" },
  "element:sessionTime": { setting: "layout.rows", note: "the `sessionTime` row, whose parts `sessionTime.parts` chooses" },
  "element:promptCache": { setting: "layout.rows", note: "the `promptCache` row" },
  "segment:sessionName": { setting: "layout.header", note: "the `sessionName` segment" },
  "segment:duration": { setting: "layout.header", note: "the `duration` segment" },
  "segment:speed": { setting: "layout.header", note: "the `speed` segment" },
  "display.showCost": { setting: "layout.header", note: "the cost segment is drawn when the list names `cost`: the client's own figure, else an estimate priced from the door's usage log" },
  "display.showRoutedCost": { setting: "cost.routed", note: "a routed session is one whose launch selected a provider, or whose model id is a cloud platform's; its cost is priced from the door's own record of each request, which claude-hud has no equivalent of, before the client's figure" },
  "display.showDailyCost": { setting: "layout.header", note: "the daily cost segment is drawn when the list names `dailyCost`; independent of the cost segment, as in claude-hud, and kept in a ledger under the agent-shim home" },
  "display.showConfigCounts": { setting: "layout.rows", note: "the environment row is drawn when the list names `environment`" },
  "display.showMemoryUsage": { setting: "layout.rows", note: "the memory row is drawn when the list names `memory`" },
  "display.environmentThreshold": { setting: "environment.threshold", note: "the fewest configuration items, in total, for the environment row to draw its counts" },
  "element:memory": { setting: "layout.rows", note: "the memory row, a bar of the memory in use with its figures" },
  "element:environment": { setting: "layout.rows", note: "the environment row, the counts of CLAUDE.md files, rules, MCP servers and hook events" },
  "segment:cost": { setting: "layout.header", note: "the cost segment, `Cost` for the client's own figure and `Est.` for a priced estimate" },
  "display.showContextBar": { setting: "context.bar", note: "claude-hud's boolean is `shown` or `hidden` here; hidden draws the figures as one line of text, so the row stays and only its bar goes" },
  "display.contextValue": { setting: "context.value", note: "the same four values; the default `both` writes the tokens held over the window before the bar and the percentage after it, where claude-hud writes `45% (45k/200k)` after it, and the percentage keeps one decimal" },
  "display.autoCompactWindow": { setting: "context.autoCompactWindow", note: "a window in tokens to measure against, unset where claude-hud has `null`, meaning the model's own window; while it is set the row draws nothing until the client reports the tokens held, where claude-hud counts them as 0, since the percentage the client reports is against a different window; the percentage keeps one decimal and the tokens shown are over that window, as in claude-hud" },
  "display.autocompactBuffer": { setting: "context.estimate", note: "claude-hud estimates the percentage, with its autocompact reserve added when `enabled` and without when `disabled`, whenever the client reports none, or reports 0 beside tokens already held; agent-shim draws nothing then unless `estimate` is `raw` (claude-hud's `disabled`) or `buffered` (its `enabled`), so the default leaves what the line has always drawn alone, and keeps a reported 0 when no estimate can be made" },
  "display.contextWarningThreshold": { setting: "context.warnAt", note: "the whole percentage at which the context bar turns yellow, unset by default, in which case it follows `bands.warnAt`, where claude-hud's default is 70" },
  "display.contextCriticalThreshold": { setting: "context.criticalAt", note: "the whole percentage at which the context bar turns red and the breakdown appears, unset by default, in which case it follows `bands.criticalAt`, where claude-hud's default is 85" },
  "display.showTokenBreakdown": { setting: "context.breakdown", note: "`critical` adds the input and cache tokens of the last request to the context row from `context.criticalAt`, as claude-hud does at its critical threshold; the default is `never`, where claude-hud's is on" },
  "display.showSessionTokens": { setting: "layout.rows", note: "the token totals are the `tokens` row, drawn when the list names it and off by default as in claude-hud; its figures come from the session's transcript, summed once per response, where a response is the adjacent records of the transcript sharing a message id (claude-hud counts a message id once wherever it recurs in the transcript), and read incrementally by the reader the session rows share, so a total ends in a plus while the reader is catching up with a transcript too big to read at once, and are drawn as `Tokens 102k (in: 5.0k, out: 7.2k, cache: 90k)` on a line of their own, where claude-hud puts them on a line of their own in its expanded layout and as `tok:` among the first line's segments in its compact one" },
  "element:context": { setting: "layout.rows", note: "the context row is drawn when the list names `context`, and the list sets where it sits among the other rows" },
  maxWidth: { setting: "layout.maxWidth", note: "the width drawn for when the client and the COLUMNS variable name none, as claude-hud's fallback is; 0 is claude-hud's null, and the width then falls to 80 where claude-hud draws without wrapping" },
  forceMaxWidth: { setting: "layout.forceMaxWidth", note: "uses layout.maxWidth whatever the client reports; a launch that forces a width without setting one is refused, where claude-hud ignores the flag" },
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

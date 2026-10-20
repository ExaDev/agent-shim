# Built-in statusline and claude-hud

The built-in statusline (`agent-shim statusline`) is being brought to the feature and configuration set of stock [claude-hud](https://github.com/jarrodwatts/claude-hud) (MIT licensed). It is implemented from claude-hud's observed behaviour, not copied from its code, and the project is credited here as the specification. Anything agent-shim does not copy is recorded below with its reason.

The inventory of what claude-hud offers is read from its `src/config.ts` and held in `src/statusline/parity/inventory.ts`, at the commit named below. `node scripts/claude-hud-inventory.mts <claude-hud checkout> --check` compares it with a checkout, and a test refuses a table row for a setting agent-shim does not have. The settings themselves are listed, with their kinds, defaults and meanings, by `agent-shim statusline keys`.

Checked against claude-hud at commit `939eb66`.

| claude-hud | agent-shim |
|---|---|
| `display.showModel` | `layout.header`: the model segment is drawn when the list names `model` |
| `display.showProvider` | `layout.header`: the provider segment is drawn when the list names `provider` |
| `display.showUsage` | `layout.rows`: the quota row is drawn when the list names `quota` |
| `display.usageValue` | `usage.value`: `used` and `remaining` where claude-hud's are `percent` and `remaining`; the bar and the colour follow the share used either way, as in claude-hud |
| `display.usageBarEnabled` | `usage.bar`: text alone is one line with the windows joined by a separator, as in claude-hud |
| `display.showResetLabel` | `usage.resetLabel`: off by default, where claude-hud's is on, so the default row is unchanged; a window with nothing still to reset is never introduced with `resets in`, and an elapsed share is never introduced either |
| `display.usageCompact` | `usage.compact`: takes precedence over `usage.bar`; the windows are named by `labels.fiveHour` and `labels.sevenDay` where claude-hud's are a fixed `5h` and `7d`, and the reset label is never drawn, as in claude-hud |
| `display.showModelScopedUsage` | `usage.modelScoped`: off by default, where claude-hud's is on, so the default row is unchanged; the windows come from the client's `rate_limits.model_scoped` and describe the signed-in account, so a session that selected a provider never draws them, and each is named by the client's own display name |
| `display.timeFormat` | `usage.timeFormat`: the same forms under the same names; `relative` is agent-shim's own duration form (`1h 30m`, `4d 1h`, `45s` under a minute, and `available`) and the default, and an elapsed share is drawn only for a window whose length is known (the five-hour and weekly windows and a provider's own windows, not a model family's) |
| `display.hourCycle` | `clock.hourCycle`: a group of its own, since claude-hud applies it to every wall-clock time its display draws, not only the usage windows'; written as `Intl.DateTimeFormat`'s hour cycles, `auto` following the system locale |
| `display.showClockSeconds` | `clock.seconds`: a group of its own for the same reason as `clock.hourCycle` |
| `display.sevenDayThreshold` | `usage.sevenDayThreshold`: 0 by default, which always draws the weekly window, where claude-hud's default is 80; a weekly window with no five-hour window beside it is always drawn, as in claude-hud, and the hidden window still counts towards `usage.threshold` |
| `display.usageThreshold` | `usage.threshold`: hides the whole row until a window has reached it, counting the weekly window and the per-model windows; the colour bands (`bands.warnAt`, `bands.criticalAt`) are a separate setting that only colours what is drawn, where claude-hud's usage colours are fixed at 75% and 90% |
| `element:usage` | `layout.rows`: the quota row is drawn when the list names `quota`; claude-hud's `limit reached` notice is not drawn: a window at its limit is a full bar, or a figure of 100% in the critical colour |
| `colors.context` | `colours.context`: the colour below the warning threshold |
| `colors.usage` | `colours.usage`: the colour below the warning threshold; the default is green, as the bands have always drawn it |
| `colors.warning` | `colours.warning` |
| `colors.usageWarning` | `colours.usageWarning`: the colour from `bands.warnAt`, where claude-hud's is from a fixed 75% |
| `colors.critical` | `colours.critical`: the colour from `bands.criticalAt`, where claude-hud's is from a fixed 90% for quota |
| `colors.model` | `colours.model` |
| `colors.label` | `colours.label` |
| `colors.barFilled` | `bar.filled` |
| `colors.barEmpty` | `bar.empty` |
| `display.showProject` | `layout.header`: the project segment is drawn when the list names `project` |
| `display.showAddedDirs` | `layout.rows`: with `project.addedDirsLayout` `row`, the added directories are drawn when the list names `addedDirs`; with `inline` they ride on the project segment, so they are drawn when `layout.header` names `project`, and claude-hud's way of drawing them with no project path is not offered (choose `row`) |
| `display.addedDirsLayout` | `project.addedDirsLayout`: `inline` or `row`, where claude-hud's second value is `line` |
| `pathLevels` | `project.pathLevels`: written as text (`"1"`, `"2"`, `"3"` or `"full"`), because every choice setting takes a closed set of strings |
| `gitStatus.enabled` | `git.enabled`: turns git off for the vcs segment and the gitFiles row; the segment is still drawn for a Jujutsu repository when `jj.enabled` is on |
| `gitStatus.showDirty` | `git.showDirty` |
| `gitStatus.showAheadBehind` | `git.showAheadBehind` |
| `gitStatus.showFileStats` | `layout.rows`: the changed-files line is drawn when the list names `gitFiles`; the total lines changed that claude-hud also draws in the branch block under this flag is its own setting, `git.showLineDiff` |
| `gitStatus.branchOverflow` | `git.branchOverflow`: under `truncate` a vcs segment listed straight after the project segment joins it into one unit, and under `wrap` the two are separate segments |
| `gitStatus.pushWarningThreshold` | `git.pushWarnAt`: 0 turns it off, as in claude-hud |
| `gitStatus.pushCriticalThreshold` | `git.pushCriticalAt`: 0 turns it off, as in claude-hud |
| `jjStatus.enabled` | `jj.enabled` |
| `jjStatus.showDirty` | `jj.showDirty` |
| `jjStatus.showConflicts` | `jj.showConflicts` |
| `colors.project` | `colours.project` |
| `colors.git` | `colours.git` |
| `colors.gitBranch` | `colours.gitBranch` |
| `element:project` | `layout.header`: claude-hud's project line is the `project` segment (the path and, inline, the added directories) and the `vcs` segment (git or jj), listed in the order the line should draw them |
| `element:addedDirs` | `layout.rows`: the `addedDirs` row, drawn when `project.addedDirsLayout` is `row` |
| `segment:project` | `layout.header`: claude-hud's first-line project segment holds the path, the added directories and the branch; here that is the `project` and `vcs` segments, positioned by `layout.header` |
| `display.modelFormat` | `model.format`: the same three formats: full, compact and short |
| `display.modelOverride` | `model.override`: replaces the client's name only: a dynamic mode's served model still follows it, since that says what is answering |
| `display.modelSource` | `model.source`: `client` is claude-hud's `stdin`; the transcript is read backwards a chunk at a time until the newest assistant record is found, so the work follows how far back that record is and not the transcript's length, and a record further back than a fixed read budget leaves the client's name in place |
| `display.providerName` | `provider.name`: a label shown in place of the launch's provider name, or alone for a launch with no provider; agent-shim does not detect Bedrock, Vertex, MiniMax or enterprise model aliases from the environment, because the provider segment names the provider the launch selected |
| `display.showAuth` | `account.parts`: the account segment already draws the login's plan, so the plan is the `plan` part of that segment, drawn when the list names it and the segment is in `layout.header`; there is no separate auth segment, and an ambient `ANTHROPIC_API_KEY` is not reported as `API Key`, since a launch with one is refused unless the person opts in |
| `display.showAuthUser` | `account.parts`: the `user` part of the account segment, which is the login's whole email address where claude-hud shows its local part |
| `display.authUserLength` | `account.userLength`: cuts the whole email address, not its local part, and `0` is no limit as in claude-hud; the default shows the address whole, as the account segment always has |
| `display.showEffortLevel` | `layout.header`: the effort segment is drawn when the list names `effort`, as its own segment where claude-hud writes it inside the model badge; claude-hud's `ultracode(<level>)`, which it infers from `/effort` wording in the transcript, is not drawn, because a bounded read of the transcript's end cannot say whether ultracode is still on |
| `display.effortFormat` | `effort.format`: the same three formats: full, symbol and text |
| `display.showAdvisor` | `layout.header`: the advisor segment is drawn when the list names `advisor` |
| `display.advisorOverride` | `advisor.override` |
| `display.showClaudeCodeVersion` | `layout.header`: the version segment is drawn when the list names `version`; it reads the version the client puts in its payload, where claude-hud runs `claude --version` |
| `display.showOutputStyle` | `layout.header`: the outputStyle segment is drawn when the list names `outputStyle`, in the header where claude-hud puts it in its environment line; the style is read from the same four settings files in the same order |
| `segment:model` | `layout.header`: claude-hud's model badge holds the provider, the model and the effort; the `provider`, `model` and `effort` segments are listed in the order they should draw, and the context bar is its own row |
| `segment:advisor` | `layout.header`: the `advisor` segment, placed in the list |
| `segment:version` | `layout.header`: the `version` segment, placed in the list |
| `segment:auth` | `layout.header`: the `account` segment, placed in the list; `account.parts` chooses what it says |
| `display.showSessionName` | `layout.header`: the session name segment is drawn when the list names `sessionName`: the title `/rename` gave the session, else the name Claude Code generated for it |
| `display.showDuration` | `layout.header`: the duration segment is drawn when the list names `duration`, counted from the first timestamp in the transcript |
| `display.showSessionStartDate` | `sessionTime.parts`: the start is drawn when the list names `started`, on the `sessionTime` row (`layout.rows`) |
| `display.showLastResponseAt` | `sessionTime.parts`: the time since the last response is drawn when the list names `lastReply`, on the `sessionTime` row (`layout.rows`) |
| `display.showCompactions` | `layout.rows`: the compactions row is drawn when the list names `compactions`; it stays hidden until the first compaction, and its count ends in a plus when the transcript was too big to count in full |
| `display.showSpeed` | `layout.header`: the speed segment is drawn when the list names `speed`; it measures against the previous refresh's sample, kept in the statusline cache, and estimates from the transcript's growth when the client reports no output tokens |
| `display.showPromptCache` | `layout.rows`: the prompt cache row is drawn when the list names `promptCache`; the expiry is a clock time written under `clock.hourCycle` and `clock.seconds`, in the machine's locale and time zone |
| `display.promptCacheTtlSeconds` | `promptCache.ttlSeconds`: the lifetime used until the transcript shows which tier the session writes |
| `element:sessionTime` | `layout.rows`: the `sessionTime` row, whose parts `sessionTime.parts` chooses |
| `element:promptCache` | `layout.rows`: the `promptCache` row |
| `segment:sessionName` | `layout.header`: the `sessionName` segment |
| `segment:duration` | `layout.header`: the `duration` segment |
| `segment:speed` | `layout.header`: the `speed` segment |
| `display.showCost` | `layout.header`: the cost segment is drawn when the list names `cost`: the client's own figure, else an estimate priced from the door's usage log |
| `display.showRoutedCost` | `cost.routed`: a routed session is one whose launch selected a provider, or whose model id is a cloud platform's; its cost is priced from the door's own record of each request, which claude-hud has no equivalent of, before the client's figure |
| `display.showDailyCost` | `layout.header`: the daily cost segment is drawn when the list names `dailyCost`; independent of the cost segment, as in claude-hud, and kept in a ledger under the agent-shim home |
| `display.showConfigCounts` | `layout.rows`: the environment row is drawn when the list names `environment` |
| `display.showMemoryUsage` | `layout.rows`: the memory row is drawn when the list names `memory` |
| `display.environmentThreshold` | `environment.threshold`: the fewest configuration items, in total, for the environment row to draw its counts |
| `element:memory` | `layout.rows`: the memory row, a bar of the memory in use with its figures |
| `element:environment` | `layout.rows`: the environment row, the counts of CLAUDE.md files, rules, MCP servers and hook events |
| `segment:cost` | `layout.header`: the cost segment, `Cost` for the client's own figure and `Est.` for a priced estimate |
| `display.externalUsagePath` | Not applicable: claude-hud reads a usage snapshot a separate tool writes; agent-shim computes the usage windows itself and draws them |
| `display.externalUsageWritePath` | Not applicable: claude-hud writes a snapshot for other tools to read; the built-in statusline is the consumer of agent-shim's usage data, not a producer for others |
| `display.externalUsageFreshnessMs` | Not applicable: it bounds the age of the snapshot claude-hud reads, and agent-shim reads none |

## Project and version control

The `project`, `vcs`, `addedDirs` and `gitFiles` elements read the working directory from the client's payload (`cwd`, else `workspace.current_dir`) and run `git` and `jj` without a shell through the statusline's ports, each bounded in time and output. The vcs segment asks git for the fewest things the settings need: one command for the branch alone, or one that reads the branch, the upstream's ahead and behind counts, dirtiness and the changed files together, and further ones only for what is drawn: the lines changed, the repository root to order the changed files by when they were modified, and a name for a detached HEAD. claude-hud runs a command for each of the branch, the status, the ahead and behind counts and the remote.

Two behaviours of claude-hud have no setting and are not reproduced. It wraps the project path, the added directories, the branch and each changed file in terminal hyperlinks (a `file:` link, and a GitHub link built from the `origin` remote); agent-shim draws them as plain text, which keeps the line's width exact and spares the remote lookup. On Windows it runs git through a long-lived worker process so that it can end a hung command's process tree; agent-shim's bounded run port ends the command it started and uses the same path on every platform.
## Cost and machine information

A direct session's cost is the client's own `cost.total_cost_usd`, drawn as `Cost`. Where the client reports none (an older client, or before the first response), the door's usage log stands in: every request the door served for the conversation is priced from the per-model prices `agent-shim model price` stores, keyed `<provider>/<model>`, with cache writes and reads priced at Anthropic's published ratios of the input price, and drawn as `Est.`. A request whose model has no configured price makes the whole estimate absent, since a total that left a request out would read lower than the bill. A conversation is the client's own session id, which the door records from each request's header beside the launch's id, because clearing the conversation starts a new id and a new client cost inside one launch; a client that sends no id gets no estimate. agent-shim ships no price table, so an estimate exists only for models the person has priced.

A routed session's own figure is not a bill, so claude-hud hides it for Bedrock and Vertex model ids unless `showRoutedCost` is set. agent-shim treats a launch that selected a provider the same way, and `cost.routed` opts in. Where the door served the session, its own record of each request is the more accurate source, so it is preferred over the client's figure; the client's figure is used only when the door gives none and it is above zero.

Today's spend is a ledger of the conversations the statusline has drawn, in the statusline's state directory under the agent-shim home: one file for each conversation for each local day, summed on read, so conversations drawing at the same moment cannot overwrite one another. Like claude-hud's, it counts a conversation from its first sighting and resets at local midnight. A conversation that was drawn on the day before, within the last day, starts the new day from the total it had then, so the spend between its last render and its first of the new day counts towards the new day, because nothing says where in the gap it fell. Days before the one preceding today are removed, and a day dated after today (the clock was set back) is left alone. A conversation is bound to the source of its first figure (the client's, or the door's estimate), and a figure from the other source is not counted. So a routed conversation that started on the door's estimate, and later shows the client's own figure because the door has no complete estimate (a switch to an unpriced model, say), stops adding to Today from then on, keeping what it had added, while the cost segment draws the new figure on its own scale. It records whichever cost the conversation shows, so a routed session contributes only when `cost.routed` is set.

The environment row reads a configuration file only up to a fixed size (a global file over it holds nothing for the row, so servers and hook events only it names are not counted), because each draw parses what it reads whole. It counts as claude-hud does (one for each CLAUDE.md file, each Markdown file under a rules directory, each MCP server per scope and each hook event) and differs in two ways: it pluralises its labels, and a project `.claude` directory that is the user's own is read once, wholly as the user scope. The output style and MCP error names that claude-hud draws on the same line are accounted for under `display.showOutputStyle` and `display.showMcp`.

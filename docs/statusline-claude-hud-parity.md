# Built-in statusline and claude-hud

The built-in statusline (`agent-shim statusline`) is being brought to the feature and configuration set of stock [claude-hud](https://github.com/jarrodwatts/claude-hud) (MIT licensed). It is implemented from claude-hud's observed behaviour, not copied from its code, and the project is credited here as the specification. Anything agent-shim does not copy is recorded below with its reason.

The inventory of what claude-hud offers is read from its `src/config.ts` and held in `src/statusline/parity/inventory.ts`, at the commit named below. `node scripts/claude-hud-inventory.mts <claude-hud checkout> --check` compares it with a checkout, and a test refuses a table row for a setting agent-shim does not have. The settings themselves are listed, with their kinds, defaults and meanings, by `agent-shim statusline keys`.

Checked against claude-hud at commit `939eb66`.

| claude-hud | agent-shim |
|---|---|
| `display.showModel` | `layout.header`: the model segment is drawn when the list names `model` |
| `display.showProvider` | `layout.header`: the provider segment is drawn when the list names `provider` |
| `display.showUsage` | `layout.rows`: the quota row is drawn when the list names `quota` |
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
| `display.externalUsagePath` | Not applicable: claude-hud reads a usage snapshot a separate tool writes; agent-shim computes the usage windows itself and draws them |
| `display.externalUsageWritePath` | Not applicable: claude-hud writes a snapshot for other tools to read; the built-in statusline is the consumer of agent-shim's usage data, not a producer for others |
| `display.externalUsageFreshnessMs` | Not applicable: it bounds the age of the snapshot claude-hud reads, and agent-shim reads none |

## Project and version control

The `project`, `vcs`, `addedDirs` and `gitFiles` elements read the working directory from the client's payload (`cwd`, else `workspace.current_dir`) and run `git` and `jj` without a shell through the statusline's ports, each bounded in time and output. The vcs segment asks git for the fewest things the settings need: one command for the branch alone, or one that reads the branch, the upstream's ahead and behind counts, dirtiness and the changed files together, and further ones only for what is drawn: the lines changed, the repository root to order the changed files by when they were modified, and a name for a detached HEAD. claude-hud runs a command for each of the branch, the status, the ahead and behind counts and the remote.

Two behaviours of claude-hud have no setting and are not reproduced. It wraps the project path, the added directories, the branch and each changed file in terminal hyperlinks (a `file:` link, and a GitHub link built from the `origin` remote); agent-shim draws them as plain text, which keeps the line's width exact and spares the remote lookup. On Windows it runs git through a long-lived worker process so that it can end a hung command's process tree; agent-shim's bounded run port ends the command it started and uses the same path on every platform.

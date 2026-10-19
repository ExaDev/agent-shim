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
| `display.externalUsagePath` | Not applicable: claude-hud reads a usage snapshot a separate tool writes; agent-shim computes the usage windows itself and draws them |
| `display.externalUsageWritePath` | Not applicable: claude-hud writes a snapshot for other tools to read; the built-in statusline is the consumer of agent-shim's usage data, not a producer for others |
| `display.externalUsageFreshnessMs` | Not applicable: it bounds the age of the snapshot claude-hud reads, and agent-shim reads none |

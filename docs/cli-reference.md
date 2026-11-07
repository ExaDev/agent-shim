# CLI reference

The full flag/command reference table, the complete command list, `configure`'s file-to-write-to precedence, the PATH-shadow check behind `doctor`, and the `check`/`doctor` debugging commands. Verbatim from an earlier README.md.

## CLI reference

| What you're setting | Global (persistent) | Temporary (this run only) | Directory-scoped (persistent) |
|---|---|---|---|
| **Identity** | `agent-shim identity use <name>` / `agent-shim @<name>` (writes `~/.agent-shim/active-identity`) | `agent-shim run @<name>` or `agent-shim run --identity <name>` / `claude @<name>` (needs `agent-shim shim enable`) / `AGENT_SHIM_IDENTITY=<name> claude` (same; an inherited `CLAUDE_CONFIG_DIR` outranks the variable but not `@<name>` or `--identity`, see [the escape hatch](configuration-model.md#identities)) | `agent-shim rule add <path> --identity <name>`; or `.agent-shim.json`'s `"identity"` |
| **Pool** | `agent-shim pool add <name> --identity <a> --identity <b>` defines one; `agent-shim pool use <name>` / `agent-shim @pool:<name>` selects it persistently | `agent-shim run @pool:<name>` or `--identity pool:<name>` / `AGENT_SHIM_IDENTITY=pool:<name>`; `--wait` sleeps when every member is refused | rule's `identity` as `pool:<name>`; or `.agent-shim.json`'s `"identity"` |
| **Configuration profile** | `agent-shim profile use <name>`; or `agent-shim identity set <identity> --default-profile <profile>` | `claude --config-profile <name>` / `AGENT_SHIM_CONFIG_PROFILE=<name> claude` | `agent-shim rule add <path> --config-profile <name>`; or `.agent-shim.json`'s `"configProfile"` |
| **A category** | `agent-shim profile set <name> --category history=true`; or `agent-shim configure` | `claude --category history=true [--category knowledge=false ...]` / `AGENT_SHIM_CATEGORY_OVERRIDE="history=true,knowledge=false"` | `agent-shim configure` run from inside the ruled directory; or `.agent-shim.json`'s `"categories"` |
| **An individual entry** | `agent-shim profile set <name> --entry "<category>/<path>=true"`; or `agent-shim configure <path>` | `claude --share <path> [--share <path> ...]` / `claude --hide <path>` / `AGENT_SHIM_ENTRY_OVERRIDE="path=true,otherpath=false"` | `agent-shim configure <path>` run from inside the ruled directory; or `.agent-shim.json`'s `"entries"` |
| **Skip permissions** | `agent-shim profile set <name> --launch-skip-permissions` (or `--no-launch-skip-permissions`); `launch.skipPermissions` in any cascade layer | `claude --skip-permissions` / `claude --no-skip-permissions` / `AGENT_SHIM_SKIP_PERMISSIONS=true claude` | rule's inline `"launch"` field; or `.agent-shim.json`'s `"launch"` |
| **Remote Control** | `agent-shim profile set <name> --launch-remote-control` (or `--no-launch-remote-control`); `launch.remoteControl` in any cascade layer | `claude --remote-control` / `claude --no-remote-control` / `AGENT_SHIM_REMOTE_CONTROL=true claude` | rule's inline `"launch"` field; or `.agent-shim.json`'s `"launch"` |
| **Provider** | `agent-shim provider add <name> ...` defines one (under `~/.agent-shim/providers/`); `agent-shim profile set <name> --launch-provider <provider>` pins it; `agent-shim identity set <identity> --provider <provider>` makes it the default for launches on one identity, beneath every other layer | `claude --provider <name>` / `claude --no-provider` (opts one launch out of whatever the cascade selects) | rule's inline `"launch": { "provider": ... }` field; or `.agent-shim.json`'s `"launch"` |
| **Headroom routing** | `agent-shim profile set <name> --launch-headroom` (or `--no-launch-headroom`); a `launch.headroom` key in `~/.agent-shim/config.json` or any cascade layer; the daemon's own `source`, `idleShutdownMinutes` and token-saving settings (`mode`, `targetRatio`, `ccr`, `rolloutChannel`, `interceptToolResults`, `readMaturation`) live in that file's global-only `headroom` block | `claude --headroom` / `claude --no-headroom` / `AGENT_SHIM_HEADROOM=true claude` | rule's inline `"launch": { "headroom": true }` field; or `.agent-shim.json`'s `"launch"` |
| **Claude Code version** | `agent-shim profile set <name> --launch-claude-version <version>` (or `--no-launch-claude-version`); a `launch.claudeVersion` key in `~/.agent-shim/config.json` or any cascade layer | `claude --claude-version <version>` / `AGENT_SHIM_CLAUDE_VERSION=<version> claude` | rule's inline `"launch": { "claudeVersion": "2.1.220" }` field; or `.agent-shim.json`'s `"launch"` |
| **Models (cascade)** | `models` in a configuration profile, directory rule or committed `.agent-shim.json`; any definition may be `null` to remove what the shallower layers set | not applicable (the global `models` block is the first layer) | the committed file's `models` merges like any other layer |
| **Launch delay and pause** | `agent-shim profile set <name> --launch-delay <duration>` (or `--no-launch-delay`) and `--launch-pause` (or `--no-launch-pause`); `launch.delay` and `launch.pause` keys in `~/.agent-shim/config.json` or any cascade layer | `claude --delay <duration>` / `claude --pause` / `claude --no-pause` / `AGENT_SHIM_DELAY=5s claude` / `AGENT_SHIM_PAUSE=true claude` | a rule's inline `"launch": { "delay": "5s" }` field; or `.agent-shim.json`'s `"launch"` |
| **Explain a pool pick** | `agent-shim profile set <name> --launch-explain` (or `--no-launch-explain`); a `launch.explain` key in `~/.agent-shim/config.json` or any cascade layer | `claude --explain` / `claude --no-explain` / `AGENT_SHIM_EXPLAIN=true claude` | a rule's inline `"launch": { "explain": true }` field; or `.agent-shim.json`'s `"launch"` |
| **Hosts kept off the front door** | `agent-shim profile set <name> --launch-proxy-bypass <host> [--launch-proxy-bypass <host> ...]` (replaces the list; `--no-launch-proxy-bypass` clears it); a `launch.proxyBypass` list in `~/.agent-shim/config.json` or any cascade layer | `AGENT_SHIM_PROXY_BYPASS="mcp.example.com,.example.org" claude` (comma-separated; replaces the cascade's list for one launch) | a rule's inline `"launch": { "proxyBypass": [...] }` field; or `.agent-shim.json`'s `"launch"` |
| **Statusline appearance** | `agent-shim profile set <name> --statusline <setting>=<value> [--statusline ...]`, and `--unset-statusline <setting>` to remove one (`agent-shim statusline keys` lists the settings); a `launch.statusline` object in `~/.agent-shim/config.json` or any cascade layer | `AGENT_SHIM_STATUSLINE='{"bar":{"width":6}}' claude` (a JSON object; replaces the cascade's settings for one launch and for every render of that session) | a rule's inline `"launch": { "statusline": {...} }` field; or `.agent-shim.json`'s `"launch"` |
| **Usage tracking** | `agent-shim profile set <name> --launch-track-usage` (or `--no-launch-track-usage`); a `launch.trackUsage` key in `~/.agent-shim/config.json` or any cascade layer | `claude --track-usage` / `claude --no-track-usage` / `AGENT_SHIM_TRACK_USAGE=true claude` | rule's inline `"launch": { "trackUsage": true }` field; or `.agent-shim.json`'s `"launch"` |
| **Identity credential** | `agent-shim identity set <name> --credential <source> [--credential-target oauthToken]` (in its `identity.json`); `--no-credential` returns it to its stored login | not applicable | not applicable: a credential belongs to the identity, not a directory |
| **Ambient-credential guard** | `agent-shim identity set <name> --allow-ambient-credential` (per identity, in its `identity.json`) | `AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL=true claude` | not applicable: this guard is about the active identity's own credential, not a directory context. Deliberately identity-only, with no cascade key, because it is a security setting |

Every boolean launch setting is decided the same way: its command-line flag outright, then its environment variable, then the cascade, then the setting's default (off, except `trackUsage`, which is on so every launch reaches the front door). Every boolean environment variable (`AGENT_SHIM_SKIP_PERMISSIONS`, `AGENT_SHIM_REMOTE_CONTROL`, `AGENT_SHIM_HEADROOM`, `AGENT_SHIM_TRACK_USAGE`, `AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL`, `AGENT_SHIM_DEBUG`) reads `true`/`1` or `false`/`0`, the same vocabulary a `--category history=true` value uses; the empty string counts as unset, and anything else is refused as a usage error rather than read as false. So `AGENT_SHIM_SKIP_PERMISSIONS=0` switches off a profile's `skipPermissions: true` for one launch.

The scriptable `agent-shim profile set ...` commands exist alongside the interactive picker specifically so this is automatable: CI, setup scripts, or a `.agent-shim.json` generator never need to drive a prompt. Every list-valued flag takes one value per occurrence and repeats for more (`claude --share <path> --share <path>`, `agent-shim profile set work --category history=true --category knowledge=false`, `agent-shim profile add acme --extends base --extends work`); no flag splits its value on commas. The two list-valued environment variables, which cannot repeat, are the exception: `AGENT_SHIM_CATEGORY_OVERRIDE` and `AGENT_SHIM_ENTRY_OVERRIDE` each hold a comma-separated list of `<key>=<bool>` pairs. A `--share`/`--hide` path (and the `AGENT_SHIM_ENTRY_OVERRIDE` env var's keys) still needs its `<category>/` prefix like every other entries key (e.g. `claude --share knowledge/skills/commit`); see [Category-based sharing](configuration-model.md#category-based-sharing). The same spelling never means two things: the launch flag is `--headroom`, the profile setting that stores it is `--launch-headroom`.

The launcher recognises its own flags only before a `--` terminator. Everything from `--` onwards is forwarded to Claude Code verbatim, so `claude mcp add n -- cmd --provider x` keeps `--provider x` for `cmd`. `@<name>` is recognised only as the very first argument; `--identity <name>` is its explicit form, and naming two different identities through both is a usage error. `CLAUDE_EXTRA_FLAGS` (below) is a different thing entirely, a passthrough to the real Claude Code binary, not a `agent-shim` override: it's a single opaque string, split on whitespace before being appended to the real binary's argv, so a flag value that itself needs an embedded space isn't expressible through it.

A launch that selects an identity with no `identity.json`, or a configuration profile with no file, is refused with exit 1 naming the missing name and how it was selected, rather than silently creating a brand-new login for a mistyped `@name` or launching with a cascade layer missing. On a terminal, the launcher first offers to create it.

### Output, errors and prompts

Every `list`, `show`, `check`, `doctor` and `status` command prints human-readable text by default and JSON with `--json`. `provider show`, `identity show`, `check` and `doctor` describe a credential by its source kinds and target (a variable name, a path, a program, a 1Password reference, a Keychain service) and never read or print a value; a `literal` source's placeholder is not printed either. `--credential <source>` takes `env:<VAR>`, `file:<path>`, `command:<program and arguments>`, `op:<op://reference>`, `keychain:<service>[:<account>]`, `literal:<placeholder>` or a JSON source object, repeats for an ordered list, and replaces the whole list on `set` (see [Credentials](configuration-model.md#credentials)).

`identity list` prints `(id: <id>)` after a name that differs from the identity's id, and after every name more than one identity claims, so each can be renamed with `identity rename <id> <new> --id`; `identity show` prints the directory, which is named by the id. `identity list` and `identity show` also print the account email, organisation, role and plan of each identity's stored login, read from its `.claude.json` (the same source as `account show`, never the token), and `identity list` keeps identities that share a login (the same account in the same organisation) next to each other. An identity with no stored login, such as one that authenticates from a credential block or has never signed in, prints nothing for those fields. An identity whose `identity.json` cannot be read is printed with `[unreadable: <reason>]` in the list and `Unreadable: <reason>` in `show`, and one whose file an interrupted resync left in a superseded farm with `[displaced: <what puts it back>]` and `Displaced: ...`; `--json` carries `problem` for both and `displaced: true` for the second. `--json` carries them as `account` (`emailAddress`, `organizationName`, `organizationType`, `organizationRole`, `billingType`, `seatTier`, each only when present) and `sharesLoginWith` (the other identities holding the same login); a profile that cannot be read is reported as `accountProblem` instead of failing the command.

Prompts appear only when standard input is a terminal and input the command needs is missing. Without a terminal, the command fails with the option that supplies that input instead of silently skipping it: `identity use` and the `@<name>` shortcut refuse a missing identity rather than offering the setup wizard, `identity set --default-profile`, `rule add --config-profile` and `profile use` refuse a missing profile rather than offering to create it, `profile add` with no options creates an empty profile rather than walking through its categories, and every `remove` needs `--yes` rather than asking for confirmation. `configure` is interactive by nature and refuses to run without a terminal. `NO_COLOR` is honoured by the prompts, the only coloured output agent-shim produces.

| Exit status | Meaning |
|---|---|
| 0 | Success, including `--help` and `--version` |
| 1 | A failure: a missing identity, profile, provider or rule, an invalid config file, a refused launch, a `doctor` finding that failed, or a `check --strict` warning |
| 2 | A usage error: an unknown command or option, a malformed flag or environment value, or required input missing with no terminal to prompt on |
| 64 | A selected provider's or the launching identity's credential block yields no token, including when every remaining source needs a person and there is no terminal or desktop session (`EX_USAGE`) |

Every failure prints as `agent-shim: <message>` on standard error. An unexpected error (a bug, not a known failure) prints its message the same way; set `AGENT_SHIM_DEBUG=1` to add its stack trace. `AGENT_SHIM_FRONTDOOR_CAPTURE=1`, set on a launch that starts or restarts the front door, records the door's CONNECT targets and piped exchanges (redacted, byte-capped) to `~/.agent-shim/logs/frontdoor-capture.jsonl`; see [Headroom routing](configuration-model.md#headroom-routing).

`agent-shim completion <bash|zsh|fish>` prints a completion script generated from the command tree itself, so it covers exactly the commands and options that exist: `source <(agent-shim completion bash)` in `~/.bashrc`, `source <(agent-shim completion zsh)` in `~/.zshrc` after `compinit`, or `agent-shim completion fish | source` in fish's config. It completes subcommands and long options at every level, and the launch flags after `run`.

### Full command list

```
agent-shim <noun> <verb> [name] [options]      # nouns: identity, profile, pool, provider, rule (credential acts on the credentials they use)

agent-shim identity add <name> [--agent <claude|codex>] [--keep-keychain-login] [--json]
agent-shim identity list [--json]
agent-shim identity show <name> [--json]
agent-shim identity set <name> [--label <text> | --no-label] [--default-profile <profile> | --no-default-profile] [--provider <provider> | --no-provider] [--[no-]allow-ambient-credential]
agent-shim identity set <name> [--credential <source>]... [--credential-target <bearer|apiKey|oauthToken>] [--no-credential]
agent-shim identity set <name> [--anchor <days>@<HH:MM>[/<zone>]]... [--no-anchor]
agent-shim identity set <name> [--credential-cache] [--credential-cache-ttl <ttl>] [--credential-cache-store <keychain|file>] [--no-credential-cache]
agent-shim identity remove <name> [--yes] [--json]   # deletes the directory, its stored token, its cached credential (never one recorded for another identity whose id names the same file; one cached before owners were recorded names no owner and is deleted whichever identity whose id names that file cached it) and its usage snapshot
agent-shim identity rename <old> <new> [--id | --move] [--dry-run | --move --discard-journal] [--json]   # without --move the name alone changes, and --id takes <old> as the identity's id; see the configuration model
agent-shim identity use <name>
agent-shim @<name>                          # shorthand for `identity use <name>`
agent-shim identity resolve-conflicts <name>  # interactively resolve a retained superseded farm's conflicts

agent-shim profile add [name] [--extends <profile>]... [--description <text>]   # interactive with no options on a terminal
agent-shim profile set <name> [--category <category>=<bool>]... [--entry <category>/<path>=<bool>]...
agent-shim profile set <name> [--extends <profile>]... [--no-extends] [--description <text> | --no-description]
agent-shim profile set <name> [--[no-]launch-skip-permissions] [--[no-]launch-remote-control] [--[no-]launch-headroom] [--[no-]launch-track-usage]
agent-shim profile set <name> [--launch-claude-version <version> | --no-launch-claude-version]
agent-shim profile set <name> [--launch-delay <duration> | --no-launch-delay] [--[no-]launch-pause] [--[no-]launch-explain] [--launch-proxy-bypass <host>... | --no-launch-proxy-bypass]
agent-shim profile set <name> [--statusline <setting>=<value>]... [--unset-statusline <setting>]...
agent-shim profile set <name> [--launch-provider <provider> | --no-launch-provider]
agent-shim profile list [--json]
agent-shim profile show <name> [--json]
agent-shim profile remove <name> [--yes]
agent-shim profile use <name>               # the global default configuration profile

agent-shim pool add <name> --identity <member>... [--preference <score|listed>] [--resume-on-limit] [--compact-before-limit] [--compact-at-utilisation <percent>]
agent-shim pool set <name> [--identity <member>...] [--preference <score|listed> | --no-preference] [--resume-on-limit | --no-resume-on-limit] [--compact-before-limit | --no-compact-before-limit] [--compact-at-utilisation <percent> | --no-compact-at-utilisation]
agent-shim pool list [--json]
agent-shim pool show <name> [--json]
agent-shim pool remove <name> [--yes]
agent-shim pool use <name>                   # the active selection becomes pool:<name>
agent-shim pool pick <name> [--json]         # the ranking a launch from here would act on; records nothing

agent-shim provider add <name> --display-name <name> (--base-url <url> | --kind codex) (--credential <source>)... [--credential-target <bearer|apiKey>] [--env KEY=VALUE]...
                                              [--codex-default-model <model>] [--codex-model <tier=model>]... [--codex-effort <none|low|medium|high>] [--codex-login <codex-cli|chatgpt-sign-in>]
agent-shim provider set <name> [--display-name <name>] ([--base-url <url>] | --kind codex) [--credential <source>]... [--credential-target <bearer|apiKey>] [--env KEY=VALUE]... [--unset-env KEY]...
agent-shim provider set <name> [--credential-cache] [--credential-cache-ttl <ttl>] [--credential-cache-store <keychain|file>] [--no-credential-cache]
                                              [--codex-default-model <model>] [--codex-model <tier=model>]... [--codex-effort <none|low|medium|high>] [--codex-login <codex-cli|chatgpt-sign-in>]
agent-shim provider add|set <name> [--picker-model <model=tier>]...   # models /model lists beside the tier models; set also takes [--unset-picker-model <model>]...
agent-shim provider add|set <name> [--catalogue-tier <tier>] [--catalogue-include <glob>]... [--catalogue-exclude <glob>]... [--catalogue-url <url>]   # http providers: list the provider's own catalogue in /model; set also takes [--unset-catalogue]
agent-shim provider models <name> [--refresh] [--json]   # the catalogue last fetched, and which of its models /model lists
agent-shim provider list [--json]
agent-shim provider show <name> [--json]
agent-shim model match [--json]
agent-shim model add <name> --mode <ordered|most-allowance|soonest-reset|spread|adaptive|lowest-latency|highest-success|cheapest> --member <ref>...
agent-shim model set <name> [--mode <mode>] [--member <ref>]...
agent-shim model remove <name> [--yes] [--json]
agent-shim model tier <fable|opus|sonnet|haiku> --ref <ref> | --clear
agent-shim model price <ref> --input <usd> --output <usd> | --clear
agent-shim model same <ref> <ref>...   # assert these refs are one model under several names
agent-shim model distinct <left> <right>   # assert two alike names are two models
agent-shim model unassert <ref>
agent-shim model family <key> [--mode <mode>] [--name <ref>]... [--context <tokens>] [--[no-]vision|tools|thinking] | --clear
agent-shim model list [--json]
agent-shim model explain <name>   # which member the virtual model's mode picks now, and why
agent-shim provider remove <name> [--yes]              # deletes its definition and file-cached credential, not a Keychain-cached credential
agent-shim provider rename <old> <new> [--json]
agent-shim provider unalias <alias> [--json]

agent-shim rule add <path> [--config-profile <profile>] [--identity <identity>]
agent-shim rule set <path> [--config-profile <profile> | --no-config-profile] [--identity <identity> | --no-identity]
agent-shim rule list [--json]
agent-shim rule show <path> [--json]
agent-shim rule remove <path> [--yes]

agent-shim credential store <identity>                 # token on standard input
agent-shim credential warm [<identity> | --provider <name>]
agent-shim credential forget [<identity> | --provider <name>]
agent-shim credential push <identity> <host> [--provider <name>]   # identity pushes require a destination agent-shim with the versioned lock receiver; refused, writing nothing, when no identity there has the name (add it there, unless identity list there already shows it), more than one claims it (rename all but one there with --id), its id there is not an ASCII letter or digit followed by ASCII letters, digits and . _ @ - no longer than the longest name, or the cache file there holds a credential recorded for another owner; for the last two, rename that identity aside there with identity rename, identity add the name and push again, which leaves the one renamed aside as it was; a provider's push over another owner's entry is refused too (another provider defined there whose name names the same file is renamed there with provider rename, and an entry no provider there reads is removed with credential forget --provider); the entry records its owner, which a host running a release from before owners were recorded reads as no entry, so upgrade that host first

agent-shim configure [path] [--identity <identity>]
agent-shim check [path] [--identity <identity>] [--json] [--strict]
agent-shim doctor [--json]
agent-shim headroom status [--json]
agent-shim headroom enable|disable [--session <id>] [--now] [--json]   # which sessions go through headroom, live; applied at each session's next cache boundary unless --now
agent-shim codex status [--json]
agent-shim codex login [--no-open] [--json]       # Sign in with ChatGPT, for providers with `codex.login: chatgpt-sign-in`
agent-shim codex logout [--json]
agent-shim frontdoor status [--json]        # also probes the serving door's two listeners and reports whether each accepted
agent-shim frontdoor restart [--json]        # replace the serving door in place; running sessions reach it on their next request
agent-shim frontdoor rc list [--json]
agent-shim frontdoor rc status [<cse_id>] [--json]   # every tracked session (named, with its identity, model, process id and working directory where known), then every registered one the door holds no record of; see below
agent-shim frontdoor rc pending [<cse_id>] [--json]
agent-shim frontdoor rc send --session <cse_id> --text <text> [--json]
agent-shim frontdoor rc answer --session <cse_id> --request <id> --approve | --deny [--text <text>] [--json]
agent-shim frontdoor rc answer --session <cse_id> --request <id> (--choose <question>:<option> | --other <question>:<text>)... [--json]   # answer a pending question; see docs/rc-questions.md
agent-shim frontdoor rc interrupt --session <cse_id> [--json]
agent-shim frontdoor rc set-model --session <cse_id> --model <model> [--json]
agent-shim frontdoor rc set-permission-mode --session <cse_id> --mode <mode> [--json]
agent-shim frontdoor rc end-session --session <cse_id> [--reason <text>] [--json]
agent-shim frontdoor rc get-usage --session <cse_id> [--skip-behaviors] [--json]
agent-shim frontdoor rc get-context-usage --session <cse_id> [--detail <summary|full>] [--json]
agent-shim frontdoor rc read-file --session <cse_id> --path <path> [--max-bytes <n>] [--encoding <utf-8|base64>] [--json]
agent-shim frontdoor rc file-suggestions --session <cse_id> --query <prefix> [--json]
agent-shim frontdoor rc keep-alive --session <cse_id> [--json]
agent-shim frontdoor rc mcp-status --session <cse_id> [--json]
agent-shim frontdoor rc mcp-reconnect --session <cse_id> --server <name> [--json]
agent-shim frontdoor rc mcp-authenticate --session <cse_id> --server <name> --redirect-uri <uri> [--json]
agent-shim frontdoor rc mcp-oauth-callback-url --session <cse_id> --server <name> --callback-url <url> [--json]
agent-shim frontdoor rc teleport --session <cse_id> --marker <text> [--json]
agent-shim frontdoor rc goal get|clear --session <cse_id> [--wait-ms <ms>] [--json]   # through a supervised session's control plugin or the self-hosted surface; see docs/rc-slash-commands.md
agent-shim frontdoor rc goal set --session <cse_id> --condition <text> [--wait-ms <ms>] [--json]   # a directive to the session's model
agent-shim frontdoor rc compact --session <cse_id> [--instructions <text>] [--wait-ms <ms>] [--json]   # waits for the compaction's outcome
agent-shim frontdoor rc watch [<cse_id>] [--json]
agent-shim frontdoor rc events [<cse_id> | --all] [--since <cursor>] [--json]   # every observed session's appearances, endings, worker state changes and pending-request births and retirements, resumable by cursor; see rc-session-events.md
agent-shim job add <name> (--identity <name> | --pool <name>) (--at <days>@<HH:MM>[/<zone>]... | --before-reset <fiveHour|sevenDay> --lead <duration>) --prompt <text> --timeout <duration> [--cwd <dir>] [--model <model>] [--allowed-tool <tool>]... [--json]
agent-shim job list [--json]
agent-shim job show <name> [--json]
agent-shim job remove <name> [--yes] [--json]
agent-shim job run <name>
agent-shim statusline keys [--json]          # every statusline setting with its kind, default (if it has one) and meaning
agent-shim statusline                          # serve as a statusline entrypoint: enrich the client's stdin payload with the identity's live provider, account and usage windows, then delegate to $AGENT_SHIM_STATUSLINE_CMD or render the built-in line
agent-shim usage [--identity <name>] [--provider <name>] [--since <duration>] [--refresh] [--resets] [--json]
agent-shim account show [<identity>] [--refresh] [--json]
agent-shim session list [--identity <name>] [--all] [--json]   # sessions that spawned agents or ran workflows, newest transcript first
agent-shim session show <session> [--identity <name>] [--json]   # the session id or an unambiguous prefix
agent-shim mcp [--allow-writes] [--allow-remote-control] [--allow-remote-control-directives] [--allow-history]      # serve the door's typed API as MCP tools on stdio; read-only without the flags
agent-shim mcp permissions show [--json]               # what the stored file allows
agent-shim mcp permissions allow|deny <writes|remote-control|remote-control-directives|history>   # change it; a running server follows on its next request, with no restart
agent-shim update [--check] [--restart-door] [--mode <off|notify|auto>] [--json]
agent-shim completion <bash|zsh|fish>
agent-shim shim enable [--dir <path>] [--force]
agent-shim shim disable [--dir <path>] [--force]

agent-shim run [@<identity>] [launch flags] [claude arguments]
  # launch flags, recognised only before a `--` terminator:
  #   --identity <name>  --config-profile <name>  --provider <name> | --no-provider
  #   --category <category>=<bool>  --share <category>/<path>  --hide <category>/<path>   (each repeatable)
  #   --[no-]skip-permissions  --[no-]remote-control  --[no-]headroom  --[no-]track-usage  --[no-]wait
  #   --claude-version <version>   run exactly this installed Claude Code version
  #   --delay <duration>   wait this long after the launcher's own output before starting claude; --[no-]pause waits for a key press instead
  #   --[no-]explain   with @pool:<name>, list every member the pick ranked and why, not only the one picked
  #   --[no-]pick   on a terminal, ask which identity to run as, even when one resolved (--no-pick never asks); a launch also asks by itself when no identity resolves, a pool pick would change account or organisation, or the identity is refused right now
  #   --native   run the real claude with nothing from agent-shim applied; cannot be combined with the flags above
claude @<identity> ...                      # the same, once `agent-shim shim enable` has run
```

`identity add` refuses, on macOS, when the Keychain already holds a Claude Code login filed for the directory the new identity would be created in (left by an identity stored there that was moved with `identity rename --move` or removed), because the new identity would start signed in as that account; the message names the entry and the `security delete-generic-password` command that removes it. `--keep-keychain-login` creates the identity signed in as that account on purpose, and if another identity holds that login the two share it.

### Remote Control session status

`frontdoor rc status`, `GET /rest/rc/status`, the `rc_status` MCP tool and the library's `RcSessionStatus` all report one entry per observed session, and an entry carries `identity`, `model`, `name`, `pid` and `cwd` beside its worker state and pending requests. A field the door has no source for is absent from the entry, never blank or null. Sessions are addressed by their `cse_` id in every verb (several sessions can share a name), so `rc status` is how a name is mapped to its id.

The sources are:

- `identity`: the identity the launch runs as, shown by name. The door takes the launcher's identity header when a request carries one and otherwise the identity recorded in the launch's front-door registry entry, found through the capability the launch's tunnel presents. The second is the one that matters here: a Remote Control worker or bridge call carries none of the launcher's custom headers (observed with Claude Code 2.1.289 and 2.1.319). A launch from before the entry recorded its identity, and a session that did not come through this machine's door, report none from the door; the registry then contributes one only if an identity has a registry of its own.
- `model`: the `model` in the worker registration's `external_metadata` or in the session's `init` event, whichever came later.
- `name`, `pid`: the Claude Code session registry, one file per live session process under `<configuration directory>/sessions`, joined to the door's session by its `bridgeSessionId`. An entry whose process has exited is ignored, and of several live entries for one session the most recently updated is read.
- `cwd`: the `cwd` in the session's `init` event, else the registry's.

The registry is read on every status request, through every identity's configuration directory, so an identity added after the door started is searched. Identities share one registry by default (sessions are history, which is shared), so it is read once and says nothing about which identity launched a session in it. A session found in no registry (it runs on another host, has not written its entry yet, or lives in a directory no identity of this door uses) is reported with only what the door itself observed.

#### Per session kind

The three ways a session reaches Remote Control differ in who plays the service, not in what the status reports. The door's session id is the service's `cse_` id in every kind, and the registry's `bridgeSessionId` is that id with the prefix `session_` in place of `cse_` (a `cse_` form is accepted too, since the CLI returns the service's id unconverted when its conversion is switched off).

| Piece | Native OAuth account (service: claude.ai) | Provider session with OAuth Remote Control (service: claude.ai) | Third-party provider, no Anthropic OAuth (service: the door's self-hosted surface) |
|---|---|---|---|
| Session id | `cse_` id from the service's create answer, observed by the door | the same | `cse_` id minted by the door (`rcSelfHost.ts`), the same form |
| Registry join (name, pid) | `bridgeSessionId` `session_<x>`; every live registry entry with one on the development machine (Claude Code 2.1.319, ids of the service's own 24-character form) matched a session id the door held credentials for | not separately exercised; the CLI writes the same field whichever inference backend it uses | `bridgeSessionId` `session_<x>`, observed against the self-hosted surface with Claude Code 2.1.289 and 2.1.319 in a throwaway rig |
| Identity | the launch's recorded identity, through the capability; covered by tests, not exercised against the live service | the same | the same: the self-hosted surface is served through the same routes and admission (covered by an end-to-end test); in the rig, the worker's calls were confirmed to carry no identity header |
| Model, cwd | worker registration metadata and `init` event as the service's worker traffic carries them | the same | the same events, served and stored by the door |
| Worker state, idle, pending requests | observed on the worker's traffic | the same | the same |

What a kind cannot do is not a status matter: with no Anthropic OAuth there is no claude.ai service behind the door, so a session exists only where the door's self-hosted mode is on (`AGENT_SHIM_FRONTDOOR_RC_SELF_HOST=1`) and its credential has been minted (`frontdoor rc selfhost mint`); the web client at claude.ai cannot reach it, and the door's own web client is the browser surface.

### `agent-shim configure`: which file it writes to

`agent-shim configure [path] [--identity <name>]` configures one identity: the one `--identity` names, or otherwise the identity a launch in the working directory would resolve (`AGENT_SHIM_IDENTITY`, a directory rule's pin, then the active identity). With none of those it is a usage error, not a guess. It never targets a profile or a rule directly. Two modes:

- **No `path`**: lists that identity's resolved top-level state — the five categories, plus a "edit a specific configuration profile" option — and lets you toggle categories directly or drill into a named profile's own file. This is the only mode that touches `categories`.
- **Given a `path`**: lists that path's children with their resolved state and multi-select toggles, for fine-grained `entries` overrides. This mode never shows or edits categories, only entries under the given path.

In both modes, *where* a toggle is written depends on `$PWD` at invocation time, not on anything passed explicitly, and it never edits a committed, team-shared file directly:

1. If `$PWD` is inside a directory covered by a committed `.agent-shim.json` (or `.agent-shim.local.json` already exists there), the toggle is written into `.agent-shim.local.json` in that same directory — created if it doesn't exist yet — which is the personal-override mechanism [Portable config](configuration-model.md#portable-config-agent-shimjson) already defines for exactly this case, and is gitignored by convention.
2. Otherwise, if `$PWD` matches a rule in the user's own `~/.agent-shim/directory-rules.json` (or would, once one is created for this exact path), the toggle is written there.
3. Otherwise, it's written into the identity's active configuration profile.

`agent-shim check` (below) shows you which of the three would apply before you commit to a change, if you're unsure.

#### Which `agent-shim` a bare command name resolves to

`doctor`'s PATH-resolution check answers a question no other check does: is the `agent-shim` your shell runs the same executable as the one producing this report? It scans PATH for the filename a bare `agent-shim` would resolve to, using the same `findPathShadow` scan `shim enable` already uses for `claude`, and compares the first hit against the running executable's own PATH-visible location — collapsing the verdict back to a pass when both names turn out to be the same real file reached through a symlink.

An earlier PATH entry winning is a **failure**, not a warning, because it invalidates the rest of the report rather than sitting alongside it: every other finding describes the binary that produced it, which in that state is not the binary your commands reach. The failure mode it exists to catch is entirely silent otherwise — a wrapper script or an abandoned install directory from an earlier channel keeps working at whatever version it was frozen at, so nothing looks broken until a config file written by the newer version trips the older one's own validation. That is not hypothetical: a hand-written wrapper from an earlier install channel, sitting ahead of `~/.local/bin` on PATH, kept re-execing a month-old binary whose copy of `IdentitySchema` predated the naming rule widening to allow `@` — so an `identity.json` a current agent-shim had written was rejected outright, with nothing anywhere reporting that the running binary was not the installed one.

The two softer verdicts are warnings rather than failures. The running executable's own directory not being on PATH at all is legitimate (an absolute-path invocation, or `npx`), and an enabled `claude` shim being shadowed still leaves the launcher reachable as `agent-shim run`.

### Debugging: `agent-shim check`

`agent-shim check [path] [--identity <name>] [--json] [--strict]` resolves the full cascade for the given path (default `$PWD`) and identity (default the active one), and prints the result (every entry's resolved state, which layer decided it, and which condition, if any, was evaluated and how) without touching the farm or spawning `claude` at all. This is the primary way to answer "why is X shared/hidden here" without launching a session to find out. `--json` prints the same report as data, and `--strict` makes it exit 1 when the report carries any warning: a resolver diagnostic, an ambiguous `history/projects/` encoding, an ambient credential a launch would refuse, or a selected provider a launch could not use. For any `history/projects/` glob override in scope, it also flags whenever the pattern's encoded form could plausibly match more than one real path (see [Pattern matching](configuration-model.md#pattern-matching-against-claudeprojects)), rather than resolving that ambiguity silently.

The entry list it prints (and the `entries` array of `--json`) covers every top-level entry of `~/.claude` and every entry a rule reaches into: a directory no rule looks inside is read as one entry, and everything beneath it has that directory's decision. A rule with a size or age condition is the exception, since it needs the totals of a whole subtree, so a configuration with one lists every entry below the directories it can match. This is what keeps a launch fast on a large history, where listing every file would mean walking all of them first.

It also runs four checks that don't depend on `path` at all, every time, so a review of an identity's isolation doesn't require reasoning through the cascade by hand:

- **Credential** — which credential a launch there would use (a selected provider's, the identity's own credential block, or its stored login), by source kind and target, never value, and a selected provider that is missing or invalid. A block that caches its token also reports its cache state: the entry's age and time left, that it has expired, or that there is no entry yet.
- **Ambient-credential exposure** — the same environment-variable check the launcher itself runs (above), surfaced here too so you can audit an identity without attempting a launch.
- **Credential storage, on macOS** — prints the Keychain service name Claude Code is actually using for the active identity (`security find-generic-password` under the hood), so you can visually confirm two identities really do resolve to two distinct entries rather than trusting the empirical pattern described in [Identities](configuration-model.md#identities) blindly.
- **`settings` exposure** — if the `settings` category resolves shared for this identity, and the underlying `settings.json`/`settings.local.json` has a non-empty `env` or `hooks` field, prints how many keys/commands would be shared (names only, never values) so you can review them against [the secrets caveat](configuration-model.md#category-based-sharing) yourself, rather than the tool guessing at what looks like a secret.

### Debugging: `agent-shim doctor`

Where `agent-shim check` resolves one directory+identity's cascade in detail, `agent-shim doctor` audits the whole `~/.agent-shim` config graph at once — identity/directory-agnostic, no arguments needed. It validates every identity's `identity.json`, every configuration profile's own `extends` chain (catching a missing profile name or a circular `extends` before a launch would), every provider file (failing one still in the format before the credential block, with its old fields named and the whole file rewritten in the current format), `directory-rules.json`, `config.json`, `categories.local.json`, and `active-identity`, each against its own Zod schema and cross-referenced against each other (an identity's `defaultConfigProfile`, a directory rule's `identity`/`configProfile`, actually pointing at something real) — plus whether a real Claude Code binary is discoverable at all, whether the `claude` command shim is enabled and its recorded location still exists, **which `agent-shim` a bare command name actually resolves to** (below), and the same ambient-credential check `check` runs. It also **warns when two or more identities hold the same login** (the same account in the same organisation, read from each signed-in identity's account metadata), naming each: they share one quota window, so all but one are redundant, and the finding names `agent-shim identity remove <name>` for the extras. The same account in different organisations, and different accounts in one organisation, are separate logins and are not flagged, nor is an identity with no stored login, no account metadata, or its own credential block or provider. Two failures name the state that holds up provider launches through headroom: **a front door supervisor beside the serving one that serves no registered launch** (read from the process table for the current user, never by signalling anything; it is reported with the exact `kill <pid>` that stops it, while a superseded door still serving launches registered against it is a warning, since it exits once they end), and **a headroom daemon whose allowlist file lacks a live front door's direct origin, or whose recorded allowlist hash lags the file**, or **an allowlist file headroom refuses over a directory on its path that agent-shim cannot repair** (a group-writable home directory or a shared `/tmp` above the root: the finding names the directory, its mode and the remedy, and fails whether or not a daemon is up, since every supervisor stops over it before serving). An allowlist file that breaks agent-shim's owner-only rule in its own directories, which its supervisor repairs or stops the daemon over, a file that only still lists a gone door's origin, and a recorded door the process table could not answer for, are warnings. The supervisor rewrites the file on its next tick, so this outlasts a tick only when the supervisor is not running or cannot write the file, and the finding says which. `agent-shim headroom status` reports the same drift on its `allowlist:` line, naming the door origins the file lacks and still lists, and `headroom status --json` carries it as data: `allowlist` (the live front doors' direct origins the daemon should serve, sorted), `allowlistFile` (the file the daemon reads), `allowlistDrift` (absent when current; otherwise either `{ "startedByEarlierRelease": true }` for a daemon from an earlier release whose fixed allowlist cannot be shown to admit the serving door, or `{ "missingFromFile": [...], "staleInFile": [...], "hashLags": <boolean> }`, the origins the file lacks and still lists and whether the recorded hash is not the file's), `allowlistFileProblem` (`{ "message", "repairable" }` when the file fails the rules it is held to: a directory on its path headroom refuses it over, which is not repairable and is reported whether or not a daemon has served the file, or a break of agent-shim's owner-only rule in its own directories or the file, which the supervisor repairs and which is reported only once a daemon has served the file), and `undeterminedFrontDoors` (each recorded door the process table could not answer for, as `{ "pid", "origin", "reason" }`). One malformed file is reported as its own failure rather than aborting the rest of the audit, and the command exits non-zero if anything failed — useful as a scriptable "is everything still consistent" gate, not just an interactive debugging aid. A pool that lists two members holding the same login (the same account in the same organisation) is reported as a warning in the pool section, since the pool ranks them as one candidate; `pool add` and `pool set` print the same warning.


### Remote Control status: `agent-shim frontdoor rc status`

The status has two parts, and `--json` prints both as `{statuses, unobserved}` (the typed API's `rc.status`, its REST route `GET /rest/rc/status` and the MCP tool derived from it answer the same object).

`statuses` lists the sessions the door's tracker holds: those whose traffic has crossed the door within its idle bound. Each entry's `workerState` carries a `source`: `observed` when the state was named by a worker state update that crossed the door, `read` when the door asked the service for it (`GET /v1/code/sessions/{id}/worker`, on the door's own dial with the session's observed client credential) because none had crossed since the record began. A session whose last state change predates the door, or whose record expired and was recreated by a heartbeat, gets a read state on its first status; a later observed state replaces it. When no state could be had, `workerState` is absent and `workerStateUnavailable` says why: no OAuth bearer was ever observed for the session, the bearer went stale, the service refused or failed the read, or the dial could not reach the API host. The reason is never dropped in favour of an empty state.

`unobserved` lists every live Claude Code session on the machine whose session registry record (`<config dir>/sessions/<pid>.json`, in the shared Claude home and in every identity's directory) names a Remote Control bridge but which the tracker holds no record of. The registry records the bridge in its compatibility form (`session_<suffix>`), and the entry reports it in the `cse_` form the rest of the surface uses. Each entry carries the local session id, the registering process, a `reason`, and a worker state read with the credential a door generation persisted for the session, or, when no door generation ever observed its create (the session was launched without routing through the door, or before the door was serving), `workerStateUnavailable` saying the door holds no credential. Records whose process has exited are left out. A failed read of a tracked session and every read of an unobserved one are reused for the tracker's idle bound (`RC_IDLE_EXPIRY_MS`) before being made again, so a polled status costs at most one service request per such session per bound.

A named session is refused as not observed only when it is in neither part.

### The statusline

`agent-shim statusline` is a statusline entrypoint for Claude Code: point the `statusLine` setting's `command` at it and it renders from the JSON Claude Code writes to its stdin. It needs only the `agent-shim` binary (or `npx agent-shim statusline`), not identities, a profile, a provider or the front door. The only files it writes are its own state, under `~/.agent-shim/statusline`: what it keeps between refreshes about each session's transcript (the transcript reader's cache, the last output speed sample and the last good context frame), each session's spend for the day, and short-lived files holding the output of the programs it runs.

What it draws comes from the payload, from the environment the client runs in, from files the client already keeps and from the git status of the session's working directory. By default it draws everything stock claude-hud's default configuration draws and agent-shim's own segments besides ([statusline-claude-hud-parity.md](statusline-claude-hud-parity.md#defaults) lists what was taken from claude-hud and what differs). The model (its display name, else its model id, each trimmed and read as absent when blank), with the label claude-hud draws beside it (Bedrock, Vertex, MiniMax or Enterprise, chosen from the client's environment and model id as claude-hud chooses it; an Antigravity client draws none), the working directory with the directories added to the session, the context window's use and the prompt cache's hit ratio come from the payload (a frame that reports a percentage of 0 or none, and no `current_usage` or each of its counters 0 or none, and whose percentage of the window in use, as the context row works it out, is not above 0 to one decimal, as Claude Code sends right after `/compact`, is rewritten as claude-hud rewrites such a frame: drawn from the session's newest compaction or its last good frame where that rule draws it from one, and as it stands where the rule draws it from neither, with the differences [statusline-claude-hud-parity.md](statusline-claude-hud-parity.md) lists); the 5h and weekly quota bars come from the payload's own `rate_limits` (claude.ai Pro and Max accounts, after the session's first API response) or, for a window it lacks, from the usage the door recorded for the identity, and the per-model weekly windows come from the payload's `rate_limits`; none of them is drawn for a Bedrock session that selected no provider (`CLAUDE_CODE_USE_BEDROCK` is `1`, or a model id carrying `anthropic.claude-` in any case, for any client but the Antigravity CLI, which is never one), whatever the settings, since such a session does not spend them; and the login account with its plan, organisation and seat comes from the `oauthAccount` block of `$CLAUDE_CONFIG_DIR/.claude.json`, or `~/.claude.json` when the configuration directory is not pinned. A session launched through agent-shim adds the identity, the provider, the provider's account and plan, and the provider's own usage windows from the door's usage snapshot; a provider session never shows the payload's windows, which describe the login account rather than the quota it spends.

A session whose model something chose for it shows the choice beside the client's own model name: `auto -> glm-5.3` when a virtual model or a tier alias picked the model that answered, read from the session's last usage record, with the serving provider folded into the arrow (`auto -> z/glm-5.3`) when the choice could have landed on more than one provider or left the launch's own. A session that named a provider-qualified model itself shows `via <provider>/<model>` instead, when that name sent it off the launch's provider.

The context bar and the quota windows are laid out as bars, in rows of one or more bars as the terminal's width allows. Where a set of rows shares a grid, each label and set of figures is padded to match, the bars start and end in the same columns, the width left over is shared between the bars, and a row with fewer bars than the grid has columns gives its last bar the empty columns' width, so its end still lines up. Whether a set of rows shares a grid depends on the width, on how the rows are merged (`layout.mergeBars`, `layout.merge`) and on how wide their labels and figures are, and where it does not, the layout gives up alignment between groups, and then between rows, rather than cut a bar: a row aligned within itself is as wide as its own labels and figures need and its bar takes the line's spare width. The order of these fallbacks is set out in the comment on `layoutBarGrid` in `src/statusline/barGrid.ts`. A bar is never narrower than `bar.width` cells, so one whose label, bar and figures are wider than the line (the default's quota windows, with each reset introduced by its words, on a narrow terminal) is drawn whole, wider than the line, as a header segment wider than the line is.

A session routed through headroom also shows what the proxy saved it (tokens, percentage and dollars) in the headroom segment, which the default header draws after the identity and before the extra segment. The statusline asks the proxy for `GET /stats/sessions/<session id>`, keyed by the payload's `session_id`, over the supervised daemon's unix socket (authenticated the way the door's own hop authenticates it) or, when `HEADROOM_PROXY_URL` names a proxy run on its own, over http. A lookup is bounded by a short timeout, and a proxy that is unreachable, slow or does not know the session simply leaves the segment out.

The Antigravity CLI (`agy`) takes the same command in `~/.gemini/antigravity-cli/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "agent-shim statusline" } }
```

Its payload differs, and the statusline reads each difference: the quota bars come from the payload's `quota` map, one per model family the account holds (Gemini 5h and weekly, third-party 5h and weekly, Gemini 4 Argon weekly), whichever model is in use, so a spent window of one family is visible while another family is drawn on; a session on an Antigravity provider through the front door draws the same family windows from the usage snapshot. The account and plan from its `email` and `plan_tier` (the Claude profile file is not consulted beside them), and the width from its live `terminal_width`. When the CLI's `statusLine.stack_with_default` is `true` its own line, which already names the model, is drawn above this one, so the model is left out here; the payload does not carry that setting, so it is read from `~/.gemini/antigravity-cli/settings.json`.

The line is laid out for the terminal's width, taken from the payload's `terminal_width` when the client states one and from `COLUMNS` otherwise (Claude Code sets it), and wraps rather than truncating. `AGENT_SHIM_STATUSLINE_CMD` names a renderer of your own: it receives the same payload with an `agent_shim` key added, and its output replaces the built-in line. With `AGENT_SHIM_STATUSLINE` unset, the built-in line reads `launch.statusline` from the config on every render, so an edit shows on the next message (see the statusline section of [configuration-model.md](configuration-model.md)).

## Native Codex CLI launches

`agent-shim identity add <name> --agent codex` creates a Codex identity. `agent-shim run --agent codex @<name> [shim sharing flags] [Codex arguments...]` launches it; the agent prefix must immediately follow `run`. `--agent=codex` is equivalent. `agent-shim check --agent codex --identity <name>` inspects its sharing decisions without launching.

`AGENT_SHIM_CODEX_BIN` selects the installed executable and `AGENT_SHIM_CODEX_HOME` selects the canonical sharing source (default `~/.codex`). The identity's stable directory becomes `CODEX_HOME`; native credential storage and SQLite state stay local. Full semantics and examples are in [codex-cli.md](codex-cli.md).

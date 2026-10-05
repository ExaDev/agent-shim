# CLI reference

The full flag/command reference table, the complete command list, `configure`'s file-to-write-to precedence, the PATH-shadow check behind `doctor`, and the `check`/`doctor` debugging commands. Verbatim from an earlier README.md.

## CLI reference

| What you're setting | Global (persistent) | Temporary (this run only) | Directory-scoped (persistent) |
|---|---|---|---|
| **Identity** | `agent-shim identity use <name>` / `agent-shim @<name>` (writes `~/.agent-shim/active-identity`) | `agent-shim run @<name>` or `agent-shim run --identity <name>` / `claude @<name>` (needs `agent-shim shim enable`) / `AGENT_SHIM_IDENTITY=<name> claude` (same) | `agent-shim rule add <path> --identity <name>`; or `.agent-shim.json`'s `"identity"` |
| **Pool** | `agent-shim pool add <name> --identity <a> --identity <b>` defines one; `agent-shim pool use <name>` / `agent-shim @pool:<name>` selects it persistently | `agent-shim run @pool:<name>` or `--identity pool:<name>` / `AGENT_SHIM_IDENTITY=pool:<name>`; `--wait` sleeps when every member is refused | rule's `identity` as `pool:<name>`; or `.agent-shim.json`'s `"identity"` |
| **Configuration profile** | `agent-shim profile use <name>`; or `agent-shim identity set <identity> --default-profile <profile>` | `claude --config-profile <name>` / `AGENT_SHIM_CONFIG_PROFILE=<name> claude` | `agent-shim rule add <path> --config-profile <name>`; or `.agent-shim.json`'s `"configProfile"` |
| **A category** | `agent-shim profile set <name> --category history=true`; or `agent-shim configure` | `claude --category history=true [--category knowledge=false ...]` / `AGENT_SHIM_CATEGORY_OVERRIDE="history=true,knowledge=false"` | `agent-shim configure` run from inside the ruled directory; or `.agent-shim.json`'s `"categories"` |
| **An individual entry** | `agent-shim profile set <name> --entry "<category>/<path>=true"`; or `agent-shim configure <path>` | `claude --share <path> [--share <path> ...]` / `claude --hide <path>` / `AGENT_SHIM_ENTRY_OVERRIDE="path=true,otherpath=false"` | `agent-shim configure <path>` run from inside the ruled directory; or `.agent-shim.json`'s `"entries"` |
| **Skip permissions** | `agent-shim profile set <name> --launch-skip-permissions` (or `--no-launch-skip-permissions`); `launch.skipPermissions` in any cascade layer | `claude --skip-permissions` / `claude --no-skip-permissions` / `AGENT_SHIM_SKIP_PERMISSIONS=true claude` | rule's inline `"launch"` field; or `.agent-shim.json`'s `"launch"` |
| **Remote Control** | `agent-shim profile set <name> --launch-remote-control` (or `--no-launch-remote-control`); `launch.remoteControl` in any cascade layer | `claude --remote-control` / `claude --no-remote-control` / `AGENT_SHIM_REMOTE_CONTROL=true claude` | rule's inline `"launch"` field; or `.agent-shim.json`'s `"launch"` |
| **Provider** | `agent-shim provider add <name> ...` defines one (under `~/.agent-shim/providers/`); `agent-shim profile set <name> --launch-provider <provider>` pins it | `claude --provider <name>` / `claude --no-provider` (opts one launch out of whatever the cascade selects) | rule's inline `"launch": { "provider": ... }` field; or `.agent-shim.json`'s `"launch"` |
| **Headroom routing** | `agent-shim profile set <name> --launch-headroom` (or `--no-launch-headroom`); a `launch.headroom` key in `~/.agent-shim/config.json` or any cascade layer; the daemon's own `source`, `idleShutdownMinutes` and token-saving settings (`mode`, `targetRatio`, `ccr`, `rolloutChannel`, `interceptToolResults`, `readMaturation`) live in that file's global-only `headroom` block | `claude --headroom` / `claude --no-headroom` / `AGENT_SHIM_HEADROOM=true claude` | rule's inline `"launch": { "headroom": true }` field; or `.agent-shim.json`'s `"launch"` |
| **Usage tracking** | `agent-shim profile set <name> --launch-track-usage` (or `--no-launch-track-usage`); a `launch.trackUsage` key in `~/.agent-shim/config.json` or any cascade layer | `claude --track-usage` / `claude --no-track-usage` / `AGENT_SHIM_TRACK_USAGE=true claude` | rule's inline `"launch": { "trackUsage": true }` field; or `.agent-shim.json`'s `"launch"` |
| **Identity credential** | `agent-shim identity set <name> --credential <source> [--credential-target oauthToken]` (in its `identity.json`); `--no-credential` returns it to its stored login | not applicable | not applicable: a credential belongs to the identity, not a directory |
| **Ambient-credential guard** | `agent-shim identity set <name> --allow-ambient-credential` (per identity, in its `identity.json`) | `AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL=true claude` | not applicable: this guard is about the active identity's own credential, not a directory context. Deliberately identity-only, with no cascade key, because it is a security setting |

Every boolean launch setting is decided the same way: its command-line flag outright, then its environment variable, then the cascade, then off. Every boolean environment variable (`AGENT_SHIM_SKIP_PERMISSIONS`, `AGENT_SHIM_REMOTE_CONTROL`, `AGENT_SHIM_HEADROOM`, `AGENT_SHIM_TRACK_USAGE`, `AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL`, `AGENT_SHIM_DEBUG`) reads `true`/`1` or `false`/`0`, the same vocabulary a `--category history=true` value uses; the empty string counts as unset, and anything else is refused as a usage error rather than read as false. So `AGENT_SHIM_SKIP_PERMISSIONS=0` switches off a profile's `skipPermissions: true` for one launch.

The scriptable `agent-shim profile set ...` commands exist alongside the interactive picker specifically so this is automatable: CI, setup scripts, or a `.agent-shim.json` generator never need to drive a prompt. Every list-valued flag takes one value per occurrence and repeats for more (`claude --share <path> --share <path>`, `agent-shim profile set work --category history=true --category knowledge=false`, `agent-shim profile add acme --extends base --extends work`); no flag splits its value on commas. The two list-valued environment variables, which cannot repeat, are the exception: `AGENT_SHIM_CATEGORY_OVERRIDE` and `AGENT_SHIM_ENTRY_OVERRIDE` each hold a comma-separated list of `<key>=<bool>` pairs. A `--share`/`--hide` path (and the `AGENT_SHIM_ENTRY_OVERRIDE` env var's keys) still needs its `<category>/` prefix like every other entries key (e.g. `claude --share knowledge/skills/commit`); see [Category-based sharing](configuration-model.md#category-based-sharing). The same spelling never means two things: the launch flag is `--headroom`, the profile setting that stores it is `--launch-headroom`.

The launcher recognises its own flags only before a `--` terminator. Everything from `--` onwards is forwarded to Claude Code verbatim, so `claude mcp add n -- cmd --provider x` keeps `--provider x` for `cmd`. `@<name>` is recognised only as the very first argument; `--identity <name>` is its explicit form, and naming two different identities through both is a usage error. `CLAUDE_EXTRA_FLAGS` (below) is a different thing entirely, a passthrough to the real Claude Code binary, not a `agent-shim` override: it's a single opaque string, split on whitespace before being appended to the real binary's argv, so a flag value that itself needs an embedded space isn't expressible through it.

A launch that selects an identity with no `identity.json`, or a configuration profile with no file, is refused with exit 1 naming the missing name and how it was selected, rather than silently creating a brand-new login for a mistyped `@name` or launching with a cascade layer missing. On a terminal, the launcher first offers to create it.

### Output, errors and prompts

Every `list`, `show`, `check`, `doctor` and `status` command prints human-readable text by default and JSON with `--json`. `provider show`, `identity show`, `check` and `doctor` describe a credential by its source kinds and target (a variable name, a path, a program, a 1Password reference, a Keychain service) and never read or print a value; a `literal` source's placeholder is not printed either. `--credential <source>` takes `env:<VAR>`, `file:<path>`, `command:<program and arguments>`, `op:<op://reference>`, `keychain:<service>[:<account>]`, `literal:<placeholder>` or a JSON source object, repeats for an ordered list, and replaces the whole list on `set` (see [Credentials](configuration-model.md#credentials)).

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

agent-shim identity add <name>
agent-shim identity list [--json]
agent-shim identity show <name> [--json]
agent-shim identity set <name> [--default-profile <profile> | --no-default-profile] [--[no-]allow-ambient-credential]
agent-shim identity set <name> [--credential <source>]... [--credential-target <bearer|apiKey|oauthToken>] [--no-credential]
agent-shim identity set <name> [--credential-cache] [--credential-cache-ttl <ttl>] [--credential-cache-store <keychain|file>] [--no-credential-cache]
agent-shim identity remove <name> [--yes]
agent-shim identity use <name>
agent-shim @<name>                          # shorthand for `identity use <name>`
agent-shim identity resolve-conflicts <name>  # interactively resolve a retained superseded farm's conflicts

agent-shim profile add [name] [--extends <profile>]... [--description <text>]   # interactive with no options on a terminal
agent-shim profile set <name> [--category <category>=<bool>]... [--entry <category>/<path>=<bool>]...
agent-shim profile set <name> [--extends <profile>]... [--no-extends] [--description <text> | --no-description]
agent-shim profile set <name> [--[no-]launch-skip-permissions] [--[no-]launch-remote-control] [--[no-]launch-headroom] [--[no-]launch-track-usage]
agent-shim profile set <name> [--launch-provider <provider> | --no-launch-provider]
agent-shim profile list [--json]
agent-shim profile show <name> [--json]
agent-shim profile remove <name> [--yes]
agent-shim profile use <name>               # the global default configuration profile

agent-shim pool add <name> --identity <identity>...
agent-shim pool set <name> --identity <identity>...
agent-shim pool list [--json]
agent-shim pool show <name> [--json]
agent-shim pool remove <name> [--yes]
agent-shim pool use <name>                   # the active selection becomes pool:<name>
agent-shim pool pick <name> [--json]         # the ranking a launch from here would act on; records nothing

agent-shim provider add <name> --display-name <name> (--base-url <url> | --kind codex) (--credential <source>)... [--credential-target <bearer|apiKey>] [--env KEY=VALUE]...
                                              [--codex-default-model <model>] [--codex-model <tier=model>]... [--codex-effort <none|low|medium|high>]
agent-shim provider set <name> [--display-name <name>] ([--base-url <url>] | --kind codex) [--credential <source>]... [--credential-target <bearer|apiKey>] [--env KEY=VALUE]... [--unset-env KEY]...
agent-shim provider set <name> [--credential-cache] [--credential-cache-ttl <ttl>] [--credential-cache-store <keychain|file>] [--no-credential-cache]
                                              [--codex-default-model <model>] [--codex-model <tier=model>]... [--codex-effort <none|low|medium|high>]
agent-shim provider list [--json]
agent-shim provider show <name> [--json]
agent-shim provider remove <name> [--yes]

agent-shim rule add <path> [--config-profile <profile>] [--identity <identity>]
agent-shim rule set <path> [--config-profile <profile> | --no-config-profile] [--identity <identity> | --no-identity]
agent-shim rule list [--json]
agent-shim rule show <path> [--json]
agent-shim rule remove <path> [--yes]

agent-shim credential store <identity>                 # token on standard input
agent-shim credential warm [<identity> | --provider <name>]
agent-shim credential forget [<identity> | --provider <name>]
agent-shim credential push <identity> <host> [--provider <name>]

agent-shim configure [path] [--identity <identity>]
agent-shim check [path] [--identity <identity>] [--json] [--strict]
agent-shim doctor [--json]
agent-shim headroom status [--json]
agent-shim codex status [--json]
agent-shim frontdoor status [--json]
agent-shim frontdoor rc list [--json]
agent-shim frontdoor rc status [<cse_id>] [--json]
agent-shim frontdoor rc pending [<cse_id>] [--json]
agent-shim frontdoor rc send --session <cse_id> --text <text> [--json]
agent-shim frontdoor rc answer --session <cse_id> --request <id> --approve | --deny [--text <text>] [--json]
agent-shim frontdoor rc interrupt --session <cse_id> [--json]
agent-shim frontdoor rc set-model --session <cse_id> --model <model> [--json]
agent-shim frontdoor rc set-permission-mode --session <cse_id> --mode <mode> [--json]
agent-shim usage [--identity <name>] [--provider <name>] [--since <duration>] [--refresh] [--json]
agent-shim account show [<identity>] [--refresh] [--json]
agent-shim completion <bash|zsh|fish>
agent-shim shim enable [--dir <path>] [--force]
agent-shim shim disable [--dir <path>] [--force]

agent-shim run [@<identity>] [launch flags] [claude arguments]
  # launch flags, recognised only before a `--` terminator:
  #   --identity <name>  --config-profile <name>  --provider <name> | --no-provider
  #   --category <category>=<bool>  --share <category>/<path>  --hide <category>/<path>   (each repeatable)
  #   --[no-]skip-permissions  --[no-]remote-control  --[no-]headroom  --[no-]track-usage  --[no-]wait
  #   --native   run the real claude with nothing from agent-shim applied; cannot be combined with the flags above
claude @<identity> ...                      # the same, once `agent-shim shim enable` has run
```

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

Where `agent-shim check` resolves one directory+identity's cascade in detail, `agent-shim doctor` audits the whole `~/.agent-shim` config graph at once — identity/directory-agnostic, no arguments needed. It validates every identity's `identity.json`, every configuration profile's own `extends` chain (catching a missing profile name or a circular `extends` before a launch would), every provider file (failing one still in the format before the credential block, with its old fields named and the whole file rewritten in the current format), `directory-rules.json`, `config.json`, `categories.local.json`, and `active-identity`, each against its own Zod schema and cross-referenced against each other (an identity's `defaultConfigProfile`, a directory rule's `identity`/`configProfile`, actually pointing at something real) — plus whether a real Claude Code binary is discoverable at all, whether the `claude` command shim is enabled and its recorded location still exists, **which `agent-shim` a bare command name actually resolves to** (below), and the same ambient-credential check `check` runs. One malformed file is reported as its own failure rather than aborting the rest of the audit, and the command exits non-zero if anything failed — useful as a scriptable "is everything still consistent" gate, not just an interactive debugging aid.


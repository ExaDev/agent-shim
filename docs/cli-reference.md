# CLI reference

The full flag/command reference table, the complete command list, `configure`'s file-to-write-to precedence, the PATH-shadow check behind `doctor`, and the `check`/`doctor` debugging commands. Verbatim from an earlier README.md.

## CLI reference

| What you're setting | Global (persistent) | Temporary (this run only) | Directory-scoped (persistent) |
|---|---|---|---|
| **Identity** | `claude-use identity use <name>` / `claude-use @<name>` (writes `~/.claude-use/active-identity`) | `claude-use run @<name>` or `claude-use run --identity <name>` / `claude @<name>` (needs `claude-use shim enable`) / `CLAUDE_USE_IDENTITY=<name> claude` (same) | `claude-use rule add <path> --identity <name>`; or `.claude-use.json`'s `"identity"` |
| **Configuration profile** | `claude-use profile use <name>`; or `claude-use identity set <identity> --default-profile <profile>` | `claude --config-profile <name>` / `CLAUDE_USE_CONFIG_PROFILE=<name> claude` | `claude-use rule add <path> --config-profile <name>`; or `.claude-use.json`'s `"configProfile"` |
| **A category** | `claude-use profile set <name> --category history=true`; or `claude-use configure` | `claude --category history=true [--category knowledge=false ...]` / `CLAUDE_USE_CATEGORY_OVERRIDE="history=true,knowledge=false"` | `claude-use configure` run from inside the ruled directory; or `.claude-use.json`'s `"categories"` |
| **An individual entry** | `claude-use profile set <name> --entry "<category>/<path>=true"`; or `claude-use configure <path>` | `claude --share <path> [--share <path> ...]` / `claude --hide <path>` / `CLAUDE_USE_ENTRY_OVERRIDE="path=true,otherpath=false"` | `claude-use configure <path>` run from inside the ruled directory; or `.claude-use.json`'s `"entries"` |
| **Skip permissions** | `claude-use profile set <name> --launch-skip-permissions` (or `--no-launch-skip-permissions`); `launch.skipPermissions` in any cascade layer | `claude --skip-permissions` / `claude --no-skip-permissions` / `CLAUDE_USE_SKIP_PERMISSIONS=true claude` | rule's inline `"launch"` field; or `.claude-use.json`'s `"launch"` |
| **Remote Control** | `claude-use profile set <name> --launch-remote-control` (or `--no-launch-remote-control`); `launch.remoteControl` in any cascade layer | `claude --remote-control` / `claude --no-remote-control` / `CLAUDE_USE_REMOTE_CONTROL=true claude` | rule's inline `"launch"` field; or `.claude-use.json`'s `"launch"` |
| **Provider** | `claude-use provider add <name> ...` defines one (under `~/.claude-use/providers/`); `claude-use profile set <name> --launch-provider <provider>` pins it | `claude --provider <name>` / `claude --no-provider` (opts one launch out of whatever the cascade selects) | rule's inline `"launch": { "provider": ... }` field; or `.claude-use.json`'s `"launch"` |
| **Headroom routing** | `claude-use profile set <name> --launch-headroom` (or `--no-launch-headroom`); a `launch.headroom` key in `~/.claude-use/config.json` or any cascade layer; the daemon's own `source`/`idleShutdownMinutes` live in that file's global-only `headroom` block | `claude --headroom` / `claude --no-headroom` / `CLAUDE_USE_HEADROOM=true claude` | rule's inline `"launch": { "headroom": true }` field; or `.claude-use.json`'s `"launch"` |
| **Identity credential** | `claude-use identity set <name> --credential <source> [--credential-target oauthToken]` (in its `identity.json`); `--no-credential` returns it to its stored login | not applicable | not applicable: a credential belongs to the identity, not a directory |
| **Ambient-credential guard** | `claude-use identity set <name> --allow-ambient-credential` (per identity, in its `identity.json`) | `CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=true claude` | not applicable: this guard is about the active identity's own credential, not a directory context. Deliberately identity-only, with no cascade key, because it is a security setting |

Every boolean launch setting is decided the same way: its command-line flag outright, then its environment variable, then the cascade, then off. Every boolean environment variable (`CLAUDE_USE_SKIP_PERMISSIONS`, `CLAUDE_USE_REMOTE_CONTROL`, `CLAUDE_USE_HEADROOM`, `CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL`, `CLAUDE_USE_DEBUG`) reads `true`/`1` or `false`/`0`, the same vocabulary a `--category history=true` value uses; the empty string counts as unset, and anything else is refused as a usage error rather than read as false. So `CLAUDE_USE_SKIP_PERMISSIONS=0` switches off a profile's `skipPermissions: true` for one launch.

The scriptable `claude-use profile set ...` commands exist alongside the interactive picker specifically so this is automatable: CI, setup scripts, or a `.claude-use.json` generator never need to drive a prompt. Every list-valued flag takes one value per occurrence and repeats for more (`claude --share <path> --share <path>`, `claude-use profile set work --category history=true --category knowledge=false`, `claude-use profile add acme --extends base --extends work`); no flag splits its value on commas. The two list-valued environment variables, which cannot repeat, are the exception: `CLAUDE_USE_CATEGORY_OVERRIDE` and `CLAUDE_USE_ENTRY_OVERRIDE` each hold a comma-separated list of `<key>=<bool>` pairs. A `--share`/`--hide` path (and the `CLAUDE_USE_ENTRY_OVERRIDE` env var's keys) still needs its `<category>/` prefix like every other entries key (e.g. `claude --share knowledge/skills/commit`); see [Category-based sharing](configuration-model.md#category-based-sharing). The same spelling never means two things: the launch flag is `--headroom`, the profile setting that stores it is `--launch-headroom`.

The launcher recognises its own flags only before a `--` terminator. Everything from `--` onwards is forwarded to Claude Code verbatim, so `claude mcp add n -- cmd --provider x` keeps `--provider x` for `cmd`. `@<name>` is recognised only as the very first argument; `--identity <name>` is its explicit form, and naming two different identities through both is a usage error. `CLAUDE_EXTRA_FLAGS` (below) is a different thing entirely, a passthrough to the real Claude Code binary, not a `claude-use` override: it's a single opaque string, split on whitespace before being appended to the real binary's argv, so a flag value that itself needs an embedded space isn't expressible through it.

A launch that selects an identity with no `identity.json`, or a configuration profile with no file, is refused with exit 1 naming the missing name and how it was selected, rather than silently creating a brand-new login for a mistyped `@name` or launching with a cascade layer missing. On a terminal, the launcher first offers to create it.

### Output, errors and prompts

Every `list`, `show`, `check`, `doctor` and `headroom status` prints human-readable text by default and JSON with `--json`. `provider show`, `identity show`, `check` and `doctor` describe a credential by its source kinds and target (a variable name, a path, a program, a 1Password reference, a Keychain service) and never read or print a value; a `literal` source's placeholder is not printed either. `--credential <source>` takes `env:<VAR>`, `file:<path>`, `command:<program and arguments>`, `op:<op://reference>`, `keychain:<service>[:<account>]`, `literal:<placeholder>` or a JSON source object, repeats for an ordered list, and replaces the whole list on `set` (see [Credentials](configuration-model.md#credentials)).

Prompts appear only when standard input is a terminal and input the command needs is missing. Without a terminal, the command fails with the option that supplies that input instead of silently skipping it: `identity use` and the `@<name>` shortcut refuse a missing identity rather than offering the setup wizard, `identity set --default-profile`, `rule add --config-profile` and `profile use` refuse a missing profile rather than offering to create it, `profile add` with no options creates an empty profile rather than walking through its categories, and every `remove` needs `--yes` rather than asking for confirmation. `configure` is interactive by nature and refuses to run without a terminal. `NO_COLOR` is honoured by the prompts, the only coloured output claude-use produces.

| Exit status | Meaning |
|---|---|
| 0 | Success, including `--help` and `--version` |
| 1 | A failure: a missing identity, profile, provider or rule, an invalid config file, a refused launch, a `doctor` finding that failed, or a `check --strict` warning |
| 2 | A usage error: an unknown command or option, a malformed flag or environment value, or required input missing with no terminal to prompt on |
| 64 | A selected provider's or the launching identity's credential block yields no token, including when every remaining source needs a person and there is no terminal or desktop session (`EX_USAGE`) |

Every failure prints as `claude-use: <message>` on standard error. An unexpected error (a bug, not a known failure) prints its message the same way; set `CLAUDE_USE_DEBUG=1` to add its stack trace.

`claude-use completion <bash|zsh|fish>` prints a completion script generated from the command tree itself, so it covers exactly the commands and options that exist: `source <(claude-use completion bash)` in `~/.bashrc`, `source <(claude-use completion zsh)` in `~/.zshrc` after `compinit`, or `claude-use completion fish | source` in fish's config. It completes subcommands and long options at every level, and the launch flags after `run`.

### Full command list

```
claude-use <noun> <verb> [name] [options]      # nouns: identity, profile, provider, rule

claude-use identity add <name>
claude-use identity list [--json]
claude-use identity show <name> [--json]
claude-use identity set <name> [--default-profile <profile> | --no-default-profile] [--[no-]allow-ambient-credential]
claude-use identity set <name> [--credential <source>]... [--credential-target <bearer|apiKey|oauthToken>] [--no-credential]
claude-use identity remove <name> [--yes]
claude-use identity use <name>
claude-use @<name>                          # shorthand for `identity use <name>`
claude-use identity resolve-conflicts <name>  # interactively resolve a retained superseded farm's conflicts

claude-use profile add [name] [--extends <profile>]... [--description <text>]   # interactive with no options on a terminal
claude-use profile set <name> [--category <category>=<bool>]... [--entry <category>/<path>=<bool>]...
claude-use profile set <name> [--extends <profile>]... [--no-extends] [--description <text> | --no-description]
claude-use profile set <name> [--[no-]launch-skip-permissions] [--[no-]launch-remote-control] [--[no-]launch-headroom]
claude-use profile set <name> [--launch-provider <provider> | --no-launch-provider]
claude-use profile list [--json]
claude-use profile show <name> [--json]
claude-use profile remove <name> [--yes]
claude-use profile use <name>               # the global default configuration profile

claude-use provider add <name> --display-name <name> --base-url <url> (--credential <source>)... [--credential-target <bearer|apiKey>] [--env KEY=VALUE]...
claude-use provider set <name> [--display-name <name>] [--base-url <url>] [--credential <source>]... [--credential-target <bearer|apiKey>] [--env KEY=VALUE]... [--unset-env KEY]...
claude-use provider list [--json]
claude-use provider show <name> [--json]
claude-use provider remove <name> [--yes]

claude-use rule add <path> [--config-profile <profile>] [--identity <identity>]
claude-use rule set <path> [--config-profile <profile> | --no-config-profile] [--identity <identity> | --no-identity]
claude-use rule list [--json]
claude-use rule show <path> [--json]
claude-use rule remove <path> [--yes]

claude-use configure [path] [--identity <identity>]
claude-use check [path] [--identity <identity>] [--json] [--strict]
claude-use doctor [--json]
claude-use headroom status [--json]
claude-use completion <bash|zsh|fish>
claude-use shim enable [--dir <path>] [--force]
claude-use shim disable [--dir <path>] [--force]

claude-use run [@<identity>] [launch flags] [claude arguments]
  # launch flags, recognised only before a `--` terminator:
  #   --identity <name>  --config-profile <name>  --provider <name> | --no-provider
  #   --category <category>=<bool>  --share <category>/<path>  --hide <category>/<path>   (each repeatable)
  #   --[no-]skip-permissions  --[no-]remote-control  --[no-]headroom
claude @<identity> ...                      # the same, once `claude-use shim enable` has run
```

### `claude-use configure`: which file it writes to

`claude-use configure [path] [--identity <name>]` configures one identity: the one `--identity` names, or otherwise the identity a launch in the working directory would resolve (`CLAUDE_USE_IDENTITY`, a directory rule's pin, then the active identity). With none of those it is a usage error, not a guess. It never targets a profile or a rule directly. Two modes:

- **No `path`**: lists that identity's resolved top-level state — the five categories, plus a "edit a specific configuration profile" option — and lets you toggle categories directly or drill into a named profile's own file. This is the only mode that touches `categories`.
- **Given a `path`**: lists that path's children with their resolved state and multi-select toggles, for fine-grained `entries` overrides. This mode never shows or edits categories, only entries under the given path.

In both modes, *where* a toggle is written depends on `$PWD` at invocation time, not on anything passed explicitly, and it never edits a committed, team-shared file directly:

1. If `$PWD` is inside a directory covered by a committed `.claude-use.json` (or `.claude-use.local.json` already exists there), the toggle is written into `.claude-use.local.json` in that same directory — created if it doesn't exist yet — which is the personal-override mechanism [Portable config](configuration-model.md#portable-config-claude-usejson) already defines for exactly this case, and is gitignored by convention.
2. Otherwise, if `$PWD` matches a rule in the user's own `~/.claude-use/directory-rules.json` (or would, once one is created for this exact path), the toggle is written there.
3. Otherwise, it's written into the identity's active configuration profile.

`claude-use check` (below) shows you which of the three would apply before you commit to a change, if you're unsure.

#### Which `claude-use` a bare command name resolves to

`doctor`'s PATH-resolution check answers a question no other check does: is the `claude-use` your shell runs the same executable as the one producing this report? It scans PATH for the filename a bare `claude-use` would resolve to, using the same `findPathShadow` scan `shim enable` already uses for `claude`, and compares the first hit against the running executable's own PATH-visible location — collapsing the verdict back to a pass when both names turn out to be the same real file reached through a symlink.

An earlier PATH entry winning is a **failure**, not a warning, because it invalidates the rest of the report rather than sitting alongside it: every other finding describes the binary that produced it, which in that state is not the binary your commands reach. The failure mode it exists to catch is entirely silent otherwise — a wrapper script or an abandoned install directory from an earlier channel keeps working at whatever version it was frozen at, so nothing looks broken until a config file written by the newer version trips the older one's own validation. That is not hypothetical: a hand-written wrapper from an earlier install channel, sitting ahead of `~/.local/bin` on PATH, kept re-execing a month-old binary whose copy of `IdentitySchema` predated the naming rule widening to allow `@` — so an `identity.json` a current claude-use had written was rejected outright, with nothing anywhere reporting that the running binary was not the installed one.

The two softer verdicts are warnings rather than failures. The running executable's own directory not being on PATH at all is legitimate (an absolute-path invocation, or `npx`), and an enabled `claude` shim being shadowed still leaves the launcher reachable as `claude-use run`.

### Debugging: `claude-use check`

`claude-use check [path] [--identity <name>] [--json] [--strict]` resolves the full cascade for the given path (default `$PWD`) and identity (default the active one), and prints the result (every entry's resolved state, which layer decided it, and which condition, if any, was evaluated and how) without touching the farm or spawning `claude` at all. This is the primary way to answer "why is X shared/hidden here" without launching a session to find out. `--json` prints the same report as data, and `--strict` makes it exit 1 when the report carries any warning: a resolver diagnostic, an ambiguous `history/projects/` encoding, an ambient credential a launch would refuse, or a selected provider a launch could not use. For any `history/projects/` glob override in scope, it also flags whenever the pattern's encoded form could plausibly match more than one real path (see [Pattern matching](configuration-model.md#pattern-matching-against-claudeprojects)), rather than resolving that ambiguity silently.

It also runs four checks that don't depend on `path` at all, every time, so a review of an identity's isolation doesn't require reasoning through the cascade by hand:

- **Credential** — which credential a launch there would use (a selected provider's, the identity's own credential block, or its stored login), by source kind and target, never value, and a selected provider that is missing or invalid.
- **Ambient-credential exposure** — the same environment-variable check the launcher itself runs (above), surfaced here too so you can audit an identity without attempting a launch.
- **Credential storage, on macOS** — prints the Keychain service name Claude Code is actually using for the active identity (`security find-generic-password` under the hood), so you can visually confirm two identities really do resolve to two distinct entries rather than trusting the empirical pattern described in [Identities](configuration-model.md#identities) blindly.
- **`settings` exposure** — if the `settings` category resolves shared for this identity, and the underlying `settings.json`/`settings.local.json` has a non-empty `env` or `hooks` field, prints how many keys/commands would be shared (names only, never values) so you can review them against [the secrets caveat](configuration-model.md#category-based-sharing) yourself, rather than the tool guessing at what looks like a secret.

### Debugging: `claude-use doctor`

Where `claude-use check` resolves one directory+identity's cascade in detail, `claude-use doctor` audits the whole `~/.claude-use` config graph at once — identity/directory-agnostic, no arguments needed. It validates every identity's `identity.json`, every configuration profile's own `extends` chain (catching a missing profile name or a circular `extends` before a launch would), every provider file (failing one still in the format before the credential block, with its old fields named and the whole file rewritten in the current format), `directory-rules.json`, `config.json`, `categories.local.json`, and `active-identity`, each against its own Zod schema and cross-referenced against each other (an identity's `defaultConfigProfile`, a directory rule's `identity`/`configProfile`, actually pointing at something real) — plus whether a real Claude Code binary is discoverable at all, whether the `claude` command shim is enabled and its recorded location still exists, **which `claude-use` a bare command name actually resolves to** (below), and the same ambient-credential check `check` runs. One malformed file is reported as its own failure rather than aborting the rest of the audit, and the command exits non-zero if anything failed — useful as a scriptable "is everything still consistent" gate, not just an interactive debugging aid.


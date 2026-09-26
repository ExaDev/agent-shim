# CLI reference

The full flag/command reference table, the complete command list, `configure`'s file-to-write-to precedence, the PATH-shadow check behind `doctor`, and the `check`/`doctor` debugging commands. Verbatim from an earlier README.md.

## CLI reference

| What you're setting | Global (persistent) | Temporary (this run only) | Directory-scoped (persistent) |
|---|---|---|---|
| **Identity** | `claude-use identity use <name>` / `claude-use @<name>` (writes `~/.claude-use/active-identity`) | `claude-use run @<name>` / `claude @<name>` (needs `claude-use shim enable`) / `CLAUDE_ACCOUNT=<name> claude` (same) | `claude-use rules add <path> --identity <name>`; or `.claude-use.json`'s `"identity"` |
| **Configuration profile** | `claude-use profile set-default <name>`; or `claude-use identity set-default-profile <identity> <profile>` | `claude --config-profile <name>` / `CLAUDE_USE_CONFIG_PROFILE=<name> claude` | `claude-use rules add <path> --profile <name>`; or `.claude-use.json`'s `"configProfile"` |
| **A category** | `claude-use profile set <name> --category history=true`; or `claude-use configure <identity>` | `claude --category history=true[,knowledge=false,...]` / `CLAUDE_USE_CATEGORY_OVERRIDE="history=true,knowledge=false"` | `claude-use configure <identity>` run from inside the ruled directory; or `.claude-use.json`'s `"categories"` |
| **An individual entry** | `claude-use profile set <name> --entry "path"=true`; or `claude-use configure <identity> <path>` | `claude --share <path>[,<path>,...]` / `claude --hide <path>[,<path>,...]` / `CLAUDE_USE_ENTRY_OVERRIDE="path=true,otherpath=false"` | `claude-use configure <identity> <path>` run from inside the ruled directory; or `.claude-use.json`'s `"entries"` |
| **Launch flags** | `claude-use profile set <name> [--skip-permissions] [--remote-control]` | `CLAUDE_USE_SKIP_PERMISSIONS=1 claude` / `CLAUDE_USE_REMOTE_CONTROL=1 claude` | rule's inline `"launch"` field; or `.claude-use.json`'s `"launch"` |
| **Provider** | `claude-use provider add <name> ...` defines one (under `~/.claude-use/providers/`); a profile pins it with `launch.provider` in `claude-use profile set <name>`'s file | `claude --provider <name>` | rule's inline `"launch": { "provider": ... }` field; or `.claude-use.json`'s `"launch"` |
| **Ambient-credential guard** | `claude-use identity set <name> --allow-ambient-credential` (per identity, in its `identity.json`) | `CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=1 claude` | not applicable — this guard is about the active identity's own credential, not a directory context |

The scriptable `claude-use profile set ...` commands exist alongside the interactive picker specifically so this is automatable — CI, setup scripts, or a `.claude-use.json` generator don't need to drive an interactive prompt. `claude-use profile set`'s `--category` and `--entry` options, and `claude`'s own `--category`/`--share`/`--hide` flags, are each repeatable in one invocation (`claude --share <path> --share <path>`, `claude-use profile set work --category history=true --category knowledge=false`) and each also accepts a comma-separated list of values in a single flag — `<key>=<bool>` pairs for `--category`/`--entry`, plain paths for `--share`/`--hide` — the same convention `claude-use profile create --extends <names>` uses for a comma-separated list of profile names, so setting several categories or entries in one launch or on one profile doesn't need one invocation per key. A `--share`/`--hide` path (and the `CLAUDE_USE_ENTRY_OVERRIDE` env var's keys) still needs its `<category>/` prefix like every other entries key (e.g. `claude --share knowledge/skills/commit`) — see [Category-based sharing](configuration-model.md#category-based-sharing). `CLAUDE_EXTRA_FLAGS` (below) is a different thing entirely, a passthrough to the real Claude Code binary, not a `claude-use` override: it's a single opaque string, split on whitespace before being appended to the real binary's argv — a flag value that itself needs an embedded space isn't expressible through it.

### Full command list

```
claude-use identity add <name>
claude-use identity use <name>
claude-use @<name>                          # shorthand for `identity use <name>`
claude-use identity list
claude-use identity set-default-profile <identity> <profile>
claude-use identity set <name> [--allow-ambient-credential | --no-allow-ambient-credential]
claude-use identity resolve <name>          # interactively resolve a retained superseded farm's conflicts

claude-use profile create <name> [--extends <name>,<name>,...]
claude-use profile list
claude-use profile set-default <name>
claude-use profile set <name> --category <cat>=<bool>[,<cat>=<bool>,...]
claude-use profile set <name> --entry "<path>"=<bool>[,"<path>"=<bool>,...]
claude-use profile set <name> [--skip-permissions] [--remote-control]

claude-use provider add <name> --display-name <name> --base-url <url> --token-env <VAR> [--env KEY=VALUE]
claude-use provider list
claude-use provider show <name>
claude-use provider remove <name>

claude-use rules add <path> [--profile <name>] [--identity <name>]
claude-use rules list
claude-use rules remove <path>

claude-use configure <identity> [path]
claude-use check [path] [--identity <name>]
claude-use doctor
claude-use run [args...]
claude-use shim enable [--dir <path>] [--force]
claude-use shim disable [--dir <path>] [--force]
```

### `claude-use configure`: which file it writes to

`claude-use configure <identity> [path]` always takes an identity as its required first argument, never a profile or a rule directly — a plain `claude-use configure <identity>` with no arguments beyond that is an error, not a default. Two modes:

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

`claude-use check [path] [--identity <name>]` resolves the full cascade for the given path (default `$PWD`) and identity (default the active one), and prints the result — every entry's resolved state, which layer decided it, and which condition (if any) was evaluated and how — without touching the farm or spawning `claude` at all. This is the primary way to answer "why is X shared/hidden here" without launching a session to find out. For any `history/projects/` glob override in scope, it also flags whenever the pattern's encoded form could plausibly match more than one real path (see [Pattern matching](configuration-model.md#pattern-matching-against-claudeprojects)), rather than resolving that ambiguity silently.

It also runs three checks that don't depend on `path` at all, every time, so a review of an identity's isolation doesn't require reasoning through the cascade by hand:

- **Ambient-credential exposure** — the same environment-variable check the launcher itself runs (above), surfaced here too so you can audit an identity without attempting a launch.
- **Credential storage, on macOS** — prints the Keychain service name Claude Code is actually using for the active identity (`security find-generic-password` under the hood), so you can visually confirm two identities really do resolve to two distinct entries rather than trusting the empirical pattern described in [Identities](configuration-model.md#identities) blindly.
- **`settings` exposure** — if the `settings` category resolves shared for this identity, and the underlying `settings.json`/`settings.local.json` has a non-empty `env` or `hooks` field, prints how many keys/commands would be shared (names only, never values) so you can review them against [the secrets caveat](configuration-model.md#category-based-sharing) yourself, rather than the tool guessing at what looks like a secret.

### Debugging: `claude-use doctor`

Where `claude-use check` resolves one directory+identity's cascade in detail, `claude-use doctor` audits the whole `~/.claude-use` config graph at once — identity/directory-agnostic, no arguments needed. It validates every identity's `identity.json`, every configuration profile's own `extends` chain (catching a missing profile name or a circular `extends` before a launch would), `directory-rules.json`, `config.json`, `categories.local.json`, and `active-identity`, each against its own Zod schema and cross-referenced against each other (an identity's `defaultConfigProfile`, a directory rule's `identity`/`configProfile`, actually pointing at something real) — plus whether a real Claude Code binary is discoverable at all, whether the `claude` command shim is enabled and its recorded location still exists, **which `claude-use` a bare command name actually resolves to** (below), and the same ambient-credential check `check` runs. One malformed file is reported as its own failure rather than aborting the rest of the audit, and the command exits non-zero if anything failed — useful as a scriptable "is everything still consistent" gate, not just an interactive debugging aid.


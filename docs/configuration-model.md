# Configuration model

Full mechanics of identities, configuration profiles, category-based sharing, the cascade merge algorithm, directory rules, portable per-repo config, project-history pattern matching and launch flags. Verbatim from an earlier README.md; linked from the README's condensed Concepts section rather than loaded into every session.

## Concepts

### Identities

An identity is a directory at `~/.claude-use/identities/<name>/` — a symlink farm mirroring the parts of `~/.claude` that are configured to be shared, plus its own locally-written credentials and daemon state that are never shared with any other identity. This is what `CLAUDE_CONFIG_DIR` points at when you run `claude` under that identity. Alongside the farm, the identity directory holds one small, Zod-validated `identity.json` (created by `claude-use identity add`): the optional `defaultConfigProfile` used to resolve which configuration profile applies (per below), and the optional `allowAmbientCredential` boolean (default `false`) that opts this one identity out of the ambient-credential launch guard described next.

Select an identity with:

- `claude-use run @<name>`, or its explicit form `claude-use run --identity <name>`: for this one invocation, always available, no setup beyond installing `claude-use` itself
- `claude @<name>` — equivalent, once `claude-use shim enable` has been run (see [Install](../README.md#install))
- `CLAUDE_USE_IDENTITY=<name> claude`: equivalent, via environment variable (this is `claude-use`'s own variable, read by its launcher; Anthropic's own multi-account convention is a plain `CLAUDE_CONFIG_DIR=<path> claude`, which `claude-use` builds on top of rather than replaces); also needs the shim enabled first
- `claude-use identity use <name>` — persistently, until changed again
- `claude-use @<name>`: the same, terser: shorthand for `claude-use identity use <name>`, matching the `@name` convention the other forms above already use. Deliberately requires the `@` prefix and requires `@<name>` to be the *only* argument, because identity names are user-chosen and unconstrained against `claude-use`'s own subcommand vocabulary (`identity`, `profile`, `provider`, `rule`, `check`, `configure`, `doctor`, `headroom`, `shim`, `run`, `completion`), so a bare `claude-use <name>` (no `@`) is deliberately left alone as an "unknown command" error rather than risking a future identity name colliding with a future subcommand name

A directory rule (see below) can also pin a specific identity to a path, overriding whichever one is otherwise active: useful as a safety net so a particular client's directory always uses the right login regardless of habit.

A launch that selects an identity which has never been created (a mistyped `@name`, a stale `CLAUDE_USE_IDENTITY`) is refused rather than silently starting a brand-new login. On a terminal the launcher first offers the same setup wizard `claude-use identity use` does.

**If `CLAUDE_CONFIG_DIR` is already set when `claude` runs, `claude-use` skips its own identity/cascade resolution entirely and lets the real binary use whatever it already points to** — the same "explicit signal wins" precedence used everywhere else in this design (an `@name` beats a directory pin, for instance). There is no farm to resync and no identity to resolve in this case, since you've named a configuration directory yourself. The ambient-credential guard below still runs regardless of this escape hatch — it's a check about credential isolation, not about identity or config-directory selection, so naming your own `CLAUDE_CONFIG_DIR` doesn't exempt you from it.

**Where the actual login credential lives, per platform, and where isolation can break down.** Claude Code fully relocates its own state under `CLAUDE_CONFIG_DIR` on every platform — including `.claude.json` (below) and, on Linux and Windows, `.credentials.json` — so on those platforms each identity's login is a genuinely separate file. **macOS is the exception**: Claude Code stores credentials in the encrypted macOS Keychain there, never in a `.credentials.json` file, regardless of `CLAUDE_CONFIG_DIR`. In practice this still isolates per identity — Keychain entries observed in the wild are named `Claude Code-credentials-<hash>`, distinctly per configuration directory, not one fixed item shared by every identity — but this namespacing isn't documented by Anthropic, only empirically observed, so treat it as verify-before-relying-on rather than a guaranteed contract, especially across Claude Code version changes.

**More importantly, on every platform, a handful of environment variables silently outrank whichever credential — file or Keychain — is stored for the active identity: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, and the `CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY` family.** They authenticate Claude Code directly from the process environment, ahead of any stored subscription login, and none of them live inside `CLAUDE_CONFIG_DIR` — they come from whatever shell environment the process inherits. If any of these are set globally, every identity would silently authenticate as that same account or key, defeating the entire premise of separate identities — so rather than just warning about this, `claude` checks for all of them before every launch and **refuses to start** if any is present, naming exactly which one and why:

```
error: ANTHROPIC_API_KEY is set in the environment. This identity's isolated
credential would be bypassed — every identity authenticates as this same key
while it's set. Unset it, or if this is deliberate, opt in per-launch with
CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=1, or persistently for this identity with
`claude-use identity set <name> --allow-ambient-credential`.
```

The check runs regardless of platform (it doesn't depend on the macOS Keychain caveat above — it's about the environment, not where the credential is stored) and is opt-out, not opt-in: a shared credential has to be a deliberate choice, made explicitly, not an ambient shell setting nobody remembers is there. `claude-use check` (below) also surfaces this proactively, without needing to actually attempt a launch to find out.

### Configuration profiles

A configuration profile is a named, reusable JSON file at `~/.claude-use/config-profiles/<name>.json` describing what to share: category toggles, individual path overrides, and launch flags. It isn't tied to any identity. Which profile applies, for a given launch, is resolved in this order:

1. An explicit `--config-profile <name>` flag or `CLAUDE_USE_CONFIG_PROFILE` environment variable (this run only)
2. A directory rule's `configProfile` selection for `$PWD` (see [Directory rules](#directory-rules))
3. The active identity's own declared default (`defaultConfigProfile` in its `identity.json`)
4. A global default (`~/.claude-use/config.json`)

Profiles compose hierarchically via `extends`:

```json
{ "extends": ["base", "work"], "categories": { "history": false } }
```

A selected profile that has no file is refused at launch rather than silently skipped as an empty layer; on a terminal the launcher offers to create it first, or to launch without it for that one run.

Resolving a profile means resolving its `extends` chain first, base to specific, then applying the profile's own overrides last — so a profile only has to state what's different from what it extends, and a whole tree of profiles (`base` → `work` → `client-strict` → one profile per client) shares as much as possible.

A single identity can use several configuration profiles, switching by directory. A single configuration profile can be reused by several identities. Someone with exactly one login can still get fully directory-scoped sharing behaviour purely from profiles and directory rules — a second login is never required just to get isolation.

## Category-based sharing

Every top-level entry in `~/.claude` is classified into one of five categories, shipped as a default map (`config/categories.default.json`):

| Category | Default shared? | Example entries |
|---|---|---|
| `secret` | **Never** — hardcoded, cannot be overridden by any configuration layer | `.credentials.json`, `backups` |
| `runtime` | No | `daemon*`, `.git*`, `.DS_Store`, `mcp-needs-auth-cache.json`, `shell-snapshots`, `statsig`, `telemetry`, `stats-cache.json`, `usage-data`, `ide`, `cache`, `scheduled_tasks.lock` |
| `history` | Yes | `projects`, `sessions`, `session-env`, `teams`, `tasks`, `todos`, `history.jsonl`, `transcripts`, `paste-cache`, `file-history`, `plans`, `workflows`, `jobs`, `debug`, `downloads`, `chrome` |
| `knowledge` | Yes | `skills`, `agents`, `rules`, `memory`, `commands`, `plugins`, `hooks`, `AGENTS.md`, `CLAUDE.md`, `README.md` |
| `settings` | Yes | `settings.json`, `settings.local.json` |

The default posture is "identities differ only in credentials": `knowledge`, `settings`, and `history` are all shared out of the box, and only `runtime` stays closed — not as a confidentiality boundary, but because daemon locks, PIDs, `.git` state, and IDE/shell snapshots are live per-process or per-machine artifacts that make no sense symlinked across two separate running identities. A configuration profile can close `history` (or `runtime`, or anything else) wholesale for a specific identity or directory — e.g. to keep a client engagement's sessions from leaking into a personal or internal identity — or share/hide individual items within an otherwise-closed category.

**`all` is shorthand for every overridable category at once**, for a profile that wants "share everything except credentials" without hand-listing `runtime`, `history`, `knowledge`, and `settings` individually — `{ "categories": { "all": true } }` expands to exactly those four set to `true`. `secret` can never be included, by construction: `all` only ever expands over the four categories a configuration layer is allowed to toggle in the first place, the same restriction a hand-written `categories` object is already under. An explicit named category always wins over `all` in the same object regardless of which one is written first, so `{ "all": true, "runtime": false }` means "share everything except runtime" — the general `all` setting, narrowed by the specific override, matching how a more specific layer already beats a less specific one everywhere else in this cascade. The same shorthand works identically from `--category all=true`/`CLAUDE_USE_CATEGORY_OVERRIDE=all=true` and `claude-use profile set <name> --category all=true`, not just profile JSON files — one expansion, shared by all three input paths.

`secret`'s "never, cannot be overridden" is an absolute check `resolve/decide.ts` makes *before* running the two-phase cascade at all — not merely the least-specific layer in that cascade, the way every other category is. This matters because [The cascade](#the-cascade-how-everything-composes)'s general rule is that a specific `entries` override always beats a category default; `secret` is the one deliberate exception, so an explicit `entries: { "secret/.credentials.json": true }` anywhere in any layer is rejected outright, the same as a bare `categories: { secret: true }` would be — path-specificity never gets a chance to apply to this one category.

**`~/.claude.json` isn't in this table at all, because — unlike `backups/` above — it isn't sourced from `~/.claude` the way everything else here is.** It's a sibling *file* next to the `~/.claude` directory, not an entry inside it: the OAuth session, personal (user/local-scope) MCP server definitions, and per-project trust decisions (which directories you've approved Claude Code to run in, and what it's allowed to do there). It fully relocates to `$CLAUDE_CONFIG_DIR/.claude.json` when set, the same as everything else — confirmed both in Anthropic's own Agent SDK documentation and empirically in this project's own development. Because it's generated fresh by Claude Code itself the moment it first runs under a new `CLAUDE_CONFIG_DIR`, `claude-use` treats it the same way as `secret`: always identity-local, never part of the shared cascade, and — since it isn't even a descendant of `~/.claude` — never something the resolver's directory walk encounters at all, rather than something explicitly excluded by category. `~/.claude/backups/` holds rolling timestamped copies of it (capped at five, auto-rotating) for Claude Code's own config-migration safety; being a genuine descendant of `~/.claude`, it *is* something the resolver walks past, which is exactly why it's listed under `secret` in the table above rather than merely assumed safe.

**A category being "shared by default" doesn't mean everything inside it is safe to share — `settings` is the one to watch.** `settings.json`'s `env` and `hooks` fields accept literal values with no schema-level restriction, and Anthropic's own documented example for `env` shows a plain literal (`"FOO": "bar"`) with no interpolation syntax available for settings.json itself — the `${VAR}`/`${VAR:-default}` expansion Anthropic does document is scoped specifically to `.mcp.json`, not to `settings.json`'s own fields. In practice this means a hook command or an `env` entry in `settings.json` can easily end up holding a real API key or token, and nothing in Claude Code's own documentation warns against it. Since `settings` is shared across every identity and configuration profile by default, a literal secret placed there is available to all of them — including a client-separated profile that never opened `history`. If you keep genuine secrets in `settings.json`, either move them out (an MCP server's own `.mcp.json`, which does support `${VAR}` expansion, or an environment variable referenced rather than embedded), or close the `settings` category explicitly for any profile that shouldn't see them.

One more boundary worth naming: an IDE extension's own UI-level preferences (VS Code's `globalStorage`, JetBrains' own per-IDE settings store) live outside `~/.claude` entirely and aren't affected by switching identities — only the functional IDE-connection state (the auth lock file under `ide/`, already in the `runtime` category above) actually relocates per identity. Don't expect a per-identity theme or editor toggle from an IDE extension; do expect the IDE↔Claude Code connection itself to isolate correctly.

**Unclassified entries never disappear silently.** If Claude Code ever adds a new top-level file or directory this map doesn't recognise, the first time `claude-use` sees it, it prompts interactively (via `claude-use configure`) for a category, or "skip for now." The answer is written to a local overlay (`~/.claude-use/categories.local.json`) so it's never asked again, and the shipped default map stays untouched. In a non-interactive context (a script, a CI run), an unanswered entry stays excluded and gets reported, rather than the tool guessing or blocking.

### Path-level overrides

Any configuration layer — a profile, a directory rule, a committed `.claude-use.json` — can override sharing for one specific path, not just a whole category, and path keys may use glob wildcards:

```json
{ "categories": { "knowledge": false }, "entries": { "knowledge/skills/commit": true } }
```

shares exactly one skill even though the rest of `knowledge` is closed. The most specific matching path always wins.

All path and glob matching in this design (`entries` keys, directory-rule `path` values, `~/.claude/projects/` patterns) is byte-for-byte case-sensitive, deliberately independent of whether the underlying filesystem is. This matters because the initial [build target](release-process.md#build-node-sea) is macOS, whose default APFS volume is case-insensitive-but-case-preserving — without a fixed policy, a config's literal key could resolve differently at the filesystem level than in `claude-use`'s own string matching whenever their casing disagreed, invisibly on that one platform. Case-sensitive matching everywhere means the same config behaves identically regardless of which platform's filesystem it runs on.

### Conditional matching (`when`)

Both an entries value and a whole rule can be made conditional instead of a flat boolean:

```json
{ "entries": { "history/projects/*": { "value": true, "when": { "newerThan": "90d" } } } }
```

```json
{ "path": "~/work/clients/acme", "categories": { "history": false }, "when": { "branch": "client/*" } }
```

| Condition | Meaning |
|---|---|
| `newerThan` | Applies only while the entry's most recent modification is within the given duration |
| `olderThan` | The inverse of `newerThan` |
| `maxSizeBytes` | Applies only while the entry is at or under the given size |
| `branch` | Applies only while the repo at `$PWD` is checked out on a matching branch (glob-capable) |
| `env` | Applies only while every named environment variable in the condition equals its given value (one or more, all required) |

Conditions combine with AND logic within one `when` object. `cwd` is deliberately not a condition type — directory scoping already has its own first-class mechanism (below), so a generic condition would just be a worse way to do the same thing.

Because every launch resolves the cascade fresh, an age-based condition means "share only recent history" stays true automatically as time passes — no config edit needed as sessions age out. The one cost: a subtree matched by a conditional key can never use the cheap "one symlink for the whole subtree" shortcut, since the decision genuinely varies per file once mtimes are inspected.

## The cascade: how everything composes

Resolution proceeds through four layers, in order:

1. Shipped defaults (`config/categories.default.json`)
2. User-global override (`~/.claude-use/config.json`)
3. The active configuration profile's resolved overrides (itself the composition of its `extends` chain, then its own direct overrides)
4. Directory-hierarchy rules for `$PWD`, shallowest to deepest — each one composing in whichever configuration profile it selects plus any inline overrides

Every layer composes with what came before it; nothing is a wholesale replacement unless it explicitly overrides every entry that matters. Concretely, this happens in two phases:

**Phase one — flatten.** Walk the ordered layer sequence once, spreading each layer's `categories` and `entries` over an accumulator. A later layer's value for the exact same category name, or the exact same literal/glob entries key, replaces an earlier layer's value for that identical key. This is a plain shallow merge — no path-specificity reasoning happens here.

**Phase two — resolve per entry.** For each actual file under `~/.claude`, look up the flattened entries map for every matching key and rank them by, in order: (1) **which layer set the rule — later layer wins, period**, ranked above exactness deliberately, because ranking exactness first would let an untrusted committed `.claude-use.json`'s exact key beat your own later, personal glob override, which would break this design's own stated trust property that a directory-scoped local rule can only ever tighten what a committed file opened, never the reverse; (2) same layer, an exact literal beats a glob; (3) same layer, the longer literal (non-wildcard) prefix wins; (4) same layer, more path segments wins (disambiguates `a/*` from `a/*/*` at the same prefix length); (5) same layer, later ordinal (source order within the file) wins. Only if nothing in the entries map matches at all does the entry fall back to the flattened categories map.

The consequence worth internalising: **entries always outrank the category default, regardless of which layer set which.** A directory rule three levels deep that flips `categories: { history: false }` cannot silently undo an earlier, shallower layer's `entries: { "history/projects/acme": true }` — a category setting is definitionally the least specific override there is. To actually change that one path, a later layer has to set an equally-or-more-specific entry itself, not merely toggle the category.

`extends` resolves via this identical two-phase algorithm, recursively — each extended profile flattens to its own result first, then the profile's own overrides fold in last, so a profile's resolved patch is just one more input to the outer cascade, not a separate mechanism.

## Directory rules

Modelled on how Claude Code itself resolves nested `CLAUDE.md` files: walking up the directory tree, each level adding context. A directory-rules file at `~/.claude-use/directory-rules.json`:

```json
{
  "rules": [
    { "path": "~/work",                "configProfile": "work-default" },
    { "path": "~/work/clients",         "configProfile": "client-strict", "identity": "work" },
    { "path": "~/work/clients/example", "entries": { "knowledge/skills/example-notes": true } }
  ]
}
```

At launch, every rule whose `path` is an ancestor of (or equal to) `$PWD` is collected, sorted shallowest-first, and folded into the cascade in order. A rule's `configProfile` composes in rather than swapping in wholesale: `client-strict` above might itself extend `work-default`, so the deeper rule is saying "here's what's additionally true this far down the tree." A rule's optional `identity` field pins which login applies for that path regardless of whichever identity is otherwise active. An explicit `@name`/`--identity`/`CLAUDE_USE_IDENTITY` still wins over a directory pin (it's the most deliberate, immediate signal), but a directory pin beats the plain global default, making it a genuine safety net: if you accidentally run the wrong login from inside a sensitive directory out of habit, the pin holds unless you explicitly override it.

Because the farm's content now depends on **(identity, resolved configuration profile, directory)**, not just identity, `claude` resolves the full cascade for `$PWD` and resyncs the active identity's farm in place on every single launch, before spawning the real binary — fast, when the resolved decision is uniform across the categories in play, since it's comparing and updating symlinks over a few dozen top-level entries rather than rebuilding from scratch. This stops being cheap the moment a conditional override is in scope for a large subtree — `history/projects/` chief among them, since a `newerThan`/`olderThan`/`maxSizeBytes` condition (per [Conditional matching](#conditional-matching-when)) can never use the uniform-symlink shortcut and has to evaluate each project directory's own mtime/size individually, on every launch, with no caching described. For a long-lived identity with a lot of history, this is worth benchmarking early rather than assumed away.

Running two or more sessions concurrently under one identity — two terminals, each in a different client directory, is exactly the pattern directory rules are meant to support — means two resyncs can race to mutate the same shared farm toward two different resolved states. The launcher serialises this with a per-identity lock file (held for the duration of the resync, released before spawning `claude`) and builds each resync's changes as a scratch tree swapped into place with an atomic rename rather than mutating the live farm path-by-path in place, so a sibling session never observes a half-updated farm partway through someone else's resync.

### Resolving a retained superseded farm

Swapping in a resynced farm carries the identity's own real local data (credentials, `identity.json`, daemon/runtime state — anything that isn't a symlink or a directory the previous resync itself materialised) across from the superseded farm into the new one. When a top-level name exists in both, the swap does not guess which copy matters more — for most categories the tool has no way to judge that safely: `categories` only tracks whether data is *shared across identities*, not whether it's *precious vs. disposable*, and overwriting either copy could discard something real.

One category is the exception. `runtime`'s own definition (see the [category table](#category-based-sharing) above) is specifically "live per-process or per-machine artifacts" — a daemon lock, an MCP auth-needed cache, an update-check result — that make no sense being fought over at all, let alone asked about. A colliding name whose category resolves to `runtime` is discarded from the superseded copy automatically, with nothing kept from the old side and nothing asked: `keep-new` is not a judgement call for this category, it is what the category already means. This needs only the name's static classification, never the resolved shared/not-shared decision for the current directory — a `runtime` entry is disposable whether or not this identity currently chooses to share it.

For everything else, the swap leaves the superseded farm on disk and reports it (`FARM_PREVIOUS_RETAINED`, or `FARM_SWAP_RECOVERED` when a crash-recovery pass on a later launch rediscovers it, naming what it auto-resolved and what it could not) rather than guessing. `claude-use identity resolve-conflicts <name>` walks every retained `.{name}.previous.*` directory for that identity, auto-resolving any further `runtime` collisions it finds the same way, and asks about the rest interactively: keep the current farm's copy, keep the superseded farm's copy, or skip it for now (leaving it exactly as-is for a later run to ask about again). A superseded directory is only removed once every one of its own conflicts has been decided; skipping even one leaves the whole directory retained.

## Portable config: `.claude-use.json`

`~/.claude-use/directory-rules.json` is local to one machine and keyed by absolute path — it doesn't survive being shared with a teammate, or even the same person cloning a repo to a different location. A `.claude-use.json` file committed at a project's root closes that gap. It's discovered exactly the way nested `CLAUDE.md` files are: every `.claude-use.json` found while walking upward from `$PWD` is collected, sorted shallowest-first, and folded into the cascade like a directory rule — except its scope is implicit (wherever the file lives, and everything below it) rather than an explicit `path` field, so it works identically no matter where the repo is checked out.

This is a different system from — and entirely independent of — a project's own `.claude/` directory (project-scoped `settings.json`, skills, hooks, commands, agents) or a project's `.mcp.json`. Claude Code resolves those directly from the current working directory's own repository tree regardless of `CLAUDE_CONFIG_DIR`, identity, or configuration profile, so switching identities never changes what a project's own committed Claude Code config does. `.claude-use.json` and `.claude-use.local.json` are `claude-use`'s own, separate convention, sitting alongside — never instead of — a project's ordinary `.claude/` setup.

The walk stops at (and includes) the user's home directory by default, configurable via `walkUpLimit` in `~/.claude-use/config.json` if it genuinely needs widening or narrowing. If the walk hits a directory it can't read, it stops there rather than failing the launch.

A `.claude-use.json` is self-contained by default:

```json
{ "categories": { "history": false }, "entries": { "knowledge/skills/commit": true } }
```

It may also reference a named `configProfile`, resolved first against any profile shipped in a sibling `.claude-use/config-profiles/` directory in the same repo, falling back to the user's own local `~/.claude-use/config-profiles/` — so a team can keep everything inline and portable, or ship a small reusable profile library alongside the pointer file.

**A per-repo local override pairs with the committed file.** Alongside `.claude-use.json`, an optional `.claude-use.local.json` in the same directory — gitignored, never committed — carries personal tweaks specific to that one clone. Add `.claude-use.local.json` to your project's `.gitignore` the same way you'd gitignore any other personal override file.

At a given directory level, up to three sources can apply, composed most-personal-last: the committed `.claude-use.json` (team-shared), then this user's own `~/.claude-use/directory-rules.json` entry for that path if one exists (cross-repo, this user's default), then `.claude-use.local.json` in that directory if present (this one repo, this user, never committed). This three-source fold happens once per directory level, and the whole shallowest-to-deepest walk (per [Directory rules](#directory-rules)) is one continuous sequence through those folded levels — a deeper level's three-source result composes on top of a shallower level's, not the other way around, and not gathered per-source across the whole tree first.

**A committed `.claude-use.json` is trusted automatically the first time you run `claude` inside a directory it covers: there is no confirmation step, by design, but you should know that before relying on it.** Because a repo's config can broaden what an identity shares (any category or entry short of the hardcoded `secret`) the moment you run `claude` inside it, cloning and running `claude` in an unfamiliar or untrusted repo changes what that identity's farm exposes for as long as you work there. If that's a concern for a given identity (a strict client-separated one, say), pin a directory rule for that path with `claude-use rule add <path> --config-profile <strict-profile>` (per [CLI reference](cli-reference.md#cli-reference)) before ever running `claude` there for the first time: a directory-scoped local rule always composes after the committed file (most-personal-last, above), so it can only tighten what an untrusted `.claude-use.json` opened, never the reverse. `claude-use check <path>` also shows you exactly what a repo's `.claude-use.json` would resolve to before you ever run `claude` there.

This turns "one login, two isolated clients, a few shared skills" (see [Examples](examples.md#examples)) into something a whole team gets automatically: instead of every teammate hand-writing a local directory rule, a repo ships its own `.claude-use.json` declaring the isolation/sharing rules directly, and anyone who clones it and runs `claude` from inside it gets the same behaviour with zero local setup.

## Pattern matching against `~/.claude/projects/`

Claude Code names each entry under `~/.claude/projects/` by encoding the absolute working directory a session ran from into a single directory name — the one confirmed sample so far is `/` becoming `-` (a session run from `/Users/alice/work/clients/acme` produces `~/.claude/projects/-Users-alice-work-clients-acme`). **Treat this as an unverified hypothesis, not a settled fact, until checked against a real installation.** Before relying on it: run a handful of sessions from representative real paths — ones containing a literal `.` (version-numbered directories are common), spaces (common in macOS paths), deep nesting past ~200 characters, and any non-ASCII characters you expect to encounter — and confirm what actually lands under `~/.claude/projects/` for each. Path-flattening schemes commonly sanitise the whole non-alphanumeric character class rather than only the separator; if Claude Code does too, matching needs to account for that, not just `/`-to-`-`. Re-check after any Claude Code version bump, since this is unversioned, undocumented behaviour on Anthropic's side that this feature depends on without a contract.

The encoding is also **many-to-one, not merely hard to decode**: `~/work/clients/acme` and `~/work/clients-acme` (or `~/work-clients/acme`) all flatten to the identical string under a pure separator substitution. A pattern aimed at one can silently match its sibling instead — a real risk, not a theoretical one, for a tool whose whole purpose is precise per-client isolation. `claude-use check` should flag when a pattern's encoded form could plausibly correspond to more than one real path, rather than resolving silently. Because the encoding is one-directional and ambiguous in this way, `claude-use` never tries to decode a directory name back into a path — only the forward direction (real path → encoded form) is ever computed.

This forward transform only applies to entries keys under the fixed `history/projects/` prefix — nowhere else. Everywhere else in this design (directory-rule `path` fields, every other `entries` key), a path is always a literal filesystem path or a normal glob over one, matched exactly as written; **a directory-rule `path` is never matched against `~/.claude/projects/` and never gets this transform** — directory rules only ever match ancestors of `$PWD` (see [Directory rules](#directory-rules)). The one place the transform applies is deliberately narrow: anything written after the literal `history/projects/` prefix in an `entries` key is a real absolute path (optionally globbed), not a literal child directory name, since `history/projects/`'s only real children are Claude Code's own encoded directory names — there's nothing else meaningful to reference there. For example:

```json
{ "entries": { "history/projects/~/work/clients/*": true } }
```

shares exactly the project-history subdirectories for every real path under `~/work/clients/`, without hand-listing each project's exact encoded name — `claude-use` encodes the `~/work/clients/*` portion the same way Claude Code names its own directories, then matches it against the literal directory names present under `~/.claude/projects/`. This is narrower and correct where the earlier, broader-sounding `categories: { history: true }` on a whole directory would not be: that opens the entire `history` category (sessions, tasks, transcripts, and everything else in the [category table](#category-based-sharing)), not just `projects`.

This whole mechanism assumes POSIX-style absolute paths (forward-slash separators). That's a non-issue today since the initial [build target](release-process.md#build-node-sea) is macOS only; if another platform is ever added, this section — and Claude Code's own encoding behaviour on that platform — needs independent re-verification, not an assumption that the same rule carries over.

## Credentials

Providers and identities describe where a token comes from with the same `credential` block: an ordered list of `sources`, tried in turn until one yields a non-empty token, and a `target` saying which variable the token is exported as in the child's environment.

```json
{
  "credential": {
    "sources": [{ "env": "Z_API_TOKEN" }, { "op": "op://vault/z/credential" }],
    "target": "bearer"
  }
}
```

Each source is an object with exactly one key naming its kind:

| Source | Token | Needs a person by default |
|---|---|---|
| `{ "env": "Z_API_TOKEN" }` | the named variable in the launching environment (its NAME, never its value) | no |
| `{ "file": "~/.config/claude-use/z.token" }` | the trimmed contents of an absolute or `~`-rooted file, refused if group or others can read or write it (mode 600 or stricter) | no |
| `{ "command": ["pass", "show", "z"] }` | the trimmed stdout of an argv run at launch with no shell | no |
| `{ "op": "op://vault/item/field" }` | `op read <ref>` | yes, unless `OP_SERVICE_ACCOUNT_TOKEN` is set |
| `{ "keychain": { "service": "claude-work", "account": "joe" } }` | `security find-generic-password -s <service> [-a <account>] -w` | no |
| `{ "literal": "dummy" }` | the value as written (a non-secret placeholder; see below) | no |

`command`, `op` and `keychain` also take `interactive` (override whether the source needs a person) and `timeoutMs` (how long the command may run; 10 seconds by default, 120 seconds for an interactive source, which leaves time to approve a prompt). A 1Password service account needs no special source: `OP_SERVICE_ACCOUNT_TOKEN` in the launching environment is inherited by `op`, which then authenticates without asking anyone, so the `op` source stops counting as interactive. A Keychain read defaults to non-interactive because an item whose access list trusts `security` reads silently and one that does not fails at once over SSH ("User interaction is not allowed") rather than hanging; mark it `interactive: true` if yours shows a dialog.

A source that needs a person is skipped when there is neither a terminal on standard input nor a desktop session (on macOS, a process in the logged-in GUI session; elsewhere, an X11 or Wayland display). When no source is left that yields a token the launch fails before anything is spawned, exit 64, with a message naming every source and why it yielded nothing, for example `claude-use: provider z has no usable credential: env Z_API_TOKEN is unset or empty; op op://vault/z/credential needs a person to approve it, but there is no terminal or desktop session`. A failed command's refusal carries its exit status and stderr, never its stdout, which would be the token. A secret file with loose permissions is skipped with a warning naming the `chmod` that fixes it, even when a later source succeeds.

`target` is `bearer` (the default, exported as `ANTHROPIC_AUTH_TOKEN`, what relays and aggregators expect), `apiKey` (`ANTHROPIC_API_KEY`, sent as `x-api-key`, what a regular Anthropic API key against `api.anthropic.com` needs) or, on an identity only, `oauthToken` (`CLAUDE_CODE_OAUTH_TOKEN`, a long-lived token from `claude setup-token`). The launcher sets the target's variable and removes the other two from the child's environment, so an ambient credential inherited from the parent shell can neither outrank the chosen one nor sit alongside it. The token reaches the child's environment and nothing else: never its argv, never a log line. `check`, `doctor` and every `--json` output describe a credential by source kind, identifying detail (a variable name, a path, a program, a reference, a Keychain service) and target, never by value.

**Why `literal` exists.** A local proxy that ignores credentials entirely (a codex-translation proxy, say) still needs some non-empty token for Claude Code to send, and there is no secret to protect. Requiring an environment variable or a secret store for a placeholder would be ceremony, so `literal` holds it in the file, where it is plainly visible as config. It is the one source whose value is written down, and it is documented and reported as a non-secret placeholder: anything with a real credential uses one of the other kinds, since provider and identity files are ordinary config that is often committed or stowed from a dotfiles repository.

On the command line, `--credential <source>` (repeatable, tried in the order given) takes `env:<VAR>`, `file:<path>`, `command:<program and arguments>` (split on whitespace), `op:<op://reference>`, `keychain:<service>[:<account>]` or `literal:<placeholder>`, or a JSON source object exactly as the file holds it for anything the short form cannot say (an argument containing spaces, `interactive`, `timeoutMs`). `--credential-target <target>` sets the target.

## Providers

A provider is a named API endpoint a session can be routed through instead of `api.anthropic.com`: an Anthropic-compatible relay, an OpenRouter-style aggregator, or any other base URL that speaks the Messages API. Providers replace the hand-written shell wrappers (`z` for GLM, `m` for MiniMax, `o` for OpenRouter, `s` for Synthetic) with first-class config, so the same identity, farm, and cascade machinery applies to them unchanged. A provider is one of two kinds: `http` (the default when `kind` is absent), the fixed endpoint described above, or `codex`, which routes through claude-use's own translation daemon instead of any base URL.

Each provider lives in its own file at `~/.claude-use/providers/<name>.json`:

```json
{
  "displayName": "GLM",
  "baseUrl": "https://api.z.ai/api/anthropic",
  "credential": { "sources": [{ "env": "Z_API_TOKEN" }] },
  "env": { "ANTHROPIC_MODEL": "glm-4.6" }
}
```

A provider's `credential` block (see [Credentials](#credentials)) is required and its target is `bearer` or `apiKey`. A regular Anthropic API key, kept in 1Password:

```json
{
  "displayName": "Anthropic API",
  "baseUrl": "https://api.anthropic.com",
  "credential": { "sources": [{ "op": "op://vault/anthropic/api-key" }], "target": "apiKey" }
}
```

A `codex` provider, which has no `baseUrl` at all:

```json
{
  "kind": "codex",
  "displayName": "Codex",
  "credential": { "sources": [{ "literal": "codex-local" }] },
  "codex": { "models": { "sonnet": "gpt-5.6-terra" }, "effort": "low" }
}
```

The `codex` kind replaces the hand-written `codex-claude-proxy.mjs` script and its `cx` wrapper. A launch that selects a codex provider starts the front-door daemon (one supervised claude-use process, its provider listener on one sticky loopback port) and points the child at `https://127.0.0.1:<port>/providers/<name>`. The translation runs inside that listener as one route of several: the request is identified (the launcher-injected session headers stripped before anything leaves the machine), passed to the ordered pipeline, and routed to the in-process translator, so one front door serves any number of codex providers, each with its own translation settings. The translator is the Anthropic Messages API mapped onto ChatGPT's Codex backend, authenticating upstream with the Codex CLI's own login in `~/.codex/auth.json` (honouring `CODEX_HOME`), refreshing it with one refresh in flight, re-reading the file before every refresh (the Codex CLI writes it too), and writing it back atomically with a rotated refresh token persisted before it is used. Upstream `session_id` is derived per session from `metadata.user_id`, so each Claude Code session is one backend session instead of the whole daemon being one. The optional `codex` block sets `defaultModel`, per-tier `models` (fable, opus, sonnet, haiku, matched by substring of the requested model name) and `effort` (none, low, medium, high); these replace the old script's `CODEX_CLAUDE_*` environment variables, which no longer exist. Provider files are re-read on every request, so edits apply without a restart, and the front door closes after `frontdoor.idleShutdownMinutes` (15 by default) with no live session. `claude-use frontdoor status` reports the daemon read-only, and `claude-use codex status` reports the codex slice of it (the door's availability, the codex providers, the usage snapshot a statusline reads). A codex provider still needs a credential, because Claude Code itself wants a token to send; `literal` is the right source, since the translator ignores it.

`env` carries any further static environment entries the child needs to use that endpoint (model maps like `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL`, `API_TIMEOUT_MS`, and so on). It may not name `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, even with an empty value: the credential target sets one and the launcher removes the others, so an entry there would either be overwritten or be a second credential hiding outside the block.

`claude-use provider add <name> ... --credential <source>...` creates one, and `provider set <name> --credential <source>...` replaces its source list (a list is replaced, not patched, because its order is its meaning); `--credential-target` changes the target alone.

Selection works exactly like the launch flags below: `launch.provider` in any cascade layer (global config, a configuration profile, a directory rule, a committed `.claude-use.json`), with a one-off `claude --provider <name>` flag outranking every layer, and `claude --no-provider` opting one launch out of whatever provider the cascade selects. When a provider is resolved, the child's environment gains `ANTHROPIC_BASE_URL` (the front door's HTTPS address for that provider, `https://127.0.0.1:<port>/providers/<name>`, never the provider's own base URL: the door forwards to that), `NODE_EXTRA_CA_CERTS` (the door's CA bundle, see [Headroom routing](#headroom-routing)), every entry of the provider's `env`, `CLAUDE_USE_PROVIDER` (the display name, for statusline use), and the resolved token under its target's variable, with the other credential variables removed.

Two refusals, both before anything is spawned: an unknown provider name exits 1 with the known provider names listed, and a provider whose credential block yields no token exits 64 with the message described under [Credentials](#credentials).

The ambient-credential guard (below) checks the parent environment and is unaffected by a provider launch: the guard runs before the child environment is built, and the provider's own token is injected into the child after it, so claude-use itself supplies the credential. An ambient `ANTHROPIC_AUTH_TOKEN` left over in a parent shell is therefore not refused when a provider is selected, because the child never sees it; with no provider selected, the guard refuses it as always.

**Provider files from before the credential block.** The separate `tokenEnv`, `tokenCommand` and `authScheme` fields, and a fixed `env.ANTHROPIC_AUTH_TOKEN`, were replaced by the `credential` block with no compatibility period. A file still using them is refused wherever it is read, and `claude-use doctor` fails it with the old fields named and the whole file rewritten in the current format: `tokenEnv` becomes an `env` source, `tokenCommand` a `command` source, a fixed `env.ANTHROPIC_AUTH_TOKEN` a `literal` source (shown as a placeholder for you to copy the value into, never printed), `authScheme: "apiKey"` the `target`, and any credential variable leaves `env`.

### Caching a credential

A source that needs a person (a desktop-unlocked `op`) prompts on every launch. A credential block can ask for its resolved token to be kept:

```json
{ "credential": { "sources": [{ "op": "op://vault/z/credential" }], "cache": { "ttl": "12h", "store": "keychain" } } }
```

`ttl` is a whole number and `s`, `m`, `h` or `d`; without one the cached token never expires and is replaced only by `credential warm`. `store` is `keychain` (the macOS login Keychain, the default there) or `file` (a mode 0600 file under `credential-cache/` in the claude-use home, the default elsewhere). A block with no `cache` stores nothing. The token, when it was fetched and the source that produced it are stored together; a launch uses the cached token until it is older than the `ttl`, then fetches again from the sources.

`claude-use identity set <name>` and `claude-use provider set <name>` take `--credential-cache`, `--credential-cache-ttl`, `--credential-cache-store` and `--no-credential-cache`. `claude-use credential warm` does the interactive fetch from a terminal and fills the cache before unattended work, `credential forget` removes it, and `credential push <identity> <host>` reads the credential locally and writes it into that host's file store over SSH (mode 0600, the token on standard input rather than in a command), so the host needs no 1Password; on that host the credential's store is set to `file`. An unattended launch with an empty cache and only sources that need a person fails with the identity or provider named and the `credential warm` command to run, instead of hanging.

The Keychain store is written through `security -i` on standard input, so the token is never an argument, and the item is readable by `security`, which is what claude-use reads it with, so later reads do not prompt. Over SSH the login keychain reports "User interaction is not allowed", so use the file store on remote hosts.

A launch replaces the claude-use process with `claude`, so a launch cannot see a 401 from the API and re-fetch; a rejected cached token is replaced with `credential warm`.

## Identity credentials

An identity authenticates with the login stored in its own directory unless its `identity.json` carries a `credential` block (see [Credentials](#credentials)), typically a `claude setup-token` token exported as `oauthToken`:

```json
{
  "name": "work",
  "allowAmbientCredential": false,
  "credential": { "sources": [{ "op": "op://vault/claude-work/token" }], "target": "oauthToken" }
}
```

`claude-use identity set work --credential-target oauthToken --credential op:op://vault/claude-work/token` writes that, `--credential` again replaces the sources, and `--no-credential` returns the identity to its stored login. The block applies only when no provider is selected (a provider's credential authenticates against the provider's endpoint instead, and the identity's is then not even resolved) and not under the `CLAUDE_CONFIG_DIR` escape hatch, where the configuration directory and whatever login it holds are the caller's.

## Headroom routing

`launch.headroom: true` (in a configuration profile, the global config, a directory rule, or a committed `.claude-use.json`, resolved through the same cascade as every other launch flag) or a one-off `claude --headroom` (or `CLAUDE_USE_HEADROOM=true claude`) routes the whole session through the local [headroom](https://github.com/ExaDev/headroom) daemon instead of straight to the provider. There is no routing mode any more: every routed session enters through the front-door daemon, and headroom is a hop the door applies, always before any protocol translator (it needs the Anthropic-shaped request). What differs between a provider session and an OAuth one is only which of the door's two listeners the child reaches:

- **A provider session** (either kind): the child's `ANTHROPIC_BASE_URL` is the front door's provider-scoped address, `https://127.0.0.1:<port>/providers/<name>`, whatever headroom setting applies. The provider listener serves HTTPS with a leaf certificate for `127.0.0.1` (and `localhost`) signed by claude-use's CA, and the child's `NODE_EXTRA_CA_CERTS` trusts that CA, so the child completes a handshake only with a listener holding a leaf that CA signed. That is what keeps the provider credential and the capability (both sent on every request) from reaching a process that merely binds the port, for instance after the door crashed and released it. `ANTHROPIC_CUSTOM_HEADERS` carries the launcher-injected session headers (the identity name, a per-launch session id, the launch's capability token, and, when headroom is on, the headroom flag and `x-headroom-project-id`, the git repository root of the working directory or the directory itself outside a repository). The door strips every one of them before anything leaves the machine; they exist for the door's identification, authorisation, middleware and hop, and for nothing else. The token is the authorisation: each launch's token is generated at bring-up, recorded in the door's session registry, and required on every request a client-facing listener routes, so a loopback process that never launched through claude-use cannot spend a session's credentials or quota through the door.
- **An OAuth session** (no provider, the session authenticates with the identity's own Claude login): `ANTHROPIC_BASE_URL` is left untouched, because Claude Code enables Remote Control and claude.ai connectors only when it believes it is talking to the real `api.anthropic.com`, and it decides that from the base URL. Routing happens one layer down instead: the child gains `HTTPS_PROXY=http://claude-use:<capability>@127.0.0.1:<connectPort>` (the launch's capability token as the proxy password, percent-encoded) and `NODE_EXTRA_CA_CERTS` trusting the same certificate authority, generated once under `~/.claude-use/frontdoor/ca/`. The door runs a CONNECT surface on that port, which refuses every CONNECT that does not present a live launch's capability (see below); for an authenticated one, every host is blind-tunnelled byte for byte (Remote Control's streaming, OAuth refreshes, connectors, telemetry all pass through untouched), except `api.anthropic.com`, whose TLS the surface terminates with a leaf signed by that CA. On the terminated session, paths under `/v1/` run through the same ordered pipeline the provider listener serves (identification, middleware, then the headroom hop, which forwards them to the daemon with the session's OAuth bearer passing through untouched), and every other path is piped by the surface itself to the real `api.anthropic.com` over TLS, so anything the pipeline does not serve (OAuth, unknown endpoints) never touches it.

The hop itself: when a session's launch resolved headroom on, the door forwards its request, still Anthropic-shaped, to the daemon and streams the response back, telling headroom to send it on to the door's own direct listener (a third, sticky, loopback port serving plain HTTP, whose routes are the same minus the hop, which is what stops the request looping). For a provider session the hop never hands headroom the provider credential: it keeps the `Authorization` or `x-api-key` header in an in-memory custody record and sends headroom a placeholder in its place (`Bearer claude-use-sequestered`, or `claude-use-sequestered`), plus a random hop id and a per-generation secret held only in the door process's memory. The direct listener admits a request only when it carries that secret and a hop id that is still live for the provider its path names, and then routes it with the headers the client originally sent. A hop id stops working the moment its hop's response to the client has ended or been abandoned; it is not single-use within the hop, because headroom sends one client request upstream more than once (its 429, 529 and 5xx retries and its memory and CCR continuations reuse the headers it was handed). So headroom, and anything that binds the direct port, sees placeholders and an id worth nothing outside its hop, never the credential; headroom's own logs and debug dumps, which record a prefix of these headers, record only the placeholder. Headroom works unchanged with the placeholder: it decides a Claude Code request's auth mode from its user agent, forwards credential headers verbatim, and passes the claude-use headers through, which was checked against the installed daemon (0.39.1) on non-streaming, streaming and `count_tokens` requests. An OAuth session's bearer is not replaced: headroom forwards OAuth traffic straight to `api.anthropic.com`, never back to the door, and uses that bearer for its subscription tracking. One daemon therefore still serves several providers, but the routing decision is the door's per session, not a header the child carries; `x-headroom-base-url` no longer exists. While the daemon is between restarts, the hop answers 502 rather than quietly bypassing compression. `HEADROOM_PROXY_URL` still names the daemon for anything else that wants it; the child never talks to it directly.

claude-use fully orchestrates the daemon; you never start, stop, or upgrade headroom by hand. The first launch that resolves headroom on spawns a detached supervisor (a background copy of the `claude-use` binary running a hidden internal subcommand), which installs headroom with `uv tool install` when the binary is missing or its version does not satisfy the configured source, starts `headroom proxy` on a free loopback port with `HEADROOM_ALLOWED_BASE_URLS` set to every provider's base URL, the front door's direct origin, and `https://api.anthropic.com`, waits for its `/readyz` to answer, and only then records the port where the front door's hop reads it live. The proxy also gets `HEADROOM_HTTP2` defaulted to `0`, forcing HTTP/1.1 to upstream providers: headroom's HTTP/2 pool multiplexes every request over shared keep-alive connections, and when a provider retires one (a routine GOAWAY, not an error) every in-flight request on it dies at once, with the single retry just as likely to land on another co-aged connection being retired in the same wave. An explicit `HEADROOM_HTTP2` in the environment overrides the default, so multiplexing can be restored without editing claude-use once headroom's pool honours GOAWAY drain and connection recycling. The daemon's port is sticky: every restart (crash, drift, idle-cycle, even a whole new supervisor generation) reuses the port it last served on whenever it is still free, and a restart that moved would strand the door's live sessions' hop on a dead address until they relaunch. Only a genuinely occupied port justifies moving, and then the move is logged. A proxy that crashes is restarted with bounded exponential backoff; after five consecutive failures to become ready the supervisor records the error in its state and gives up, and the next launch fails loudly with the daemon log path rather than silently bypassing headroom. Crash detection is driven by the proxy's own exit event (which is also what reaps it), and every pid liveness check in the coordination layer is zombie-aware, because a process that died unreaped still answers `kill(pid, 0)` as alive while holding no port; a deliberate stop escalates SIGTERM to SIGKILL on a bounded timeout, since the proxy does not reliably die on SIGTERM alone. When the allowlist or install source drifts (a provider file changed, the configured source changed), the daemon is restarted only once no session is live, so a running session is never cut off; when no session has been live for `idleShutdownMinutes` (15 by default), the supervisor stops the daemon and exits, freeing its memory.

Coordination lives under `~/.claude-use/headroom/`: `state.json` (supervisor pid, daemon pid, port, version, allowlist hash, last error), an exclusive-create start lock so concurrent launches start at most one supervisor, and `sessions/<launcher-pid>.json` files as the session registry, pruned automatically when a launcher pid is no longer alive. `claude-use headroom status` reports all of it read-only, and `claude-use doctor` includes the daemon in its audit. The front door keeps its own coordination under `~/.claude-use/frontdoor/` (its state naming both listeners' ports and the direct listener's, its own start lock and session registry, and the door's CA under `ca/`, which signs both the provider listener's loopback leaf and the CONNECT surface's intercept leaf: `ca.pem`, world-readable because it is public material that children point `NODE_EXTRA_CA_CERTS` at, and `ca.key`, mode 0600, both generated once on the machine's first front-door start and reused forever after, because regenerating them would strand every child still trusting the old authority; `ca/bundles/` holds the combined bundles described below). `claude-use frontdoor status` reports the door, its listeners, the hop's view of the daemon and its sessions.

**Authenticating the door before the credential goes out.** A live pid in the door's `state.json` proves nothing about who holds the port it names: the door may have crashed and left the port free for anyone, or the pid may since belong to an unrelated process. So before a launch registers its capability or hands its child an address, the launcher probes the provider listener's `/healthz` over TLS, trusting only claude-use's CA and requiring the leaf to name `127.0.0.1`, and sends no capability or credential on that probe. A listener that fails (an untrusted certificate, nothing answering, a wrong answer) is treated as a stale or hostile owner: the launch spawns a replacement supervisor, which takes a free port when the sticky one is held and is verified in turn, and if the replacement fails too the launch is refused with the reason and the daemon log path. Sessions already running against a port a hostile process has taken fail their TLS handshake and send it nothing; they recover by relaunching.

**The child's trust bundle.** Node reads exactly one file from `NODE_EXTRA_CA_CERTS`, so pointing it straight at the door's CA would silently drop a bundle the user already set there (a corporate proxy's CA, say). A routed child therefore gets the CA file itself when the parent set nothing, the parent's file unchanged when it already contains the CA (a launch from inside a routed session), and otherwise a combined bundle (the parent's certificates, then the CA) written once under `~/.claude-use/frontdoor/ca/bundles/`, named by its content hash. When the parent's file cannot be read the child gets the CA alone and the launch warns, naming the file; Node would have ignored that file anyway. Everything the child spawns inherits the bundle, so its subprocesses also trust the door's CA, whose key only this user can read.

**What remains exposed.** The door-to-headroom leg and headroom's own listener are plain HTTP on loopback, because headroom is a separate program serving HTTP. If the headroom daemon dies and another local process binds its port before it restarts, that process receives the routed requests in flight: prompt and response content, the project identity, the placeholder, the hop secret and the hop id. It cannot obtain the provider credential, but while one of those hops is still live it could replay that hop's id and secret to the door's direct listener and have the door spend the credential (and return the answer), for that hop's provider only, until the hop ends. An OAuth session's bearer does cross that leg, as it always has, since headroom needs it. The same is true of headroom without claude-use; closing it would need headroom to authenticate its own listener.

**The front door's per-launch capability.** Every routed launch registers itself under `~/.claude-use/frontdoor/sessions/<launcher-pid>.json` with a random capability token that its child presents on every request, and a request without a live launch's token is refused before any route runs. The token is a bearer secret (presenting it to a listener spends the launch's provider credential or Codex login), so the registry directory is created mode 0700 and each record written mode 0600, atomically, and narrowed if it already existed wider: another local account on a shared host can neither list nor read it. The supervisor reads these records through the front door's own registry functions, which carry the token; headroom's registry reader is strict and token-less, so it would see none of them and idle the listeners shut under a live session, releasing the sticky ports. `frontdoor status` and `codex status` list a launch by pid and start time only, never the token. A launcher that died has its record pruned, and with it the capability stops being accepted.

**Authenticating the CONNECT surface.** A proxy that tunnels for anyone who asks is an open TCP proxy for every local process: it can be used to exhaust the door or to reach the network through the user's egress. So the surface authenticates the CONNECT request itself, before it parses the target, dials anything or terminates any TLS. The capability rides in the `HTTPS_PROXY` URL because the CONNECT request that opens a tunnel is sent before any of the child's own headers, and every proxy-aware client turns a URL credential into `Proxy-Authorization: Basic ...` on each CONNECT: this was checked against the installed Claude Code (both the Homebrew cask and the native install), curl, Node's own `NODE_USE_ENV_PROXY` support and Python's `urllib`, all of which send it on the first CONNECT without waiting for a challenge. The surface takes the Basic credential's password (the user name is only a label) and checks it, in constant time, against the same live session registry the routed pipeline admits requests by. A CONNECT with no credential, another scheme, a repeated header or a capability that is not live answers `407 Proxy Authentication Required` with `Proxy-Authenticate: Basic realm="claude-use front door"` and is closed, and no target is ever dialled for it. A launch whose launcher has died loses its capability when the supervisor prunes it, and the surface re-checks every open tunnel's capability once per supervisor tick (one second), closing the tunnels and terminated sessions a dead launch left open.

The surface also bounds its connections (`CONNECT_LIMITS` in `src/frontdoor/connect.ts`, each value's reasoning beside it). A connection must deliver its whole CONNECT head within 10 seconds or it is answered 408 and closed, since every client sends the head the moment it connects. At most 64 connections may be waiting for their head at once; one more evicts the oldest waiting connection (also 408) rather than refusing the newcomer, so a process holding half-sent heads cannot lock live launches out, whose heads arrive at once and are authenticated before they could be evicted. A head over 8 KiB is answered 431. At most 1024 authenticated connections (tunnels and terminated sessions together) may be open at once; one more is answered 503 and closed. An authenticated tunnel has no idle timeout: Remote Control and other long-lived streams can stay silent between events for as long as the far end chooses, so any idle limit would cut real sessions. Tunnels are bounded instead by who can open them, by the cap, and by revocation when their launch ends.

What the capability does and does not cover: every process in the launch's own tree (the Bash tool's commands, hooks, MCP servers) inherits `HTTPS_PROXY` with the capability, exactly as it inherits the rest of the environment and the `ANTHROPIC_CUSTOM_HEADERS` copy of the same token, and so can tunnel through the surface; that reaches nothing the process could not reach itself. A process running as the same user is not kept out either, since it can read the registry or the child's environment directly; the capability closes the port to other local accounts and to processes that can reach loopback but not the user's files. Anything that prints or logs its environment or proxy URL records the capability, which is valid until that launch ends. One launch's process tree can still fill the authenticated cap and starve other launches until its tunnels close.

Two settings live in the global `~/.claude-use/config.json` under `headroom` (they describe one daemon per machine, so they are deliberately global-only, never per-directory):

```json
{ "headroom": { "source": "headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@eb02fa4126450c9905a49394fdec19ae2e7c9c30", "idleShutdownMinutes": 15 } }
```

`source` is the install spec handed to `uv tool install` (any PEP 508 form works; a pinned `headroom==0.39.0` is checked against the installed version on every start), and `idleShutdownMinutes` is how long an idle daemon lingers before shutdown.

The same block carries headroom's token-saving settings, which claude-use turns into flags and environment for the daemon it supervises, so they no longer depend on whichever shell started it first:

```json
{ "headroom": { "mode": "token", "targetRatio": 0.5, "ccr": "lossless" } }
```

`mode` is `cache` (headroom's default: earlier turns are frozen for provider prefix-cache hits) or `token` (earlier turns may be rewritten for more compression). `targetRatio` is the keep-ratio for prose and code compression, above 0 and at most 1, lower being more aggressive; unset lets headroom decide. `ccr` is `default` (retrieval markers and the `headroom_retrieve` tool), `lossless` (tool output compacted with no markers) or `none` (no markers and no retrieval tool, so a compressed original cannot be recovered). `rolloutChannel` (`beta`, `canary` or `dev`) is headroom's experimental channel, exported as `HEADROOM_ROLLOUT_CHANNEL`. `interceptToolResults` needs `canary` or `dev` and `readMaturation` needs `beta` or `dev`; the config is refused if either is set without a channel that unlocks it, so neither can be enabled by accident. An unset field adds no flag. Settings are compared on every supervisor tick, so a change restarts the daemon once no session is live, the way a changed allowlist or `source` does, and `claude-use headroom status` shows the configured settings and whether a restart is pending. Memory, learning, the code graph and rate limits are not exposed: they are not token savings or do not suit one machine-wide daemon.

**Providers under headroom.** A launch that selects any provider (or resolves headroom on) brings the front door up before headroom, and the headroom allowlist includes the door's direct origin (every http provider's base URL is already in the allowlist, and a provider's upstream through headroom is the door's direct listener, where the in-process translator or the pass-through serves it). The consequence of the drift rule above: the first routed launch after adding a first provider, while headroom is already serving live sessions, is refused until headroom has restarted once no session is live, because the running daemon's allowlist predates the door's address. Launches succeed normally from then on. The ordering inside the door is fixed regardless: headroom sits before the translator (it needs the Anthropic-shaped request), so a codex session runs Claude Code, the front door, headroom, the front door's direct listener, the translator, the Codex backend, in that order.

**The cache-sharing model.** Everything routed through one daemon shares that daemon's caches: the semantic cache (response reuse across identical requests) is shared across accounts, which is the point of running one daemon per machine; headroom's memory state is scoped per project by the `x-headroom-project-id` header, so two projects talking to the same daemon keep separate memory; and the provider (which account's endpoint, which model mapping) is selected per session by the front door's route, not by anything the child sends. Sharing a daemon with other people therefore means giving them the daemon's address under a shared `HEADROOM_PROXY_TOKEN`, which is also what headroom binds memory identity to: point a colleague at your daemon and they share its caches and per-project memory as that token's identity, so treat the token like any other shared credential.

## Launch flags

`skipPermissions`, `remoteControl` and `headroom` resolve through the same cascade as everything else (shipped default: all off), and each also has a one-off command-line flag and environment variable. For each setting, the flag decides outright, then the environment variable, then the cascade:

```bash
claude --skip-permissions          # or --no-skip-permissions; CLAUDE_USE_SKIP_PERMISSIONS=true|false
claude --remote-control            # or --no-remote-control;   CLAUDE_USE_REMOTE_CONTROL=true|false
claude --headroom                  # or --no-headroom;         CLAUDE_USE_HEADROOM=true|false
```

The environment variables read `true`/`1` and `false`/`0`, so `CLAUDE_USE_SKIP_PERMISSIONS=0` switches off a profile's `skipPermissions: true` for one launch. `provider` (see above) resolves through the same cascade, with `--provider <name>` and `--no-provider` as its one-off forms. A configuration profile stores these as `launch.*` keys, set with `claude-use profile set <name> --launch-skip-permissions`, `--launch-remote-control`, `--launch-headroom` and `--launch-provider <name>` (each with a `--no-` form), so a launch flag and the profile setting that stores it never share a spelling. The launcher recognises all of these only before a `--` terminator; everything from `--` on is forwarded to Claude Code untouched.

`$CLAUDE_EXTRA_FLAGS` is passed straight through to the underlying `claude` binary.

### Ambient-credential guard

Before any of the above, the launcher checks the environment for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY` (see [Identities](#identities) for why) and refuses to launch if any is present, unless the active identity has `allowAmbientCredential: true` in its `identity.json` or `CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=true` (or `1`) is set for this one invocation. The opt-in is deliberately identity-only, with no cascade key, since a committed `.claude-use.json` must never be able to switch a credential-isolation check off. An empty string counts as unset for all six variables: this matters because clearing one of them with `export ANTHROPIC_API_KEY=""` (rather than `unset`), a real pattern in wrapper scripts that fall through to a different variable once the first is cleared, must not trip the guard:

```bash
CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=1 claude   # this run only
claude-use identity set <name> --allow-ambient-credential   # persistently, for this identity
```

An identity's own credential block does not trip the guard on the token it injects: a `claude @work` started inside a `claude @work` session finds `CLAUDE_CODE_OAUTH_TOKEN` already holding exactly the token this launch resolves, and that variable holding that value is not ambient. The same variable holding any other value, or any other guarded variable, still trips it.


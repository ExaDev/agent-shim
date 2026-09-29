# Configuration model

Full mechanics of identities, configuration profiles, category-based sharing, the cascade merge algorithm, directory rules, portable per-repo config, project-history pattern matching and launch flags. Verbatim from an earlier README.md; linked from the README's condensed Concepts section rather than loaded into every session.

## Concepts

### Identities

An identity is a directory at `~/.claude-use/identities/<name>/` — a symlink farm mirroring the parts of `~/.claude` that are configured to be shared, plus its own locally-written credentials and daemon state that are never shared with any other identity. This is what `CLAUDE_CONFIG_DIR` points at when you run `claude` under that identity. Alongside the farm, the identity directory holds one small, Zod-validated `identity.json` (created by `claude-use identity add`): the optional `defaultConfigProfile` used to resolve which configuration profile applies (per below), and the optional `allowAmbientCredential` boolean (default `false`) that opts this one identity out of the ambient-credential launch guard described next.

Select an identity with:

- `claude-use run @<name>` — for this one invocation, always available, no setup beyond installing `claude-use` itself
- `claude @<name>` — equivalent, once `claude-use shim enable` has been run (see [Install](../README.md#install))
- `CLAUDE_ACCOUNT=<name> claude` — equivalent, via environment variable (this is `claude-use`'s own variable, read by its launcher; Anthropic's own multi-account convention is a plain `CLAUDE_CONFIG_DIR=<path> claude`, which `claude-use` builds on top of rather than replaces) — also needs the shim enabled first
- `claude-use identity use <name>` — persistently, until changed again
- `claude-use @<name>` — the same, terser: shorthand for `claude-use identity use <name>`, matching the `@name` convention the other forms above already use. Deliberately requires the `@` prefix and requires `@<name>` to be the *only* argument — identity names are user-chosen and unconstrained against `claude-use`'s own subcommand vocabulary (`identity`, `profile`, `rules`, `check`, `configure`, `doctor`, `shim`, `run`), so a bare `claude-use <name>` (no `@`) is deliberately left alone as an "unknown command" error rather than risking a future identity name colliding with a future subcommand name

A directory rule (see below) can also pin a specific identity to a path, overriding whichever one is otherwise active — useful as a safety net so a particular client's directory always uses the right login regardless of habit.

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

At launch, every rule whose `path` is an ancestor of (or equal to) `$PWD` is collected, sorted shallowest-first, and folded into the cascade in order. A rule's `configProfile` composes in rather than swapping in wholesale — `client-strict` above might itself extend `work-default`, so the deeper rule is saying "here's what's additionally true this far down the tree." A rule's optional `identity` field pins which login applies for that path regardless of whichever identity is otherwise active — an explicit `@name`/`CLAUDE_ACCOUNT` on the command line still wins over a directory pin (it's the most deliberate, immediate signal), but a directory pin beats the plain global default, making it a genuine safety net: if you accidentally run the wrong login from inside a sensitive directory out of habit, the pin holds unless you explicitly override it.

Because the farm's content now depends on **(identity, resolved configuration profile, directory)**, not just identity, `claude` resolves the full cascade for `$PWD` and resyncs the active identity's farm in place on every single launch, before spawning the real binary — fast, when the resolved decision is uniform across the categories in play, since it's comparing and updating symlinks over a few dozen top-level entries rather than rebuilding from scratch. This stops being cheap the moment a conditional override is in scope for a large subtree — `history/projects/` chief among them, since a `newerThan`/`olderThan`/`maxSizeBytes` condition (per [Conditional matching](#conditional-matching-when)) can never use the uniform-symlink shortcut and has to evaluate each project directory's own mtime/size individually, on every launch, with no caching described. For a long-lived identity with a lot of history, this is worth benchmarking early rather than assumed away.

Running two or more sessions concurrently under one identity — two terminals, each in a different client directory, is exactly the pattern directory rules are meant to support — means two resyncs can race to mutate the same shared farm toward two different resolved states. The launcher serialises this with a per-identity lock file (held for the duration of the resync, released before spawning `claude`) and builds each resync's changes as a scratch tree swapped into place with an atomic rename rather than mutating the live farm path-by-path in place, so a sibling session never observes a half-updated farm partway through someone else's resync.

### Resolving a retained superseded farm

Swapping in a resynced farm carries the identity's own real local data (credentials, `identity.json`, daemon/runtime state — anything that isn't a symlink or a directory the previous resync itself materialised) across from the superseded farm into the new one. When a top-level name exists in both, the swap does not guess which copy matters more — for most categories the tool has no way to judge that safely: `categories` only tracks whether data is *shared across identities*, not whether it's *precious vs. disposable*, and overwriting either copy could discard something real.

One category is the exception. `runtime`'s own definition (see the [category table](#category-based-sharing) above) is specifically "live per-process or per-machine artifacts" — a daemon lock, an MCP auth-needed cache, an update-check result — that make no sense being fought over at all, let alone asked about. A colliding name whose category resolves to `runtime` is discarded from the superseded copy automatically, with nothing kept from the old side and nothing asked: `keep-new` is not a judgement call for this category, it is what the category already means. This needs only the name's static classification, never the resolved shared/not-shared decision for the current directory — a `runtime` entry is disposable whether or not this identity currently chooses to share it.

For everything else, the swap leaves the superseded farm on disk and reports it (`FARM_PREVIOUS_RETAINED`, or `FARM_SWAP_RECOVERED` when a crash-recovery pass on a later launch rediscovers it, naming what it auto-resolved and what it could not) rather than guessing. `claude-use identity resolve <name>` walks every retained `.{name}.previous.*` directory for that identity, auto-resolving any further `runtime` collisions it finds the same way, and asks about the rest interactively: keep the current farm's copy, keep the superseded farm's copy, or skip it for now (leaving it exactly as-is for a later run to ask about again). A superseded directory is only removed once every one of its own conflicts has been decided; skipping even one leaves the whole directory retained.

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

**A committed `.claude-use.json` is trusted automatically the first time you run `claude` inside a directory it covers — there is no confirmation step, by design, but you should know that before relying on it.** Because a repo's config can broaden what an identity shares (any category or entry short of the hardcoded `secret`) the moment you run `claude` inside it, cloning and running `claude` in an unfamiliar or untrusted repo changes what that identity's farm exposes for as long as you work there. If that's a concern for a given identity — a strict client-separated one, say — pin a directory rule for that path with `claude-use rules add <path> --profile <strict-profile>` (per [CLI reference](cli-reference.md#cli-reference)) before ever running `claude` there for the first time: a directory-scoped local rule always composes after the committed file (most-personal-last, above), so it can only tighten what an untrusted `.claude-use.json` opened, never the reverse. `claude-use check <path>` also shows you exactly what a repo's `.claude-use.json` would resolve to before you ever run `claude` there.

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

## Providers

A provider is a named API endpoint a session can be routed through instead of `api.anthropic.com`: an Anthropic-compatible relay, an OpenRouter-style aggregator, or any other base URL that speaks the Messages API. Providers replace the hand-written shell wrappers (`z` for GLM, `m` for MiniMax, `o` for OpenRouter, `s` for Synthetic) with first-class config, so the same identity, farm, and cascade machinery applies to them unchanged.

Each provider lives in its own file at `~/.claude-use/providers/<name>.json`:

```json
{
  "displayName": "GLM",
  "baseUrl": "https://api.z.ai/api/anthropic",
  "tokenEnv": "Z_API_TOKEN",
  "env": { "ANTHROPIC_MODEL": "glm-4.6" }
}
```

`tokenEnv` is the NAME of an environment variable holding the token, never the token itself: a provider file is ordinary committed config, and the credential stays in the environment or a secret store where it belongs. It may be omitted only by a provider whose `env` itself carries a non-empty `ANTHROPIC_AUTH_TOKEN`: a local proxy that takes a fixed dummy token (and validates nothing) has no real secret to keep out of the file, and anything with a real credential must still name its variable. `env` carries any further static environment entries the child needs to use that endpoint (model maps like `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL`, `API_TIMEOUT_MS`, an explicit `ANTHROPIC_API_KEY: ""` for endpoints where the auth token must take over, and so on).

Selection works exactly like the launch flags below: `launch.provider` in any cascade layer (global config, a configuration profile, a directory rule, a committed `.claude-use.json`), with a one-off `claude --provider <name>` flag outranking every layer. When a provider is resolved, the child's environment gains `ANTHROPIC_BASE_URL` (the provider's base URL), `ANTHROPIC_AUTH_TOKEN` (the token read from `tokenEnv`), every entry of the provider's `env`, and `CLAUDE_USE_PROVIDER` (the display name, for statusline use). `ANTHROPIC_API_KEY` is explicitly cleared to the empty string unless the provider's own `env` names a value, so an ambient key inherited from the parent environment cannot outrank the token that was just set.

Two refusals, both before anything is spawned: an unknown provider name exits 1 with the known provider names listed, and a provider whose `tokenEnv` is unset or empty in the parent environment exits 64 with `claude-use: provider <name> needs <VAR> set in your environment` (a fixed-credential provider instead refuses only if its `env.ANTHROPIC_AUTH_TOKEN` is empty, which `ProviderSchema` already rejects at load).

The ambient-credential guard (below) checks the parent environment and is unaffected by a provider launch: the guard runs before the child environment is built, and the provider's own token is injected into the child after it, so claude-use itself supplies the credential. An ambient `ANTHROPIC_AUTH_TOKEN` left over in a parent shell is therefore not refused when a provider is selected, because the child never sees it; with no provider selected, the guard refuses it as always.

## Headroom routing

`launch.headroom: true` (in a configuration profile, the global config, a directory rule, or a committed `.claude-use.json`, resolved through the same cascade as every other launch flag) or a one-off `CLAUDE_USE_HEADROOM=1 claude` routes the whole session through a local [headroom](https://github.com/ExaDev/headroom) daemon instead of straight to the provider. How the child is routed depends on whether a provider is selected for that launch, and nothing else decides it (there is no user-facing setting for the mode):

- **Provider mode** (a provider is selected): the child's `ANTHROPIC_BASE_URL` becomes the daemon's loopback address, `HEADROOM_PROXY_URL` names it too, and `ANTHROPIC_CUSTOM_HEADERS` gains `x-headroom-project-id` (the git repository root of the working directory, or the directory itself outside a repository) plus `x-headroom-base-url` carrying the provider's real upstream so one daemon can serve several providers per request.
- **OAuth mode** (no provider, the session authenticates with the identity's own Claude login): `ANTHROPIC_BASE_URL` is left untouched and routing happens one layer down, at the proxy layer. Claude Code enables Remote Control and claude.ai connectors only when it believes it is talking to the real `api.anthropic.com`, and it decides that from the base URL, so pointing it at a local address to get compression (the only option before this mode existed) silently disabled both. Instead the child gains `HTTPS_PROXY=http://127.0.0.1:<mitmPort>` and `NODE_EXTRA_CA_CERTS` pointing at a certificate authority generated once under `~/.claude-use/headroom/ca/`. The supervisor runs a CONNECT proxy on that port: every host is blind-tunnelled byte for byte (Remote Control's streaming, OAuth refreshes, connectors, telemetry all pass through untouched), except `api.anthropic.com`, whose TLS the proxy terminates with a leaf signed by that CA. On the terminated session, paths under `/v1/` are forwarded to the headroom daemon's existing loopback port (compression, per-session stats and upstream auth unchanged; the session's OAuth bearer passes through untouched, and `x-headroom-project-id` still scopes memory per project), and every other path is piped by the proxy itself to the real `api.anthropic.com` over TLS, so anything headroom does not serve (OAuth, unknown endpoints) never touches it.

claude-use fully orchestrates the daemon; you never start, stop, or upgrade headroom by hand. The first launch that resolves headroom on spawns a detached supervisor (a background copy of the `claude-use` binary running a hidden internal subcommand), which installs headroom with `uv tool install` when the binary is missing or its version does not satisfy the configured source, starts `headroom proxy` on a free loopback port with `HEADROOM_ALLOWED_BASE_URLS` set to every provider's base URL plus `https://api.anthropic.com`, waits for its `/readyz` to answer, and only then records the port where launches can find it. The proxy also gets `HEADROOM_HTTP2` defaulted to `0`, forcing HTTP/1.1 to upstream providers: headroom's HTTP/2 pool multiplexes every request over shared keep-alive connections, and when a provider retires one (a routine GOAWAY, not an error) every in-flight request on it dies at once, with the single retry just as likely to land on another co-aged connection being retired in the same wave. An explicit `HEADROOM_HTTP2` in the environment overrides the default, so multiplexing can be restored without editing claude-use once headroom's pool honours GOAWAY drain and connection recycling. The supervisor also binds the MITM CONNECT proxy in its own process, and it does so before any daemon start attempt, so an OAuth launch never finds one server up without the other. Both addresses are then sticky: every restart (crash, drift, idle-cycle, even a whole new supervisor generation) reuses the ports the servers last served on whenever they are still free, because each session's environment was frozen at launch pointing at that address (the provider mode sessions at the daemon's port, the OAuth mode sessions at the proxy's) and a restart that moved would strand every live session on a dead one. Only a genuinely occupied port justifies moving, and then sessions launched against the old port are stale until they relaunch. A proxy that crashes is restarted with bounded exponential backoff; after five consecutive failures to become ready the supervisor records the error in its state and gives up, and the next launch fails loudly with the daemon log path rather than silently bypassing headroom. (The MITM proxy cannot crash independently: it is a server inside the supervisor process, so it lives and dies with it; while the daemon alone is restarting, the proxy keeps listening and its `/v1/` paths answer 502 until the daemon is back, rather than quietly bypassing headroom.) Crash detection is driven by the proxy's own exit event (which is also what reaps it), and every pid liveness check in the coordination layer is zombie-aware, because a process that died unreaped still answers `kill(pid, 0)` as alive while holding no port; a deliberate stop escalates SIGTERM to SIGKILL on a bounded timeout, since the proxy does not reliably die on SIGTERM alone. When the allowlist or install source drifts (a provider file changed, the configured source changed), the daemon is restarted only once no session is live, so a running session is never cut off; when no session has been live for `idleShutdownMinutes` (15 by default), the supervisor stops the daemon and the MITM proxy, and exits, freeing its memory.

Coordination lives under `~/.claude-use/headroom/`: `state.json` (supervisor pid, daemon pid, both ports, version, allowlist hash, last error), the CA under `ca/` (`ca.pem`, world-readable because it is public material that children point `NODE_EXTRA_CA_CERTS` at, and `ca.key`, mode 0600; both generated once on the machine's first headroom start and reused forever after, because regenerating them would strand every child still trusting the old authority), an exclusive-create start lock so concurrent launches start at most one supervisor, and `sessions/<launcher-pid>.json` files as the session registry, pruned automatically when a launcher pid is no longer alive. `claude-use headroom status` reports all of it read-only, and `claude-use doctor` includes the daemon and the proxy's CA in its audit.

Two settings live in the global `~/.claude-use/config.json` under `headroom` (they describe one daemon per machine, so they are deliberately global-only, never per-directory):

```json
{ "headroom": { "source": "headroom-ai[proxy] @ git+https://github.com/ExaDev/headroom@feat/per-session-savings", "idleShutdownMinutes": 15 } }
```

`source` is the install spec handed to `uv tool install` (any PEP 508 form works; a pinned `headroom==0.39.0` is checked against the installed version on every start), and `idleShutdownMinutes` is how long an idle daemon lingers before shutdown.

**The cache-sharing model.** Everything routed through one daemon shares that daemon's caches: the semantic cache (response reuse across identical requests) is shared across accounts, which is the point of running one daemon per machine; headroom's memory state is scoped per project by the `x-headroom-project-id` header, so two projects talking to the same daemon keep separate memory; and the provider (which account's endpoint, which model mapping) is selected per request by `x-headroom-base-url`. Sharing a daemon with other people therefore means giving them the daemon's address under a shared `HEADROOM_PROXY_TOKEN`, which is also what headroom binds memory identity to: point a colleague at your daemon and they share its caches and per-project memory as that token's identity, so treat the token like any other shared credential.

## Launch flags

`skipPermissions` and `remoteControl` resolve through the same cascade as everything else (shipped default: both off), plus a one-off environment variable escape hatch. `provider` and `headroom` (see the sections above) resolve exactly the same way:

```bash
CLAUDE_USE_SKIP_PERMISSIONS=1 claude
CLAUDE_USE_REMOTE_CONTROL=1 claude
CLAUDE_USE_HEADROOM=1 claude
```

`$CLAUDE_EXTRA_FLAGS` is passed straight through to the underlying `claude` binary.

### Ambient-credential guard

Before any of the above, the launcher checks the environment for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY` (see [Identities](#identities) for why) and refuses to launch if any is present, unless the active identity has `allowAmbientCredential: true` in its `identity.json` or `CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=1` is set for this one invocation. An empty string counts as unset for all six variables — this matters because clearing one of them with `export ANTHROPIC_API_KEY=""` (rather than `unset`), a real pattern in wrapper scripts that fall through to a different variable once the first is cleared, must not trip the guard:

```bash
CLAUDE_USE_ALLOW_AMBIENT_CREDENTIAL=1 claude   # this run only
claude-use identity set <name> --allow-ambient-credential   # persistently, for this identity
```


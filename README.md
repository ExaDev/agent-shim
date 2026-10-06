# agent-shim

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/agent-shim) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/agent-shim) [![Release](https://img.shields.io/github/v/release/ExaDev/agent-shim)](https://github.com/ExaDev/agent-shim/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/agent-shim/ci.yml?branch=main)](https://github.com/ExaDev/agent-shim/actions) [![Homebrew](https://img.shields.io/badge/Homebrew-FBB040?logo=homebrew&logoColor=white)](https://github.com/ExaDev/homebrew-agent-shim) [![Scoop](https://img.shields.io/badge/Scoop-205081?logo=data:image/svg%2Bxml%3Bbase64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTExIDJoMnY5aC0yek0xMiAyMmE3IDcgMCAwIDAgNy03SDVhNyA3IDAgMCAwIDcgN3oiIGZpbGw9IiNmZmYiLz48L3N2Zz4K&logoColor=white)](https://github.com/ExaDev/scoop-agent-shim)

A profile manager and launcher for [Claude Code](https://claude.com/claude-code) that lets one person run multiple logins from one machine while controlling — precisely, and per working directory — what gets shared between them.

[![npm downloads chart, log scale](https://shieldcn.dev/chart/npm/agent-shim.svg?bg=transparent&logo=false&yScale=log)](https://www.npmjs.com/package/agent-shim)

## The problem

Claude Code keeps everything it knows in one place: `~/.claude`. Skills, memory, conventions, but also every conversation transcript, session file, and task list you've ever produced, across every project you've ever touched. If you want a second login (a personal account alongside a work one, say) or you want to keep one client's work cleanly separated from another's, there's no built-in way to say "share the skills and conventions, but not the history" — it's all one directory, all or nothing.

`agent-shim` solves this with two independent things:

- **An identity** is a login. It's the thing that owns credentials and daemon state, and it's what you switch between with `claude @work` or `claude @personal`.
- **A configuration profile** is a reusable, named bundle of sharing rules — what's visible, what isn't. It exists independently of any identity, and which one applies can depend entirely on which directory you're working in.

Keeping these separate matters because they answer different questions. "Which login am I using?" and "What should this login see right now?" don't have to have the same answer every time, and forcing them to share one concept (as most ad hoc setups do) means you can't express "one login, several different sharing postures depending on where I am" — which turns out to be the common case.

## Install

```bash
curl -fsSL https://github.com/ExaDev/agent-shim/releases/latest/download/install.sh | sh
```

This installs `agent-shim` alone into `~/.local/bin`; your existing `claude` command is left untouched. `agent-shim run [args...]` reaches the same identity-resolve, farm-resync, spawn pipeline a `claude`-named binary would, so every feature already works with no further setup. Run `agent-shim shim enable` once for the shorter `claude @<name>` form (`shim disable` reverses it).

Also available: npm (`npm install -g agent-shim`, needs Node 22.18 or later, or 24 and above), Homebrew (`brew install ExaDev/agent-shim/agent-shim`), Scoop on Windows, a scoped GitHub Packages alias, and installing straight from the git repository with no registry at all. Each channel's exact commands, the platform support matrix, and the one architecture (macOS x64) that needs a different install path are in [docs/installation.md](docs/installation.md).

## Renamed from claude-use

agent-shim was called `claude-use` until it was renamed. Everything written for the old name keeps working, and `agent-shim doctor` lists what still uses it:

- The `claude-use` command is installed beside `agent-shim` by every channel and runs the same program.
- `CLAUDE_USE_*` environment variables are read wherever `AGENT_SHIM_*` is; the current name wins when both are set.
- An existing `~/.claude-use` is used in place when there is no `~/.agent-shim`. Do not move it: macOS Claude Code keys each identity's Keychain login on the exact path of its configuration directory (`<root>/identities/<name>`), so relocating the root signs every identity out. A fresh installation uses `~/.agent-shim`.
- A committed `.claude-use.json` or `.claude-use.local.json` is read when the directory has no `.agent-shim.json` or `.agent-shim.local.json`; `configure` keeps writing into the legacy local file while it is the only one.
- A farm manifest written under the old name is read, and replaced by the current one on the next resync.
- A session launched by a release under the old name keeps working against a newer front door: its internal `x-claude-use-*` request headers are accepted as their `x-agent-shim-*` equivalents and never forwarded upstream.
- npm: `claude-use` is still published, identical to `agent-shim` and exposing both commands, so `npm install -g claude-use` keeps tracking releases. Homebrew moves an installed `claude-use` formula to `agent-shim` on upgrade.

## Quick start

```bash
agent-shim identity add personal      # create your first identity (a fresh login)
agent-shim run @personal              # log in and start using it
```

Want the shorter `claude @personal` instead? Run `agent-shim shim enable` once — see [Install](#install).

That's it — with no further configuration, everything in `~/.claude` that isn't credentials or daemon runtime is classified into categories (see below) and shared according to sensible defaults. Add a second identity, add configuration profiles, and add directory rules only once you actually need more control than that.

## Concepts

`agent-shim` separates two things most ad hoc multi-account setups conflate:

- **An identity** is a login: the thing that owns credentials and daemon state, selected with `agent-shim run @<name>` or, once `agent-shim shim enable` has run, `claude @<name>`.
- **A configuration profile** is a reusable, named bundle of sharing rules, independent of any identity, resolved per working directory via directory rules or a committed `.agent-shim.json`.

A third, optional thing sits on top of identities: **a pool** is a named list of them. Select `pool:<name>` where an identity name goes (`claude @pool:subs`) and agent-shim picks the member whose unused quota is closest to expiring, skipping any that are refused right now, using the usage it already records. A pool can instead declare `--preference listed`, which tries the members in the order the pool lists them, skipping only one that is refused right now. A member entry may itself name another pool (`pool:<name>`), which is ranked with its own policy and contributes its pick at that position, so "this identity first, then the fleet" nests the fleet rather than copying its member list; cycles are refused. See [docs/configuration-model.md](docs/configuration-model.md#pools-picking-an-account-at-launch).

Every top-level entry in `~/.claude` is classified into one of five categories, shipped as a default map (`config/categories.default.json`):

| Category | Default shared? | Example entries |
|---|---|---|
| `secret` | **Never** — hardcoded, cannot be overridden by any configuration layer | `.credentials.json`, `backups`, `settings.json.bak*` |
| `runtime` | No | `daemon*`, `.git*`, `.DS_Store`, `mcp-needs-auth-cache.json`, `codex-quota.json`, `file-transfers`, `shell-snapshots`, `statsig`, `telemetry`, `stats-cache.json`, `usage-data`, `ide`, `cache`, `scheduled_tasks.lock` |
| `history` | Yes | `projects`, `sessions`, `session-env`, `teams`, `tasks`, `todos`, `history.jsonl`, `transcripts`, `paste-cache`, `file-history`, `plans`, `workflows`, `jobs`, `debug`, `downloads`, `chrome` |
| `knowledge` | Yes | `skills`, `agents`, `rules`, `memory`, `commands`, `plugins`, `hooks`, `AGENTS.md`, `CLAUDE.md`, `README.md` |
| `settings` | Yes | `settings.json`, `settings.local.json` |

Sharing composes through a cascade (shipped defaults, then a user-global override, then the active configuration profile, then directory rules for `$PWD`, shallowest to deepest); a specific path override always outranks a category default regardless of which layer set it. A committed `.agent-shim.json` at a project's root makes this portable: anyone who clones the repo and runs `claude` inside it gets the same isolation rules with no local setup.

`claude` refuses to launch while `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or a `CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY` variable is set in the environment, because those outrank every identity's stored credential and would make all identities authenticate as the same account. Opt in deliberately with `AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL=1` for one launch or `agent-shim identity set <name> --allow-ambient-credential`.

Providers and identities take their token from one `credential` block: an ordered list of sources (`env`, `file`, `command`, and the `op` and `keychain` presets, plus a `literal` placeholder for a local proxy), tried in turn, and a target (`bearer`, `apiKey`, or `oauthToken` for an identity). An identity's token reaches the child's environment only; a provider's never reaches the child at all (the front door attaches it at the provider's route, which is also what lets provider inference and Remote Control share one session). `check`, `doctor` and `--json` report the source kind and target, never the value.

The full mechanics, including the credential block, the merge algorithm, conditional sharing rules (age, size, git branch, environment), the ambient-credential launch guard, and how `~/.claude/projects/` history is pattern-matched, are in [docs/configuration-model.md](docs/configuration-model.md). Worked examples are in [docs/examples.md](docs/examples.md).

## CLI reference

```
agent-shim <noun> <verb> [name] [options]      # nouns: identity, profile, pool, provider, rule

agent-shim identity add <name> [--json]
agent-shim identity list [--json]
agent-shim identity show <name> [--json]
agent-shim identity set <name> [--default-profile <profile> | --no-default-profile] [--[no-]allow-ambient-credential] [--json]
agent-shim identity set <name> [--credential <source>]... [--credential-target <bearer|apiKey|oauthToken>] [--no-credential] [--json]
agent-shim identity remove <name> [--yes] [--json]
agent-shim identity use <name> [--json]
agent-shim @<name>                          # shorthand for `identity use <name>`
agent-shim identity resolve-conflicts <name>  # interactively resolve a retained superseded farm's conflicts

agent-shim profile add [name] [--extends <profile>]... [--description <text>]   # interactive with no options on a terminal [--json]
agent-shim profile set <name> [--category <category>=<bool>]... [--entry <category>/<path>=<bool>]... [--json]
agent-shim profile set <name> [--extends <profile>]... [--no-extends] [--description <text> | --no-description] [--json]
agent-shim profile set <name> [--[no-]launch-skip-permissions] [--[no-]launch-remote-control] [--[no-]launch-headroom] [--[no-]launch-track-usage]
agent-shim profile set <name> [--launch-claude-version <version> | --no-launch-claude-version] [--json] [--json]
agent-shim profile set <name> [--launch-provider <provider> | --no-launch-provider] [--json]
agent-shim profile list [--json]
agent-shim profile show <name> [--json]
agent-shim profile remove <name> [--yes] [--json]
agent-shim profile use <name>               # the global default configuration profile [--json]

agent-shim pool add <name> --identity <member>... [--preference <score|listed>] [--json]
agent-shim pool set <name> [--identity <member>...] [--preference <score|listed> | --no-preference] [--json]
agent-shim pool list [--json]
agent-shim pool show <name> [--json]
agent-shim pool remove <name> [--yes] [--json]
agent-shim pool use <name> [--json]
agent-shim pool pick <name> [--json]

agent-shim provider add <name> --display-name <name> (--base-url <url> | --kind codex) (--credential <source>)... [--credential-target <bearer|apiKey>] [--env KEY=VALUE]... [--json]
                                              [--codex-default-model <model>] [--codex-model <tier=model>]... [--codex-effort <none|low|medium|high>] [--codex-login <codex-cli|chatgpt-sign-in>]
agent-shim provider set <name> [--display-name <name>] ([--base-url <url>] | --kind codex) [--credential <source>]... [--credential-target <bearer|apiKey>] [--env KEY=VALUE]... [--unset-env KEY]... [--json]
                                              [--codex-default-model <model>] [--codex-model <tier=model>]... [--codex-effort <none|low|medium|high>] [--codex-login <codex-cli|chatgpt-sign-in>]
agent-shim provider list [--json]
agent-shim provider show <name> [--json]
agent-shim provider remove <name> [--yes] [--json]

agent-shim rule add <path> [--config-profile <profile>] [--identity <identity>] [--json]
agent-shim rule set <path> [--config-profile <profile> | --no-config-profile] [--identity <identity> | --no-identity] [--json]
agent-shim rule list [--json]
agent-shim rule show <path> [--json]
agent-shim rule remove <path> [--yes] [--json]

agent-shim configure [path] [--identity <identity>]
agent-shim check [path] [--identity <identity>] [--json] [--strict]
agent-shim doctor [--json]
agent-shim headroom status [--json]
agent-shim codex status [--json]
agent-shim codex login [--no-open] [--json]       # Sign in with ChatGPT, for providers with `codex.login: chatgpt-sign-in`
agent-shim codex logout [--json]
agent-shim frontdoor status [--json]
agent-shim frontdoor rc list [--json]
agent-shim frontdoor rc status [<cse_id>] [--json]
agent-shim frontdoor rc pending [<cse_id>] [--json]
agent-shim frontdoor rc send --session <cse_id> --text <text> [--json]
agent-shim frontdoor rc answer --session <cse_id> --request <id> --approve | --deny [--text <text>] [--json]
agent-shim frontdoor rc interrupt --session <cse_id> [--json]
agent-shim frontdoor rc set-model --session <cse_id> --model <model> [--json]
agent-shim frontdoor rc set-permission-mode --session <cse_id> --mode <mode> [--json]
agent-shim frontdoor rc watch [<cse_id>] [--json]
agent-shim frontdoor rc selfhost mint <identity> [--force] [--json]
agent-shim usage [--identity <name>] [--provider <name>] [--since <duration>] [--refresh] [--json]
agent-shim account show [<identity>] [--refresh] [--json]
agent-shim update [--check] [--mode <off|notify|auto>] [--json]
agent-shim completion <bash|zsh|fish>
agent-shim shim enable [--dir <path>] [--force]
agent-shim shim disable [--dir <path>] [--force]

agent-shim run [@<identity>] [launch flags] [claude arguments]
  # launch flags, recognised only before a `--` terminator:
  #   --identity <name>  --config-profile <name>  --provider <name> | --no-provider
  #   --category <category>=<bool>  --share <category>/<path>  --hide <category>/<path>   (each repeatable)
  #   --[no-]skip-permissions  --[no-]remote-control  --[no-]headroom  --[no-]track-usage  --[no-]wait
  #   --claude-version <version>   run exactly this installed Claude Code version
  #   --native   run the real claude with nothing from agent-shim applied; cannot be combined with the flags above
claude @<identity> ...                      # the same, once `agent-shim shim enable` has run
```

Every `list`, `show`, `check`, `doctor` and `headroom status` prints text by default and JSON with `--json`, and so do the mutating commands (`add`, `set`, `remove` and `use` on identities, profiles, providers, pools and rules), which print one object naming the `action`, the `kind`, the `name` and, for a creation or update, the stored `value`. Prompts appear only when standard input is a terminal; without one, a command that needs input fails with the option that supplies it (a `remove` needs `--yes`). Failures print as `agent-shim: <message>` and exit 1, usage errors exit 2, a selected provider or identity whose credential block yields no token exits 64, and `AGENT_SHIM_DEBUG=1` adds stack traces to unexpected errors. `agent-shim completion <bash|zsh|fish>` prints a shell completion script.

`agent-shim check [path]` resolves the full cascade for a directory without touching the farm, and is the primary way to answer "why is X shared or hidden here". `agent-shim doctor` audits the whole `~/.agent-shim` config graph at once: every identity, profile, `extends` chain, provider (naming the exact replacement for a file still in the format before the credential block) and directory rule, plus whether the right `agent-shim` is the one actually on `PATH`.

The full per-setting flag and environment-variable table (global, one-off, and directory-scoped forms of every setting), and the file-precedence rules `configure` uses when writing a toggle, are in [docs/cli-reference.md](docs/cli-reference.md).

## Architecture

One compiled binary backs both `claude` and `agent-shim`; the entrypoint dispatches on `path.basename(process.argv[1])`, so installation just needs two differently-named copies (or hardlinks) of the same executable on `PATH`.

```
src/
  cli.ts                 # entrypoint: dispatches on invoked name to launcher vs identity/profile-manager subcommands
  launcher.ts             # runLauncher: thin orchestration over launcher/*
  launcher/               # argv parsing, the ambient-credential guard, identity/profile resolution, farm resync
  identityManager.ts, configProfiles.ts, providers.ts, directoryRules.ts   # the `identity`/`profile`/`provider`/`rule` nouns' commands
  identityStore.ts, configProfilesStore.ts, providersStore.ts, directoryRulesStore.ts, poolStore.ts   # their data layers, free of command-line dependencies and exported by the library
  program.ts, completion.ts # buildProgram (the whole command tree, side-effect free) and generated shell completion
  configure.ts, check.ts, doctor.ts, claudeShim.ts           # interactive picker, the check and doctor commands, `claude` shim
  checkReport.ts, checkReportSchema.ts, doctorReport.ts, poolPickReport.ts   # the dry-run inspector, the Zod schema of its JSON form, the whole-tree audit and the pool ranking as data, free of command-line dependencies and exported by the library
  resolve/                # the pure cascade resolver: flatten, decide, extends, walk, plan, reconcile
  config/                 # Zod schemas, cosmiconfig loading, category classification, atomic JSON store
  index.ts                # the library surface (see below): resolver, farm sync, headroom routing, the ambient-credential guard
schema/                   # published JSON Schemas, generated by `pnpm schema`
scripts/build.mts          # esbuild bundle, then `node --build-sea`
install.sh                 # downloads, verifies, and installs the latest release binary
```

Every custom error extends `CliError`; `main()`'s top-level catch prints its message alone for an expected failure and a full stack trace for anything else. Config validation is Zod throughout, with `categories` a closed shape and `entries` an open, glob-capable record, since the two fields have opposite key cardinality. The resolver itself is pure: it takes filesystem, git, and environment facts as an injected parameter rather than reading them itself, which is what makes it unit-testable with fakes.

The package also publishes a library surface alongside the binary: `import { resolveDecisions, resyncFarm, startConnectServer, runFrontDoorSupervisor, runSupervisor, detectAmbientCredential } from "agent-shim"` (ESM or CJS, with type declarations). It re-exports only the pure, port-injected modules, so another tool can resolve identities, sync a farm, run the front door's CONNECT surface and supervisor and the headroom supervisor, or check the ambient-credential guard in process without the CLI installed. Nothing reachable from it imports `commander` or `@clack/prompts`, and the build fails if that stops being true. Its dependencies stay external, installed through the package's own `dependencies`.

The full source layout with per-file responsibilities, the schema design rationale, why config loading uses cosmiconfig's `load()` rather than `search()`, and the resolver's merge and materialisation mechanics are in [docs/architecture.md](docs/architecture.md).

## Releases and builds

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint); every push to `main` runs semantic-release, which decides whether a release is warranted, bumps the version, updates `CHANGELOG.md`, and tags it. `pnpm build` bundles the CLI and then runs Node's single-executable-application step, which needs Node 25.5.0 or later with SEA support: a Homebrew-installed Node has this compiled out, so use a build from nodejs.org or a version manager instead.

macOS x64 is the one target Node core does not verify SEA against, and the resulting binary segfaults on that architecture: a known, unfixed upstream Node limitation, not a bug in this project. Homebrew and `install.sh` both work around it by installing through npm and a real Node on that one platform instead of the broken binary.

The full CI pipeline (why the six platform builds also run on every PR, the semantic-release quirks, npm OIDC trusted publishing, and the root-cause investigation behind the macOS x64 crash) is in [docs/release-process.md](docs/release-process.md).

## Testing

The resolver's cascade and materialisation logic is pure, taking filesystem, git, and environment facts as an injected parameter, so it is unit-tested extensively with fakes rather than a real filesystem, `git`, or `~/.agent-shim`. `launcher.ts`, `check.ts`, and `doctor.ts` each get their own coverage for the real side effects the resolver's purity does not reach: symlink and materialised-directory writes, spawning the real `claude` binary, and the ambient-credential guard.

The full list of test cases, including the two-phase merge algorithm, conditional entries, farm reconciliation, and every command's own edge cases, is in [docs/testing.md](docs/testing.md).

## Development

```bash
pnpm install     # install dependencies
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint . --max-warnings 0
pnpm test        # vitest run
pnpm build       # bundle src/cli.ts with esbuild, then node --build-sea (needs Node >= v25.5.0 with SEA support, not Homebrew's build; see docs/release-process.md)
pnpm schema      # regenerate schema/*.schema.json from src/config/schema.ts; CI fails if this drifts from what's committed
```

Run a single test file directly with `pnpm exec vitest run <path>`. Tests never touch a real identity: `vitest.config.ts` sets `AGENT_SHIM_HOME` to a throwaway directory, and a setup file refuses to run at all if that variable is unset or resolves to the real `~/.agent-shim`.

Commits are gated by Husky hooks: `commit-msg` enforces conventional-commit format, `pre-commit` runs `eslint --fix` on staged files and rejects merge/squash commits and mass deletions on `main`, and `pre-push` runs the full test suite and also rejects a push that would delete more than 100 files on the remote.

A fresh clone needs one extra step before committing anything, since git stores filter definitions in `.git/config` rather than in the repository:

```sh
git config filter.secrets.clean 'python3 .githooks/git-filter-clean %f'
git config filter.secrets.smudge cat
```

Without this, the secret-redaction clean filter `.gitattributes` declares resolves to nothing and content reaches the object store unredacted. Never add a `diff.secrets.textconv` pointing at the same script: it is a stream filter expecting stdin, not a path, and would hang forever under lint-staged. Full rationale for the `%f` argument, plus the test-isolation and commit-hook details above, is in [docs/development.md](docs/development.md).

## Contributing

Issues and pull requests are welcome. Please keep the tool itself free of assumptions about any particular organisation, client, or directory layout — it should work the same for anyone. Governance details (contribution sign-off requirements, code of conduct, review process) aren't decided yet and will be added here before the repository is opened up beyond its initial maintainers.

## References

- [docs/configuration-model.md](docs/configuration-model.md): identities, configuration profiles, category-based sharing, the cascade merge algorithm, directory rules, conditional matching, portable `.agent-shim.json`, `~/.claude/projects/` pattern matching, providers, headroom routing, and launch flags.
- [docs/cli-reference.md](docs/cli-reference.md): the full flag and environment-variable table, `configure`'s file-write precedence, and the `check`/`doctor` debugging commands.
- [docs/examples.md](docs/examples.md): worked configuration examples and a permutation reference.
- [docs/architecture.md](docs/architecture.md): the source layout file by file, error reporting design, schema rationale, and resolver mechanics.
- [docs/release-process.md](docs/release-process.md): the semantic-release pipeline, the Node SEA build, its macOS x64 limitation, and npm/GitHub Packages publishing.
- [docs/testing.md](docs/testing.md): the full list of cases the test suites cover.
- [docs/library.md](docs/library.md): using agent-shim in process: what the library exposes, and what stays CLI-only.
- [docs/installation.md](docs/installation.md): every install channel in full, with the platform support matrix.
- [docs/development.md](docs/development.md): test isolation, commit hooks, and the secret-redaction filter rationale.
- [docs/headroom-measurement.md](docs/headroom-measurement.md): measuring what headroom's transforms are worth on real conversations, offline: the replay method, the cache-weighted cost model and its limits.
- [docs/rc-interception-rig.md](docs/rc-interception-rig.md): the Remote Control interception rig: bring-up, per-host TLS proof, teardown, and the manual login step.
- [docs/rc-web-client.md](docs/rc-web-client.md): the self-hosted Remote Control web client: the page the door serves behind its control token for browser control of its sessions, how it authenticates and speaks the typed API, and how it is tested.

## License

[MIT License](LICENSE).

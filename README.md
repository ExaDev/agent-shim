# claude-use

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/claude-use) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/claude-use) [![Release](https://img.shields.io/github/v/release/ExaDev/claude-use)](https://github.com/ExaDev/claude-use/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/claude-use/ci.yml?branch=main)](https://github.com/ExaDev/claude-use/actions) [![Homebrew](https://img.shields.io/badge/Homebrew-FBB040?logo=homebrew&logoColor=white)](https://github.com/ExaDev/homebrew-claude-use) [![Scoop](https://img.shields.io/badge/Scoop-205081?logo=data:image/svg%2Bxml%3Bbase64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTExIDJoMnY5aC0yek0xMiAyMmE3IDcgMCAwIDAgNy03SDVhNyA3IDAgMCAwIDcgN3oiIGZpbGw9IiNmZmYiLz48L3N2Zz4K&logoColor=white)](https://github.com/ExaDev/scoop-claude-use)

A profile manager and launcher for [Claude Code](https://claude.com/claude-code) that lets one person run multiple logins from one machine while controlling — precisely, and per working directory — what gets shared between them.

## The problem

Claude Code keeps everything it knows in one place: `~/.claude`. Skills, memory, conventions, but also every conversation transcript, session file, and task list you've ever produced, across every project you've ever touched. If you want a second login (a personal account alongside a work one, say) or you want to keep one client's work cleanly separated from another's, there's no built-in way to say "share the skills and conventions, but not the history" — it's all one directory, all or nothing.

`claude-use` solves this with two independent things:

- **An identity** is a login. It's the thing that owns credentials and daemon state, and it's what you switch between with `claude @work` or `claude @personal`.
- **A configuration profile** is a reusable, named bundle of sharing rules — what's visible, what isn't. It exists independently of any identity, and which one applies can depend entirely on which directory you're working in.

Keeping these separate matters because they answer different questions. "Which login am I using?" and "What should this login see right now?" don't have to have the same answer every time, and forcing them to share one concept (as most ad hoc setups do) means you can't express "one login, several different sharing postures depending on where I am" — which turns out to be the common case.

## Install

```bash
curl -fsSL https://github.com/ExaDev/claude-use/releases/latest/download/install.sh | sh
```

This installs `claude-use` alone into `~/.local/bin`; your existing `claude` command is left untouched. `claude-use run [args...]` reaches the same identity-resolve, farm-resync, spawn pipeline a `claude`-named binary would, so every feature already works with no further setup. Run `claude-use shim enable` once for the shorter `claude @<name>` form (`shim disable` reverses it).

Also available: npm (`npm install -g claude-use`, needs Node 22.12 or later), Homebrew (`brew install ExaDev/claude-use/claude-use`), Scoop on Windows, a scoped GitHub Packages alias, and installing straight from the git repository with no registry at all. Each channel's exact commands, the platform support matrix, and the one architecture (macOS x64) that needs a different install path are in [docs/installation.md](docs/installation.md).

## Quick start

```bash
claude-use identity add personal      # create your first identity (a fresh login)
claude-use run @personal              # log in and start using it
```

Want the shorter `claude @personal` instead? Run `claude-use shim enable` once — see [Install](#install).

That's it — with no further configuration, everything in `~/.claude` that isn't credentials or daemon runtime is classified into categories (see below) and shared according to sensible defaults. Add a second identity, add configuration profiles, and add directory rules only once you actually need more control than that.

## Concepts

`claude-use` separates two things most ad hoc multi-account setups conflate:

- **An identity** is a login: the thing that owns credentials and daemon state, selected with `claude-use run @<name>` or, once `claude-use shim enable` has run, `claude @<name>`.
- **A configuration profile** is a reusable, named bundle of sharing rules, independent of any identity, resolved per working directory via directory rules or a committed `.claude-use.json`.

Every top-level entry in `~/.claude` is classified into one of five categories, shipped as a default map (`config/categories.default.json`):

| Category | Default shared? | Example entries |
|---|---|---|
| `secret` | **Never** — hardcoded, cannot be overridden by any configuration layer | `.credentials.json`, `backups` |
| `runtime` | No | `daemon*`, `.git*`, `.DS_Store`, `mcp-needs-auth-cache.json`, `shell-snapshots`, `statsig`, `telemetry`, `stats-cache.json`, `usage-data`, `ide`, `cache`, `scheduled_tasks.lock` |
| `history` | Yes | `projects`, `sessions`, `session-env`, `teams`, `tasks`, `todos`, `history.jsonl`, `transcripts`, `paste-cache`, `file-history`, `plans`, `workflows`, `jobs`, `debug`, `downloads`, `chrome` |
| `knowledge` | Yes | `skills`, `agents`, `rules`, `memory`, `commands`, `plugins`, `hooks`, `AGENTS.md`, `CLAUDE.md`, `README.md` |
| `settings` | Yes | `settings.json`, `settings.local.json` |

Sharing composes through a cascade (shipped defaults, then a user-global override, then the active configuration profile, then directory rules for `$PWD`, shallowest to deepest); a specific path override always outranks a category default regardless of which layer set it. A committed `.claude-use.json` at a project's root makes this portable: anyone who clones the repo and runs `claude` inside it gets the same isolation rules with no local setup.

The full mechanics, including the merge algorithm, conditional sharing rules (age, size, git branch, environment), the ambient-credential launch guard, and how `~/.claude/projects/` history is pattern-matched, are in [docs/configuration-model.md](docs/configuration-model.md). Worked examples are in [docs/examples.md](docs/examples.md).

## CLI reference

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

`claude-use check [path]` resolves the full cascade for a directory without touching the farm, and is the primary way to answer "why is X shared or hidden here". `claude-use doctor` audits the whole `~/.claude-use` config graph at once: every identity, profile, `extends` chain, and directory rule, plus whether the right `claude-use` is the one actually on `PATH`.

The full per-setting flag and environment-variable table (global, one-off, and directory-scoped forms of every setting), and the file-precedence rules `configure` uses when writing a toggle, are in [docs/cli-reference.md](docs/cli-reference.md).

## Architecture

One compiled binary backs both `claude` and `claude-use`; the entrypoint dispatches on `path.basename(process.argv[1])`, so installation just needs two differently-named copies (or hardlinks) of the same executable on `PATH`.

```
src/
  cli.ts                 # entrypoint: dispatches on invoked name to launcher vs identity/profile-manager subcommands
  launcher.ts             # runLauncher: thin orchestration over launcher/*
  launcher/               # argv parsing, the ambient-credential guard, identity/profile resolution, farm resync
  identityManager.ts, configProfiles.ts, directoryRules.ts   # `claude-use identity`/`profile`/`rules` subcommands
  configure.ts, check.ts, doctor.ts, claudeShim.ts           # interactive picker, dry-run inspector, whole-tree audit, `claude` shim
  resolve/                # the pure cascade resolver: flatten, decide, extends, walk, plan, reconcile
  config/                 # Zod schemas, cosmiconfig loading, category classification, atomic JSON store
schema/                   # published JSON Schemas, generated by `pnpm schema`
scripts/build.mts          # esbuild bundle, then `node --build-sea`
install.sh                 # downloads, verifies, and installs the latest release binary
```

Every custom error extends `CliError`; `main()`'s top-level catch prints its message alone for an expected failure and a full stack trace for anything else. Config validation is Zod throughout, with `categories` a closed shape and `entries` an open, glob-capable record, since the two fields have opposite key cardinality. The resolver itself is pure: it takes filesystem, git, and environment facts as an injected parameter rather than reading them itself, which is what makes it unit-testable with fakes.

The full source layout with per-file responsibilities, the schema design rationale, why config loading uses cosmiconfig's `load()` rather than `search()`, and the resolver's merge and materialisation mechanics are in [docs/architecture.md](docs/architecture.md).

## Releases and builds

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint); every push to `main` runs semantic-release, which decides whether a release is warranted, bumps the version, updates `CHANGELOG.md`, and tags it. `pnpm build` bundles the CLI and then runs Node's single-executable-application step, which needs Node 25.5.0 or later with SEA support: a Homebrew-installed Node has this compiled out, so use a build from nodejs.org or a version manager instead.

macOS x64 is the one target Node core does not verify SEA against, and the resulting binary segfaults on that architecture: a known, unfixed upstream Node limitation, not a bug in this project. Homebrew and `install.sh` both work around it by installing through npm and a real Node on that one platform instead of the broken binary.

The full CI pipeline (why the six platform builds also run on every PR, the semantic-release quirks, npm OIDC trusted publishing, and the root-cause investigation behind the macOS x64 crash) is in [docs/release-process.md](docs/release-process.md).

## Testing

The resolver's cascade and materialisation logic is pure, taking filesystem, git, and environment facts as an injected parameter, so it is unit-tested extensively with fakes rather than a real filesystem, `git`, or `~/.claude-use`. `launcher.ts`, `check.ts`, and `doctor.ts` each get their own coverage for the real side effects the resolver's purity does not reach: symlink and materialised-directory writes, spawning the real `claude` binary, and the ambient-credential guard.

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

Run a single test file directly with `pnpm exec vitest run <path>`. Tests never touch a real identity: `vitest.config.ts` sets `CLAUDE_USE_HOME` to a throwaway directory, and a setup file refuses to run at all if that variable is unset or resolves to the real `~/.claude-use`.

Commits are gated by Husky hooks: `commit-msg` enforces conventional-commit format, `pre-commit` runs `eslint --fix` on staged files and rejects merge/squash commits and mass deletions on `main`, `pre-push` runs the full test suite.

A fresh clone needs one extra step before committing anything, since git stores filter definitions in `.git/config` rather than in the repository:

```sh
git config filter.secrets.clean 'python3 .githooks/git-filter-clean %f'
git config filter.secrets.smudge cat
```

Without this, the secret-redaction clean filter `.gitattributes` declares resolves to nothing and content reaches the object store unredacted. Never add a `diff.secrets.textconv` pointing at the same script: it is a stream filter expecting stdin, not a path, and would hang forever under lint-staged. Full rationale for the `%f` argument, plus the test-isolation and commit-hook details above, is in [docs/development.md](docs/development.md).

## Contributing

Issues and pull requests are welcome. Please keep the tool itself free of assumptions about any particular organisation, client, or directory layout — it should work the same for anyone. Governance details (contribution sign-off requirements, code of conduct, review process) aren't decided yet and will be added here before the repository is opened up beyond its initial maintainers.

## References

- [docs/configuration-model.md](docs/configuration-model.md): identities, configuration profiles, category-based sharing, the cascade merge algorithm, directory rules, conditional matching, portable `.claude-use.json`, `~/.claude/projects/` pattern matching, and launch flags.
- [docs/cli-reference.md](docs/cli-reference.md): the full flag and environment-variable table, `configure`'s file-write precedence, and the `check`/`doctor` debugging commands.
- [docs/examples.md](docs/examples.md): worked configuration examples and a permutation reference.
- [docs/architecture.md](docs/architecture.md): the source layout file by file, error reporting design, schema rationale, and resolver mechanics.
- [docs/release-process.md](docs/release-process.md): the semantic-release pipeline, the Node SEA build, its macOS x64 limitation, and npm/GitHub Packages publishing.
- [docs/testing.md](docs/testing.md): the full list of cases the test suites cover.
- [docs/installation.md](docs/installation.md): every install channel in full, with the platform support matrix.
- [docs/development.md](docs/development.md): test isolation, commit hooks, and the secret-redaction filter rationale.

## License

[Apache License 2.0](LICENSE).

# Architecture

The source layout file-by-file, error-reporting design (`CliError`), the Zod schema design for `categories` vs `entries`, why config loading uses cosmiconfig's `load()` rather than `search()` or `$import`, and the resolver's merge/materialisation mechanics. Verbatim from an earlier README.md.

## Architecture

One compiled binary backs both `claude` and `claude-use` — the entrypoint dispatches on `path.basename(process.argv[1])`, so installation just needs two differently-named copies (or hardlinks) of the same executable on `PATH`.

```
src/
  cli.ts                 # entrypoint; dispatches on invoked name -> launcher vs identity/profile-manager subcommands
  cliError.ts             # CliError — the base class every user-facing error extends, so main()'s top-level catch can print a clean message instead of a stack trace
  paths.ts               # CLAUDE_USE_HOME-aware layout paths — every other module resolves ~/.claude-use/... paths through this, never inline
  pathNorm.ts            # rule-path normalisation/ancestor helpers shared across the resolver and directory rules
  versionDiscovery.ts     # portable "find the real claude binary" logic
  realPorts.ts            # the real filesystem/spawn/proc/clock/git ports wired into runLauncher by cli.ts (tests wire fakes instead)
  launcher.ts             # runLauncher: thin orchestration over launcher/* below
  launcher/
    ports.ts              # FsPort, SpawnPort, RunPort, ClockPort, ProcPort, LogPort, FarmFs — injected, fakeable
    argv.ts               # parseLauncherArgv — @name consumed only at argv[0]
    guard.ts              # the ambient-credential guard — six guarded vars, empty string counts as unset
    identity.ts           # decideIdentity, decideConfigProfile, loadIdentity
    flags.ts              # resolveLaunchFlags, buildFlagArgs, buildArgv, buildEnv
    extraFlags.ts         # splitExtraFlags for $CLAUDE_EXTRA_FLAGS
    cascade.ts            # loads and assembles the CascadeInput a real launch needs (profiles, directory rules, .claude-use.json)
    lock.ts               # per-identity resync lock
    farm.ts               # farm resync: plan -> build scratch -> reconcile/carry-over -> atomic swap -> crash recovery
    spawn.ts              # spawnClaude — spawns the real binary, propagates its exit code
  identityManager.ts      # `claude-use identity` subcommands
  configProfiles.ts       # `claude-use profile` subcommands (scriptable set/set-default alongside `create`/`list`)
  directoryRules.ts       # `claude-use rules` subcommands
  configure.ts            # `claude-use configure` interactive picker (@clack/prompts)
  check.ts                # `claude-use check` dry-run inspector — cascade resolution, ambient-credential/Keychain/settings-secrets diagnostics — no farm writes, no spawn
  doctor.ts                # `claude-use doctor` whole-tree audit — every identity/profile/extends-chain/directory-rules/config.json/categories.local.json/active-identity, plus which `claude-use` PATH actually resolves to, aggregating rather than throwing on a broken file
  claudeShim.ts            # `claude-use shim enable`/`disable` — the one explicit action that creates/removes a `claude`-named hardlink of the running executable; records claude-shim.json
  cli/
    parsers.ts            # shared CLI-flag parsing helpers (splitTopLevelCommas, parsePair, repeatable-flag collectors)
  resolve/
    pipeline.ts            # resolveDecisions: runs the whole pipeline for one launch, topLevelNames
    types.ts              # every resolver type
    match.ts              # canonicaliseEntryKey, compileMatcher, compareSpecificity
    projects.ts            # forward-only ~/.claude/projects/ path encoder — no decoder exists
    conditions.ts          # parseDuration, evaluateWhen, matchBranch
    flatten.ts             # phase one: shallow overwrite per identical canonical key
    decide.ts              # phase two: selectRule, resolveEntry, resolveAll
    extends.ts             # profile extends-chain linearisation (cycle guard + diamond de-dup, post-order emission)
    walk.ts                # directory-ancestor walk + three-source (.claude-use.json / directory-rules.json / .claude-use.local.json) fold
    plan.ts                # materialise-vs-symlink planning
    reconcile.ts           # pure write-through reconciliation planning
  config/
    schema.ts             # Zod schemas: CategoryMap, ConfigProfile, DirectoryRules, GlobalConfig, Identity — single source of truth
    load.ts                # cosmiconfig load(filepath) wrapper (format-flexible parsing) + Zod validation
    classify.ts            # categories.default.json + categories.local.json + real entry names -> Classification
    store.ts               # readJson, writeJsonAtomic, applyPatch — shared by every CLI adapter
    categories.default.json
*.test.ts                  # every module above ships with a colocated test file
schema/                    # published JSON Schemas, generated by `pnpm schema` and stamped with a release-pinned $id at publish time
sea-config.json            # generated by scripts/build.mts, not hand-maintained
package.json / tsconfig.json
scripts/
  build.mts                # esbuild bundle -> node --build-sea=<config> (see Build (Node SEA) below); --bundle-only stops after the bundle, for npm publishing
  gen-schema.mts            # z.toJSONSchema() per exported schema -> schema/*.schema.json
  gen-schema-core.ts        # shared schema-generation logic used by gen-schema.mts
  stamp-schema-ids.mts      # rewrites $id to the real version-pinned release URL at publish time
.github/workflows/
  ci.yml                    # one workflow: check (every push/PR) plus the whole release pipeline, gated to
                             # tag pushes only — five platform builds, npm publish, GitHub Release, and the
                             # Homebrew/Scoop tap updates below
install.sh                 # downloads the latest release's binary for the running OS/arch, verifies its
                             # checksum, and installs it as both `claude` and `claude-use` in ~/.local/bin
```

### Error reporting: `CliError` vs. everything else

Every custom error this project throws to represent an expected, user-facing failure — a missing identity/profile/rule, a malformed config file, an invalid `--category`/`--share`/`--hide` flag — extends `CliError` (`src/cliError.ts`), an otherwise-empty abstract subclass of `Error`. `main()` in `src/cli.ts` wraps its whole body in one top-level `try`/`catch`: a `CliError` prints as `error.message` alone, with no stack trace, and exits `1`; anything else — a genuine, unanticipated bug — is rethrown and crashes with its full stack trace, which is more useful for diagnosing it than swallowing it would be. Before this existed, an error like `IdentityNotFoundError` thrown from the `@name` shortcut or from inside a Commander action (`identity use`, `profile create`, etc.) crashed with a raw Node.js stack trace instead of the one-line message its own constructor already built — the class carried the right text, nothing at the top ever caught it. `main()` calls `buildClaudeUseProgram().parseAsync(process.argv)`, not `.parse()`, specifically so an `async` action's rejection (e.g. `identity resolve <name>`, which awaits an interactive prompt) reaches this same catch too, rather than surfacing as an unhandled promise rejection Commander's synchronous `.parse()` never awaits.

`cliError.test.ts` asserts every one of these error classes actually extends `CliError` — the one regression `tsc`/`eslint` can never catch on their own, since a class silently reverting to `extends Error`, or a new one added without extending `CliError` at all, is still perfectly valid TypeScript.

`schema.ts` models `categories` and `entries` differently despite their identical JSON-object appearance in every example above, because they have opposite key cardinality: `categories` only ever touches the four overridable names in the [category table](configuration-model.md#category-based-sharing) plus the `all` shorthand, so it's a closed `z.strictObject({ all: z.boolean().optional(), runtime: z.boolean().optional(), history: z.boolean().optional(), knowledge: z.boolean().optional(), settings: z.boolean().optional() })` piped through a `.transform()` that expands `all` into the four real categories and drops it from the result — deliberately omitting `secret` from the shape entirely, so an attempted `secret` key is rejected at parse time rather than relying only on the runtime check described above — while `entries` is genuinely open-ended (any literal or glob path, each required to carry its `<category>/` prefix per the [Category-based sharing](configuration-model.md#category-based-sharing) section above) and stays a `z.record(z.string().regex(ENTRY_KEY_RE), EntryValueSchema)`. The closed shape for `categories` also gives editors real key-name autocomplete from the published JSON Schema (the `schema/` directory above) — generated with Zod's `io: "input"` option specifically because a schema with a `.transform()` can't be represented in JSON Schema at all under the default `"output"` mode, and `"input"` is what a hand-written config actually needs describing anyway, which a record type couldn't offer either way.

`ConfigProfile.extends` is a flat `z.array(z.string()).optional()` — a list of other profiles' *names*, resolved by `resolve/extends.ts` loading each named file and walking the resulting graph at runtime. It's correctly **not** a self-referential Zod schema (no `z.lazy()` needed): nothing in `ConfigProfile`'s own shape points back at `ConfigProfile`. Because each profile file validates in isolation, though, Zod has no way to catch a circular `extends` definition (`a` extends `b` extends `a`) — the walker in `resolve/extends.ts` needs its own cycle guard (a visited-set), independent of schema validation.

The `when` condition object's `env` field is `z.record(z.string().min(1), z.string()).optional()` — zero or more named environment-variable checks, ANDed together within the same `when` object exactly like every other condition, rather than a single fixed `{ name, value }` pair (which would need `when` itself to become an array to check more than one variable, a shape nothing else in this design uses).

### Why config file loading uses cosmiconfig's `load()`, never its `search()`

Every config file this tool reads — the global config, named configuration profiles, and each `.claude-use.json`/`.claude-use.local.json` found while walking the directory tree — is loaded with [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)'s `load(filepath)`. Its `search()` method stops at the first config file found while walking upward; this design needs the opposite — every ancestor collected, shallowest-first — so `launcher/cascade.ts` does its own directory walk and calls `load()` at each level it visits, getting cosmiconfig's format flexibility without fighting its traversal semantics. JSON and YAML work with zero extra setup (`js-yaml` is a bundled dependency); JS config files work via native dynamic `import`/`require`. TS config files are real too, but cosmiconfig lists `typescript` as an *optional peer dependency*, not a bundled one — since every config file this tool actually defines is `.json`, that's moot in practice, but it means `.ts` config support isn't something this codebase gets "for free" the way JSON/YAML/JS are, and shipping the compiled Node SEA binary with no `node_modules` at runtime (per [Install](../README.md#install)) means a `.ts` config file would fail to load unless `typescript` were bundled into the SEA blob specifically for that purpose — not planned, since nothing this tool ships needs it.

### Why `extends` isn't cosmiconfig's `$import`

cosmiconfig also supports an `$import` directive that deep-merges imported files, later imports winning — close to what `extends` needs. (Its default `mergeImportArrays: true` concatenates arrays — imported items first, then local — rather than fully replacing them; only `mergeImportArrays: false` gives array fields the same "later wins" outright-replacement behaviour objects and primitives already get.) It isn't used for two reasons: it resolves imports by relative file path, not by profile name, so a name-to-path resolution step is needed regardless; and it has no awareness of the entries-beat-categories, most-specific-path-wins rule, which has to be bespoke either way. `resolve/flatten.ts` implements one flatten function, reused for both the `extends` chain and the outer cascade, rather than splitting the same conceptual merge across two implementations that could drift apart.

### Resolver mechanics

For each `~/.claude` entry, walk the cascade to a boolean decision. If the decision is uniform for an entire subtree, symlink that directory in one shot. If a deeper path override splits the decision, materialise that directory as a real local directory instead of a symlink and recurse, repeating the check at each level — only directories with an actual split ever get exploded. A conditional entries key is never eligible for the uniform-symlink shortcut, since its decision can only be evaluated per-file.

The pure decision logic — `(entryFacts, cascade, path) => Map<path, boolean>` — takes filesystem/git/env facts as an injected parameter (an entry manifest of path, mtime, and size; a resolved git branch; an env snapshot), rather than reading any of that itself. This is what makes it unit-testable with fake mtimes and a fake branch, per [Testing strategy](testing.md#testing-strategy), without touching a real filesystem or `git` — "pure" here means decoupled from I/O via dependency injection, not that no I/O happens anywhere in the resolver; something still has to walk `~/.claude` and stat its entries to build the manifest this function consumes.

**Materialised directories need a write-through reconciliation step, not just a one-way split.** A directory the real Claude Code binary can create new children in at runtime — `history/projects/` chief among them, since Claude Code creates a new project subdirectory there the first time it sees an unfamiliar working directory — is exactly the kind of directory the tool's own conditional and per-project sharing examples recommend materialising. Once materialised, it stops being a live view of `~/.claude/projects/` and becomes a locally-built directory of symlinks (and further materialised subdirectories) frozen at resync time. Anything Claude Code subsequently writes into it — a brand-new project subdirectory, a new session file inside an existing one — lands as a real, untracked child of that materialised directory, not a symlink back to `~/.claude`: invisible to every other identity, and liable to be misread as stale scaffolding and pruned on a later resync.

The resolver closes this by treating every materialised directory as a two-way sync point, not a one-way snapshot, and does so without ever mutating the live farm in place — consistent with [Directory rules](configuration-model.md#directory-rules)'s atomic-swap resync, not in tension with it. On every resync, before building the new scratch tree, the reconciliation pass reads (never writes) each materialised directory still present in the *old* live farm and diffs its actual children against what the previous resync placed there. Any child that's a real file/directory rather than a symlink or a previously-materialised (and still-tracked) subdirectory is new data Claude Code wrote since the last resync — it gets **copied** into the corresponding real path under `~/.claude` (the canonical location, so it's never lost regardless of what happens to the old farm next), and the resolver then makes its usual category/entries decision for that now-canonical entry same as any other, which the new scratch tree reflects like everything else. Once the scratch tree is fully built this way, the atomic rename swaps it in and the old live farm — materialised copies included — is discarded wholesale, the same single swap every other resync already performs; reconciliation never needs its own separate write against the live tree.

The reverse direction matters just as much: a directory materialised because of a split whose cause later disappears (a profile edit removes the entry override that split it, say) collapses back into a single plain symlink on the next resync, rather than being left behind as permanent local scaffolding. This is the same "compare against prior farm state, update only what changed" logic that makes every resync fast in the common case, applied to the one case where a subtree's resolved shape needs to get simpler, not just different.


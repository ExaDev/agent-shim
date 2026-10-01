# Architecture

The source layout file-by-file, error-reporting design (`CliError`), the Zod schema design for `categories` vs `entries`, why config loading uses cosmiconfig's `load()` rather than `search()` or `$import`, and the resolver's merge/materialisation mechanics. Verbatim from an earlier README.md.

## Architecture

One compiled binary backs both `claude` and `claude-use` — the entrypoint dispatches on `path.basename(process.argv[1])`, so installation just needs two differently-named copies (or hardlinks) of the same executable on `PATH`.

```
src/
  cli.ts                 # entrypoint and the only module with import-time side effects; dispatches on invoked name -> launcher vs the claude-use command tree
  program.ts              # buildProgram: constructs the whole claude-use Commander tree with no side effects, so the command surface is unit-testable
  runClaude.ts            # the launch pipeline wired to real ports, shared by the `claude` binary name and `claude-use run`
  cliError.ts             # CliError (and UsageError, MissingInputError, PromptCancelledError), the documented exit statuses, and reportFatalError, the one place a failure becomes output and an exit status
  completion.ts           # `claude-use completion <shell>`: bash, zsh and fish scripts generated from the built command tree
  paths.ts               # CLAUDE_USE_HOME-aware layout paths — every other module resolves ~/.claude-use/... paths through this, never inline
  pathNorm.ts            # rule-path normalisation/ancestor helpers shared across the resolver and directory rules
  versionDiscovery.ts     # portable "find the real claude binary" logic
  realPorts.ts            # the real filesystem/spawn/proc/clock/git/credential ports wired into runLauncher by runClaude.ts (tests wire fakes instead)
  launcher.ts             # runLauncher: thin orchestration over launcher/* below
  launcher/
    ports.ts              # FsPort, SpawnPort, RunPort, ClockPort, ProcPort, LogPort, FarmFs — injected, fakeable
    argv.ts               # parseLauncherArgv: @name only at argv[0], --identity, the launch flags, nothing after a `--` terminator
    guard.ts              # the ambient-credential guard — six guarded vars, empty string counts as unset, the launching identity's own injected token exempt
    identity.ts           # decideIdentity, decideConfigProfile, loadIdentity
    flags.ts              # resolveLaunchFlags, buildFlagArgs, buildArgv, buildEnv
    extraFlags.ts         # splitExtraFlags for $CLAUDE_EXTRA_FLAGS
    cascade.ts            # loads and assembles the CascadeInput a real launch needs (profiles, directory rules, .claude-use.json)
    lock.ts               # per-identity resync lock
    farm.ts               # farm resync: plan -> build scratch -> reconcile/carry-over -> atomic swap -> crash recovery
    spawn.ts              # spawnClaude — spawns the real binary, propagates its exit code
  identityManager.ts      # the `identity` noun: add/list/show/set/remove/use/resolve-conflicts
  configProfiles.ts       # the `profile` noun: add/set/list/show/remove/use
  providers.ts            # the `provider` noun (add/set/list/show/remove) + the launch-time provider resolution the launcher calls, and the old-format provider file conversion `doctor` reports
  credential.ts           # the shared credential block's resolver: sources tried in order behind an injected CredentialPort, presets compiled to argv, target variables, summaries that never carry a value
  headroom/                # the headroom routing daemon: coordination state, the launcher-side ensure step, the supervisor loop, and the `headroom status` / hidden `__headroom-supervisor` commands
    state.ts               # state.json, the session registry, the start lock, allowlist computation — pure over an injected HeadroomFs
    ensure.ts               # the launcher's lock-and-poll bring-up: start at most one supervisor, wait for ready state (daemon port AND MITM port), register the session
    supervisor.ts           # install/start/restart/drift/idle decision loop for the daemon plus the in-process MITM proxy, pure over injected SupervisorPorts
    mitm.ts                 # the MITM CONNECT proxy OAuth launches route through: node-forge CA/leaf minting, the routing decisions, and the real effects over node's net/tls/http
    headers.ts              # ANTHROPIC_CUSTOM_HEADERS merge (Name: Value lines, later block wins per name)
    commands.ts             # real ports for the supervisor, `headroom status`, command registration
  frontdoor/                # the front-door daemon: one claude-use listener routing every session claude-use routes (a provider's, or headroom's)
    route.ts                # the URL space (/providers/<name>), the identity step that strips the launcher-injected session headers, and the route interface a destination implements (including whether a headroom hop may sit in front)
    pipeline.ts             # the ordered pipeline (identify, response middleware at each response head, headroom hop then route) and the typed hook point where the usage-tracking middleware registers
    headroomHop.ts, passthrough.ts   # the hop that forwards an Anthropic-shaped request to the daemon and back, and the pass-through route that streams to an Anthropic-compatible upstream
    providerRoute.ts        # resolves /providers/<name> requests to a route by reading the provider file fresh per request
    codexMount.ts           # the codex translation mounted as one route (an adapter over createCodexRoute, not a second implementation)
    server.ts, connect.ts   # the plain-HTTP listener transport, and the CONNECT surface OAuth launches point HTTPS_PROXY at: node-forge CA/leaf minting, TLS termination, blind tunnels, and the same pipeline for /v1/
    supervisor.ts, ensure.ts, state.ts   # the three-listener lifecycle (sticky ports, session registry, idle shutdown), the launcher's lock-and-poll bring-up, and the coordination state; the session registry holds each launch's capability token behind owner-only modes and has its own list, prune and remove (never headroom's token-less ones)
    commands.ts             # real ports wiring the whole pipeline in the supervisor process, `frontdoor status`, and the hidden supervisor subcommand
  codex/                    # the codex translation the front door serves in process for `kind: codex` providers (the port of the old codex-claude-proxy.mjs)
    anthropic.ts, translate.ts, events.ts   # the pure core: Zod-validated Anthropic Messages and Codex Responses shapes, the translation between them, and the Codex SSE events translated back to Anthropic SSE
    relay.ts, route.ts        # the request/response relay, transport-neutral so the front door serves it as one route among several
    auth.ts, agent.ts         # the ~/.codex/auth.json store (one refresh in flight, re-read before refresh, atomic write, rotated token persisted before use) and the undici agent with the 10s keep-alive ceiling
    upstream.ts, upstreamPort.ts   # the upstream client (per-session `session_id` derived from `metadata.user_id`) and its injected port
    http.ts, quota.ts         # named HTTP statuses, and upstream quota/limit responses forwarded as Anthropic-shaped errors
    commands.ts               # the real translation ports (auth store, upstream fetch, usage snapshot) the front door mounts, and `codex status` reporting through it
  directoryRules.ts       # the `rule` noun: add/set/list/show/remove
  configure.ts            # `claude-use configure` interactive picker (@clack/prompts)
  check.ts                # `claude-use check` dry-run inspector — cascade resolution, credential/ambient-credential/Keychain/settings-secrets diagnostics — no farm writes, no spawn
  doctor.ts                # `claude-use doctor` whole-tree audit — every identity/profile/extends-chain/provider/directory-rules/config.json/categories.local.json/active-identity, plus which `claude-use` PATH actually resolves to, aggregating rather than throwing on a broken file
  claudeShim.ts            # `claude-use shim enable`/`disable` — the one explicit action that creates/removes a `claude`-named hardlink of the running executable; records claude-shim.json
  cli/
    bool.ts               # the one boolean vocabulary (true/1, false/0) flags and environment variables share
    parsers.ts            # parsePair, parseBool, parseEnvBool, and the one-value-per-occurrence repeatable-flag collectors
    credentialOption.ts   # the `--credential <source>` short forms and JSON form, validated against CredentialSourceSchema
    commandDeps.ts        # CommandDeps (paths, prompts, terminal check, exit) every command registers with, plus --json, examples and the shared remove confirmation
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

Every custom error this project throws to represent an expected, user-facing failure (a missing identity/profile/rule, a malformed config file, an invalid `--category`/`--share`/`--hide` flag) extends `CliError` (`src/cliError.ts`), which carries the exit status it maps to: 1 by default, 2 for a `UsageError` (a malformed flag or environment value, or a `MissingInputError` when a command needs input and standard input is not a terminal). `main()` in `src/cli.ts` hands whatever it rejects with to `reportFatalError`, the single error path for every command, the `@name` shortcut and the `claude`-named launcher alike: a `CliError` prints as `claude-use: <message>` with no stack trace; a `CommanderError` (the program is built with `exitOverride`, so an unknown command or option throws after Commander has printed its own message) maps to its own 0 for `--help`/`--version` and to 2 otherwise; anything else is an unanticipated bug, printed as `claude-use: <message>` with its stack trace added only when `CLAUDE_USE_DEBUG` is true. Nothing calls `process.exit` directly: commands that report findings (`doctor`, `check --strict`) set `process.exitCode`, and the long-running hidden `__headroom-supervisor` ends the process through the injected `CommandDeps.exit`. `main()` calls `buildProgram(...).parseAsync(process.argv)`, not `.parse()`, so an `async` action's rejection (any command that awaits an interactive prompt) reaches the same path rather than surfacing as an unhandled promise rejection Commander's synchronous `.parse()` never awaits.

Commands never read `process.stdin.isTTY` or call `@clack/prompts` themselves: `buildProgram` hands every registration a `CommandDeps` with the prompt port and an `isInteractive` check, so each command's terminal and non-terminal behaviour (prompt, or fail naming the option that supplies the input) is unit-tested end to end through the built program with scripted answers.

`cliError.test.ts` asserts every one of these error classes actually extends `CliError` — the one regression `tsc`/`eslint` can never catch on their own, since a class silently reverting to `extends Error`, or a new one added without extending `CliError` at all, is still perfectly valid TypeScript.

`schema.ts` models `categories` and `entries` differently despite their identical JSON-object appearance in every example above, because they have opposite key cardinality: `categories` only ever touches the four overridable names in the [category table](configuration-model.md#category-based-sharing) plus the `all` shorthand, so it's a closed `z.strictObject({ all: z.boolean().optional(), runtime: z.boolean().optional(), history: z.boolean().optional(), knowledge: z.boolean().optional(), settings: z.boolean().optional() })` piped through a `.transform()` that expands `all` into the four real categories and drops it from the result — deliberately omitting `secret` from the shape entirely, so an attempted `secret` key is rejected at parse time rather than relying only on the runtime check described above — while `entries` is genuinely open-ended (any literal or glob path, each required to carry its `<category>/` prefix per the [Category-based sharing](configuration-model.md#category-based-sharing) section above) and stays a `z.record(z.string().regex(ENTRY_KEY_RE), EntryValueSchema)`. The closed shape for `categories` also gives editors real key-name autocomplete from the published JSON Schema (the `schema/` directory above) — generated with Zod's `io: "input"` option specifically because a schema with a `.transform()` can't be represented in JSON Schema at all under the default `"output"` mode, and `"input"` is what a hand-written config actually needs describing anyway, which a record type couldn't offer either way.

`ConfigProfile.extends` is a flat `z.array(z.string()).optional()` — a list of other profiles' *names*, resolved by `resolve/extends.ts` loading each named file and walking the resulting graph at runtime. It's correctly **not** a self-referential Zod schema (no `z.lazy()` needed): nothing in `ConfigProfile`'s own shape points back at `ConfigProfile`. Because each profile file validates in isolation, though, Zod has no way to catch a circular `extends` definition (`a` extends `b` extends `a`) — the walker in `resolve/extends.ts` needs its own cycle guard (a visited-set), independent of schema validation.

The `when` condition object's `env` field is `z.record(z.string().min(1), z.string()).optional()` — zero or more named environment-variable checks, ANDed together within the same `when` object exactly like every other condition, rather than a single fixed `{ name, value }` pair (which would need `when` itself to become an array to check more than one variable, a shape nothing else in this design uses).

### Why config file loading uses cosmiconfig's `load()`, never its `search()`

Every config file this tool reads — the global config, named configuration profiles, and each `.claude-use.json`/`.claude-use.local.json` found while walking the directory tree — is loaded with [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)'s `load(filepath)`. Its `search()` method stops at the first config file found while walking upward; this design needs the opposite — every ancestor collected, shallowest-first — so `launcher/cascade.ts` does its own directory walk and calls `load()` at each level it visits, getting cosmiconfig's format flexibility without fighting its traversal semantics. JSON and YAML work with zero extra setup (`js-yaml` is a bundled dependency); JS config files work via native dynamic `import`/`require`. TS config files are real too, but cosmiconfig lists `typescript` as an *optional peer dependency*, not a bundled one — since every config file this tool actually defines is `.json`, that's moot in practice, but it means `.ts` config support isn't something this codebase gets "for free" the way JSON/YAML/JS are, and shipping the compiled Node SEA binary with no `node_modules` at runtime (per [Install](../README.md#install)) means a `.ts` config file would fail to load unless `typescript` were bundled into the SEA blob specifically for that purpose — not planned, since nothing this tool ships needs it.

### Why `extends` isn't cosmiconfig's `$import`

cosmiconfig also supports an `$import` directive that deep-merges imported files, later imports winning — close to what `extends` needs. (Its default `mergeImportArrays: true` concatenates arrays — imported items first, then local — rather than fully replacing them; only `mergeImportArrays: false` gives array fields the same "later wins" outright-replacement behaviour objects and primitives already get.) It isn't used for two reasons: it resolves imports by relative file path, not by profile name, so a name-to-path resolution step is needed regardless; and it has no awareness of the entries-beat-categories, most-specific-path-wins rule, which has to be bespoke either way. `resolve/flatten.ts` implements one flatten function, reused for both the `extends` chain and the outer cascade, rather than splitting the same conceptual merge across two implementations that could drift apart.

### The headroom daemon

When a launch resolves `headroom` on, the launcher (synchronous end to end, right through to `spawnSync`) never talks to the daemon process directly and never starts `headroom` itself. It goes through an injected `HeadroomPort` whose real implementation does exactly three things synchronously: take an exclusive-create start lock under `<home>/headroom/` (so concurrent launches spawn at most one supervisor), re-exec this very binary detached as `claude-use __headroom-supervisor` (a hidden subcommand; a SEA binary re-execs itself, the npm bundle re-execs Node against its script path), and poll `state.json` until it names a live supervisor, a live daemon pid, and a port, then register the launching pid in `sessions/`. The port number in state is written only after the supervisor's own `/readyz` probe has passed, so "state has a port" is by construction "the proxy answers".

The front door, not the headroom supervisor, hosts the second server: the CONNECT surface OAuth launches point `HTTPS_PROXY` at. It terminates TLS for `api.anthropic.com` alone (with a leaf signed by a node-forge CA persisted under `<home>/frontdoor/ca/`, the key mode 0600), runs that host's `/v1/` paths through the same ordered pipeline the plain listener serves, and pipes every other path, and every other host, untouched. That shape is what keeps Claude Code's Remote Control and connectors working under compression: they refuse any `ANTHROPIC_BASE_URL` the child can be given, but honour the proxy layer, so the base URL stays pointing at the real API. All of the surface's effects (TCP listening, TLS termination, HTTP parsing, forwarding) sit behind a `ConnectEffects` port in the same style as `SupervisorPorts`, and its routing decisions are pure functions over strings; the TLS round-trip tests run the real server against node-forge-generated certificates with only the upstream target redirected.

The supervisor is the only thing that starts, stops, restarts, or upgrades headroom. Its whole lifecycle (install via `uv tool install` when the binary is missing or its version fails the configured source, crash restarts with bounded exponential backoff and a retry budget, drift restarts deferred until the session registry is empty, idle shutdown) lives in `src/headroom/supervisor.ts` as one pure-ish loop over injected `SupervisorPorts`, so every decision is tested against a fake clock, filesystem, and process table. Coordination between separate OS processes is entirely file-based (state, lock, session files) with pid liveness as the source of truth, which is what lets a synchronous launcher, a detached supervisor, and several concurrent sessions cooperate without any of them holding a socket open to another.

The daemon's loopback address is sticky across every restart and supervisor generation: `lastPort` in state.json is the preference (surviving crashes and idle shutdowns), `port` is the ready signal, and a start reuses the sticky port whenever binding it succeeds, because every live session's environment was frozen at launch pointing there. Only a genuinely occupied port justifies moving, and then the old sessions are unavoidably stale until they relaunch.

Two facts about process death shape that liveness layer. First, the supervisor keeps every spawned headroom's `ChildProcess` handle and consumes its exit event: that event is both the crash signal and the reaping (a child nobody listens for is a child nobody reaps, and the loop's sleeps run on real timers precisely so the event loop can deliver it). Second, every liveness check anywhere in the coordination layer (crash detection, session pruning, state inspection, the identity lock's holder check) is zombie-aware via `ps`'s state column: a process that exited unreaped still answers `kill(pid, 0)` as alive, but holds no port and will never write state, so it must read as dead. Stops escalate SIGTERM to SIGKILL on a bounded grace, because the proxy has been observed to ignore SIGTERM outright. The supervisor handles SIGTERM and SIGINT explicitly and routes them through an orderly exit (Node skips `exit` handlers on unhandled signal death), so its own death takes its children with it; and a successor supervisor stops any orphan daemon a predecessor left running before starting its own, so nothing squatting on a port escapes supervision.

### Resolver mechanics

For each `~/.claude` entry, walk the cascade to a boolean decision. If the decision is uniform for an entire subtree, symlink that directory in one shot. If a deeper path override splits the decision, materialise that directory as a real local directory instead of a symlink and recurse, repeating the check at each level — only directories with an actual split ever get exploded. A conditional entries key is never eligible for the uniform-symlink shortcut, since its decision can only be evaluated per-file.

The pure decision logic — `(entryFacts, cascade, path) => Map<path, boolean>` — takes filesystem/git/env facts as an injected parameter (an entry manifest of path, mtime, and size; a resolved git branch; an env snapshot), rather than reading any of that itself. This is what makes it unit-testable with fake mtimes and a fake branch, per [Testing strategy](testing.md#testing-strategy), without touching a real filesystem or `git` — "pure" here means decoupled from I/O via dependency injection, not that no I/O happens anywhere in the resolver; something still has to walk `~/.claude` and stat its entries to build the manifest this function consumes.

**Materialised directories need a write-through reconciliation step, not just a one-way split.** A directory the real Claude Code binary can create new children in at runtime — `history/projects/` chief among them, since Claude Code creates a new project subdirectory there the first time it sees an unfamiliar working directory — is exactly the kind of directory the tool's own conditional and per-project sharing examples recommend materialising. Once materialised, it stops being a live view of `~/.claude/projects/` and becomes a locally-built directory of symlinks (and further materialised subdirectories) frozen at resync time. Anything Claude Code subsequently writes into it — a brand-new project subdirectory, a new session file inside an existing one — lands as a real, untracked child of that materialised directory, not a symlink back to `~/.claude`: invisible to every other identity, and liable to be misread as stale scaffolding and pruned on a later resync.

The resolver closes this by treating every materialised directory as a two-way sync point, not a one-way snapshot, and does so without ever mutating the live farm in place — consistent with [Directory rules](configuration-model.md#directory-rules)'s atomic-swap resync, not in tension with it. On every resync, before building the new scratch tree, the reconciliation pass reads (never writes) each materialised directory still present in the *old* live farm and diffs its actual children against what the previous resync placed there. Any child that's a real file/directory rather than a symlink or a previously-materialised (and still-tracked) subdirectory is new data Claude Code wrote since the last resync — it gets **copied** into the corresponding real path under `~/.claude` (the canonical location, so it's never lost regardless of what happens to the old farm next), and the resolver then makes its usual category/entries decision for that now-canonical entry same as any other, which the new scratch tree reflects like everything else. Once the scratch tree is fully built this way, the atomic rename swaps it in and the old live farm — materialised copies included — is discarded wholesale, the same single swap every other resync already performs; reconciliation never needs its own separate write against the live tree.

The reverse direction matters just as much: a directory materialised because of a split whose cause later disappears (a profile edit removes the entry override that split it, say) collapses back into a single plain symlink on the next resync, rather than being left behind as permanent local scaffolding. This is the same "compare against prior farm state, update only what changed" logic that makes every resync fast in the common case, applied to the one case where a subtree's resolved shape needs to get simpler, not just different.


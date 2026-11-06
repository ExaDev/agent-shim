# Native Codex CLI identities

agent-shim can launch the installed OpenAI Codex CLI with a separate login and state directory for each Codex identity:

```sh
agent-shim identity add codex-work --agent codex
agent-shim run --agent codex @codex-work login
agent-shim run --agent codex @codex-work
agent-shim run --agent codex @codex-work exec "explain this project"
agent-shim run --agent codex @codex-work resume --last
agent-shim run --agent codex @codex-work login status
agent-shim run --agent codex @codex-work logout
```

Install Codex separately. agent-shim finds `codex` on `PATH`, skipping its own executable to prevent recursion. `AGENT_SHIM_CODEX_BIN=/absolute/path/to/codex` selects a particular executable. The existing `claude` shim and `agent-shim run` without an agent prefix continue to launch Claude Code. `--agent claude` is also accepted. Put `--agent codex` immediately after `run`; `--agent=codex` is equivalent.

Existing identities belong to Claude Code. A Codex identity stores `"agent": "codex"` in `identity.json`; `identity list` marks it `[codex]`, and `identity show --json` includes `agent`. Create a separate identity for a Codex login. Launching an identity through the wrong agent is refused before resyncing its farm. The agent cannot be changed with `identity set`.

## Selecting and configuring a launch

The Codex launcher selects the identity in this order: a leading `@name` or `--identity name`, `AGENT_SHIM_IDENTITY`, the directory's identity pin, then the active identity selected with `identity use`. A selected identity must already exist and belong to Codex. A bare launch with no identity is refused. `CLAUDE_CONFIG_DIR` has no effect on Codex identity selection, and an inherited `CODEX_HOME` cannot bypass it.

The configuration profile resolves from `--config-profile`, `AGENT_SHIM_CONFIG_PROFILE`, the directory's profile selection, the identity's default profile, then the global default. Sharing uses the existing global/profile/directory cascade, including portable `.agent-shim.json`, conditional entries and profile inheritance.

Put shim arguments before the first Codex argument:

```sh
agent-shim profile add codex-private --category history=false
agent-shim run --agent codex @codex-work --config-profile codex-private --hide knowledge/skills exec -p native-profile "explain this project"
agent-shim check --agent codex --identity codex-work --json
```

The shim consumes only a prefix containing `@name`, `--identity`, `--config-profile`, `--category`, `--share` and `--hide`. After the first native argument it forwards every remaining token unchanged, including `--`, `@` text and flags with names resembling shim flags. Codex's `-p`/`--profile` selects a native Codex TOML profile; it is distinct from agent-shim's JSON configuration profile. `--help`, `--version`, `login`, `logout`, `exec`, `resume`, `app-server` and other native subcommands reach Codex.

## Home, credentials and sharing

The identity's stable directory, `<AGENT_SHIM_HOME>/identities/<id>`, becomes its `CODEX_HOME`. The name can change without moving it. The directory is owner-only, and terminal input/output, child exit status and termination signals are preserved. Native Codex owns the login flow and token refresh; agent-shim does not copy a login from `~/.codex` or parse its tokens.

Codex's canonical sharing source is `~/.codex`. Set `AGENT_SHIM_CODEX_HOME` to select another canonical source. This is deliberately separate from `CODEX_HOME`, which can be inherited from the session launching another identity.

Codex has its own classification map in `src/codex/categories.ts`; the Claude classification and `categories.local.json` overlay do not apply:

| Category | Default shared? | Codex entries |
|---|---|---|
| secret | Never | `auth.json` and its backups, SQLite/database files and sidecars, `identity.json`, `cap_sid`, `credentials*`, `secrets*` |
| runtime | No | logs, caches, temporary files, shell snapshots, package and binary state, `models_cache.json`, `version.json` |
| history | Yes | `sessions`, `archived_sessions`, `history.jsonl`, `session_index.jsonl`, `memories` |
| knowledge | Yes | `AGENTS.md`, `AGENTS.override.md`, `skills`, `rules`, `agents`, `prompts` |
| settings | Yes | `config.toml`, `*.config.toml` |

Unknown entries remain private. Entry overrides cannot share anything classified as secret. Existing local login/database files survive a sharing resync; they are never adopted into the canonical home. Hiding a previously shared path follows the ordinary farm behavior, removing the view without deleting the canonical data.

Shared TOML configuration should refer to credentials through environment variables rather than contain literal tokens. Custom provider credentials and custom paths in that configuration are deliberate user configuration; moving `CODEX_HOME` does not rewrite arbitrary paths or isolate a remote server selected with Codex's native `--remote` option. To keep settings or history private, use `--category settings=false` or `--category history=false`, a profile, or directory rules. Codex's SQLite indexes remain private even when session files are shared; this launcher does not merge Codex's history databases.

The launcher enforces `cli_auth_credentials_store="file"` and an identity-local `sqlite_home` with Codex CLI config overrides, and sets `CODEX_SQLITE_HOME` to the same home. It refuses user `-c`/`--config` overrides of those two settings. This keeps logins out of a shared OS credential store and databases out of an inherited external directory. An administrator's enforced Codex authentication requirements still take precedence and may cause Codex to refuse the launch.

Known ambient authentication variables (`OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_IDENTITY_TOKEN_FILE`, `OPENAI_FEDERATION_RULE_ID`) cause a launch refusal when nonempty, naming the variable without its value. Deliberately opt in with `AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL=1` or `identity set codex-work --allow-ambient-credential`. Provider-specific environment variable names chosen in native Codex configuration remain that configuration's responsibility.

The upstream contracts are documented in [Codex environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables) and [credential storage](https://learn.chatgpt.com/docs/auth#credential-storage). The native launch was smoke-tested with Codex CLI 0.167.0 using temporary, signed-out homes and no inference requests.

## Related features

`agent-shim codex login`, `codex logout` and `codex status` retain their existing meaning: they manage the front door's translation provider and its Sign in with ChatGPT grant. To operate a native identity's login, use `run --agent codex @name login` or `logout` instead. `doctor` validates Codex identity configuration and points to the native login-status command; it does not claim a Codex login is signed in based on Claude's Keychain.

Codex sessions connect directly to the upstream selected by Codex. Claude-only provider routing, headroom, account anchors, the statusline renderer and Claude launch flags do not apply. Codex identities with Claude provider, credential-block or anchor settings are refused. Pool selection is refused rather than ranking a Codex login using Claude's usage snapshots; Codex quota-based pools and per-request routing are tracked in [#158](https://github.com/ExaDev/agent-shim/issues/158). Codex status presentation is tracked in [#703](https://github.com/ExaDev/agent-shim/issues/703).

## [4.2.1](https://github.com/ExaDev/claude-use/compare/v4.2.0...v4.2.1) (2026-10-01)

### Bug Fixes

* **headroom:** pin the default install source to a commit and warn on moving git refs ([ecc4cdc](https://github.com/ExaDev/claude-use/commit/ecc4cdc6fbe1a1383138336ceb633b436be8824a)), closes [#54](https://github.com/ExaDev/claude-use/issues/54)

## [4.2.0](https://github.com/ExaDev/claude-use/compare/v4.1.0...v4.2.0) (2026-09-30)

### Features

* **frontdoor:** add the front-door daemon with its ordered routing pipeline ([db7ca79](https://github.com/ExaDev/claude-use/commit/db7ca79d610b8f10ec442884b0e9f56020c73483))
* **frontdoor:** mount the codex translation in process and retire the codex daemon ([3489832](https://github.com/ExaDev/claude-use/commit/348983294534c840e1b30a6d92abf1bafea61c8d))

## [4.1.0](https://github.com/ExaDev/claude-use/compare/v4.0.0...v4.1.0) (2026-09-30)

### Features

* add a codex provider kind served by a supervised translation daemon ([9d07d40](https://github.com/ExaDev/claude-use/commit/9d07d402046bbe52fa5a6b55f93b3ffd5ffb1a61))

## [4.0.0](https://github.com/ExaDev/claude-use/compare/v3.0.0...v4.0.0) (2026-09-30)

### ⚠ BREAKING CHANGES

* provider files no longer accept tokenEnv, tokenCommand,
  authScheme or a credential variable in env; use a credential block instead.
  A file still in the old format is refused with its exact replacement, and the
  --token-env, --token-command and --auth-scheme options are gone.

### Features

* report credentials in check and old-format providers in doctor ([eada1de](https://github.com/ExaDev/claude-use/commit/eada1de93601210551eee58b6f4a8e4f1cd3b152))
* resolve provider and identity tokens from a shared credential block ([affe491](https://github.com/ExaDev/claude-use/commit/affe4913c3ae36a2c4d0adea7be41c961498d3eb))

## [3.0.0](https://github.com/ExaDev/claude-use/compare/v2.9.0...v3.0.0) (2026-09-30)

### ⚠ BREAKING CHANGES

* rules is now rule, and rule add no longer updates an
  existing rule (use rule set). profile create, wizard and set-default
  are profile add, set and use. identity set-default-profile is identity
  set --default-profile, and identity resolve is identity
  resolve-conflicts. configure takes --identity instead of a positional
  identity. rules add --profile is rule add --config-profile.
  profile set --skip-permissions, --remote-control and --headroom are
  --launch-skip-permissions, --launch-remote-control and
  --launch-headroom. CLAUDE_ACCOUNT is CLAUDE_USE_IDENTITY. --category,
  --entry, --share, --hide and --extends take one value per occurrence
  instead of a comma list. A launch naming a missing identity or
  configuration profile now exits 1.

### Features

* one command grammar, flag spelling and error path for claude-use ([ecbc90a](https://github.com/ExaDev/claude-use/commit/ecbc90a94d41cc9c3813bf80a6f1aeb794ba9cf4))

## [2.9.0](https://github.com/ExaDev/claude-use/compare/v2.8.0...v2.9.0) (2026-09-30)

### Features

* **providers:** token commands and API key auth scheme ([ce730bb](https://github.com/ExaDev/claude-use/commit/ce730bb8343c804a50cb571d799eca51e915bfb7))

### Bug Fixes

* default the supervised headroom proxy to HTTP/1.1 upstream ([ad9f837](https://github.com/ExaDev/claude-use/commit/ad9f8379cf6d13b9740e02664207f3d80d1cde17))

## [2.8.0](https://github.com/ExaDev/claude-use/compare/v2.7.0...v2.8.0) (2026-09-27)

### Features

* add --headroom/--no-headroom one-off launch flags ([94e1a2c](https://github.com/ExaDev/claude-use/commit/94e1a2cf29daec32df1aaefcfb9b40ccd96b0f6c))

## [2.7.0](https://github.com/ExaDev/claude-use/compare/v2.6.0...v2.7.0) (2026-09-27)

### Features

* route OAuth sessions through a TLS-terminating MITM proxy for headroom ([48ce107](https://github.com/ExaDev/claude-use/commit/48ce1070837fc7a6f9c087635a2e874c1e10e8a0))

## [2.6.0](https://github.com/ExaDev/claude-use/compare/v2.5.4...v2.6.0) (2026-09-27)

### Features

* allow a provider to carry a fixed credential instead of tokenEnv ([5598e3c](https://github.com/ExaDev/claude-use/commit/5598e3ca7098605bc773ec96e622a2ebfed0f8e3))

## [2.5.4](https://github.com/ExaDev/claude-use/compare/v2.5.3...v2.5.4) (2026-09-27)

### Bug Fixes

* keep the headroom daemon's port stable across restarts ([bb7da4f](https://github.com/ExaDev/claude-use/commit/bb7da4f385478920eefd9f5b6013a55332e38621))

## [2.5.3](https://github.com/ExaDev/claude-use/compare/v2.5.2...v2.5.3) (2026-09-27)

### Bug Fixes

* reap the headroom proxy and read zombie pids as dead ([e31eb21](https://github.com/ExaDev/claude-use/commit/e31eb217c1afa47c8828e6abc60575761aa5530b))
* treat a zombie identity-lock holder as dead ([72ff6f2](https://github.com/ExaDev/claude-use/commit/72ff6f2e2caf7e068c175a55be79ad9fc96c2467))

## [2.5.2](https://github.com/ExaDev/claude-use/compare/v2.5.1...v2.5.2) (2026-09-27)

### Bug Fixes

* name the headroom distribution correctly in the default install spec ([a6167cd](https://github.com/ExaDev/claude-use/commit/a6167cd63809251877f06a1ad827d7a4f3675fa2))
* pin the headroom source to the per-session-savings branch ([10be19c](https://github.com/ExaDev/claude-use/commit/10be19c1a164ad52cefee0b05250b7bf1bab5ca6))

## [2.5.1](https://github.com/ExaDev/claude-use/compare/v2.5.0...v2.5.1) (2026-09-27)

### Bug Fixes

* resolve launch flags from the cascade on escape-hatch launches ([98e7e48](https://github.com/ExaDev/claude-use/commit/98e7e48020fe5872c5c6eba23f4d76372ea1a6bf))

## [2.5.0](https://github.com/ExaDev/claude-use/compare/v2.4.2...v2.5.0) (2026-09-27)

### Features

* route launches through a supervised headroom daemon ([47912fd](https://github.com/ExaDev/claude-use/commit/47912fd1783984435e33ac0ba3220d4af805dcf7))
* route launches through named API providers ([9d41cb6](https://github.com/ExaDev/claude-use/commit/9d41cb606add2eeb835f3d50194209c6f1354338))

## [2.4.2](https://github.com/ExaDev/claude-use/compare/v2.4.1...v2.4.2) (2026-09-17)

### Bug Fixes

* preserve literal -- when forwarding args in claude-use run ([f046c44](https://github.com/ExaDev/claude-use/commit/f046c44cea02bf7137395f81ac92390f814dded8))

## [2.4.1](https://github.com/ExaDev/claude-use/compare/v2.4.0...v2.4.1) (2026-09-14)

### Bug Fixes

* **lint:** resolve @exadev/eslint-config fallout in cli/claudeShim ([8307bf1](https://github.com/ExaDev/claude-use/commit/8307bf1a490d656a924a63f1c21e4cfcf250aaa7))
* **lint:** resolve @exadev/eslint-config fallout in configure/rules ([a4baf9d](https://github.com/ExaDev/claude-use/commit/a4baf9d02178b8235eab1758790305028210a432))
* **lint:** resolve @exadev/eslint-config fallout in doctor/identity ([8beeff5](https://github.com/ExaDev/claude-use/commit/8beeff52ac758d2feb69451765245fcdf95cf88e))
* **lint:** resolve @exadev/eslint-config fallout in remaining src/* ([81dbd90](https://github.com/ExaDev/claude-use/commit/81dbd9077ed7592094e0d0be931df4f32158f927))
* **lint:** resolve @exadev/eslint-config fallout in scripts/release config ([ff353d8](https://github.com/ExaDev/claude-use/commit/ff353d8ecb41fe5fd40567253b8be9a25871f8c6))
* **lint:** resolve @exadev/eslint-config fallout in src/config ([17a0c36](https://github.com/ExaDev/claude-use/commit/17a0c360e3ea70fa5c7434d3b65a113390e68273))
* **lint:** resolve @exadev/eslint-config fallout in src/launcher ([81fe0a8](https://github.com/ExaDev/claude-use/commit/81fe0a84589e2cd1be051461039944a8710eb709))
* **lint:** resolve @exadev/eslint-config fallout in src/resolve ([98a7e67](https://github.com/ExaDev/claude-use/commit/98a7e6777e812136b5408ce73294a453c6f80f8a))
* repair NUL-byte corruption in dedupeDiagnostics's key template ([341185d](https://github.com/ExaDev/claude-use/commit/341185d5547fb2b9b7a9a549c0f8078a08c7177a))

## [2.4.0](https://github.com/ExaDev/claude-use/compare/v2.3.1...v2.4.0) (2026-09-12)

### Features

* default the new-identity wizard's profile prompt to skip ([eb2faf8](https://github.com/ExaDev/claude-use/commit/eb2faf80c2b8a8b5532f96c6d1d228086c31a0f3))

## [2.3.1](https://github.com/ExaDev/claude-use/compare/v2.3.0...v2.3.1) (2026-09-12)

### Bug Fixes

* retry the npm tarball fetch long enough to survive real propagation lag ([579b7b2](https://github.com/ExaDev/claude-use/commit/579b7b24c158d5b59f95b5e87f194a4c6f1fe58f))

## [2.3.0](https://github.com/ExaDev/claude-use/compare/v2.2.0...v2.3.0) (2026-09-12)

### Features

* auto-resolve a runtime-category farm collision instead of asking ([3b7d3ee](https://github.com/ExaDev/claude-use/commit/3b7d3ee4fc1a282ffb21c36d934067ac35746701))

## [2.2.0](https://github.com/ExaDev/claude-use/compare/v2.1.0...v2.2.0) (2026-09-12)

### Features

* report which claude-use a bare command name actually resolves to ([75ae588](https://github.com/ExaDev/claude-use/commit/75ae58806d710212a485d42b133eb94eb1bcc050))

### Bug Fixes

* keep listing identities when one identity.json cannot be read ([d863334](https://github.com/ExaDev/claude-use/commit/d863334d73afdd8c93a2776c4076dd9e8e6959bc))

## [2.1.0](https://github.com/ExaDev/claude-use/compare/v2.0.4...v2.1.0) (2026-09-11)

### Features

* allow @ in the body of identity and profile names ([838b99c](https://github.com/ExaDev/claude-use/commit/838b99c79fd5614fcd8149cd9c23f39e453c64d4))

## [2.0.4](https://github.com/ExaDev/claude-use/compare/v2.0.3...v2.0.4) (2026-09-11)

### Bug Fixes

* reject an invalid identity name before offering the creation wizard ([91442d0](https://github.com/ExaDev/claude-use/commit/91442d04b02f2dfe00eb2a39e5244ef29659ff95))

## [2.0.3](https://github.com/ExaDev/claude-use/compare/v2.0.2...v2.0.3) (2026-09-11)

### Bug Fixes

* refresh dependencies to clear the five high and two moderate audit advisories ([219e0a3](https://github.com/ExaDev/claude-use/commit/219e0a3d4fdb5ddb3fa58fa7c0d1c9de8da2b792))

## [2.0.2](https://github.com/ExaDev/claude-use/compare/v2.0.1...v2.0.2) (2026-08-21)

### Bug Fixes

* convert createProfile's raw ZodError throw into ConfigValidationError ([423eddf](https://github.com/ExaDev/claude-use/commit/423eddfa17d41b0f94c0283fc2ddf713882ea302))
* convert directoryRules' raw parse/Error throws into CliError subclasses ([74cfe16](https://github.com/ExaDev/claude-use/commit/74cfe160d861eab7fa2293eff990b3db5384e24f))

## [2.0.1](https://github.com/ExaDev/claude-use/compare/v2.0.0...v2.0.1) (2026-08-21)

### Bug Fixes

* convert addIdentity's Zod validation failure into a CliError ([d03712a](https://github.com/ExaDev/claude-use/commit/d03712a04cf5f4ed3486f81c8ab6e765cf3a0b5b))

## [2.0.0](https://github.com/ExaDev/claude-use/compare/v1.5.0...v2.0.0) (2026-08-19)

### ⚠ BREAKING CHANGES

* history (projects, sessions, session-env, teams, tasks,
  todos, history.jsonl, transcripts, paste-cache, file-history, plans,
  workflows, jobs, debug, downloads, chrome) is now shared between identities
  by default. Anyone relying on the old closed-by-default behaviour for
  confidentiality between identities must now set categories.history=false
  explicitly, via a configuration profile, directory rule, or
  ~/.claude-use/config.json's global categories override.

### Features

* share history by default, isolating identities on credentials alone ([bc8a9bd](https://github.com/ExaDev/claude-use/commit/bc8a9bdab232fb4c68612f380360dc4e850a6ec9))

### Bug Fixes

* override nanoid to ^3.3.18 to clear GHSA-2v37-7h3g-55p8 ([114a8dc](https://github.com/ExaDev/claude-use/commit/114a8dc0a7df52eb07ae0b001f5627761916d1e0))

## [1.5.0](https://github.com/ExaDev/claude-use/compare/v1.4.0...v1.5.0) (2026-08-07)

### Features

* offer an identity setup wizard when [@name](https://github.com/name) targets a missing identity ([62c5819](https://github.com/ExaDev/claude-use/commit/62c5819cafaa24bbe5f1cdc711b336225413a0ab))

### Bug Fixes

* override js-yaml to ^4.3.1 to clear CVE-2026-59870 ([57eede9](https://github.com/ExaDev/claude-use/commit/57eede98d06f30e74bcd3051a77105bd276455e1))

## [1.4.0](https://github.com/ExaDev/claude-use/compare/v1.3.2...v1.4.0) (2026-08-06)

### Features

* add a unified profile wizard and offer it when a profile is missing ([218f531](https://github.com/ExaDev/claude-use/commit/218f53154334fa9921638f7b0a966b09906bedf5))

## [1.3.2](https://github.com/ExaDev/claude-use/compare/v1.3.1...v1.3.2) (2026-08-06)

### Bug Fixes

* catch known errors at the top level instead of crashing with a stack trace ([e7523a6](https://github.com/ExaDev/claude-use/commit/e7523a6d019258aab4feee93ccf7f36c47492c89))

## [1.3.1](https://github.com/ExaDev/claude-use/compare/v1.3.0...v1.3.1) (2026-08-05)

### Bug Fixes

* run the PR-triggered platform build jobs even though semantic-release is skipped ([a2058d5](https://github.com/ExaDev/claude-use/commit/a2058d5ae1569654719f20d1470d00e304e78eaf)), references [#7](https://github.com/ExaDev/claude-use/issues/7)

## [1.3.0](https://github.com/ExaDev/claude-use/compare/v1.2.1...v1.3.0) (2026-08-05)

### Features

* build and smoke test each platform binary on pull requests ([7c297b3](https://github.com/ExaDev/claude-use/commit/7c297b3de25c0cef073b8c41af495f39f91241fb))

## [1.2.1](https://github.com/ExaDev/claude-use/compare/v1.2.0...v1.2.1) (2026-08-05)

### Bug Fixes

* scope the shared Turbo cache key by runner architecture, not just OS ([7e43b7f](https://github.com/ExaDev/claude-use/commit/7e43b7f7e80e06a80f82ad452c1639ec249608ce))

## [1.2.0](https://github.com/ExaDev/claude-use/compare/v1.1.0...v1.2.0) (2026-08-05)

### Features

* build the bundle in prepare so a git-based install actually works ([f9166d5](https://github.com/ExaDev/claude-use/commit/f9166d5b148a8a4c978811557b5ec38e5add82af))

## [1.1.0](https://github.com/ExaDev/claude-use/compare/v1.0.0...v1.1.0) (2026-08-05)

### Features

* publish claude-use as @exadev/claude-use to GitHub Packages ([aa9d5bc](https://github.com/ExaDev/claude-use/commit/aa9d5bcb32451df86a039d46f9f431f9f2bf5794))

## [1.0.0](https://github.com/ExaDev/claude-use/compare/v0.6.0...v1.0.0) (2026-08-05)

### ⚠ BREAKING CHANGES

* none -- this commit changes no behavior. It marks the
  existing CLI and configuration surface as the v1.0 stable public API,
  triggering the major version bump to reflect that commitment.

### Miscellaneous Chores

* declare the public API stable at v1.0.0 ([1213ae2](https://github.com/ExaDev/claude-use/commit/1213ae2c26a8e5b0e5a73aa8c5a490542d4de1a8))

## [0.6.0](https://github.com/ExaDev/claude-use/compare/v0.5.0...v0.6.0) (2026-08-05)

### Features

* add claude-use identity resolve for interactive farm-conflict resolution ([7fb1095](https://github.com/ExaDev/claude-use/commit/7fb10955a7e340a97be5873b2ff8e7b020ea680d))

## [0.5.0](https://github.com/ExaDev/claude-use/compare/v0.4.0...v0.5.0) (2026-08-04)

### Features

* add a claude-use @<name> shortcut for identity use <name> ([28868bd](https://github.com/ExaDev/claude-use/commit/28868bd88821d381a8958d5db77368887ecfad2a))

## [0.4.0](https://github.com/ExaDev/claude-use/compare/v0.3.6...v0.4.0) (2026-08-04)

### Features

* add an 'all' shorthand for every overridable category ([4ad3a96](https://github.com/ExaDev/claude-use/commit/4ad3a96a23a0bfb5e549448d4bfb1f1607aec191))

## [0.3.6](https://github.com/ExaDev/claude-use/compare/v0.3.3...v0.3.6) (2026-08-03)

v0.3.4 and v0.3.5 were tagged but never fully published — a CI concurrency race cancelled their release pipelines mid-flight (fixed below), and both tags/releases have been removed. v0.3.6 is the first version to actually ship the fixes below.

### Bug Fixes

* make the Turbo cache key unique per CI run ([660fd3d](https://github.com/ExaDev/claude-use/commit/660fd3d46bbe25bf28722520cb53fa2db7dc299e))
* don't cancel an in-flight release when a push supersedes it ([5ee1f30](https://github.com/ExaDev/claude-use/commit/5ee1f30acd56c4830ca14110c5e414bdb7c42898))
* stop trying to override the reserved GITHUB_REF_NAME variable ([e14e733](https://github.com/ExaDev/claude-use/commit/e14e73302861f684ec82195f29baf523a6bc6f57))

## [0.3.3](https://github.com/ExaDev/claude-use/compare/v0.3.2...v0.3.3) (2026-08-03)

### Bug Fixes

* override conventional-changelog-writer to fix empty changelog notes ([47e787b](https://github.com/ExaDev/claude-use/commit/47e787bdb161bfb865d524519fc8d3bc138e6940))

## [0.3.2](https://github.com/ExaDev/claude-use/compare/v0.3.1...v0.3.2) (2026-08-03)

### Bug Fixes

* re-dispatch CI against the new tag instead of relying on its push event ([b19a5ba](https://github.com/ExaDev/claude-use/commit/b19a5bac5a35c83e6fb9e36a33cfe703e90a2e98))

## [0.3.1](https://github.com/ExaDev/claude-use/compare/v0.3.0...v0.3.1) (2026-08-02)

### Bug Fixes

* point semantic-release at the SSH remote so it uses the deploy key ([ec9ff49](https://github.com/ExaDev/claude-use/commit/ec9ff49cceef95888cf2ee0de8f3453aeb72c666))
* use a deploy key so semantic-release's tag push triggers the release pipeline ([c11cda3](https://github.com/ExaDev/claude-use/commit/c11cda35cc1dbd621de8796fec18bfd952620140))

## [0.3.0](https://github.com/ExaDev/claude-use/compare/v0.2.10...v0.3.0) (2026-08-02)

### Features

* automate version decisions and changelog via semantic-release ([bb1b8a3](https://github.com/ExaDev/claude-use/commit/bb1b8a3bec0f99ff2300e843618002c95000fbea))

## [0.2.10](https://github.com/ExaDev/claude-use/compare/v0.2.9...v0.2.10) (2026-08-02)

### Bug Fixes

* install macOS x64 via npm in install.sh too, matching Homebrew ([0eb58aa](https://github.com/ExaDev/claude-use/commit/0eb58aa084f0c0feb3d4d0f849bd78b778fb573b)), references [nodejs/node#62893](https://github.com/nodejs/node/issues/62893) [#59553](https://github.com/ExaDev/claude-use/issues/59553)

## [0.2.9](https://github.com/ExaDev/claude-use/compare/v0.2.8...v0.2.9) (2026-08-02)

### Bug Fixes

* install macOS x64 Homebrew via npm instead of the broken SEA binary ([6f2f406](https://github.com/ExaDev/claude-use/commit/6f2f4068dbc9743df8d0c5528c6eabe1d416fe51)), references [nodejs/node#62893](https://github.com/nodejs/node/issues/62893) [nodejs/node#59553](https://github.com/nodejs/node/issues/59553)

## [0.2.8](https://github.com/ExaDev/claude-use/compare/v0.2.7...v0.2.8) (2026-08-02)

## [0.2.7](https://github.com/ExaDev/claude-use/compare/v0.2.6...v0.2.7) (2026-08-02)

## [0.2.6](https://github.com/ExaDev/claude-use/compare/v0.2.5...v0.2.6) (2026-08-02)

### Bug Fixes

* recognise claude.exe when dispatching launcher vs CLI mode ([7766b26](https://github.com/ExaDev/claude-use/commit/7766b260cbaad4333a17ccf0e1e2a2c92f10ab6c))

## [0.2.5](https://github.com/ExaDev/claude-use/compare/v0.2.4...v0.2.5) (2026-08-02)

## [0.2.4](https://github.com/ExaDev/claude-use/compare/v0.2.3...v0.2.4) (2026-08-02)

### Bug Fixes

* hardlink the real running binary, not a PATH-visible proxy ([1a743bc](https://github.com/ExaDev/claude-use/commit/1a743bc7a251755ce1bf0549096ebeed3beb16f6))

## [0.2.3](https://github.com/ExaDev/claude-use/compare/v0.2.2...v0.2.3) (2026-08-02)

### Bug Fixes

* use PATHEXT extension matching, not mode bits, on Windows ([5bb9ccd](https://github.com/ExaDev/claude-use/commit/5bb9ccdcfe60bc55e54ff2b15377eea1e889061e))

## [0.2.2](https://github.com/ExaDev/claude-use/compare/v0.2.1...v0.2.2) (2026-08-02)

### Bug Fixes

* redirect shim placement when invoked through a re-exec wrapper ([daffb25](https://github.com/ExaDev/claude-use/commit/daffb259c1d8a27c5a2842047523c7e213d6f141))

## [0.2.1](https://github.com/ExaDev/claude-use/compare/v0.2.0...v0.2.1) (2026-08-01)

### Bug Fixes

* resolve own executable path via PATH search, not raw argv[1] ([7bd14c6](https://github.com/ExaDev/claude-use/commit/7bd14c62e44e31c8eee48f693fd762904d672283))

## [0.2.0](https://github.com/ExaDev/claude-use/compare/v0.1.1...v0.2.0) (2026-08-01)

### Features

* add claude-use doctor, a whole-tree config-graph audit ([e770287](https://github.com/ExaDev/claude-use/commit/e770287fa94d31977330d69ac096daa3d8e33013))
* add claude-use shim enable/disable ([b97d65d](https://github.com/ExaDev/claude-use/commit/b97d65d8efefe7b5903ae478caf51c80f921666f))
* **cli:** add claude-use run to reach the launcher without a claude binary ([3759744](https://github.com/ExaDev/claude-use/commit/3759744edeb69efd281f17c2621945c96033b06e))
* **paths:** add claude-shim.json to LayoutPaths ([bc92e8b](https://github.com/ExaDev/claude-use/commit/bc92e8bdb6cc93c5d1668c2b223187f27024b97a))
* wire claude-use shim into cli.ts and doctor.ts ([6c8c023](https://github.com/ExaDev/claude-use/commit/6c8c0239c6df2f6c776e2e23a7273dd31c372229))

### Bug Fixes

* **build:** replace error cast with a type guard, preserve the cause ([2c68c9e](https://github.com/ExaDev/claude-use/commit/2c68c9e0e00353a640adf6769bf69621f449a081))
* **claudeShim:** place the shim next to the executable as invoked ([4752261](https://github.com/ExaDev/claude-use/commit/4752261f423dbf9c01378d719aeda981a2b174ba))
* **config:** replace type assertions with guards and narrower types ([2511000](https://github.com/ExaDev/claude-use/commit/2511000cc126ef382d3735bcac8e758a19f4c293))
* **configure:** verify clack results instead of casting them back to Value ([f95e109](https://github.com/ExaDev/claude-use/commit/f95e10992bef14a1e38e2630cd7d92e657773003))
* drop claude from the npm package's bin field ([ab1e9a7](https://github.com/ExaDev/claude-use/commit/ab1e9a7167a4c6e0e5a63a57ce9a3c071123153b))
* **launcher:** remove redundant casts and empty fake lock sleeps ([1c3cb42](https://github.com/ExaDev/claude-use/commit/1c3cb42e96c4e7256a5d065a0de19c6f0879f27b))
* remove redundant casts in realPorts and directoryRules ([5010709](https://github.com/ExaDev/claude-use/commit/5010709cbb0b82945e5537a32adbd8010a91446e))
* **resolve:** drop unused imports, a stale cast, and a dead assignment ([6405a07](https://github.com/ExaDev/claude-use/commit/6405a07d22336a40615b6d1fdca0411d1a0d569b))

## [0.1.1](https://github.com/ExaDev/claude-use/compare/v0.1.0...v0.1.1) (2026-08-01)

### Bug Fixes

* use the explicit npx command form to work around an npm bin-resolution bug ([4ce7f0e](https://github.com/ExaDev/claude-use/commit/4ce7f0ec1d99697cdbbfffd391d23b3d61cc1c00))

## 0.1.0 (2026-08-01)

### Features

* add a placeholder CLI entrypoint for SEA packaging proof-of-concept ([be3407e](https://github.com/ExaDev/claude-use/commit/be3407eefe09e5ce7afe5c988e8337559159e1d9))
* add CLAUDE_USE_HOME-aware path resolution ([06c0806](https://github.com/ExaDev/claude-use/commit/06c0806dcdb2306c3646bb9436c159b5faf0e371))
* add claude-use check dry-run cascade inspector ([90ced3f](https://github.com/ExaDev/claude-use/commit/90ced3fc133c334966a280624f2e2297347eeae8))
* add claude-use identity subcommands ([0d1a871](https://github.com/ExaDev/claude-use/commit/0d1a871e3f744b28e85cb295b3dd5e3a2e25caac))
* add claude-use profile subcommands ([70385fb](https://github.com/ExaDev/claude-use/commit/70385fbc8935cdd5c36fed302627a0e577d8d7ed))
* add claude-use rules subcommands ([442083d](https://github.com/ExaDev/claude-use/commit/442083de7be4c1fc0e5afa5ee4ec375cf3544050))
* add injectable launcher ports for filesystem, spawn, process, and logging ([859c401](https://github.com/ExaDev/claude-use/commit/859c401deebd39faa7573472a88f50d0648cb1ef))
* add version discovery with PATH fallback ([a7ce649](https://github.com/ExaDev/claude-use/commit/a7ce64986a14ae6af55969a99389a4cceef367d8))
* build a Node SEA binary with the stable --build-sea command ([e7db11a](https://github.com/ExaDev/claude-use/commit/e7db11a53be1a3e455925823e4807a49588c8d0d))
* build a one-off cascade override from CLI flags and env vars ([815005e](https://github.com/ExaDev/claude-use/commit/815005e80d2eb31a93f7af5688129365f6dbe202))
* build, reconcile, and atomically swap an identity's symlink farm ([7642f36](https://github.com/ExaDev/claude-use/commit/7642f36faf3ca426ec95db0dcbaecbbc26d6d390))
* classify ~/.claude entries against the shipped category map ([fecac4a](https://github.com/ExaDev/claude-use/commit/fecac4a3bdc02da882d446c6eaabad5efba75975))
* **cli:** add comma-separated key=value pair parsers ([7da1cab](https://github.com/ExaDev/claude-use/commit/7da1cab2afbc4a7a2029ec837762e12f0711e0f7))
* **config:** add atomic JSON store with read/write/patch helpers ([c2e67f8](https://github.com/ExaDev/claude-use/commit/c2e67f8ea37dc64f0dbb9cae68ecd5de853dc631))
* **configure:** add interactive claude-use configure command ([bd0d486](https://github.com/ExaDev/claude-use/commit/bd0d486cf65672b02a88c30644fb5120b03cd68b))
* decide which identity and config profile a launch resolves to ([4bce045](https://github.com/ExaDev/claude-use/commit/4bce045f0961bfa6cc470a1569279c6b7283505a))
* define Zod schemas for every claude-use configuration file ([e3aca0e](https://github.com/ExaDev/claude-use/commit/e3aca0e1e4072e79234e10629c43c4632bd0d4b3))
* detect and refuse ambient credentials that would bypass identity isolation ([bf9da22](https://github.com/ExaDev/claude-use/commit/bf9da226bf6c202451dec7d66c127e8ac60f7042))
* dispatch cli.ts to the launcher or the claude-use Commander tree ([af9377d](https://github.com/ExaDev/claude-use/commit/af9377da9271b2634b53682f9445dd86bfb4f458))
* encode real paths into ~/.claude/projects/ directory names ([d91de21](https://github.com/ExaDev/claude-use/commit/d91de212bec790e079180d7c6401dd9e021dee4c))
* expose claude-use --version via Commander ([171a46e](https://github.com/ExaDev/claude-use/commit/171a46e8acc2008886633313b48fba8ac6278254))
* expose the resolver through one facade and cover the cascade ([4c4cbda](https://github.com/ExaDev/claude-use/commit/4c4cbdaf1bd86cb2dd9a16ecd5b7fbda157d5da4))
* generate and publish JSON Schemas from Zod config schemas ([12edf2e](https://github.com/ExaDev/claude-use/commit/12edf2e5047012209d154b7bd8bfdf55f1ed01a6))
* install the built SEA binary as both claude and claude-use ([e582fa2](https://github.com/ExaDev/claude-use/commit/e582fa260f216cc41b8a0654f43d70ab832a4240))
* linearise extends graphs and assemble the directory cascade ([bcb4515](https://github.com/ExaDev/claude-use/commit/bcb45153ca86c77ebf990849f0de74247b12b1dd))
* load config files by exact path with explicit entries key ordering ([a4acf2d](https://github.com/ExaDev/claude-use/commit/a4acf2d29bbc66507b71c0f45cd1c58cd90baa5b))
* load every config file one launch's cascade is assembled from ([abd493a](https://github.com/ExaDev/claude-use/commit/abd493af80deb9cf0f998848cba0018a717742e5))
* make the esbuild bundle publishable as an npm bin package ([50771b0](https://github.com/ExaDev/claude-use/commit/50771b0398a547ae8d4f1ae46027a2441650b93b))
* orchestrate one claude launch through guard, identity, and flag resolution ([4bcdeca](https://github.com/ExaDev/claude-use/commit/4bcdeca9a3460cc836bba478c09a4de6e87c9374))
* parse --config-profile/--category/--share/--hide from launcher argv ([8577f79](https://github.com/ExaDev/claude-use/commit/8577f79738cbbeced0ec06f2f65df3739222df32))
* parse a leading [@name](https://github.com/name) identity token from launcher argv ([cffb339](https://github.com/ExaDev/claude-use/commit/cffb339b57a271398e3d1608c95482ac63e919ed))
* plan the symlink farm and reconcile data written into it ([fe65734](https://github.com/ExaDev/claude-use/commit/fe6573496341acdd48aca9d414f5a5df0a9cc42b))
* rank entries rules by a total specificity order, layer first ([662ca70](https://github.com/ExaDev/claude-use/commit/662ca702817447567b3ab281ad08dd536d89aa27))
* refuse to launch when an ambient credential would bypass identity isolation ([9151762](https://github.com/ExaDev/claude-use/commit/9151762c884a30cde2e368e60dce1b382b9997cf))
* resolve a cascade to per-entry sharing decisions in two phases ([fd5b085](https://github.com/ExaDev/claude-use/commit/fd5b08586aa315fac2fb406bc34d6c39c876c400))
* resolve launch flags and assemble the spawned binary's argv and env ([6194296](https://github.com/ExaDev/claude-use/commit/6194296237b3e8acd2f4aeb587923b5795d69a47))
* resync the active identity's farm on every claude launch ([335af65](https://github.com/ExaDev/claude-use/commit/335af650e353a4c28a79dd1b53b7577d6e06cabf))
* serialise concurrent farm resyncs of one identity behind a lock file ([d6b7862](https://github.com/ExaDev/claude-use/commit/d6b786241546ce8892e9b66d8f9d5980c79bf835))
* spawn the real claude binary and propagate its exit code ([7144517](https://github.com/ExaDev/claude-use/commit/71445176e51a4656dece81a77f6381a14a5c2301))
* split CLAUDE_EXTRA_FLAGS into multiple forwarded argv entries ([a0f4e29](https://github.com/ExaDev/claude-use/commit/a0f4e293b21c0affd90f380d65471d626adce16d))
* thread one-off --category/--share/--hide overrides into the farm resync ([4690615](https://github.com/ExaDev/claude-use/commit/4690615c9541a69fcee2997b347215cd8ca9fe87))

### Bug Fixes

* make install.sh actually download the release binary it installs ([c176320](https://github.com/ExaDev/claude-use/commit/c176320fd2fbf2e0a70e5aaf47c0ad15015526b1))

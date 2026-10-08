# Installation

Every install channel in full, including the platform-support matrix, the npm >= 12 `--allow-git` requirement, GitHub Packages authentication, and why macOS x64 needs a different path on some channels. Verbatim from an earlier README.md.

## Install

```bash
curl -fsSL https://github.com/ExaDev/agent-shim/releases/latest/download/install.sh | sh
```

This installs `agent-shim` alone into `~/.local/bin` — nothing else changes on your system, and in particular your `claude` command, however you already have it set up, is left completely untouched. `agent-shim` doubles as the launcher itself: `agent-shim run [args...]` reaches the exact same identity-resolve → farm-resync → spawn pipeline a `claude`-named binary would, so every feature this tool has already works with zero further setup. No Node.js installation is required; the binary is self-contained ([Node SEA](https://nodejs.org/api/single-executable-applications.html) build).

If you'd also like the shorter `claude @<name>` form instead of `agent-shim run @<name>`, that's one explicit, separate, reversible step:

```bash
agent-shim shim enable   # creates a `claude` launcher next to agent-shim; agent-shim shim disable undoes it
```

**Alternative: npm.** `agent-shim` is also published as an npm package — useful if you already have Node 22.18 or later (or 24 and above) and would rather not download a platform-specific binary:

```bash
npx agent-shim identity list
npm install -g agent-shim
```

The npm package deliberately ships only the `agent-shim` bin — not `claude` — specifically so there's no bin-name ambiguity for `npx` to ever get wrong (a real, observed bug in at least one current npm version: a package exposing two bin names, one matching the package name, could still resolve to the wrong one on a bare `npx <package>@version` invocation). `agent-shim run [args...]` reaches the exact same launcher pipeline regardless of that. `agent-shim shim enable` works here too on macOS/Linux — an npm install's own bundle is directly executable via its own shebang once hardlinked to a bare `claude` — though not on Windows, where an npm-installed agent-shim running under Node has no bundled `.exe` to link from; use Scoop there instead.

**Alternative: GitHub Packages.** The identical npm bundle above is also published under a scoped alias, `@exadev/agent-shim`, to GitHub Packages — for anyone who already authenticates against `npm.pkg.github.com` for other org packages and would rather not add npmjs.com as a second registry. GitHub Packages requires authentication for every install even though the package itself is public, so this needs a personal access token with at least `read:packages` scope and one line of `.npmrc` configuration before either command below works:

```bash
echo "@exadev:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=<a GitHub PAT with read:packages>" >> ~/.npmrc

npx @exadev/agent-shim identity list
npm install -g @exadev/agent-shim
```

See [Publishing to npm](release-process.md#publishing-to-npm) for why this alias is published by its own separate CI job rather than as a second step of the plain npm one above.

**Alternative: directly from GitHub, no registry at all.** No npmjs.com, no GitHub Packages, no authentication of any kind — npm and npx both support installing straight from a git repository:

```bash
npx github:ExaDev/agent-shim identity list
npm install -g github:ExaDev/agent-shim
```

This clones the repo and builds it from source rather than fetching a published tarball: npm automatically runs the `prepare` script for any git-based install — unlike `prepublishOnly`, which only fires on `npm publish` — and `prepare` is what builds `dist/cli.cjs` here, the same script that sets up this repo's own git hooks for a contributor's local clone. Slower than every other channel (a real esbuild build in place of downloading a prebuilt artifact) and pinned to whatever ref you reference — append `#<tag-or-branch-or-commit>` after the repo (e.g. `github:ExaDev/agent-shim#v1.1.0`) — rather than resolved by semver the way the other channels are.

**On npm ≥ 12**, git dependencies are refused unless allowed explicitly — add `--allow-git=root` to either command above (`--allow-git=all` crashes npm 12.0.2 outright; `root`, meaning "a direct dependency of the project being installed," is both narrower and the one that actually works). npm may also print a warning that `agent-shim`'s `prepare` script was "blocked because they are not covered by allowScripts" — in testing against npm 12.0.2 the script still ran and produced a working install regardless of that message, but if a future npm patch actually enforces it, approve the script explicitly (`npm approve-scripts agent-shim` on npm 11, `npm install-scripts approve agent-shim` on npm 12 — the command was renamed between versions) before installing.

**Alternative: Homebrew (macOS and Linux).**

```bash
brew install ExaDev/agent-shim/agent-shim
```

**Alternative: Scoop (Windows).**

```powershell
scoop bucket add agent-shim https://github.com/ExaDev/scoop-agent-shim
scoop install agent-shim
```

Scoop cannot rename a package, so the bucket also keeps a `claude-use` manifest that mirrors every release (the release workflow generates it from `agent-shim.json`). An existing `scoop install claude-use` keeps updating to the same files; new installs should use `agent-shim`.

Every channel installs `agent-shim` alone — none of them install a `claude` command; `agent-shim shim enable` is the one explicit action that does, on any of them. The GitHub Release binary and Scoop ship the self-contained Node SEA build (no Node.js installation required) — macOS arm64, both Linux architectures, and both Windows architectures are all targets Node core itself tests and verifies `--build-sea` against upstream; the raw GitHub Release binary for macOS x64 is published best-effort, since Node core does not test or verify single-executable-application support on that target and the resulting binary genuinely crashes there (see [Build (Node SEA)](release-process.md#build-node-sea) below). **Homebrew and `install.sh` both work around this on macOS x64 specifically**: rather than installing that broken binary, they depend on (or check for) Node and install the same plain bundle the npm channel publishes — a real, working `agent-shim`, not a best-effort one. npm ships the plain bundle everywhere, running under whatever Node (22.18 or later, or 24 and above) you already have.

## Updating

`agent-shim update` brings an installation to the newest release: it resolves the version the `releases/latest` redirect points at, compares it with the running one, and (unless `--check` was passed, which only reports) downloads that release's platform binary, verifies its sha256 sidecar, and installs it over the running executable in place, held by a lock so two updates cannot interleave. An installation a package manager owns refuses instead and names the command that channel updates with: `brew upgrade agent-shim` under a Homebrew prefix, `npm install -g agent-shim@latest` for an npm install (and for macOS x64, where the standalone binary is broken upstream) and `scoop update agent-shim` on Windows. Re-running `install.sh` does the same job as `agent-shim update` for a binary installation, and reinstalls it from scratch for any other.

Launches can also handle updating themselves, gated by the `update.mode` setting in the global `~/.agent-shim/config.json` (`agent-shim update --mode <mode>` writes it and exits):

- `off` (the default, and what an absent setting means) never touches the network at launch.
- `notify` checks for a newer release when a launch starts, at most once a day per installation (the timestamp of the last check is kept in `<root>/update.check`, written before the check itself so a fleet of concurrent launches does not hammer GitHub), and prints one line on stderr naming the newer release and the command that applies it. A running version that is current or ahead prints nothing.
- `auto` does everything `notify` does and additionally applies the update in the background: the same check, and when a newer release exists, a detached copy of the binary runs `agent-shim update` while the launch carries on. The update command's own lock keeps concurrent applies safe.

The check never delays, blocks or fails a launch, whatever the network or the filesystem does, and a `notify` line is printed only when the answer arrives before the child takes over the terminal (a line emitted mid-session would corrupt its display). An applied update swaps the binary on disk for future launches; processes already running keep the version they started with until they restart, with one deliberate exception: the front-door supervisor turns itself over, because it is the one long-lived process every later launch talks to. The supervisor stats the installed `agent-shim` entry (the file `agent-shim update` renames its verified bytes over, resolved as the sibling beside the door's own entry when the door was spawned through the `claude` hardlink, the legacy `claude-use` symlink or another name, and as the door's own entry when no sibling exists, the npm bundle's own layout) once at startup and again on every tick with an empty session registry, and at the first such tick past the door's own start (a one-tick grace that lets the launch ensuring the door write its session record first) where that file is a different one it exits through its ordinary graceful shutdown, so the next launch spawns a door from the new binary on the same sticky ports. A live session is never cut off (the door waits for the registry to empty), and an entry that is briefly missing (a deleted binary, or a remove-then-link install such as `install.sh` between its removal and its relink) leaves the door alone, so a half-applied install never flaps it. Scoop installs and a `shim enable --dir` layout keep the idle-only turnover, because no file the door can watch there changes on update: Scoop builds a new version directory beside the old one (and its channel updates itself), and a `shim enable --dir` copy is not the entry `agent-shim update` renames over, so the door's watched file keeps the old binary until the idle timeout retires it. On an installation a package manager owns, the background apply of `auto` refuses exactly as a manual `agent-shim update` would, and being detached its refusal is silent; the `notify` line still names the release, and running `agent-shim update` once by hand names the channel's own upgrade command.


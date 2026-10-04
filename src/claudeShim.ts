import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { z } from "zod";

import { withExamples, type CommandDeps } from "./cli/commandDeps";
import { readJson, writeJsonAtomic } from "./config/store";
import { findExecutableInDir, realContentSourcePath, realOwnExecutablePath } from "./realPorts";
import { CliError } from "./cliError";
import type { LayoutPaths } from "./paths";

/** The claude-shim.json marker's own shape: never hand-edited, so it lives here rather than in `src/config/schema.ts`'s user-editable schemas (and is correctly excluded from `scripts/gen-schema.mts`'s published-schema generation, which only ever imports from that file). */
// rwxr-xr-x -- the copy-fallback path below sets this explicitly since a plain copyFile doesn't preserve the source's own executable bit the way a hardlink (which shares the same inode) does.
const EXECUTABLE_FILE_MODE = 0o755;

export const ClaudeShimStateSchema = z.strictObject({
  targetPath: z.string().min(1),
  method: z.enum(["hardlink", "copy"]),
  installedAtMs: z.number(),
});
export type ClaudeShimState = z.infer<typeof ClaudeShimStateSchema>;

/** Raised by enableClaudeShim/disableClaudeShim when the target path exists but doesn't look like agent-shim's own doing (no matching claude-shim.json marker, and not a hardlink of the currently-running executable) — refuses rather than silently clobbering or deleting something an installer never created. Bypassed by --force. */
export class ForeignClaudeEntryError extends CliError {
  constructor(
    readonly targetPath: string,
    readonly action: "enable" | "disable",
  ) {
    super(
      `${targetPath} already exists and does not look like something agent-shim created. Refusing to ` +
        `${action === "enable" ? "overwrite" : "remove"} it automatically — inspect it yourself, or pass --force if you're sure.`,
    );
    this.name = "ForeignClaudeEntryError";
  }
}

/** Raised by enableClaudeShim when the running executable cannot possibly be turned into a directly-runnable `claude` command: an npm/Node install of agent-shim on Windows, which has no bundled .exe and no shebang-based dispatch the way POSIX does. Not bypassed by --force — this isn't a safety refusal, it's "this would produce a broken file." */
export class UnsupportedShimSourceError extends CliError {
  constructor(readonly contentSourcePath: string) {
    super(
      `Cannot create a working \`claude\` command from ${contentSourcePath} on Windows: an npm-installed ` +
        "agent-shim running under Node.js has no .exe to hardlink/copy, and Windows has no shebang-based " +
        "dispatch the way POSIX does. Install agent-shim via Scoop instead (see README), which ships a real " +
        "agent-shim.exe this command can link from.",
    );
    this.name = "UnsupportedShimSourceError";
  }
}

/**
 * The exact filename to create: `claude.exe` when the running executable is itself a `.exe` (Windows needs the extension to recognise it as directly executable at all), `claude` for every other case.
 *
 * Deliberately not "preserve whatever extension the source has" — an npm install's own file is `cli.cjs`, and a bare `claude` (not `claude.cjs`) is what makes it invocable as the expected command on POSIX, where a shebang plus the executable bit is what matters, not the filename's extension.
 */
export function claudeTargetFilename(ownExecutablePath: string): string {
  return commandFilename(ownExecutablePath, "claude");
}

/** The same rule generalised to any command name this tool owns, so `doctor`'s PATH-resolution check can ask "what filename would a bare `agent-shim` be" without restating the Windows `.exe` condition and letting the two drift apart. */
export function commandFilename(ownExecutablePath: string, commandName: string): string {
  return ownExecutablePath.toLowerCase().endsWith(".exe") ? `${commandName}.exe` : commandName;
}

/**
 * `cli.ts`'s own name-dispatch check: is `invokedName` (the basename of however this binary was invoked) one of the two names `shim enable` ever creates, per `claudeTargetFilename` above? `path.basename` includes the file extension, so a bare `=== "claude"` comparison never matches the Windows case, where the file must be named `claude.exe` to be directly invocable at all.
 *
 * Confirmed as a real, previously-undetected bug against an actual Scoop install: the shim-placement and hardlink-source bugs fixed in prior releases had never let a Windows `claude.exe` invocation reach this far before, so this exact mismatch never surfaced until the shim itself finally worked end-to-end — invoking the newly-created `claude.exe` fell through to agent-shim's own CLI (printing its own `--version`) instead of the launcher.
 */
export function isInvokedAsClaude(invokedName: string): boolean {
  return invokedName === "claude" || invokedName.toLowerCase() === "claude.exe";
}

/**
 * Builds the check `discoverClaudeBinary`'s PATH fallback uses to recognise this very tool among the `claude` candidates it finds, so the launcher can never recursively discover and spawn itself.
 *
 * A candidate counts as this tool when it is the file `claude-shim.json` records (the marker is authoritative even after an agent-shim upgrade left the target holding the previous version's bytes, when neither its content nor its inode match the running binary any more; the same trust `enableClaudeShim`/`disableClaudeShim` already place in the marker) or when it is the same file as this process's own content, compared by inode the way `enableClaudeShim` already compares for its "is this target mine" decision (`fs.statSync` follows symlinks, so a `claude` symlink pointing at the running binary counts as the same file too, while a package manager's symlink to a different package's launcher does not).
 *
 * Deliberately checks candidate files rather than excluding whole directories, the previous shape: an npm global prefix's bin directory holds every globally-installed package's binaries side by side, so a directory-level exclusion hid a genuinely separate `@anthropic-ai/claude-code` install living in the same directory as agent-shim (#188). The layouts the exclusion existed for stay safe, because the only `claude` dropped in them is agent-shim's own shim copy: install.sh's `~/.local/bin`, Homebrew's `/opt/homebrew/bin` and Scoop's shims directory are shared bin directories in exactly the same way, and a different package's claude there is now found instead of hidden.
 */
export function resolveOwnBinaryCheck(paths: LayoutPaths, contentSourcePath: string): (candidate: string) => boolean {
  const state = readJson(paths.claudeShimFile, ClaudeShimStateSchema);
  const recordedTarget = state === undefined ? undefined : path.resolve(state.targetPath);
  // Statted on first use rather than at build time, since discovery may resolve through the versions directory and never ask about a PATH candidate at all.
  let ownStat: fs.Stats | undefined;
  return (candidate) => {
    if (recordedTarget !== undefined && path.resolve(candidate) === recordedTarget) {
      return true;
    }
    ownStat ??= statOrUndefined(contentSourcePath);
    const candidateStat = statOrUndefined(candidate);
    return (
      ownStat !== undefined &&
      candidateStat !== undefined &&
      // A platform reporting no inode number for either file must not read every candidate as this tool.
      ownStat.ino !== 0 &&
      candidateStat.ino !== 0 &&
      candidateStat.dev === ownStat.dev &&
      candidateStat.ino === ownStat.ino
    );
  };
}

/** Where `shim enable` places `claude` absent a --dir override: alongside the running executable. */
export function resolveClaudeTargetPath(ownExecutablePath: string, dir?: string): string {
  return path.join(dir ?? path.dirname(ownExecutablePath), claudeTargetFilename(ownExecutablePath));
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isCrossDeviceError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV";
}

function lstatOrUndefined(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

/** `fs.statSync` with ENOENT collapsed to undefined. Unlike `lstatOrUndefined` it follows symlinks, so a `claude` symlink resolves to whatever file it actually points at, which is what `resolveOwnBinaryCheck`'s inode comparison needs. */
function statOrUndefined(target: string): fs.Stats | undefined {
  try {
    return fs.statSync(target);
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

/** The two low-level fs calls the hardlink-then-copy-fallback needs, matching `src/config/store.ts`'s own `StoreFs`/`nodeStoreFs`-with-a-real-default pattern — the one seam in this file that isn't plain `node:fs`, added so the EXDEV fallback branch gets real unit coverage without a genuine cross-filesystem test rig. */
export interface LinkFs {
  readonly link: (existingPath: string, newPath: string) => void;
  readonly copyFile: (src: string, dest: string) => void;
  readonly chmod: (target: string, mode: number) => void;
}
const nodeLinkFs: LinkFs = { link: fs.linkSync, copyFile: fs.copyFileSync, chmod: fs.chmodSync };

/** Inputs to `enableClaudeShim`. */
export interface EnableShimParams {
  readonly paths: LayoutPaths;
  /** `realOwnExecutablePath()` (see realPorts.ts) — the PATH-visible location `claude` should be placed alongside, supplied by the wiring layer. Deliberately separate from `contentSourcePath` below: for a Scoop install, this is `~/scoop/shims/agent-shim.exe` (Scoop's own proxy binary, not agent-shim's real content), and using it as the link/copy source would hardlink that proxy instead of the genuine executable. */
  readonly ownExecutablePath: string;
  /** `realContentSourcePath()` (see realPorts.ts) — the actual file whose content is this running process, used as the hardlink/copy source and for "is the existing target mine" inode comparisons. */
  readonly contentSourcePath: string;
  /** process.platform, supplied by the wiring layer — only used for the Windows/npm-source guard. */
  readonly platform: string;
  readonly dir?: string;
  readonly force: boolean;
}

type EnableShimAction = "enabled" | "reenabled";
export interface EnableShimResult {
  readonly action: EnableShimAction;
  readonly targetPath: string;
  readonly method: "hardlink" | "copy";
}

/**
 * Creates a `claude`-named hardlink (falling back to a copy on a cross-device filesystem) of the currently running `agent-shim` executable, so `claude @<name>` works directly instead of needing `agent-shim run`.
 *
 * A target that already exists is only ever overwritten when it's provably agent-shim's own doing — either it shares an inode with the currently-running executable (covers a pre-existing install from before this feature existed, where no marker could possibly exist yet), or claude-shim.json records this exact target path (covers refreshing after a agent-shim upgrade, when the old target's inode no longer matches the new binary's content). Anything else is refused unless `force` is set — this could otherwise silently delete or overwrite someone's genuine, unrelated `claude` binary.
 */
export function enableClaudeShim(params: EnableShimParams, linkFs: LinkFs = nodeLinkFs): EnableShimResult {
  const realContentPath = fs.realpathSync(params.contentSourcePath);

  if (params.platform === "win32" && !realContentPath.toLowerCase().endsWith(".exe")) {
    throw new UnsupportedShimSourceError(realContentPath);
  }

  // Deliberately targets alongside the executable *as invoked* (params.ownExecutablePath), not its realpath: a package manager's own PATH-visible entry is very often a symlink into some other directory entirely (e.g. Homebrew's `/opt/homebrew/bin/agent-shim` -> `../Cellar/agent-shim/<version>/bin/agent-shim`), and the new `claude` shim needs to land next to that PATH-visible symlink, not buried in the Cellar keg alongside the dereferenced target where nothing on PATH would ever find it. The link *source* below uses realContentPath instead, so the hardlink/copy is always of agent-shim's genuine content — never a symlink-of-a-symlink, and never a different PATH-visible proxy binary (Scoop's own shim) that merely happens to live at the placement location.
  const targetPath = resolveClaudeTargetPath(params.ownExecutablePath, params.dir);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const existing = lstatOrUndefined(targetPath);
  if (existing !== undefined) {
    const ownStat = fs.statSync(realContentPath);
    const state = readJson(params.paths.claudeShimFile, ClaudeShimStateSchema);
    const sameInode = existing.dev === ownStat.dev && existing.ino === ownStat.ino;
    const markerMatches = state !== undefined && path.resolve(state.targetPath) === targetPath;
    if (!sameInode && !markerMatches && !params.force) {
      throw new ForeignClaudeEntryError(targetPath, "enable");
    }
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  let method: "hardlink" | "copy";
  try {
    linkFs.link(realContentPath, targetPath);
    method = "hardlink";
  } catch (error) {
    if (!isCrossDeviceError(error)) {
      throw error;
    }
    linkFs.copyFile(realContentPath, targetPath);
    linkFs.chmod(targetPath, EXECUTABLE_FILE_MODE);
    method = "copy";
  }

  const newState: ClaudeShimState = { targetPath, method, installedAtMs: Date.now() };
  writeJsonAtomic(params.paths.claudeShimFile, newState);

  return { action: existing === undefined ? "enabled" : "reenabled", targetPath, method };
}

type DisableShimAction = "disabled" | "not-enabled";
export interface DisableShimResult {
  readonly action: DisableShimAction;
  readonly targetPath: string;
}

export interface DisableShimParams {
  readonly paths: LayoutPaths;
  /** `realOwnExecutablePath()` — the PATH-visible location, used to derive the default target path. */
  readonly ownExecutablePath: string;
  /** `realContentSourcePath()` — used for the "is the existing target mine" inode comparison; see `EnableShimParams` for why this must be separate from `ownExecutablePath`. */
  readonly contentSourcePath: string;
  readonly dir?: string;
  readonly force: boolean;
}

/** The inverse of `enableClaudeShim`: removes the `claude` command it created, using the same "is this ours" safety check. A no-op, not an error, when nothing is enabled — including clearing a dangling marker whose target has since been deleted by other means. */
export function disableClaudeShim(params: DisableShimParams): DisableShimResult {
  const realContentPath = fs.realpathSync(params.contentSourcePath);
  const state = readJson(params.paths.claudeShimFile, ClaudeShimStateSchema);
  const targetPath =
    params.dir !== undefined
      ? path.join(params.dir, claudeTargetFilename(params.ownExecutablePath))
      : (state?.targetPath ?? resolveClaudeTargetPath(params.ownExecutablePath));

  const existing = lstatOrUndefined(targetPath);
  if (existing === undefined) {
    if (state !== undefined) {
      fs.rmSync(params.paths.claudeShimFile, { force: true });
    }
    return { action: "not-enabled", targetPath };
  }

  const ownStat = fs.statSync(realContentPath);
  const sameInode = existing.dev === ownStat.dev && existing.ino === ownStat.ino;
  const markerMatches = state !== undefined && path.resolve(state.targetPath) === targetPath;
  if (!sameInode && !markerMatches && !params.force) {
    throw new ForeignClaudeEntryError(targetPath, "disable");
  }

  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.rmSync(params.paths.claudeShimFile, { force: true });
  return { action: "disabled", targetPath };
}

export type PathShadowStatus =
  | { readonly status: "ok" }
  | { readonly status: "not-on-path" }
  | { readonly status: "shadowed"; readonly by: string };

export interface FindPathShadowParams {
  readonly pathDirs: readonly string[];
  readonly targetDir: string;
  readonly targetFilename: string;
  readonly findExecutableInDir: (dir: string, name: string) => string | undefined;
}

/** Would something else on PATH run before the just-enabled `claude`? Reuses the exact PATH-scan semantics `discoverClaudeBinary`'s own fallback already uses (via the injected `findExecutableInDir`), rather than shelling out to `command -v` — this answers a more directly relevant question ("would this tool's own binary discovery find this file first") without spawning a process at all. */
export function findPathShadow(params: FindPathShadowParams): PathShadowStatus {
  const resolvedTargetDir = path.resolve(params.targetDir);
  for (const dir of params.pathDirs) {
    const found = params.findExecutableInDir(dir, params.targetFilename);
    if (found === undefined) {
      continue;
    }
    return path.resolve(dir) === resolvedTargetDir ? { status: "ok" } : { status: "shadowed", by: found };
  }
  return params.pathDirs.some((dir) => path.resolve(dir) === resolvedTargetDir) ? { status: "ok" } : { status: "not-on-path" };
}

/**
 * Registers `agent-shim shim enable`/`agent-shim shim disable` onto `program`.
 *
 * `shim` is a deliberate noun-group, matching `identity`/`profile`/`rule`: it names the actual mechanism (a PATH-level executable that dispatches by invoked name, the same concept Scoop itself calls a "shim"), so `enable`/`disable` read as toggling one clearly-scoped thing rather than "installing"/"uninstalling" software, which could be misread as installing Claude Code itself.
 */
export function registerShimCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const shim = withExamples(
    program
      .command("shim")
      .description(
        "Manage the `claude` command shim: an optional, explicit way to also invoke this launcher as `claude` " +
          "instead of `agent-shim run`. Off by default; every installer ships only `agent-shim`.",
      ),
    ["agent-shim shim enable", "agent-shim shim disable"],
  );

  const enable = shim
    .command("enable")
    .description("Create a `claude`-named copy of this same executable, alongside agent-shim by default.")
    .option("--dir <path>", "Enable into this directory instead of alongside the running agent-shim executable.")
    .option("--force", "Overwrite the target even if it doesn't look like agent-shim's own doing.")
    .action((options: Readonly<{ dir?: string; force?: boolean }>) => {
      const ownExecutablePath = realOwnExecutablePath();
      const contentSourcePath = realContentSourcePath();
      const result = enableClaudeShim({
        paths,
        ownExecutablePath,
        contentSourcePath,
        platform: process.platform,
        ...(options.dir === undefined ? {} : { dir: path.resolve(options.dir) }),
        force: options.force ?? false,
      });
      console.log(`${result.action === "enabled" ? "Installed" : "Reinstalled"} \`claude\` at ${result.targetPath} (${result.method}).`);

      const shadow = findPathShadow({
        pathDirs: (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== ""),
        targetDir: path.dirname(result.targetPath),
        targetFilename: path.basename(result.targetPath),
        findExecutableInDir,
      });
      if (shadow.status === "not-on-path") {
        console.warn(`warning: ${path.dirname(result.targetPath)} is not on PATH — add it, or use \`agent-shim run\` instead.`);
      } else if (shadow.status === "shadowed") {
        console.warn(
          `warning: 'claude' on PATH currently resolves to ${shadow.by}, not ${result.targetPath}. ` +
            `Put ${path.dirname(result.targetPath)} ahead of it on PATH.`,
        );
      }
    });

  withExamples(enable, ["agent-shim shim enable", "agent-shim shim enable --dir ~/bin"]);

  const disable = shim
    .command("disable")
    .description("Remove the `claude` command shim `shim enable` previously created. A no-op, not an error, if none is enabled.")
    .option("--dir <path>", "Look in this directory instead of trusting the recorded location.")
    .option("--force", "Remove the target even if it doesn't look like agent-shim's own doing.")
    .action((options: Readonly<{ dir?: string; force?: boolean }>) => {
      const ownExecutablePath = realOwnExecutablePath();
      const contentSourcePath = realContentSourcePath();
      const result = disableClaudeShim({
        paths,
        ownExecutablePath,
        contentSourcePath,
        ...(options.dir === undefined ? {} : { dir: path.resolve(options.dir) }),
        force: options.force ?? false,
      });
      console.log(
        result.action === "disabled"
          ? `Removed \`claude\` at ${result.targetPath}.`
          : `No \`claude\` command enabled at ${result.targetPath}; nothing to do.`,
      );
    });
  withExamples(disable, ["agent-shim shim disable"]);
}

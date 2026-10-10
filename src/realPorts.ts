import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSea } from "node:sea";

import { cosmiconfigReader } from "./config/load";
import type { CredentialPort } from "./credential";
import { defaultVersionsDir, discoverClaudeBinary, installedVersions, type ClaudeBinaryResolver, type VersionsDirEntry } from "./versionDiscovery";
import { ensureHeadroom } from "./headroom/ensure";
import { currentHeadroomAllowlist } from "./headroom/supervisor";
import type { HeadroomSocketTrustPorts } from "./headroom/socket";
import { hashAllowlist, removeSession } from "./headroom/state";
import type { LayoutPaths } from "./paths";
import type { FarmFs, FsPort, HeadroomPort, LogPort, ProcPort, RunPort, SpawnPort } from "./launcher/ports";

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** The real, `node:fs`-backed `FsPort` used by the actual `claude` launcher — never used in tests. */
export const realFsPort: FsPort = {
  readFileUtf8(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  },
  readConfigFile: cosmiconfigReader(),
  readdir(dirPath) {
    try {
      return fs.readdirSync(dirPath);
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
  },
};

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * The real, `node:fs`-backed `FarmFs` used by an actual resync — never used in tests, which run the whole of `src/launcher/farm.ts` against an in-memory fake.
 *
 * `lstat` never follows symlinks, `copyRecursive` copies a symlink as a symlink rather than as its target's contents, and `writeFileExclusive` uses the `wx` flag so the identity lock's mutual exclusion rests on one atomic syscall rather than a read-then-write pair.
 */
/** Mode of a directory only its owner may enter: the sessions registry holds per-launch capability tokens, so another local account must not even list it. */
const OWNER_ONLY_DIR_MODE = 0o700;
/** Mode of a file only its owner may read or write, for the capability record inside that directory. */
const OWNER_ONLY_FILE_MODE = 0o600;
/** The permission bits of a file mode, without its type bits. */
const PERMISSION_BITS = 0o777;

export const realFarmFs: FarmFs = {
  lstat(filePath) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file";
    return { kind, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  },
  readdir(dirPath) {
    try {
      return fs.readdirSync(dirPath);
    } catch (error) {
      if (isEnoent(error) || isErrorWithCode(error, "ENOTDIR")) {
        return [];
      }
      throw error;
    }
  },
  mkdirp(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  },
  symlink(target, linkPath) {
    fs.symlinkSync(target, linkPath);
  },
  rename(from, to) {
    fs.renameSync(from, to);
  },
  removeRecursive(targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  },
  copyRecursive(from, to) {
    fs.cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: true });
  },
  readFileUtf8(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  },
  writeFileUtf8(filePath, contents) {
    fs.writeFileSync(filePath, contents, "utf8");
  },
  mkdirPrivate(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    fs.chmodSync(dirPath, OWNER_ONLY_DIR_MODE);
  },
  writeFilePrivate(filePath, contents) {
    const temp = `${filePath}.${String(process.pid)}.tmp`;
    fs.writeFileSync(temp, contents, { encoding: "utf8", mode: OWNER_ONLY_FILE_MODE });
    fs.chmodSync(temp, OWNER_ONLY_FILE_MODE);
    fs.renameSync(temp, filePath);
  },
  appendFilePrivate(filePath, contents) {
    const descriptor = fs.openSync(filePath, "a", OWNER_ONLY_FILE_MODE);
    try {
      // A file created here already has the mode (the umask can only narrow it); one that existed wider is narrowed before anything is appended to it.
      if ((fs.fstatSync(descriptor).mode & PERMISSION_BITS) !== OWNER_ONLY_FILE_MODE) {
        fs.fchmodSync(descriptor, OWNER_ONLY_FILE_MODE);
      }
      const bytes = Buffer.from(contents, "utf8");
      let written = 0;
      // A write to a regular file may take fewer bytes than offered; the rest follows until all of it has landed.
      while (written < bytes.length) {
        written += fs.writeSync(descriptor, bytes, written, bytes.length - written);
      }
    } finally {
      fs.closeSync(descriptor);
    }
  },
  writeFileExclusive(filePath, contents) {
    try {
      fs.writeFileSync(filePath, contents, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (error) {
      if (isErrorWithCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    }
  },
  hashFile(filePath) {
    try {
      return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    } catch (error) {
      if (isEnoent(error) || isErrorWithCode(error, "EISDIR")) {
        return undefined;
      }
      throw error;
    }
  },
};

// A single Int32Array element, the minimum SharedArrayBuffer Atomics.wait can block on.
const INT32_BYTE_LENGTH = 4;

/**
 * Blocks the current thread for `ms` milliseconds.
 *
 * The launcher is synchronous end to end, right through to `spawnSync`, so waiting on another process's identity lock cannot be done with a promise. `Atomics.wait` on a private buffer is the one way to sleep synchronously without burning the CPU in a spin loop.
 */
export function realSleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTE_LENGTH)), 0, 0, ms);
}

/** Whether a process is still running. Signal 0 performs the permission and existence checks without delivering anything; `EPERM` means the process exists but belongs to another user. */
function realIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorWithCode(error, "EPERM");
  }
}

/**
 * Whether `pid` is a zombie: a process that has exited but whose parent has not reaped it. Read from `ps`'s process-state column, the one source that distinguishes "exited, awaiting reap" from "running": a defunct process still answers `kill(pid, 0)` (so `realIsProcessAlive` alone cannot see the difference), while `ps -o stat=` reports `Z` for exactly that state.
 *
 * When `ps` is unavailable (no POSIX userland, i.e. Windows) the answer is "not a zombie", falling back to plain signal-0 semantics rather than guessing every process dead.
 */
function realIsProcessZombie(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().startsWith("Z");
}

/**
 * Whether `pid` is a live, schedulable process: signal-0 alive AND not a zombie. This is the liveness notion every headroom coordination decision must use, because a defunct daemon holds no port and a defunct supervisor will never write state, yet both still "exist" as far as signal 0 is concerned.
 */
export function realIsProcessRunning(pid: number): boolean {
  return realIsProcessAlive(pid) && !realIsProcessZombie(pid);
}

/** The real `RunPort`, used for auxiliary commands whose output this process needs to read — git branch detection for `when: { branch }` conditions, and `check.ts`'s macOS Keychain lookup. */
export const realRunPort: RunPort = {
  run(command, args) {
    const result = spawnSync(command, [...args], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  },
};

/** Expands a leading `~` in a credential file path to the home directory; any other path is returned as written (the schema only admits absolute and `~`-rooted ones). */
function expandHome(filePath: string): string {
  return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

/** `launchctl managername` prints this for a process inside a logged-in macOS GUI session, where a secret store can show an approval dialog; a process reached over SSH or from a daemon reports a different manager. */
const MACOS_GUI_SESSION_MANAGER = "Aqua";

/**
 * Whether this process runs inside a desktop session a secret store's approval dialog can appear in. macOS asks `launchctl` which session manager owns the process; other POSIX systems count an X11 or Wayland display. Windows is not detected, so there only a terminal counts as a person being present.
 */
function hasDesktopSession(): boolean {
  if (process.platform === "darwin") {
    const result = spawnSync("launchctl", ["managername"], { encoding: "utf8" });
    return result.status === 0 && result.stdout.trim() === MACOS_GUI_SESSION_MANAGER;
  }
  if (process.platform === "win32") {
    return false;
  }
  return (process.env.DISPLAY ?? "") !== "" || (process.env.WAYLAND_DISPLAY ?? "") !== "";
}

/**
 * The real `CredentialPort`. A secret file's mode is reported only where POSIX permission bits exist (not on Windows, whose ACLs Node's `stat` does not expose). A command runs with no shell under its timeout; a non-interactive one gets no stdin and has its stderr captured for the error message, while an interactive one inherits the terminal's stdin and stderr so its prompt reaches a person. stdout is always captured, since it is the token.
 */
export const realCredentialPort: CredentialPort = {
  readSecretFile(filePath) {
    const resolved = expandHome(filePath);
    let content: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
      content = fs.readFileSync(resolved, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return { found: false };
      }
      throw error;
    }
    return { found: true, content, mode: process.platform === "win32" ? undefined : stat.mode };
  },
  runCommand(argv, options) {
    const [command, ...args] = argv;
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: options.timeoutMs,
      stdio: options.interactive ? ["inherit", "pipe", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    // A timeout and a spawn failure (the program is not installed) both surface as `error`, with no output worth reading: the node typings do not model that stdout and stderr are null for a spawn failure. A spawn failure has no stderr of its own, so its error message is the explanation.
    if (result.error !== undefined) {
      const timedOut = isErrorWithCode(result.error, "ETIMEDOUT");
      return { status: result.status, stdout: "", stderr: timedOut ? "" : result.error.message, timedOut };
    }
    // An interactive run's stderr went to the terminal, so there is nothing captured (the typings again say string; it is null).
    return { status: result.status, stdout: result.stdout, stderr: options.interactive ? "" : result.stderr, timedOut: false };
  },
  personPresent: () => process.stdin.isTTY || hasDesktopSession(),
};

/** Reads the git branch checked out at `cwd`, and whether the repository is in detached-HEAD state. Both undefined when `cwd` is not in a repository at all. */
export function resolveGitBranch(run: RunPort, cwd: string): { branch?: string; branchDetached?: boolean } {
  const result = run.run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.status !== 0) {
    return {};
  }
  const name = result.stdout.trim();
  if (name === "" ) {
    return {};
  }
  if (name === "HEAD") {
    return { branchDetached: true };
  }
  return { branch: name, branchDetached: false };
}

/** The repository root containing `cwd`, or undefined outside a repository: headroom's per-project identity (`x-headroom-project-id`). */
function resolveGitRoot(run: RunPort, cwd: string): string | undefined {
  const result = run.run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (result.status !== 0) {
    return undefined;
  }
  const root = result.stdout.trim();
  return root === "" ? undefined : root;
}

/** The argv that re-runs this very executable with `args`: a SEA binary re-execs itself directly, while the npm-published bundle needs its script path for Node to run. */
export function selfInvocation(args: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  return { command: process.execPath, args: isSea() ? [...args] : [realContentSourcePath(), ...args] };
}

/** Runs this very executable with `args` as a detached background process whose output is discarded, unref'd so the caller never waits on it, with `AGENT_SHIM_HOME` pinned to `paths.root` so it acts on the same state root as the caller. */
export function spawnSelfDetached(paths: LayoutPaths, args: readonly string[]): void {
  const invocation = selfInvocation(args);
  const child = spawn(invocation.command, [...invocation.args], { detached: true, stdio: "ignore", env: { ...process.env, AGENT_SHIM_HOME: paths.root } });
  child.unref();
}

/**
 * The spawn options every background daemon agent-shim starts shares. `detached: true` puts the child in a new session with no controlling terminal, so closing the terminal a launch started from (SIGHUP to that terminal's session) never reaches it: a second session still using the daemon keeps working after the first one's terminal is gone. Standard input is closed and both output streams go to the daemon's log file.
 */
export function detachedDaemonSpawnOptions(logFd: number, env: NodeJS.ProcessEnv): { readonly detached: true; readonly stdio: ["ignore", number, number]; readonly env: NodeJS.ProcessEnv } {
  return { detached: true, stdio: ["ignore", logFd, logFd], env };
}

/**
 * Spawns a detached supervisor: a background copy of this very executable running a hidden internal subcommand, its output appended to `logPath`, unref'd so the launcher never waits on it. `AGENT_SHIM_HOME` is passed explicitly so the supervisor lands on the same root as its spawner even when the launcher was started with the variable set only for itself.
 */
export function spawnDetachedSupervisor(paths: LayoutPaths, subcommand: string, logPath: string): number {
  return spawnDetachedDaemon(selfInvocation([subcommand]), paths, subcommand, logPath);
}

/** Starts a background daemon: `paths`, `subcommand` and `logPath` as for `spawnDetachedSupervisor`, which a caller that is not the agent-shim command line process supplies in place of it. */
export type DaemonSpawner = (paths: LayoutPaths, subcommand: string, logPath: string) => number;

/** A `DaemonSpawner` that starts daemons through the agent-shim executable at `executable`, for a caller (a library host) whose own process is not it. */
export function spawnDaemonThrough(executable: string): DaemonSpawner {
  return (paths, subcommand, logPath) => spawnDetachedDaemon({ command: executable, args: [subcommand] }, paths, subcommand, logPath);
}

/** A `DaemonSpawner` that starts daemons by running the JavaScript bundle at `script` (the package's `dist/cli.cjs`) with the Node that is running this process, for a library host that did not name an executable. */
export function spawnDaemonThroughScript(script: string): DaemonSpawner {
  return (paths, subcommand, logPath) => spawnDetachedDaemon({ command: process.execPath, args: [script, subcommand] }, paths, subcommand, logPath);
}

function spawnDetachedDaemon(invocation: { readonly command: string; readonly args: readonly string[] }, paths: LayoutPaths, subcommand: string, logPath: string): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  try {
    const child = spawn(invocation.command, invocation.args, detachedDaemonSpawnOptions(logFd, { ...process.env, AGENT_SHIM_HOME: paths.root }));
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`spawning ${subcommand} returned no pid`);
    }
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}

/** The headroom supervisor's hidden subcommand and where it logs, shared by every `DaemonSpawner` a headroom launch uses. */
function spawnHeadroomSupervisor(paths: LayoutPaths, spawnDaemon: DaemonSpawner): number {
  return spawnDaemon(paths, "__headroom-supervisor", paths.headroomLogPath);
}

/** The permission bits of a stat's mode, without its file type bits, as the headroom socket checks compare them. */
const SOCKET_PERMISSION_BITS = 0o777;

/**
 * The real `HeadroomSocketTrustPorts`: this process's platform and user id, and an `lstat` that never follows symlinks, so a symlinked socket or socket directory is seen as the symlink it is and refused.
 */
export const realHeadroomSocketTrust: HeadroomSocketTrustPorts = {
  platform: process.platform,
  currentUid: () => {
    if (process.getuid === undefined) {
      throw new Error(`no POSIX user id on ${process.platform}`);
    }
    return process.getuid();
  },
  lstat: (target) => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
    const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isSocket() ? "socket" : "other";
    return { kind, uid: stat.uid, mode: stat.mode & SOCKET_PERMISSION_BITS };
  },
};

/**
 * The real `HeadroomPort` for one launch: `ensure` runs the lock-and-poll coordination against the real filesystem and process table and derives the per-project identity from the real git repository containing the working directory; `release` removes this launcher's session-registry entry.
 */
export function realHeadroomPort(paths: LayoutPaths, options: { readonly spawnDaemon: DaemonSpawner; readonly cwd: string }): HeadroomPort {
  return {
    ensure: ({ routesProvider }) => {
      const up = ensureHeadroom({
        paths,
        launcherPid: process.pid,
        ...(routesProvider ? { requiredAllowlistHash: () => hashAllowlist(currentHeadroomAllowlist(realFarmFs, paths)) } : {}),
        ports: {
          fs: realFarmFs,
          // Zombie-aware on purpose: a supervisor that died while still a child of this launcher sits unreaped until the launcher itself exits, and a defunct supervisor answering signal 0 as alive would stretch every launch to the full start timeout.
          isRunning: realIsProcessRunning,
          now: () => Date.now(),
          sleep: realSleepSync,
          spawnSupervisor: (layout) => spawnHeadroomSupervisor(layout, options.spawnDaemon),
        },
      });
      return {
        socketPath: up.socketPath,
        projectId: resolveGitRoot(realRunPort, options.cwd) ?? options.cwd,
      };
    },
    release: () => {
      removeSession(realFarmFs, paths.headroomSessionsDir, process.pid);
    },
  };
}

/** The real `SpawnPort`, backed by `node:child_process`'s `spawnSync` — the Node equivalent of the legacy bash tool's `exec`. */
export const realSpawnPort: SpawnPort = {
  spawnSync(command, args, options) {
    const result = spawnSync(command, args, options);
    return { status: result.status, signal: result.signal, ...(result.error === undefined ? {} : { error: result.error }) };
  },
};

/** The real `ProcPort`, reading the actual process environment and logical CLI argv (`process.argv.slice(2)`). */
export const realProcPort: ProcPort = {
  env: process.env,
  argv: process.argv.slice(2),
  exit: (code: number): never => process.exit(code),
};

/** The real `LogPort`, writing info/warn to stdout and errors to stderr. */
export const realLogPort: LogPort = {
  info: (message: string) => { console.log(message); },
  warn: (message: string) => { console.warn(message); },
  error: (message: string) => { console.error(message); },
};

// The owner/group/other execute bits (0b001 repeated in each of the three permission triads) -- a nonzero result means at least one of the three "may execute" bits is set.
const EXECUTE_BITS_MASK = 0o111;

function listVersionsDir(dir: string): VersionsDirEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        isFile: true,
        isExecutable: (stat.mode & EXECUTE_BITS_MASK) !== 0,
        sizeBytes: stat.size,
      };
    });
}

/** Node's own docs are explicit that `fs.Stats.mode` on Windows only ever exposes the owner read/write bits — there is no execute bit at all there, since Windows has no POSIX-style per-file executable permission; executability is determined by file extension instead (the same PATHEXT mechanism a shell uses to resolve a bare command name). Falls back to a fixed default list matching Windows' own documented default in case `PATHEXT` is unset. */
const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1";

function windowsPathExtensions(pathext: string | undefined): readonly string[] {
  return (pathext ?? WINDOWS_DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
}

/**
 * The pure decision logic behind `findExecutableInDir`, taking `platform`/`pathext`/the mode-stat as explicit parameters so it's unit-testable against fake Windows/POSIX environments without touching real process globals or a real filesystem — this is exactly the kind of platform-dependent logic that's easy to get subtly wrong (confirmed: it was, twice, across two failed release attempts before this was extracted and actually tested).
 *
 * `statFileMode` returns the file's POSIX mode bits if `candidate` exists as a regular file, or `undefined` otherwise (ENOENT collapsed to `undefined`, every other error still propagated by the real implementation).
 *
 * On Windows, this can't rely on `fs.Stats.mode`'s execute bits at all (see the comment above `windowsPathExtensions`), so it instead mirrors what a real shell does resolving a bare command name: try `name` as given if it already carries a recognised extension (e.g. a `.exe` filename passed in explicitly, as `resolveOwnExecutablePath`'s Scoop-shim redirect does), otherwise try appending each `PATHEXT` extension in turn and return the first that exists as a file. Everywhere else, a file counts as executable only when its POSIX mode bits actually say so.
 */
export function resolveExecutableCandidate(
  dir: string,
  name: string,
  env: {
    readonly platform: string;
    readonly pathext: string | undefined;
    readonly statFileMode: (candidate: string) => number | undefined;
  },
): string | undefined {
  const candidate = path.join(dir, name);

  if (env.platform === "win32") {
    const extensions = windowsPathExtensions(env.pathext);
    const alreadyHasRecognisedExtension = extensions.some((ext) => candidate.toLowerCase().endsWith(ext.toLowerCase()));
    if (alreadyHasRecognisedExtension) {
      return env.statFileMode(candidate) !== undefined ? candidate : undefined;
    }
    for (const ext of extensions) {
      const withExt = candidate + ext;
      if (env.statFileMode(withExt) !== undefined) {
        return withExt;
      }
    }
    return undefined;
  }

  const mode = env.statFileMode(candidate);
  return mode !== undefined && (mode & EXECUTE_BITS_MASK) !== 0 ? candidate : undefined;
}

function realStatFileMode(candidate: string): number | undefined {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() ? stat.mode : undefined;
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Looks for a file literally named `name` inside `dir` and confirms it's runnable. Exported so `src/claudeShim.ts`'s PATH-shadow and shim-redirect checks can reuse the exact same semantics `discoverClaudeBinary`'s own PATH fallback already uses, rather than shelling out to a shell builtin like `command -v`. Real-wired convenience over `resolveExecutableCandidate` — see that function for the actual decision logic and its own tests. */
export function findExecutableInDir(dir: string, name: string): string | undefined {
  return resolveExecutableCandidate(dir, name, {
    platform: process.platform,
    pathext: process.env.PATHEXT,
    statFileMode: realStatFileMode,
  });
}

function searchPathForExecutable(
  pathDirs: readonly string[],
  name: string,
  findExecutable: (dir: string, name: string) => string | undefined,
): string | undefined {
  for (const dir of pathDirs) {
    const found = findExecutable(dir, name);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Resolves the absolute path to the currently-running agent-shim/claude executable from the raw process/env facts a call site would otherwise read directly off `process` — passed explicitly so this is unit-testable without touching real process globals.
 *
 * This exists because `process.argv[1]` is not a reliable "path to my own executable" for a Node single-executable-application (SEA) binary the way it is for an ordinary Node script. Per Node's own SEA documentation, a SEA binary's `argv[1]` merely echoes back whatever string appeared on the command line — verbatim, with no path or PATH resolution applied by Node or the OS — whereas a shebang-invoked script (the npm/plain-Node case) genuinely receives its resolved script path there, because the kernel's shebang handling substitutes the shell's already-PATH-resolved pathname before Node ever starts. Concretely: typing the bare word `agent-shim` at a shell prompt produces `argv[1] === "agent-shim"` for a SEA binary (no directory component at all), which previously got fed straight into `fs.realpathSync`/`path.dirname` as if it were a real path — resolving relative to `process.cwd()` instead of wherever PATH actually found the binary, and throwing ENOENT the moment cwd didn't happen to contain a same-named file. Confirmed via a minimal instrumented SEA binary reproducing exactly this, and matching the exact failure every release verification job hit once invoking `agent-shim`/`claude` as a bare PATH-resolved command rather than by absolute path.
 *
 * A second, separate wrinkle: some install channels invoke this binary through a re-exec wrapper rather than running it directly. Scoop's own shim (`~/scoop/shims/agent-shim.exe`) is a compiled proxy (confirmed from its source: https://github.com/ScoopInstaller/Shim/blob/main/cs/shim.cs) that calls `CreateProcessW(null, cmd, ...)` with the real target's absolute path as the first token of `cmd` — per the Win32 `CreateProcess` contract, passing `lpApplicationName = null` means that first token becomes both the module launched *and* what the child receives as its own command line — so this process ends up seeing the real target's absolute path, living in a versioned app directory Scoop deliberately keeps off PATH, not the shim's own PATH-visible location. Placing the new `claude` alongside that path (as the Homebrew/direct-invocation case correctly does) would create a file PATH can never find. Confirmed against a real Scoop install: `agent-shim shim enable` placed `claude.exe` next to the real target in the app directory, and the immediately following `claude --version` failed with "not recognized" because that directory was never on PATH.
 *
 * The redirect-if-not-on-PATH check below applies uniformly to whichever candidate we end up with — whether derived from a path-shaped `argv1`, or from the `execPath` fallback (`argv1` undefined) — since it's unconfirmed whether a Windows SEA binary duplicates `argv[0]` into `argv[1]` the same way the POSIX build does; treating both sources identically is strictly more robust either way and regresses nothing already confirmed working.
 *
 * The algorithm: if the raw candidate is a bare word with no path separator, it can only have been found via PATH lookup in the first place (Node/the OS applies no resolution to it at all), so search PATH ourselves for the first directory containing an executable of that name, reconstructing exactly what the shell already did. Otherwise, resolve it (or the `execPath` fallback) against cwd, then check whether the *resulting directory* is itself on PATH: if so, use it directly (the Homebrew/direct-invocation case — never realpath'd, since a package manager's PATH-visible entry is often a symlink elsewhere, e.g. Homebrew's `/opt/homebrew/bin/agent-shim` pointing at its own Cellar keg, and callers need that PATH-visible location, not the dereferenced target). If that directory is *not* on PATH (the Scoop re-exec case above), search PATH for a separately-installed entry sharing our own invoked basename before falling back to the direct candidate.
 */
export function resolveOwnExecutablePath(env: {
  readonly argv1: string | undefined;
  readonly execPath: string;
  readonly cwd: string;
  readonly pathDirs: readonly string[];
  readonly findExecutableInDir: (dir: string, name: string) => string | undefined;
}): string {
  if (env.argv1 !== undefined && !env.argv1.includes("/") && !env.argv1.includes("\\")) {
    return searchPathForExecutable(env.pathDirs, env.argv1, env.findExecutableInDir) ?? env.execPath;
  }

  const candidate = env.argv1 === undefined ? env.execPath : path.resolve(env.cwd, env.argv1);
  const candidateDir = path.dirname(candidate);
  const candidateDirOnPath = env.pathDirs.some((dir) => path.resolve(dir) === candidateDir);
  if (candidateDirOnPath) {
    return candidate;
  }

  const viaPath = searchPathForExecutable(env.pathDirs, path.basename(candidate), env.findExecutableInDir);
  return viaPath ?? candidate;
}

/** Real-wired convenience over `resolveOwnExecutablePath`, reading the actual process globals — this is what every real call site (`cli.ts`, `doctor.ts`, `claudeShim.ts`'s command wiring) should use instead of reading `process.argv[1]`/`process.execPath` directly. */
export function realOwnExecutablePath(): string {
  return resolveOwnExecutablePath({
    argv1: process.argv[1],
    execPath: process.execPath,
    cwd: process.cwd(),
    pathDirs: (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== ""),
    findExecutableInDir,
  });
}

/**
 * Resolves the path to the actual file whose *content* is this running process — never a PATH-visible location, which can differ from the real content entirely (Scoop's own shim, a compiled proxy binary, sits at the PATH-visible location while the genuine agent-shim binary lives elsewhere; see `resolveOwnExecutablePath`'s own doc comment for the full mechanism). This is what `enableClaudeShim`/`disableClaudeShim` must hardlink/copy from and compare inodes against — using `resolveOwnExecutablePath`'s redirected PATH-visible location for this would hardlink Scoop's generic shim proxy itself, not agent-shim's real content, which is exactly the bug this function exists to avoid (confirmed against a real Scoop install: `shim enable` correctly placed `claude.exe` in `shims/`, but invoking it failed with Scoop's own "Cannot open shim file for read" error, because the hardlink's source was Scoop's proxy, paired via a `.shim` config file keyed to its *original* filename).
 *
 * `node:sea`'s `isSea()` is the correct, documented way to distinguish the two operating modes this tool ships in, rather than inferring it from `argv1`'s shape: for a single-executable-application build, `process.execPath` is always the real, fully-resolved running binary (confirmed: Windows `CreateProcess` with `lpApplicationName = null` still resolves to the genuine target file, the same one `execPath` reports, regardless of Scoop's separate PATH-visible proxy). For a plain Node script (the npm-published bundle), `execPath` would instead point at the Node interpreter itself — useless — so `argv1` (the shebang-resolved script path, reliable in this mode) is used instead.
 */
export function resolveContentSourcePath(env: { readonly isSea: boolean; readonly execPath: string; readonly argv1: string | undefined }): string {
  return env.isSea ? env.execPath : (env.argv1 ?? env.execPath);
}

/** Real-wired convenience over `resolveContentSourcePath`. */
export function realContentSourcePath(): string {
  return resolveContentSourcePath({ isSea: isSea(), execPath: process.execPath, argv1: process.argv[1] });
}

/** Builds the real `resolveClaudeBinary` callback `runLauncher` needs: scans the real versions directory, then falls back to a real PATH search, never returning this tool's own binary (see `resolveOwnBinaryCheck`, which builds that check from the shim marker and the running executable's own content). */
export function realResolveClaudeBinary(isOwnBinary: (candidate: string) => boolean): ClaudeBinaryResolver {
  return (request) =>
    discoverClaudeBinary({
      listVersionsDir,
      pathDirs: (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== ""),
      findExecutableInDir,
      isOwnBinary,
      ...(request?.version === undefined ? {} : { version: request.version }),
    });
}

/** The Claude Code versions installed in the real versions directory, oldest first: what `check` and `doctor` compare a pin against. */
export function realInstalledClaudeVersions(): readonly string[] {
  return installedVersions(listVersionsDir(defaultVersionsDir()));
}

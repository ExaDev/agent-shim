import type { ConfigFileReader } from "../config/load";

/**
 * Filesystem operations the launcher needs, injected so no test in this project ever touches a real filesystem — consistent with the resolver core's own injected-facts approach in `src/resolve/types.ts`.
 */
export interface FsPort {
  /** Reads a file's contents as UTF-8 text, or returns undefined when it does not exist. Used for plain-text files like the persisted active-identity file. */
  readonly readFileUtf8: (filePath: string) => string | undefined;
  /** Reads and parses a config file (JSON/YAML/JS via cosmiconfig in the real implementation), returning undefined when it does not exist. Mirrors `src/config/load.ts`'s own injected reader shape so `loadIdentity` can compose directly with `loadConfigFile`. */
  readonly readConfigFile: ConfigFileReader;
  /** Lists one directory's immediate child names, or an empty list when it does not exist. Used to name the known providers in an unknown-provider refusal. */
  readonly readdir: (dir: string) => readonly string[];
}

/** What one node of a tree is, as reported by an `lstat` that never follows symlinks. */
type FarmNodeKind = "dir" | "file" | "symlink";

/** The subset of stat information the farm builder and the fact builder actually read. */
export interface FarmStat {
  readonly kind: FarmNodeKind;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

/**
 * Every filesystem operation the farm resync performs, injected so the whole of `src/launcher/farm.ts` — symlink creation, materialisation, adoption copies, and the atomic swap itself — runs against an in-memory fake in tests and never against a real `~/.claude` or `~/.claude-use`.
 *
 * `lstat` never follows symlinks: a `~/.claude` that contains a directory symlink escaping the tree (a skills directory linked out to a separate dotfiles repository, say) must be recorded as one symlink entry rather than recursed into, both to keep the fact manifest finite and because the farm links such an entry at `<claudeHome>/<rel>` and lets the OS resolve the remaining hops.
 */
export interface FarmFs {
  /** Stats one path without following symlinks, or returns undefined when nothing is there. */
  readonly lstat: (path: string) => FarmStat | undefined;
  /** Lists one directory's immediate child names, or an empty list when it does not exist. */
  readonly readdir: (path: string) => readonly string[];
  /** Creates a directory and any missing parents, succeeding silently when it already exists. */
  readonly mkdirp: (path: string) => void;
  /** Creates a symbolic link at `linkPath` pointing at `target`. */
  readonly symlink: (target: string, linkPath: string) => void;
  /** Renames `from` to `to`. Both are always within one directory tree on one filesystem in this module's own usage, so this is the atomic primitive the farm swap is built on. */
  readonly rename: (from: string, to: string) => void;
  /** Removes a path and everything beneath it, succeeding silently when it does not exist. */
  readonly removeRecursive: (path: string) => void;
  /** Copies a file, symlink, or whole directory tree from `from` to `to`. */
  readonly copyRecursive: (from: string, to: string) => void;
  /** Reads a file's contents as UTF-8 text, or undefined when it does not exist. */
  readonly readFileUtf8: (path: string) => string | undefined;
  /** Writes a file's full contents as UTF-8 text, creating or truncating it. */
  readonly writeFileUtf8: (path: string, contents: string) => void;
  /** Creates a file only if it does not already exist, returning false when it does. This is the exclusive-create the identity lock depends on for its mutual exclusion — a read-then-write pair would race. */
  readonly writeFileExclusive: (path: string, contents: string) => boolean;
  /** A stable content hash of one file, or undefined when it is missing or is not a regular file. Used only to recognise farm data that has already been adopted into the canonical tree. */
  readonly hashFile: (path: string) => string | undefined;
}

/** The outcome of one `spawnSync` call, mirroring Node's own `SpawnSyncReturns` shape narrowly to what the launcher actually reads. */
export interface SpawnResult {
  /** The child's exit code, or null when it was terminated by a signal instead of exiting normally. */
  readonly status: number | null;
  /** The signal that terminated the child, or null when it exited normally. */
  readonly signal: NodeJS.Signals | null;
  /** Set when the child process could not even be spawned (e.g. the binary does not exist). */
  readonly error?: Error;
}

/** Runs the real `claude` binary synchronously, injected so no test ever spawns a real process. The Node equivalent of the legacy bash tool's `exec` is `spawnSync` with `stdio: "inherit"` followed by propagating the child's own exit code — see `src/launcher/spawn.ts`. */
export interface SpawnPort {
  readonly spawnSync: (
    command: string,
    args: readonly string[],
    options: { readonly stdio: "inherit"; readonly env: Readonly<Record<string, string | undefined>> },
  ) => SpawnResult;
}

/** The outcome of one synchronous external-command run (distinct from `SpawnPort`, which is specifically for replacing this process with the real `claude` binary — `RunPort` is for auxiliary commands like `git rev-parse` for branch detection, or `security find-generic-password` for the macOS Keychain diagnostic in `check.ts`, whose output this process needs to keep running and read). */
interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs an external command and captures its output, injected so no test ever shells out for real. Not used by this phase's own modules yet — declared here so every later module (branch-conditioned `when` evaluation, `check.ts`'s Keychain lookup) shares one injectable shape rather than each inventing its own. */
export interface RunPort {
  readonly run: (command: string, args: readonly string[]) => RunResult;
}

/**
 * The running process itself: its environment, its logical argv, and the ability to terminate with an exit code.
 *
 * `argv` is the *logical* CLI arguments only — whatever the user typed after `claude`/`claude-use`, already stripped of the Node executable path and the script path (`process.argv.slice(2)` in the real implementation). `exit` mirrors `process.exit`'s own `never` return type: a real process never returns from it, and a test fake enforces the same shape by throwing a marker so control flow unwinds the same way in both cases.
 */
export interface ProcPort {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly exit: (code: number) => never;
}

/** Where the launcher reports what it decided and why — refusals, warnings about an identity that could not be loaded, and (per the "strictly-better than the legacy script" goal) which identity/profile ended up selected. */
export interface LogPort {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
}

/** The running headroom daemon one launch routed through, as `HeadroomPort.ensure` reports it. */
export interface HeadroomUp {
  /** The loopback port the local headroom proxy listens on. */
  readonly port: number;
  /** The project identity headroom scopes memory state to: the git repo root of the launch directory, or the directory itself outside a repository. */
  readonly projectId: string;
}

/**
 * Everything the launcher needs from the headroom daemon, injected so its daemon-supervision side effects stay behind a port and the launcher's own logic stays pure over it (`src/realPorts.ts` wires the real one; tests wire fakes).
 *
 * `ensure` brings the daemon up (spawning the detached supervisor when nothing healthy is running) and registers this launch in its session registry; `release` removes that registration when the spawned `claude` exits.
 */
export interface HeadroomPort {
  readonly ensure: () => HeadroomUp;
  readonly release: () => void;
}

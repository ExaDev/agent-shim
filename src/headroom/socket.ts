import path from "node:path";

import type { LayoutPaths } from "../paths";
import type { HeadroomFs } from "./state";

/**
 * Mode of the directory holding the daemon's unix socket: only its owner may enter it. Headroom creates the socket itself (mode 0600) but never creates or narrows its parent, so this directory is what authenticates the door-to-headroom hop: a process running as another user cannot connect to, replace or squat on a socket it cannot reach.
 */
export const HEADROOM_SOCKET_DIR_MODE = 0o700;

/** The group and other permission bits: any of them set on the socket or its directory means someone other than the owner can reach the daemon, and the hop refuses it. */
const GROUP_OR_OTHER_BITS = 0o077;

/** Permission modes are read in octal. */
const OCTAL_RADIX = 8;

/** Digits a permission mode is printed with (`0755`), the way `chmod` and `ls` users read it. */
const MODE_DIGITS = 4;

/** The suffix of every daemon socket under the socket directory, after the owning supervisor's pid. */
const HEADROOM_SOCKET_SUFFIX = ".sock";

/** Matches a socket name this layout produces, capturing the owning supervisor's pid. */
const HEADROOM_SOCKET_NAME = /^(\d+)\.sock$/;

/**
 * The longest socket path, in bytes, every platform agent-shim runs headroom on can bind: `sockaddr_un.sun_path` is 104 bytes on macOS and the BSDs (108 on Linux), and the path is stored NUL-terminated, so 103 bytes is the portable maximum. A longer path fails inside headroom's bind with an error the supervisor would only see as a daemon that never became ready, so it is refused up front with the reason.
 */
export const UNIX_SOCKET_PATH_MAX_BYTES = 103;

/**
 * Platforms where headroom cannot serve on a unix socket: Python's asyncio has no unix-socket server on Windows, so `headroom proxy --uds` cannot start there. Headroom routing is refused on these platforms rather than falling back to a TCP port, since a TCP port is exactly the unauthenticated hop the socket replaces.
 */
const PLATFORMS_WITHOUT_UNIX_SOCKETS: readonly string[] = ["win32"];

/** What an `lstat` (which never follows symlinks) reports about one path, narrowed to what authenticating the socket needs. */
export interface SocketPathStat {
  readonly kind: "dir" | "file" | "socket" | "symlink" | "other";
  /** The owning user id. */
  readonly uid: number;
  /** The permission bits, without the file type bits. */
  readonly mode: number;
}

/** The platform facts and the one filesystem call the socket checks need, injected so every refusal is unit-testable without a real socket, directory or second user. */
export interface HeadroomSocketTrustPorts {
  /** `process.platform` in the real implementation. */
  readonly platform: string;
  /** This process's user id. Only called on a platform with unix sockets, which all have POSIX user ids. */
  readonly currentUid: () => number;
  /** Stats one path without following symlinks, or returns undefined when nothing is there. */
  readonly lstat: (target: string) => SocketPathStat | undefined;
  /** The target a symlink holds, as written: how the allowlist file's path is resolved through a symlinked ancestor. */
  readonly readlink: (target: string) => string;
}

/** Either a socket path the hop may dial, or the reason it must not: the two never appear together. */
export type HeadroomSocketTarget = { readonly socketPath: string; readonly refused?: never } | { readonly refused: string; readonly socketPath?: never };

/** The socket one supervisor generation's daemon serves on: named by the supervisor's pid, so two supervisors alive at once (a superseded one draining its sessions beside its replacement) never contend for one path. */
export function headroomSocketPath(paths: LayoutPaths, supervisorPid: number): string {
  return path.join(paths.headroomSocketDir, `${String(supervisorPid)}${HEADROOM_SOCKET_SUFFIX}`);
}

/** Why headroom cannot serve on a unix socket on `platform`, or undefined when it can. */
function platformRefusal(platform: string): string | undefined {
  return PLATFORMS_WITHOUT_UNIX_SOCKETS.includes(platform)
    ? `headroom routing needs a unix domain socket, which headroom cannot serve on ${platform}; agent-shim never falls back to a TCP port for this hop`
    : undefined;
}

/** How a refusal names each kind a path is expected to be. */
const KIND_NAMES: Readonly<Record<"dir" | "file" | "socket", string>> = { dir: "directory", file: "file", socket: "socket" };

/** Why one stat fails the owner-only test (wrong kind, a symlink, another owner, or group or other access), or undefined when it passes. */
function ownerOnlyRefusal(label: string, target: string, stat: SocketPathStat | undefined, expected: "dir" | "file" | "socket", uid: number): string | undefined {
  if (stat === undefined) {
    return `the headroom ${label} ${target} does not exist`;
  }
  if (stat.kind === "symlink") {
    return `the headroom ${label} ${target} is a symlink; it must be the real ${KIND_NAMES[expected]}`;
  }
  if (stat.kind !== expected) {
    return `the headroom ${label} ${target} is not a ${KIND_NAMES[expected]}`;
  }
  if (stat.uid !== uid) {
    return `the headroom ${label} ${target} is owned by uid ${String(stat.uid)}, not by this user (uid ${String(uid)})`;
  }
  if ((stat.mode & GROUP_OR_OTHER_BITS) !== 0) {
    return `the headroom ${label} ${target} has mode ${stat.mode.toString(OCTAL_RADIX).padStart(MODE_DIGITS, "0")}, which lets other users reach it; it must be accessible to its owner only`;
  }
  return undefined;
}

/**
 * Authenticates the daemon's socket before the door sends it anything: the platform must have unix sockets, and both the socket's directory and the socket itself must be the real thing (never a symlink), owned by this user, with no group or other access. Ownership is the whole authentication: only this user can create a socket inside a directory only this user can enter, so a socket that passes was put there by this user's own daemon.
 */
export function verifyHeadroomSocket(socketPath: string, ports: HeadroomSocketTrustPorts): HeadroomSocketTarget {
  const unsupported = platformRefusal(ports.platform);
  if (unsupported !== undefined) {
    return { refused: unsupported };
  }
  const uid = ports.currentUid();
  const directory = path.dirname(socketPath);
  const refusal =
    ownerOnlyRefusal("socket directory", directory, ports.lstat(directory), "dir", uid) ?? ownerOnlyRefusal("socket", socketPath, ports.lstat(socketPath), "socket", uid);
  return refusal === undefined ? { socketPath } : { refused: refusal };
}

/** How the allowlist file fails the rules it is held to: what is wrong, and whether the supervisor can repair it (only what lies in agent-shim's own directories can be). */
export interface AllowlistFileProblem {
  readonly message: string;
  readonly repairable: boolean;
}

/** The most symlinks followed while resolving the allowlist file's path, headroom's own bound (Linux's MAXSYMLINKS, the larger of the common kernels' limits). */
const MAX_SYMLINK_HOPS = 40;

/** The uid that owns everything it likes anyway, so trusting it adds no one. */
const ROOT_UID = 0;

/** The write bits for group and others. */
const GROUP_OR_OTHER_WRITE_BITS = 0o022;
/** The sticky bit (`S_ISVTX`): a directory carrying it is shared on purpose, so narrowing it would break everything else that uses it. */
const STICKY_BIT = 0o1000;

/**
 * Every directory resolving the absolute `target` passes through, from `/` down, each once, the way headroom's guard walks it: one entry at a time, following a symlink met on the way (with a relative target taken from the link's own directory) and recording the directory holding each entry looked up. A symlink at the final entry is not followed: agent-shim's own rule refuses a symlinked allowlist file before its target matters. Returns a reason instead when the symlinks go deeper than headroom follows.
 */
function pathDirectories(target: string, ports: HeadroomSocketTrustPorts): readonly string[] | string {
  const pending = target.split("/").reverse();
  let current = "/";
  const directories: string[] = [];
  let hops = 0;
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (name === "" || name === ".") {
      continue;
    }
    if (name === "..") {
      // `current` is symlink-free, so its lexical parent is its real one.
      current = path.dirname(current);
      continue;
    }
    if (!directories.includes(current)) {
      directories.push(current);
    }
    const entry = path.join(current, name);
    if (pending.length > 0 && ports.lstat(entry)?.kind === "symlink") {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        return `the symlinks on the allowlist file's path go more than ${String(MAX_SYMLINK_HOPS)} deep`;
      }
      const linkTarget = ports.readlink(entry);
      if (path.isAbsolute(linkTarget)) {
        current = "/";
      }
      pending.push(...linkTarget.split("/").reverse());
    } else if (pending.length > 0) {
      current = entry;
    }
  }
  return directories;
}

/** The remedy for a directory above the agent-shim root that is not this user's to change. */
const MOVE_ROOT_REMEDY = "move the agent-shim root (AGENT_SHIM_HOME) to where every directory above it is owned by this user or root and not writable by group or others";

/**
 * Why headroom refuses the allowlist file over one directory on its path, or undefined when the directory passes headroom's rule: owned by this user or root, not writable by group or others, the sticky bit being no exception (mode bits only; access control lists are not judged). `remedy` says what fixes it for a directory agent-shim does not own and so cannot repair: narrowing it when this user owns it and it is not sticky, else moving the root, as headroom's own refusal advises; agent-shim's own directory needs none, since the supervisor repairs it.
 */
function headroomDirectoryRefusal(directory: string, stat: SocketPathStat | undefined, uid: number, remedy: boolean): string | undefined {
  // As headroom advises: only a directory this user owns and that is not sticky is theirs to narrow; a sticky shared one such as /tmp, root's or another user's must not be, so the root moves instead.
  if (stat?.kind !== "dir") {
    return `the directory ${directory} on the allowlist file's path is ${stat === undefined ? "missing" : "not a directory"}, so headroom refuses the file`;
  }
  if (stat.uid !== uid && stat.uid !== ROOT_UID) {
    return `the directory ${directory} on the allowlist file's path is owned by uid ${String(stat.uid)}, not by this user (uid ${String(uid)}) or root, so headroom refuses the file${remedy ? `; ${MOVE_ROOT_REMEDY}` : ""}`;
  }
  if ((stat.mode & GROUP_OR_OTHER_WRITE_BITS) !== 0) {
    return `the directory ${directory} on the allowlist file's path is writable by group or others (mode ${stat.mode.toString(OCTAL_RADIX).padStart(MODE_DIGITS, "0")}), so headroom refuses the file${remedy ? `; ${stat.uid === uid && (stat.mode & STICKY_BIT) === 0 ? `run \`chmod go-w ${directory}\`` : MOVE_ROOT_REMEDY}` : ""}`;
  }
  return undefined;
}

/**
 * How the allowlist file at `allowlistFile` fails the rules it is held to, or undefined when it keeps them. Headroom's guard refuses the file, and then admits nothing, unless every directory its path resolves through, from `/` down, is owned by its user or root and not writable by group or others (the sticky bit is no exception, and only mode bits are judged), and the file itself is owned by its user or root and not writable by group or others. Every directory on the path is judged here by that same rule, so a group-writable home directory or a shared `/tmp` above the agent-shim root is reported, as not repairable: those directories are not agent-shim's to change, and the message names the directory, its mode and the remedy. The two directories agent-shim owns on the path are its to repair: its parent, the headroom directory, by headroom's rule, and the allowlist file's own directory (the socket directory) and the file itself by agent-shim's stricter owner-only rule (the real thing, no symlink, owned by this user, no group or other access at all); of these, only something other than a file at the file's path is not repairable.
 */
/**
 * The allowlist file problem `headroom status` and `doctor` report, or undefined when there is none worth reporting. A directory headroom refuses the file over that agent-shim cannot repair is reported whether or not a daemon has served the file, since every supervisor stops over it before serving; a break agent-shim repairs is reported only once a daemon has served the file (`served`), since until then the next supervisor repairs it before serving, and a root where headroom has not yet run lacks its directories and file by design.
 */
export function reportableAllowlistFileProblem(allowlistFile: string, ports: HeadroomSocketTrustPorts, served: boolean): AllowlistFileProblem | undefined {
  const problem = verifyAllowlistFile(allowlistFile, ports);
  return problem?.repairable === false || served ? problem : undefined;
}

export function verifyAllowlistFile(allowlistFile: string, ports: HeadroomSocketTrustPorts): AllowlistFileProblem | undefined {
  const uid = ports.currentUid();
  const directories = pathDirectories(allowlistFile, ports);
  if (typeof directories === "string") {
    return { message: directories, repairable: false };
  }
  // The resolved directory holding the file (the socket directory) and its parent (the headroom directory): agent-shim's own, which the supervisor repairs.
  const socketDirectory = directories.at(-1);
  const headroomDirectory = socketDirectory === undefined ? undefined : path.dirname(socketDirectory);
  for (const directory of directories) {
    const stat = ports.lstat(directory);
    if (directory === socketDirectory) {
      const refusal = ownerOnlyRefusal("allowlist directory", directory, stat, "dir", uid);
      if (refusal !== undefined) {
        return { message: refusal, repairable: true };
      }
      continue;
    }
    const own = directory === headroomDirectory;
    const refusal = headroomDirectoryRefusal(directory, stat, uid, !own);
    if (refusal !== undefined) {
      return { message: refusal, repairable: own };
    }
  }
  const fileStat = ports.lstat(allowlistFile);
  const refusal = ownerOnlyRefusal("allowlist file", allowlistFile, fileStat, "file", uid);
  if (refusal === undefined) {
    return undefined;
  }
  // A rewrite renames a file into place, which replaces a symlink or another user's file but not a directory or other kind of entry.
  const replaceable = fileStat === undefined || fileStat.kind === "file" || fileStat.kind === "symlink";
  return { message: refusal, repairable: replaceable };
}

/**
 * Prepares the socket one supervisor generation will start its daemon on, returning its path or the reason headroom cannot be served here. The directory is created mode 0700 (and narrowed when it already existed wider, which only its owner can do), then checked exactly as the door checks it, so a directory the door would refuse is refused before any daemon starts. A symlink at the directory's path is refused before anything is created, since creating or narrowing through it would act on whatever it points at.
 */
export function prepareHeadroomSocket(fs: Pick<HeadroomFs, "mkdirPrivate">, ports: HeadroomSocketTrustPorts, paths: LayoutPaths, supervisorPid: number): HeadroomSocketTarget {
  const unsupported = platformRefusal(ports.platform);
  if (unsupported !== undefined) {
    return { refused: unsupported };
  }
  const socketPath = headroomSocketPath(paths, supervisorPid);
  const length = Buffer.byteLength(socketPath, "utf8");
  if (length > UNIX_SOCKET_PATH_MAX_BYTES) {
    return {
      refused: `the headroom socket path ${socketPath} is ${String(length)} bytes, longer than the ${String(UNIX_SOCKET_PATH_MAX_BYTES)} a unix socket path can hold; set AGENT_SHIM_HOME to a shorter directory`,
    };
  }
  if (ports.lstat(paths.headroomSocketDir)?.kind === "symlink") {
    return { refused: `the headroom socket directory ${paths.headroomSocketDir} is a symlink; it must be the real directory` };
  }
  fs.mkdirPrivate(paths.headroomSocketDir);
  const refusal = ownerOnlyRefusal("socket directory", paths.headroomSocketDir, ports.lstat(paths.headroomSocketDir), "dir", ports.currentUid());
  return refusal === undefined ? { socketPath } : { refused: refusal };
}

/**
 * Removes the sockets of supervisor generations that are no longer running. Headroom removes its socket on a clean shutdown, but a daemon stopped by SIGKILL (the escalation a stuck proxy gets) leaves its socket behind, and nothing else would ever clear it. A running supervisor's socket, this one's included, is left alone; anything not named by this layout is not this function's to touch.
 */
export function pruneStaleHeadroomSockets(fs: Pick<HeadroomFs, "readdir" | "removeRecursive">, paths: LayoutPaths, isRunning: (pid: number) => boolean): readonly string[] {
  const removed: string[] = [];
  for (const name of fs.readdir(paths.headroomSocketDir)) {
    const pid = HEADROOM_SOCKET_NAME.exec(name)?.[1];
    if (pid === undefined || isRunning(Number.parseInt(pid, 10))) {
      continue;
    }
    fs.removeRecursive(path.join(paths.headroomSocketDir, name));
    removed.push(name);
  }
  return removed;
}

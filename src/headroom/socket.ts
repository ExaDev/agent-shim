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
  readonly kind: "dir" | "socket" | "symlink" | "other";
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

/** Why one stat fails the owner-only test (wrong kind, a symlink, another owner, or group or other access), or undefined when it passes. */
function ownerOnlyRefusal(label: string, target: string, stat: SocketPathStat | undefined, expected: SocketPathStat["kind"], uid: number): string | undefined {
  if (stat === undefined) {
    return `the headroom ${label} ${target} does not exist`;
  }
  if (stat.kind === "symlink") {
    return `the headroom ${label} ${target} is a symlink; it must be the real ${expected === "dir" ? "directory" : "socket"}`;
  }
  if (stat.kind !== expected) {
    return `the headroom ${label} ${target} is not a ${expected === "dir" ? "directory" : "socket"}`;
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

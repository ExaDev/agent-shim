import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { FAKE_UID, createFakeFarmFs, fakeSocketTrust } from "../test-helpers";
import { HEADROOM_SOCKET_DIR_MODE, headroomSocketPath, prepareHeadroomSocket, pruneStaleHeadroomSockets, verifyAllowlistFile, verifyHeadroomSocket, type SocketPathStat } from "./socket";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");
const SUPERVISOR_PID = 4242;
const SOCKET_PATH = headroomSocketPath(paths, SUPERVISOR_PID);
/** Another user's uid. */
const OTHER_UID = 0;
/** The mode headroom creates its socket with. */
const SOCKET_MODE = 0o600;
/** The one supervisor still running in the pruning test. */
const LIVE_SUPERVISOR_PID = 11;
const OWNER_ONLY_DIR: SocketPathStat = { kind: "dir", uid: FAKE_UID, mode: HEADROOM_SOCKET_DIR_MODE };
const OWNER_ONLY_SOCKET: SocketPathStat = { kind: "socket", uid: FAKE_UID, mode: SOCKET_MODE };

/** The trust ports over a fake world where the socket directory and the socket stat as given. */
function trustWith(directory: SocketPathStat | undefined, socket: SocketPathStat | undefined, platform?: string) {
  return fakeSocketTrust(createFakeFarmFs({}), {
    ...(platform === undefined ? {} : { platform }),
    overrides: { ...(directory === undefined ? {} : { [paths.headroomSocketDir]: directory }), ...(socket === undefined ? {} : { [SOCKET_PATH]: socket }) },
  });
}

describe("headroomSocketPath", () => {
  it("names the socket by its supervisor generation inside the socket directory", () => {
    expect(SOCKET_PATH).toBe("/home/testuser/.agent-shim/headroom/run/4242.sock");
  });
});

describe("verifyHeadroomSocket", () => {
  it("accepts an owner-only socket inside an owner-only directory", () => {
    expect(verifyHeadroomSocket(SOCKET_PATH, trustWith(OWNER_ONLY_DIR, OWNER_ONLY_SOCKET))).toEqual({ socketPath: SOCKET_PATH });
  });

  it.each([
    ["the directory belongs to another user", { ...OWNER_ONLY_DIR, uid: OTHER_UID }, OWNER_ONLY_SOCKET, `the headroom socket directory ${paths.headroomSocketDir} is owned by uid 0, not by this user (uid ${String(FAKE_UID)})`],
    ["the directory is group accessible", { ...OWNER_ONLY_DIR, mode: 0o750 }, OWNER_ONLY_SOCKET, `the headroom socket directory ${paths.headroomSocketDir} has mode 0750, which lets other users reach it; it must be accessible to its owner only`],
    ["the directory is world accessible", { ...OWNER_ONLY_DIR, mode: 0o701 }, OWNER_ONLY_SOCKET, `the headroom socket directory ${paths.headroomSocketDir} has mode 0701, which lets other users reach it; it must be accessible to its owner only`],
    ["the directory is a symlink", { ...OWNER_ONLY_DIR, kind: "symlink" }, OWNER_ONLY_SOCKET, `the headroom socket directory ${paths.headroomSocketDir} is a symlink; it must be the real directory`],
    ["the directory is missing", undefined, OWNER_ONLY_SOCKET, `the headroom socket directory ${paths.headroomSocketDir} does not exist`],
    ["the socket belongs to another user", OWNER_ONLY_DIR, { ...OWNER_ONLY_SOCKET, uid: OTHER_UID }, `the headroom socket ${SOCKET_PATH} is owned by uid 0, not by this user (uid ${String(FAKE_UID)})`],
    ["the socket is group accessible", OWNER_ONLY_DIR, { ...OWNER_ONLY_SOCKET, mode: 0o660 }, `the headroom socket ${SOCKET_PATH} has mode 0660, which lets other users reach it; it must be accessible to its owner only`],
    ["the socket is a symlink", OWNER_ONLY_DIR, { ...OWNER_ONLY_SOCKET, kind: "symlink" }, `the headroom socket ${SOCKET_PATH} is a symlink; it must be the real socket`],
    ["the socket is a regular file", OWNER_ONLY_DIR, { ...OWNER_ONLY_SOCKET, kind: "other" }, `the headroom socket ${SOCKET_PATH} is not a socket`],
    ["the socket is missing", OWNER_ONLY_DIR, undefined, `the headroom socket ${SOCKET_PATH} does not exist`],
  ] as const)("refuses when %s", (_name, directory, socket, reason) => {
    expect(verifyHeadroomSocket(SOCKET_PATH, trustWith(directory, socket))).toEqual({ refused: reason });
  });

  it("refuses on a platform without unix sockets, whatever the filesystem says, rather than falling back to TCP", () => {
    expect(verifyHeadroomSocket(SOCKET_PATH, trustWith(OWNER_ONLY_DIR, OWNER_ONLY_SOCKET, "win32"))).toEqual({
      refused: "headroom routing needs a unix domain socket, which headroom cannot serve on win32; agent-shim never falls back to a TCP port for this hop",
    });
  });
});

describe("prepareHeadroomSocket", () => {
  it("creates the socket directory owner-only, narrowing one that existed wider, and returns this generation's socket", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomSocketDir);
    expect(prepareHeadroomSocket(fs, fakeSocketTrust(fs), paths, SUPERVISOR_PID)).toEqual({ socketPath: SOCKET_PATH });
    expect(fs.modeOf(paths.headroomSocketDir)).toBe(HEADROOM_SOCKET_DIR_MODE);
  });
});

describe("pruneStaleHeadroomSockets", () => {
  it("removes only the sockets of supervisors that are no longer running", () => {
    const fs = createFakeFarmFs({});
    fs.mkdirPrivate(paths.headroomSocketDir);
    for (const name of ["10.sock", "11.sock", "keep.txt"]) {
      fs.writeFileUtf8(`${paths.headroomSocketDir}/${name}`, "");
    }
    expect(pruneStaleHeadroomSockets(fs, paths, (pid) => pid === LIVE_SUPERVISOR_PID)).toEqual(["10.sock"]);
    expect(fs.readdir(paths.headroomSocketDir)).toEqual(["11.sock", "keep.txt"]);
  });
});

describe("verifyAllowlistFile", () => {
  const FILE = paths.headroomAllowlistFile;
  const HOME = "/home/testuser";
  const OWNER_ONLY_FILE: SocketPathStat = { kind: "file", uid: FAKE_UID, mode: SOCKET_MODE };
  /** A file its group may read. */
  const GROUP_READABLE_FILE_MODE = 0o640;
  /** What a umask of 002 gives a home directory: writable by its group. */
  const GROUP_WRITABLE_DIR_MODE = 0o775;
  /** A shared directory such as /tmp: writable by everyone, with the sticky bit. */
  const STICKY_SHARED_DIR_MODE = 0o1777;
  const ORDINARY_DIR_MODE = 0o755;
  const ROOT_UID = 0;
  /** A world whose real directories run from `/` down to the socket directory, every stat as given in `overrides`, else this user's at 0755 (and `/` root's). */
  const worldWith = (overrides: Readonly<Record<string, SocketPathStat>>, root = paths.headroomSocketDir): ReturnType<typeof fakeSocketTrust> => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(root);
    return fakeSocketTrust(fs, { overrides: { [paths.headroomSocketDir]: OWNER_ONLY_DIR, [FILE]: OWNER_ONLY_FILE, ...overrides } });
  };
  const trustFor = (file: SocketPathStat | undefined): ReturnType<typeof fakeSocketTrust> => {
    const fs = createFakeFarmFs({});
    fs.mkdirp(paths.headroomSocketDir);
    return fakeSocketTrust(fs, { overrides: { [paths.headroomSocketDir]: OWNER_ONLY_DIR, ...(file === undefined ? {} : { [FILE]: file }) } });
  };

  it("passes an owner-only file in an owner-only directory under ordinary ancestors", () => {
    expect(verifyAllowlistFile(FILE, trustFor(OWNER_ONLY_FILE))).toBeUndefined();
    expect(verifyAllowlistFile(FILE, worldWith({ [HOME]: { kind: "dir", uid: FAKE_UID, mode: ORDINARY_DIR_MODE } }))).toBeUndefined();
  });

  it("accepts ancestors owned by root, as headroom does", () => {
    expect(verifyAllowlistFile(FILE, worldWith({ "/home": { kind: "dir", uid: ROOT_UID, mode: ORDINARY_DIR_MODE } }))).toBeUndefined();
  });

  it("refuses, as not repairable, a group-writable home directory, naming it, its mode and the remedy", () => {
    expect(verifyAllowlistFile(FILE, worldWith({ [HOME]: { kind: "dir", uid: FAKE_UID, mode: GROUP_WRITABLE_DIR_MODE } }))).toEqual({
      message: `the directory ${HOME} on the allowlist file's path is writable by group or others (mode 0775), so headroom refuses the file; run \`chmod go-w ${HOME}\``,
      repairable: false,
    });
  });

  it("advises moving the root, not narrowing, for a sticky directory this user owns, which is shared on purpose", () => {
    expect(verifyAllowlistFile(FILE, worldWith({ [HOME]: { kind: "dir", uid: FAKE_UID, mode: STICKY_SHARED_DIR_MODE } }))?.message).toBe(
      `the directory ${HOME} on the allowlist file's path is writable by group or others (mode 1777), so headroom refuses the file; move the agent-shim root (AGENT_SHIM_HOME) to where every directory above it is owned by this user or root and not writable by group or others`,
    );
  });

  it("refuses a sticky shared ancestor such as /tmp: the sticky bit is no exception", () => {
    const tmpRoot = buildLayoutPaths("/tmp/agent-shim");
    const fs = createFakeFarmFs({});
    fs.mkdirp(tmpRoot.headroomSocketDir);
    const trust = fakeSocketTrust(fs, { overrides: { "/tmp": { kind: "dir", uid: ROOT_UID, mode: STICKY_SHARED_DIR_MODE }, [tmpRoot.headroomSocketDir]: OWNER_ONLY_DIR, [tmpRoot.headroomAllowlistFile]: OWNER_ONLY_FILE } });
    expect(verifyAllowlistFile(tmpRoot.headroomAllowlistFile, trust)).toEqual({
      message: "the directory /tmp on the allowlist file's path is writable by group or others (mode 1777), so headroom refuses the file; move the agent-shim root (AGENT_SHIM_HOME) to where every directory above it is owned by this user or root and not writable by group or others",
      repairable: false,
    });
  });

  it("judges the directories a symlinked ancestor resolves to", () => {
    const linked = buildLayoutPaths("/tmp/agent-shim");
    const fs = createFakeFarmFs({});
    fs.mkdirp("/private/tmp/agent-shim/headroom/run");
    fs.seed({ "/tmp": { symlink: "/private/tmp" } });
    const trust = fakeSocketTrust(fs, {
      overrides: { "/private/tmp": { kind: "dir", uid: ROOT_UID, mode: STICKY_SHARED_DIR_MODE }, "/private/tmp/agent-shim/headroom/run": OWNER_ONLY_DIR, "/private/tmp/agent-shim/headroom/run/allowlist.txt": OWNER_ONLY_FILE },
    });
    expect(verifyAllowlistFile(linked.headroomAllowlistFile, trust)?.message).toBe(
      "the directory /private/tmp on the allowlist file's path is writable by group or others (mode 1777), so headroom refuses the file; move the agent-shim root (AGENT_SHIM_HOME) to where every directory above it is owned by this user or root and not writable by group or others",
    );
  });

  it("refuses, as not repairable, an ancestor another user owns", () => {
    expect(verifyAllowlistFile(FILE, worldWith({ [HOME]: { kind: "dir", uid: OTHER_UID + 1, mode: ORDINARY_DIR_MODE } }))).toEqual({
      message: `the directory ${HOME} on the allowlist file's path is owned by uid ${String(OTHER_UID + 1)}, not by this user (uid ${String(FAKE_UID)}) or root, so headroom refuses the file; move the agent-shim root (AGENT_SHIM_HOME) to where every directory above it is owned by this user or root and not writable by group or others`,
      repairable: false,
    });
  });

  it("refuses, as repairable, agent-shim's own directories when they break its owner-only rule", () => {
    expect(verifyAllowlistFile(FILE, worldWith({ [paths.headroomDir]: { kind: "dir", uid: FAKE_UID, mode: GROUP_WRITABLE_DIR_MODE } }))).toEqual({
      message: `the directory ${paths.headroomDir} on the allowlist file's path is writable by group or others (mode 0775), so headroom refuses the file`,
      repairable: true,
    });
    expect(verifyAllowlistFile(FILE, worldWith({ [paths.headroomSocketDir]: { kind: "dir", uid: FAKE_UID, mode: ORDINARY_DIR_MODE } }))).toEqual({
      message: `the headroom allowlist directory ${paths.headroomSocketDir} has mode 0755, which lets other users reach it; it must be accessible to its owner only`,
      repairable: true,
    });
  });

  it("refuses the file when it is a symlink, another user's, a directory, reachable by group or others, or missing, all repairable but the directory", () => {
    expect(verifyAllowlistFile(FILE, trustFor({ kind: "symlink", uid: FAKE_UID, mode: SOCKET_MODE }))).toEqual({ message: `the headroom allowlist file ${FILE} is a symlink; it must be the real file`, repairable: true });
    expect(verifyAllowlistFile(FILE, trustFor({ kind: "file", uid: OTHER_UID, mode: SOCKET_MODE }))).toEqual({ message: `the headroom allowlist file ${FILE} is owned by uid ${String(OTHER_UID)}, not by this user (uid ${String(FAKE_UID)})`, repairable: true });
    expect(verifyAllowlistFile(FILE, trustFor({ kind: "dir", uid: FAKE_UID, mode: HEADROOM_SOCKET_DIR_MODE }))).toEqual({ message: `the headroom allowlist file ${FILE} is not a file`, repairable: false });
    expect(verifyAllowlistFile(FILE, trustFor({ kind: "file", uid: FAKE_UID, mode: GROUP_READABLE_FILE_MODE }))).toEqual({
      message: `the headroom allowlist file ${FILE} has mode 0640, which lets other users reach it; it must be accessible to its owner only`,
      repairable: true,
    });
    expect(verifyAllowlistFile(FILE, trustFor(undefined))).toEqual({ message: `the headroom allowlist file ${FILE} does not exist`, repairable: true });
  });
});

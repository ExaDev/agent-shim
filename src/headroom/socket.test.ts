import { describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { FAKE_UID, createFakeFarmFs, fakeSocketTrust } from "../test-helpers";
import { HEADROOM_SOCKET_DIR_MODE, headroomSocketPath, prepareHeadroomSocket, pruneStaleHeadroomSockets, verifyHeadroomSocket, type SocketPathStat } from "./socket";

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

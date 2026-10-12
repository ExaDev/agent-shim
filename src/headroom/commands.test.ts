import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureCa, generateCa, realConnectCertStore } from "../frontdoor/connect";
import { realTrustBundleFs } from "../frontdoor/realFrontDoorPort";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { writeFrontDoorDirectRecord, writeFrontDoorState, type FrontDoorLiveness } from "../frontdoor/state";
import { createFakeFarmFs, FAKE_UID } from "../test-helpers";
import { collectHeadroomStatus, formatHeadroomStatus, headroomProxyArgs, headroomSpawnEnv, resolveHeadroomTrustBundle } from "./commands";
import { headroomSocketPath, type HeadroomSocketTrustPorts } from "./socket";
import { earlierReleaseAllowlistHash } from "./earlierRelease";
import { formatAllowlistFile, hashAllowlist, readAllProviders, writeAllowlistFile, writeHeadroomState, writeSession } from "./state";

const paths = buildLayoutPaths("/home/testuser/.agent-shim");

const SUPERVISOR_PID = 11;
const HEADROOM_PID = 12;
const SESSION_PID = 13;
const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIR_MODE = 0o700;
const GROUP_WRITABLE_DIR_MODE = 0o775;
const SOCKET_PATH = headroomSocketPath(paths, SUPERVISOR_PID);
const DOOR_DIRECT_PORT = 50123;
const DOOR_ORIGIN = `http://127.0.0.1:${String(DOOR_DIRECT_PORT)}`;
const MOVED_DOOR_DIRECT_PORT = 50999;
const MOVED_DOOR_ORIGIN = `http://127.0.0.1:${String(MOVED_DOOR_DIRECT_PORT)}`;
/** The daemon's command line as this release's supervisor starts it, reading an allowlist file. */
const THIS_RELEASE_DAEMON = (): string => `python -m headroom.cli proxy --uds ${SOCKET_PATH} --allowed-base-urls-file /home/testuser/.agent-shim/headroom/allowlist.txt --no-rate-limit`;
/** Every pid a test names as a door is one: the reused-pid and unreadable-table cases are covered where records are pruned. */
const ANY_LIVE_DOOR = (pids: readonly number[]): FrontDoorLiveness => ({ doors: new Set(pids), unknown: new Map() });
/** What the daemon serves with the one door this world has: its direct origin, and nothing for any provider. */
const ALLOWLIST = [DOOR_ORIGIN];
/** Every path the status checks is this user's and owner-only, as the supervisor leaves the allowlist file and its directory. */
const OWNER_ONLY_PATHS: HeadroomSocketTrustPorts = {
  platform: "linux",
  currentUid: () => FAKE_UID,
  lstat: (target) => ({ kind: target === paths.headroomAllowlistFile ? "file" : "dir", uid: FAKE_UID, mode: target === paths.headroomAllowlistFile ? OWNER_ONLY_FILE_MODE : OWNER_ONLY_DIR_MODE }),
  readlink: (target) => {
    throw new Error(`EINVAL: ${target} is not a symlink`);
  },
};

/** A distinct supervisor generation, alive, recorded only under the legacy state name. */
const LEGACY_SUPERVISOR_PID = 7070;

function aliveWorld() {
  const fs = createFakeFarmFs({});
  fs.mkdirp(paths.providersDir);
  fs.writeFileUtf8(
    `${paths.providersDir}/z.json`,
    JSON.stringify({ displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }] } }),
  );
  writeHeadroomState(fs, paths.headroomStateFile, {
    supervisorPid: SUPERVISOR_PID,
    headroomPid: HEADROOM_PID,
    socketPath: SOCKET_PATH,
    version: "headroom 0.39.1",
    allowlistHash: hashAllowlist(ALLOWLIST),
  });
  writeFrontDoorState(fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
  writeAllowlistFile(fs, paths.headroomAllowlistFile, ALLOWLIST);
  writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_PID, startedAt: 1000, supervisorPid: SUPERVISOR_PID });
  const alive = new Set([SUPERVISOR_PID, HEADROOM_PID, SESSION_PID]);
  return { fs, alive };
}

describe("collectHeadroomStatus", () => {
  it("reports a healthy daemon, its live session, the current allowlist, its file, and no drift", () => {
    const { fs, alive } = aliveWorld();
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS });
    expect(status.supervisorAlive).toBe(true);
    expect(status.headroomAlive).toBe(true);
    expect(status.state.socketPath).toBe(SOCKET_PATH);
    expect(status.allowlist).toEqual(ALLOWLIST);
    expect(status.allowlistFile).toBe(paths.headroomAllowlistFile);
    expect(status.allowlistDrift).toBeUndefined();
    expect(status.sessions).toEqual([{ pid: SESSION_PID, startedAt: 1000, supervisorPid: SUPERVISOR_PID, alive: true }]);
  });

  it("marks dead pids without touching anything, and does not count a provider edit as drift, since providers are never on the allowlist", () => {
    const { fs } = aliveWorld();
    fs.writeFileUtf8(
      `${paths.providersDir}/m.json`,
      JSON.stringify({ displayName: "MiniMax", baseUrl: "https://api.minimax.io", credential: { sources: [{ env: "T" }] } }),
    );
    const status = collectHeadroomStatus(fs, paths, { isRunning: () => false, commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS });
    expect(status.supervisorAlive).toBe(false);
    expect(status.headroomAlive).toBe(false);
    expect(status.sessions.map((session) => session.alive)).toEqual([false]);
    expect(status.allowlistDrift).toBeUndefined();
    expect(fs.readFileUtf8(paths.headroomAllowlistFile)).toBe(formatAllowlistFile(ALLOWLIST));
  });

  it("names the moved front door's origin and what it costs provider launches while the file lags it", () => {
    const { fs, alive } = aliveWorld();
    const before = [MOVED_DOOR_ORIGIN];
    writeAllowlistFile(fs, paths.headroomAllowlistFile, before);
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: SUPERVISOR_PID, headroomPid: HEADROOM_PID, socketPath: SOCKET_PATH, allowlistHash: hashAllowlist(before) });
    writeFrontDoorState(fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS });
    expect(status.allowlist).toEqual([DOOR_ORIGIN]);
    expect(status.allowlistDrift).toEqual({ missingFromFile: [DOOR_ORIGIN], staleInFile: [MOVED_DOOR_ORIGIN], hashLags: false });
    const line = formatHeadroomStatus(status).find((entry) => entry.startsWith("allowlist:"));
    expect(line).toContain(`lacks ${DOOR_ORIGIN} (live front doors' direct origins, so the daemon refuses every request a provider launch sends back through those doors)`);
    expect(line).toContain(`still lists ${MOVED_DOOR_ORIGIN}`);
    expect(line).toContain(`supervisor ${String(SUPERVISOR_PID)} rewrites the file on its next tick, so drift that persists means it cannot write it (see ${paths.headroomLogPath})`);
  });

  it("counts a live superseded door's recorded origin as current, not stale, and drops a dead door's", () => {
    const { fs, alive } = aliveWorld();
    const supersededDoor = 7001;
    const deadDoor = 7003;
    alive.add(supersededDoor);
    writeFrontDoorState(fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    writeFrontDoorDirectRecord(fs, paths.frontdoorDirectRecordsDir, { pid: supersededDoor, directPort: MOVED_DOOR_DIRECT_PORT });
    writeFrontDoorDirectRecord(fs, paths.frontdoorDirectRecordsDir, { pid: deadDoor, directPort: 1 });
    const served = [DOOR_ORIGIN, MOVED_DOOR_ORIGIN];
    writeAllowlistFile(fs, paths.headroomAllowlistFile, served);
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: SUPERVISOR_PID, headroomPid: HEADROOM_PID, socketPath: SOCKET_PATH, allowlistHash: hashAllowlist(served) });
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: (pids) => ({ doors: new Set(pids.filter((pid) => alive.has(pid))), unknown: new Map() }), pathTrust: OWNER_ONLY_PATHS });
    expect(status.allowlist).toEqual(served);
    expect(status.allowlistDrift).toBeUndefined();
  });

  it("reports a daemon started by an earlier release, without an allowlist file, as one that restarts once its sessions end", () => {
    const { fs, alive } = aliveWorld();
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: SUPERVISOR_PID, headroomPid: HEADROOM_PID, socketPath: SOCKET_PATH, allowlistHash: "hash-of-an-earlier-allowlist" });
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: () => `python -m headroom.cli proxy --uds ${SOCKET_PATH} --no-rate-limit`, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS });
    expect(status.allowlistDrift).toEqual({ startedByEarlierRelease: true });
    expect(formatHeadroomStatus(status).find((entry) => entry.startsWith("allowlist:"))).toContain("started by an earlier release with an allowlist fixed at start; it restarts once its sessions end");
    // The hash that release records for this world's provider and door: its fixed allowlist admits the serving door, so nothing has drifted.
    const providers = readAllProviders(fs, paths.providersDir).map((entry) => entry.provider);
    writeHeadroomState(fs, paths.headroomStateFile, { supervisorPid: SUPERVISOR_PID, headroomPid: HEADROOM_PID, socketPath: SOCKET_PATH, allowlistHash: earlierReleaseAllowlistHash(providers, DOOR_ORIGIN) });
    expect(collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: () => `python -m headroom.cli proxy --uds ${SOCKET_PATH} --no-rate-limit`, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS }).allowlistDrift).toBeUndefined();
  });

  it("says the supervisor has not recorded a file it rewrote, which holds provider launches at their gate", () => {
    const { fs, alive } = aliveWorld();
    writeAllowlistFile(fs, paths.headroomAllowlistFile, [...ALLOWLIST, MOVED_DOOR_ORIGIN].sort());
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS });
    expect(status.allowlistDrift).toEqual({ missingFromFile: [], staleInFile: [MOVED_DOOR_ORIGIN], hashLags: true });
    expect(formatHeadroomStatus(status).find((entry) => entry.startsWith("allowlist:"))).toContain("has not yet recorded the file's allowlist as served, and provider launches through headroom wait until it does");
  });

  it("names a recorded door the process table could not answer for, and why its origin stays admitted", () => {
    const { fs, alive } = aliveWorld();
    const unknownDoor = 7004;
    writeFrontDoorDirectRecord(fs, paths.frontdoorDirectRecordsDir, { pid: unknownDoor, directPort: MOVED_DOOR_DIRECT_PORT });
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: (pids) => ({ doors: new Set(), unknown: new Map(pids.map((pid) => [pid, "ps timed out"])) }), pathTrust: OWNER_ONLY_PATHS });
    expect(status.undeterminedFrontDoors).toEqual([{ pid: unknownDoor, origin: MOVED_DOOR_ORIGIN, reason: "ps timed out" }]);
    expect(status.allowlist).toEqual([DOOR_ORIGIN, MOVED_DOOR_ORIGIN]);
    expect(formatHeadroomStatus(status)).toContain(`front door ${String(unknownDoor)}: could not tell whether it is still running (ps timed out), so its direct origin ${MOVED_DOOR_ORIGIN} stays admitted`);
  });

  it("reports an allowlist file that breaks agent-shim's owner-only rule because its directory is group-writable", () => {
    const { fs, alive } = aliveWorld();
    const groupWritable: HeadroomSocketTrustPorts = {
      ...OWNER_ONLY_PATHS,
      lstat: (target) => (target === paths.headroomSocketDir ? { kind: "dir", uid: FAKE_UID, mode: GROUP_WRITABLE_DIR_MODE } : OWNER_ONLY_PATHS.lstat(target)),
    };
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: groupWritable });
    const problem = `the headroom allowlist directory ${paths.headroomSocketDir} has mode 0775, which lets other users reach it; it must be accessible to its owner only`;
    expect(status.allowlistFileProblem).toEqual({ message: problem, repairable: true });
    expect(formatHeadroomStatus(status)).toContain(`allowlist file: breaks agent-shim's owner-only rule, which its supervisor repairs on its next tick or stops the daemon over: ${problem}`);
  });

  it("reports a group-writable home directory above the root as a problem headroom refuses the file over and the supervisor cannot repair", () => {
    const { fs, alive } = aliveWorld();
    const home = "/home/testuser";
    const groupWritableHome: HeadroomSocketTrustPorts = {
      ...OWNER_ONLY_PATHS,
      lstat: (target) => (target === home ? { kind: "dir", uid: FAKE_UID, mode: GROUP_WRITABLE_DIR_MODE } : target === "/" ? { kind: "dir", uid: 0, mode: OWNER_ONLY_DIR_MODE } : OWNER_ONLY_PATHS.lstat(target)),
    };
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: groupWritableHome });
    const message = `the directory ${home} on the allowlist file's path is writable by group or others (mode 0775), so headroom refuses the file; run \`chmod go-w ${home}\``;
    expect(status.allowlistFileProblem).toEqual({ message, repairable: false });
    expect(formatHeadroomStatus(status)).toContain(`allowlist file: headroom refuses it, so it admits nothing and every provider request through headroom fails: ${message}`);
  });

  it("reports such a home directory with no daemon serving, and leaves a repairable break unreported until one does", () => {
    const fs = createFakeFarmFs({});
    writeHeadroomState(fs, paths.headroomStateFile, { lastError: "headroom would refuse its allowlist file" });
    const home = "/home/testuser";
    const withHome = (mode: number): HeadroomSocketTrustPorts => ({
      ...OWNER_ONLY_PATHS,
      lstat: (target) => (target === home ? { kind: "dir", uid: FAKE_UID, mode } : target === "/" ? { kind: "dir", uid: 0, mode: OWNER_ONLY_DIR_MODE } : OWNER_ONLY_PATHS.lstat(target)),
    });
    const statusWith = (pathTrust: HeadroomSocketTrustPorts) => collectHeadroomStatus(fs, paths, { isRunning: () => false, commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust });
    expect(statusWith(withHome(GROUP_WRITABLE_DIR_MODE)).allowlistFileProblem).toEqual({
      message: `the directory ${home} on the allowlist file's path is writable by group or others (mode 0775), so headroom refuses the file; run \`chmod go-w ${home}\``,
      repairable: false,
    });
    expect(statusWith(withHome(OWNER_ONLY_DIR_MODE)).allowlistFileProblem).toBeUndefined();
  });

  it("does not check an allowlist file for a daemon started by an earlier release, which reads none", () => {
    const { fs, alive } = aliveWorld();
    fs.removeRecursive(paths.headroomAllowlistFile);
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: () => `python -m headroom.cli proxy --uds ${SOCKET_PATH} --no-rate-limit`, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS });
    expect(status.allowlistFileProblem).toBeUndefined();
    expect(formatHeadroomStatus(status).some((entry) => entry.startsWith("allowlist file:"))).toBe(false);
  });

  it("reports a missing file as admitting nothing", () => {
    const { fs, alive } = aliveWorld();
    fs.removeRecursive(paths.headroomAllowlistFile);
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS });
    // The recorded hash names entries no file lists any more, so the gate waits as well.
    expect(status.allowlistDrift).toEqual({ missingFromFile: ALLOWLIST, staleInFile: [], hashLags: true });
    expect(formatHeadroomStatus(status).find((entry) => entry.startsWith("allowlist:"))).toContain(`${paths.headroomAllowlistFile} lacks ${ALLOWLIST.join(", ")}`);
  });

  it("reports a live previous-release supervisor recorded under the legacy state name as the serving daemon", () => {
    const { fs, alive } = aliveWorld();
    // The shared name carries nothing; only the legacy file names the live daemon, and the read-only resolution must surface it without migrating.
    fs.removeRecursive(paths.headroomStateFile);
    writeHeadroomState(fs, paths.headroomLegacyStateFile, {
      supervisorPid: SUPERVISOR_PID,
      headroomPid: HEADROOM_PID,
      socketPath: SOCKET_PATH,
      version: "headroom 0.39.1",
    });
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS });
    expect(status.supervisorAlive).toBe(true);
    expect(status.headroomAlive).toBe(true);
    expect(status.state.socketPath).toBe(SOCKET_PATH);
  });

  it("prefers the shared name's record over a live legacy one beside it", () => {
    const { fs, alive } = aliveWorld();
    writeHeadroomState(fs, paths.headroomLegacyStateFile, { supervisorPid: LEGACY_SUPERVISOR_PID, headroomPid: LEGACY_SUPERVISOR_PID + 1, socketPath: headroomSocketPath(paths, LEGACY_SUPERVISOR_PID) });
    alive.add(LEGACY_SUPERVISOR_PID);
    alive.add(LEGACY_SUPERVISOR_PID + 1);
    const status = collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS });
    expect(status.state.socketPath).toBe(SOCKET_PATH);
  });

  it("treats absent state as a never-run daemon rather than an error", () => {
    const status = collectHeadroomStatus(createFakeFarmFs({}), paths, { isRunning: () => true, commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS });
    expect(status.state).toEqual({});
    expect(status.supervisorAlive).toBe(false);
    expect(status.allowlist).toEqual([]);
  });
});

describe("formatHeadroomStatus", () => {
  it("renders the running daemon's pids, socket, version, allowlist, sessions, and log path", () => {
    const { fs, alive } = aliveWorld();
    const lines = formatHeadroomStatus(collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS }));
    expect(lines[0]).toBe(`supervisor: pid ${String(SUPERVISOR_PID)} (alive)`);
    expect(lines[1]).toBe(
      `headroom: pid ${String(HEADROOM_PID)} (alive), listening on unix socket ${SOCKET_PATH}, headroom 0.39.1`,
    );
    expect(lines[2]).toBe(`allowlist: ${DOOR_ORIGIN}`);
    expect(lines[3]).toBe("settings: headroom defaults");
    expect(lines[4]).toBe(`sessions: 1 registered (${String(SESSION_PID)})`);
    expect(lines.at(-1)).toBe(`daemon log: ${paths.headroomLogPath} (not created yet)`);
  });

  it("marks a session registered against a supervisor other than the one the state file names", () => {
    const { fs, alive } = aliveWorld();
    const superseded = 77;
    writeSession(fs, paths.headroomSessionsDir, { pid: SESSION_PID + 1, startedAt: 1000, supervisorPid: superseded });
    alive.add(SESSION_PID + 1);
    const lines = formatHeadroomStatus(collectHeadroomStatus(fs, paths, { isRunning: (pid) => alive.has(pid), commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS }));
    expect(lines[4]).toBe(`sessions: 2 registered (${String(SESSION_PID)}, ${String(SESSION_PID + 1)} on superseded supervisor ${String(superseded)})`);
  });

  it("says plainly when nothing is running", () => {
    const lines = formatHeadroomStatus(collectHeadroomStatus(createFakeFarmFs({}), paths, { isRunning: () => true, commandLine: THIS_RELEASE_DAEMON, frontDoorLiveness: ANY_LIVE_DOOR, pathTrust: OWNER_ONLY_PATHS }));
    expect(lines[0]).toBe("supervisor: not running (no state recorded)");
    expect(lines[1]).toBe("headroom: not running");
    expect(lines[2]).toBe("allowlist: none (no front door has served yet)");
    expect(lines[3]).toBe("settings: headroom defaults");
    expect(lines[4]).toBe("sessions: none");
  });
});

describe("headroomSpawnEnv", () => {
  it("defaults HEADROOM_HTTP2 to 0 and passes the rest of the environment through", () => {
    const env = headroomSpawnEnv({ PATH: "/usr/bin" }, {});
    expect(env.HEADROOM_HTTP2).toBe("0");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("removes an ambient allowlist, so the daemon admits exactly what the supervisor writes to its allowlist file", () => {
    const env = headroomSpawnEnv({ PATH: "/usr/bin", HEADROOM_ALLOWED_BASE_URLS: "https://example.com", HEADROOM_ALLOWED_BASE_URLS_FILE: "/elsewhere/allowlist" }, {});
    expect(env).not.toHaveProperty("HEADROOM_ALLOWED_BASE_URLS");
    expect(env).not.toHaveProperty("HEADROOM_ALLOWED_BASE_URLS_FILE");
  });

  it("leaves an explicit HEADROOM_HTTP2 from the parent environment in place", () => {
    const env = headroomSpawnEnv({ HEADROOM_HTTP2: "1" }, {});
    expect(env.HEADROOM_HTTP2).toBe("1");
  });

  it("removes an ambient HEADROOM_HOST and HEADROOM_PORT, which headroom refuses alongside --uds", () => {
    const env = headroomSpawnEnv({ PATH: "/usr/bin", HEADROOM_HOST: "0.0.0.0", HEADROOM_PORT: "8787" }, {});
    expect(Object.keys(env)).toEqual(expect.arrayContaining(["PATH", "HEADROOM_HTTP2"]));
    expect(env).not.toHaveProperty("HEADROOM_HOST");
    expect(env).not.toHaveProperty("HEADROOM_PORT");
  });
});

/** Every environment variable a TLS stack headroom runs reads as a file or directory path naming trust anchors: headroom's own additive bundle, Python's ssl and httpx (`SSL_CERT_FILE`, `SSL_CERT_DIR`), and requests (`REQUESTS_CA_BUNDLE`). */
const TRUST_PATH_VARIABLES = ["HEADROOM_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE"] as const;

/** The armour line every PEM certificate starts with: its presence in an environment value means certificate text where a path belongs. */
const PEM_CERTIFICATE_HEADER = "-----BEGIN CERTIFICATE-----";

describe("headroom trust", () => {
  let root: string;
  let layout: LayoutPaths;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "headroom-trust-test-"));
    layout = buildLayoutPaths(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Writes a real door CA to this root, exactly as the door's first start does, and returns its certificate PEM. */
  function startDoorCa(): string {
    return ensureCa(realConnectCertStore(layout), () => generateCa(new Date())).certPem;
  }

  it("hands headroom no trust bundle on a root where no door has ever run", () => {
    expect(resolveHeadroomTrustBundle({ caCertFile: layout.frontdoorCaCertFile, bundlesDir: layout.frontdoorCaBundlesDir, inherited: undefined, fs: realTrustBundleFs })).toBeUndefined();
  });

  it("points HEADROOM_CA_BUNDLE at a file holding the door's CA, and exports no certificate text in any variable", () => {
    const caPem = startDoorCa();
    const trust = resolveHeadroomTrustBundle({ caCertFile: layout.frontdoorCaCertFile, bundlesDir: layout.frontdoorCaBundlesDir, inherited: undefined, fs: realTrustBundleFs });
    const env = headroomSpawnEnv({ PATH: "/usr/bin" }, {}, trust?.path);

    expect(env.HEADROOM_CA_BUNDLE).toBe(layout.frontdoorCaCertFile);
    expect(readFileSync(layout.frontdoorCaCertFile, "utf8")).toBe(caPem);
    for (const [name, value] of Object.entries(env)) {
      expect(value, name).not.toContain(PEM_CERTIFICATE_HEADER);
    }
    for (const name of TRUST_PATH_VARIABLES) {
      const value = env[name];
      if (value !== undefined) {
        expect(statSync(value).isFile(), name).toBe(true);
      }
    }
  });

  it("never replaces headroom's default trust store with the door's CA alone", () => {
    startDoorCa();
    const trust = resolveHeadroomTrustBundle({ caCertFile: layout.frontdoorCaCertFile, bundlesDir: layout.frontdoorCaBundlesDir, inherited: undefined, fs: realTrustBundleFs });
    const env = headroomSpawnEnv({ PATH: "/usr/bin" }, {}, trust?.path);

    expect(env).not.toHaveProperty("SSL_CERT_FILE");
    expect(env).not.toHaveProperty("REQUESTS_CA_BUNDLE");
  });

  it("folds an inherited HEADROOM_CA_BUNDLE into the bundle, since headroom reads one file from it", () => {
    const caPem = startDoorCa();
    const corporateFile = path.join(root, "corporate.pem");
    const corporatePem = generateCa(new Date()).certPem;
    writeFileSync(corporateFile, corporatePem, "utf8");

    const trust = resolveHeadroomTrustBundle({ caCertFile: layout.frontdoorCaCertFile, bundlesDir: layout.frontdoorCaBundlesDir, inherited: corporateFile, fs: realTrustBundleFs });
    const env = headroomSpawnEnv({ HEADROOM_CA_BUNDLE: corporateFile }, {}, trust?.path);

    if (trust === undefined) {
      throw new Error("a door CA exists, so headroom must be handed a trust bundle");
    }
    expect(env.HEADROOM_CA_BUNDLE).toBe(trust.path);
    expect(path.dirname(trust.path)).toBe(layout.frontdoorCaBundlesDir);
    const bundle = readFileSync(trust.path, "utf8");
    expect(bundle).toContain(caPem.trim());
    expect(bundle).toContain(corporatePem.trim());
  });

  it("leaves an inherited SSL_CERT_FILE in place, so an explicit replacement store in the parent environment still wins", () => {
    startDoorCa();
    const trust = resolveHeadroomTrustBundle({ caCertFile: layout.frontdoorCaCertFile, bundlesDir: layout.frontdoorCaBundlesDir, inherited: undefined, fs: realTrustBundleFs });
    const env = headroomSpawnEnv({ SSL_CERT_FILE: "/etc/ssl/corporate.pem" }, {}, trust?.path);

    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/corporate.pem");
    expect(env.HEADROOM_CA_BUNDLE).toBe(layout.frontdoorCaCertFile);
  });
});

describe("headroomProxyArgs", () => {
  it("serves the proxy on the unix socket and binds no TCP address", () => {
    const args = headroomProxyArgs(SOCKET_PATH, paths.headroomAllowlistFile, { mode: "token" });
    expect(args).toEqual(["proxy", "--uds", SOCKET_PATH, "--allowed-base-urls-file", paths.headroomAllowlistFile, "--no-rate-limit", "--mode", "token"]);
    expect(args).not.toContain("--port");
    expect(args).not.toContain("--host");
  });

  it("turns the daemon's local rate limiter off whatever the settings", () => {
    expect(headroomProxyArgs(SOCKET_PATH, paths.headroomAllowlistFile, {})).toContain("--no-rate-limit");
    expect(headroomProxyArgs(SOCKET_PATH, paths.headroomAllowlistFile, { mode: "cache" })).toContain("--no-rate-limit");
  });
});

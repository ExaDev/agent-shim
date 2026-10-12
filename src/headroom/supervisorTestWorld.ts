/**
 * The fake world the headroom supervisor's test files run `runSupervisor` against, shared so the loop's tests can be split by concern without each file rebuilding the process model.
 */
import { HEADROOM_DEFAULT_SOURCE } from "../config/schema";
import { buildLayoutPaths } from "../paths";
import { FAKE_UID, createFakeFarmFs, fakeSocketTrust } from "../test-helpers";
import { resolveSupervisorConfig, runSupervisor, type HeadroomSupervisorConfig, type RunSupervisorOptions, type SupervisorPorts } from "./supervisor";
import type { HeadroomSettings } from "./settings";
import { headroomSocketPath, type SocketPathStat } from "./socket";
import { pinnedGitCommit } from "./source";
import type { FrontDoorLiveness } from "../frontdoor/state";
import { parseAllowlistFile, writeHeadroomState, writeSession } from "./state";

export const paths = buildLayoutPaths("/home/testuser/.agent-shim");

export const SESSION_PID = 321;
export const OWN_PID = 4242;
export const OTHER_SUPERVISOR_PID = 5151;
export const OTHER_DAEMON_PID = 5152;
/** The socket this supervisor generation serves on. */
export const OWN_SOCKET = headroomSocketPath(paths, OWN_PID);
/** The socket another live supervisor's daemon serves on. */
export const OTHER_SOCKET = headroomSocketPath(paths, OTHER_SUPERVISOR_PID);
export const TICKS_INSTALL_TEST = 3;
export const TICKS_SHORT = 2;
export const TICKS_DRIFT_TEST = 40;
export const IDLE_NEVER_MINUTES = 60;

/**
 * The fake world `runSupervisor` runs against: a fake filesystem seeded with providers, a clock advanced only by the supervisor's own sleeps, a modelled process table, and controllable readiness, install, and version results. `onSleep` lets a test script the outside world (a provider file appearing, a session ending) between ticks.
 *
 * The process model distinguishes exactly what the real one does: `alive` is signal-0-style existence, `zombies` holds pids that exited without being reaped (still "existing", never running), and `kill` models the ChildProcess exit event (death observed and the child reaped, the way the real supervisor's exit listener does).
 */
export function makeWorld(seededProviders: readonly { name: string; baseUrl: string }[] = []) {
  const fs = createFakeFarmFs({});
  fs.mkdirp(paths.providersDir);
  for (const provider of seededProviders) {
    fs.writeFileUtf8(
      `${paths.providersDir}/${provider.name}.json`,
      JSON.stringify({ displayName: provider.name, baseUrl: provider.baseUrl, credential: { sources: [{ env: "T" }] } }),
    );
  }

  let clock = 0;
  let nextPid = 1000;
  const readySockets = new Set<string>();
  let autoReady = true;
  let version: string | undefined = "headroom 0.39.1";
  let installOk = true;
  let onInstall: (() => void) | undefined;
  let installedCommit: string | undefined = pinnedGitCommit(HEADROOM_DEFAULT_SOURCE);
  const alive = new Set<number>([process.pid]);
  /** The pids whose command line is a front-door supervisor's; a live pid outside it is some other process that reused a door's pid. */
  const frontDoorSupervisors = new Set<number>();
  /** The command line `ps` would report for a pid, for the ones a test names; any other pid reads as unreadable. */
  const commandLines = new Map<number, string>();
  /** Every pid list the supervisor asked the process table about, one entry per read. */
  const livenessReads: (readonly number[])[] = [];
  /** When set, the process table cannot be read (ps failed or timed out), and this is why. */
  let processTableUnreadable: string | undefined;
  const zombies = new Set<number>();
  /** Each daemon start, with the allowlist file it was pointed at and that file's entries at the moment it started. */
  const spawns: { pid: number; socketPath: string; allowlistFile: string; allowlist: readonly string[] | undefined; settings: HeadroomSettings }[] = [];
  let platform = "linux";
  let socketStatOverrides: Record<string, SocketPathStat> = {};
  let currentConfig: HeadroomSupervisorConfig = resolveSupervisorConfig({});
  const stops: number[] = [];
  const installs: string[] = [];
  const logLines: string[] = [];
  const sleepDelays: number[] = [];
  let onSleep: (() => void) | undefined;

  /** Resolves on a later microtask, the way a real readiness probe awaits I/O; also keeps the promise-shaped fakes honest under the async rules. */
  async function settled<T>(value: T): Promise<T> {
    return await Promise.resolve(value);
  }

  /** A dead daemon closes its listener: without this, a generation's reused socket path would keep answering /readyz from beyond the grave. */
  function dropReadySocket(pid: number): void {
    for (let index = spawns.length - 1; index >= 0; index -= 1) {
      const spawn = spawns[index];
      if (spawn?.pid === pid) {
        readySockets.delete(spawn.socketPath);
        return;
      }
    }
  }

  const world = {
    setConfig: (next: HeadroomSupervisorConfig) => {
      currentConfig = next;
    },
    fs,
    alive,
    frontDoorSupervisors,
    commandLines,
    livenessReads,
    set processTableUnreadable(reason: string | undefined) {
      processTableUnreadable = reason;
    },
    zombies,
    spawns,
    stops,
    installs,
    logLines,
    sleepDelays,
    set onSleep(hook: (() => void) | undefined) {
      onSleep = hook;
    },
    /** The platform the socket checks see. */
    set platform(value: string) {
      platform = value;
    },
    /** Socket-check stats that replace the fake filesystem's, keyed by resolved path: another owner, a wide mode, a symlink. */
    set socketStats(value: Record<string, SocketPathStat>) {
      socketStatOverrides = value;
    },
    /** When false, spawned proxies never answer /readyz. */
    set autoReady(value: boolean) {
      autoReady = value;
    },
    /** When set, the MITM proxy cannot bind, the way a poisoned port or a missing certificate would fail a real bind. */
    set version(value: string | undefined) {
      version = value;
    },
    set onInstall(hook: (() => void) | undefined) {
      onInstall = hook;
    },
    set installOk(value: boolean) {
      installOk = value;
    },
    /** The commit the installed binary was built from, as its direct_url.json records it. Defaults to the default source's pinned commit, so a test that does not care sees a matching install. */
    set installedCommit(value: string | undefined) {
      installedCommit = value;
    },
    /** The ChildProcess exit event arriving: death observed, child reaped, no zombie remains. */
    kill(pid: number): void {
      alive.delete(pid);
      zombies.delete(pid);
      dropReadySocket(pid);
    },
    /** The observed macOS failure mode: the process died but nothing reaped it, so signal 0 still answers while nothing is running. */
    zombify(pid: number): void {
      zombies.add(pid);
      dropReadySocket(pid);
    },
    /** Registers a live launcher against `supervisorPid`: this supervisor unless a test says another one owns the session. */
    writeSessionFile(pid: number, supervisorPid: number = OWN_PID): void {
      alive.add(pid);
      writeSession(fs, paths.headroomSessionsDir, { pid, startedAt: clock, supervisorPid });
    },
    /** Another supervisor taking ownership of the state file: alive, with its own daemon and socket recorded, the way a second supervisor's startup or crash-restart leaves the file. */
    handOwnershipToAnotherSupervisor(): void {
      alive.add(OTHER_SUPERVISOR_PID);
      alive.add(OTHER_DAEMON_PID);
      writeHeadroomState(fs, paths.headroomStateFile, {
        supervisorPid: OTHER_SUPERVISOR_PID,
        headroomPid: OTHER_DAEMON_PID,
        socketPath: OTHER_SOCKET,
        installedSource: HEADROOM_DEFAULT_SOURCE,
      });
    },
    ports: {
      fs,
      paths,
      ownPid: OWN_PID,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
        sleepDelays.push(ms);
        if (onSleep !== undefined) {
          onSleep();
        }
        await settled(undefined);
      },
      isRunning: (pid: number) => alive.has(pid) && !zombies.has(pid),
      daemonCommandLine: (pid: number) => commandLines.get(pid),
      frontDoorLiveness: (pids: readonly number[]): FrontDoorLiveness => {
        livenessReads.push([...pids]);
        const reason = processTableUnreadable;
        if (reason !== undefined) {
          return { doors: new Set(), unknown: new Map(pids.map((pid) => [pid, reason])) };
        }
        return { doors: new Set(pids.filter((pid) => alive.has(pid) && !zombies.has(pid) && frontDoorSupervisors.has(pid))), unknown: new Map() };
      },
      daemonLogSize: () => Buffer.byteLength(fs.readFileUtf8(paths.headroomLogPath) ?? ""),
      readDaemonLogTail: (fromByte: number, maxBytes: number) => {
        const bytes = Buffer.from(fs.readFileUtf8(paths.headroomLogPath) ?? "");
        return bytes.subarray(Math.max(fromByte, bytes.length - maxBytes)).toString("utf8");
      },
      // Read through getters, so a test can switch the platform or replace a stat after the world is built.
      socketTrust: {
        get platform() {
          return platform;
        },
        currentUid: () => FAKE_UID,
        lstat: (target: string) => fakeSocketTrust(fs, { overrides: socketStatOverrides }).lstat(target),
        readlink: (target: string) => fakeSocketTrust(fs).readlink(target),
      },
      readConfig: () => currentConfig,
      spawnHeadroom: (socketPath: string, allowlistFile: string, settings: Readonly<HeadroomSettings>) => {
        nextPid += 1;
        alive.add(nextPid);
        zombies.delete(nextPid);
        const content = fs.readFileUtf8(allowlistFile);
        spawns.push({ pid: nextPid, socketPath, allowlistFile, allowlist: content === undefined ? undefined : parseAllowlistFile(content), settings });
        if (autoReady) {
          readySockets.add(socketPath);
        }
        return nextPid;
      },
      stopProcess: (pid: number) => {
        alive.delete(pid);
        stops.push(pid);
      },
      ready: async (socketPath: string) => await settled(readySockets.has(socketPath)),
      install: (spec: string) => {
        installs.push(spec);
        onInstall?.();
        if (installOk) {
          installedCommit = pinnedGitCommit(spec);
          // A successful install puts the binary on PATH, like the real one does.
          version ??= "headroom 0.39.1";
          return { ok: true };
        }
        return { ok: false, error: "uv is not installed or not on PATH (spawn ENOENT)" };
      },
      headroomVersion: () => version,
      installedCommit: () => installedCommit,
      log: (line: string) => {
        logLines.push(line);
      },
    } satisfies SupervisorPorts,
  };
  return world;
}

export const config = resolveSupervisorConfig({});

/** Runs the supervisor against `world` with `supervisorConfig` as both its starting configuration and what it reads from disk each tick. */
export async function supervise(world: ReturnType<typeof makeWorld>, supervisorConfig: HeadroomSupervisorConfig, options?: RunSupervisorOptions): Promise<number> {
  world.setConfig(supervisorConfig);
  return await runSupervisor(supervisorConfig, world.ports, options);
}

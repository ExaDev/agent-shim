import path from "node:path";

import { describe, expect, it } from "vitest";

import { listFrontDoorDirectRecords, removeFrontDoorDirectRecord, writeFrontDoorDirectRecord, writeFrontDoorState } from "../frontdoor/state";
import { FAKE_UID } from "../test-helpers";
import { HEADROOM_SUPERVISOR_STILL_RUNNING, runSupervisor, type SupervisorPorts } from "./supervisor";
import { formatAllowlistFile, HeadroomStateSchema, hashAllowlist, parseAllowlistFile, readHeadroomState } from "./state";
import {
  paths,
  OWN_SOCKET,
  SESSION_PID,
  TICKS_INSTALL_TEST,
  TICKS_SHORT,
  TICKS_DRIFT_TEST,
  IDLE_NEVER_MINUTES,
  makeWorld,
  config,
  supervise,
} from "./supervisorTestWorld";

/** The front door's direct port before and after it moves. */
const DOOR_DIRECT_PORT = 50123;
const MOVED_DOOR_DIRECT_PORT = 50999;
const DOOR_ORIGIN = `http://127.0.0.1:${String(DOOR_DIRECT_PORT)}`;
const MOVED_DOOR_ORIGIN = `http://127.0.0.1:${String(MOVED_DOOR_DIRECT_PORT)}`;
/** The front door supervisor serving on the first direct port, and the one that supersedes it on the second. */
const OLD_DOOR_PID = 7001;
const NEW_DOOR_PID = 7002;
/** The owner-only file mode the allowlist file must be written with. */
const OWNER_ONLY_FILE_MODE = 0o600;
/** The mode a umask of 002 gives a new directory: writable by its group, which headroom refuses for the allowlist file's directory. */
const GROUP_WRITABLE_DIR_MODE = 0o775;
/** A file its group may read, and a directory its group may enter: both fail agent-shim's owner-only rule, and both are repairable. */
const GROUP_READABLE_FILE_MODE = 0o640;
const GROUP_READABLE_DIR_MODE = 0o750;
/** Another user's uid. */
const OTHER_UID = 0;
/** The owner-only mode the run directory is narrowed to. */
const OWNER_ONLY_DIR_MODE = 0o700;

describe("runSupervisor: the allowlist file", () => {
  it("writes the allowlist file owner-only before the daemon starts and points the daemon at it", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    await supervise(world, config, { tickLimit: TICKS_SHORT });
    // The door's direct origin alone: no provider is ever on the allowlist.
    const expected = [DOOR_ORIGIN];
    expect(world.spawns.map((spawn) => [spawn.allowlistFile, spawn.allowlist])).toEqual([[paths.headroomAllowlistFile, expected]]);
    expect(world.fs.readFileUtf8(paths.headroomAllowlistFile)).toBe(formatAllowlistFile(expected));
    expect(world.fs.modeOf(paths.headroomAllowlistFile)).toBe(OWNER_ONLY_FILE_MODE);
    expect(readHeadroomState(world.fs, paths.headroomStateFile)?.allowlistHash).toBe(hashAllowlist(expected));
  });

  it("rewrites the allowlist file and records its hash when the front door moves under a live session, with no restart", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    let moved = false;
    world.onSleep = () => {
      if (!moved && world.spawns.length === 1) {
        world.writeSessionFile(SESSION_PID);
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: MOVED_DOOR_DIRECT_PORT });
        moved = true;
      }
    };
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_INSTALL_TEST });
    const expected = [MOVED_DOOR_ORIGIN];
    expect(world.fs.readFileUtf8(paths.headroomAllowlistFile)).toBe(formatAllowlistFile(expected));
    const state = readHeadroomState(world.fs, paths.headroomStateFile);
    expect(state?.allowlistHash).toBe(hashAllowlist(expected));
    expect(state?.headroomPid).toBe(world.spawns[0]?.pid);
    expect(state?.socketPath).toBe(OWN_SOCKET);
    expect(world.spawns).toHaveLength(1);
    expect(world.stops).toEqual([]);
  });

  it("only ever records an allowlist hash in state once the allowlist file already holds the list that hash was computed from", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    const recorded: { hash: string; fileHash: string | undefined }[] = [];
    const ports: SupervisorPorts = {
      ...world.ports,
      fs: {
        ...world.fs,
        writeFilePrivate: (file: string, contents: string) => {
          if (file === paths.headroomStateFile) {
            const hash = HeadroomStateSchema.parse(JSON.parse(contents)).allowlistHash;
            if (hash !== undefined) {
              const content = world.fs.readFileUtf8(paths.headroomAllowlistFile);
              recorded.push({ hash, fileHash: content === undefined ? undefined : hashAllowlist(parseAllowlistFile(content)) });
            }
          }
          world.fs.writeFilePrivate(file, contents);
        },
      },
    };
    let moved = false;
    world.onSleep = () => {
      if (!moved && world.spawns.length === 1) {
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: MOVED_DOOR_DIRECT_PORT });
        moved = true;
      }
    };
    world.setConfig({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES });
    await runSupervisor({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, ports, { tickLimit: TICKS_INSTALL_TEST });
    // One record at the start and one for the moved door, each already backed by the file.
    expect(new Set(recorded.map((entry) => entry.hash)).size).toBe(2);
    expect(recorded.every((entry) => entry.fileHash === entry.hash)).toBe(true);
  });

  it("leaves the allowlist file to the state's owner once another supervisor has taken it over", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    world.writeSessionFile(SESSION_PID);
    let handedOver = false;
    world.onSleep = () => {
      if (!handedOver && world.spawns.length === 1) {
        world.handOwnershipToAnotherSupervisor();
        // The owner has written its own view; this superseded supervisor must not overwrite it.
        world.fs.writeFilePrivate(paths.headroomAllowlistFile, "https://owner.example\n");
        handedOver = true;
      }
    };
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_INSTALL_TEST });
    expect(handedOver).toBe(true);
    expect(world.fs.readFileUtf8(paths.headroomAllowlistFile)).toBe("https://owner.example\n");
  });

  it("keeps a superseded door's direct origin admitted while that door lives, and withdraws it the tick after its pid exits", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    world.alive.add(OLD_DOOR_PID);
    world.frontDoorSupervisors.add(OLD_DOOR_PID);
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { supervisorPid: OLD_DOOR_PID, directPort: DOOR_DIRECT_PORT });
    writeFrontDoorDirectRecord(world.fs, paths.frontdoorDirectRecordsDir, { pid: OLD_DOOR_PID, directPort: DOOR_DIRECT_PORT });
    const listed: (readonly string[])[] = [];
    let ticks = 0;
    world.onSleep = () => {
      ticks += 1;
      listed.push(parseAllowlistFile(world.fs.readFileUtf8(paths.headroomAllowlistFile) ?? ""));
      if (ticks === 1) {
        // A second door takes over on another port while the old one still serves its sessions.
        world.alive.add(NEW_DOOR_PID);
        world.frontDoorSupervisors.add(NEW_DOOR_PID);
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, { supervisorPid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT });
        writeFrontDoorDirectRecord(world.fs, paths.frontdoorDirectRecordsDir, { pid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT });
      }
      if (ticks === 2) {
        // The old door's sessions end and it exits gracefully, removing its own record.
        world.alive.delete(OLD_DOOR_PID);
        removeFrontDoorDirectRecord(world.fs, paths.frontdoorDirectRecordsDir, OLD_DOOR_PID);
      }
    };
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_INSTALL_TEST });
    listed.push(parseAllowlistFile(world.fs.readFileUtf8(paths.headroomAllowlistFile) ?? ""));
    expect(listed[0]).toContain(DOOR_ORIGIN);
    expect(listed[1]).toEqual(expect.arrayContaining([DOOR_ORIGIN, MOVED_DOOR_ORIGIN]));
    expect(listed[2]).toContain(MOVED_DOOR_ORIGIN);
    expect(listed[2]).not.toContain(DOOR_ORIGIN);
    expect(world.spawns).toHaveLength(1);
  });

  it("prunes a crashed door's record, whose pid is dead but whose file was never removed, and withdraws its origin", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    world.alive.add(NEW_DOOR_PID);
    world.frontDoorSupervisors.add(NEW_DOOR_PID);
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { supervisorPid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT });
    writeFrontDoorDirectRecord(world.fs, paths.frontdoorDirectRecordsDir, { pid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT });
    writeFrontDoorDirectRecord(world.fs, paths.frontdoorDirectRecordsDir, { pid: OLD_DOOR_PID, directPort: DOOR_DIRECT_PORT });
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_SHORT });
    expect(listFrontDoorDirectRecords(world.fs, paths.frontdoorDirectRecordsDir)).toEqual([{ pid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT }]);
    expect(parseAllowlistFile(world.fs.readFileUtf8(paths.headroomAllowlistFile) ?? "")).not.toContain(DOOR_ORIGIN);
  });

  it("prunes a door record whose pid now belongs to some other live process, and withdraws its origin", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    world.alive.add(NEW_DOOR_PID);
    world.frontDoorSupervisors.add(NEW_DOOR_PID);
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { supervisorPid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT });
    writeFrontDoorDirectRecord(world.fs, paths.frontdoorDirectRecordsDir, { pid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT });
    // The old door crashed and the system handed its pid to an unrelated process.
    world.alive.add(OLD_DOOR_PID);
    writeFrontDoorDirectRecord(world.fs, paths.frontdoorDirectRecordsDir, { pid: OLD_DOOR_PID, directPort: DOOR_DIRECT_PORT });
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_SHORT });
    expect(listFrontDoorDirectRecords(world.fs, paths.frontdoorDirectRecordsDir)).toEqual([{ pid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT }]);
    expect(parseAllowlistFile(world.fs.readFileUtf8(paths.headroomAllowlistFile) ?? "")).not.toContain(DOOR_ORIGIN);
  });

  it("keeps every door record and its origin while the process table cannot be read, and prunes once it can", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    // Neither pid is running any more, but ps cannot say so.
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { supervisorPid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT });
    writeFrontDoorDirectRecord(world.fs, paths.frontdoorDirectRecordsDir, { pid: OLD_DOOR_PID, directPort: DOOR_DIRECT_PORT });
    world.processTableUnreadable = "ps timed out";
    let readable = false;
    world.onSleep = () => {
      if (!readable) {
        expect(listFrontDoorDirectRecords(world.fs, paths.frontdoorDirectRecordsDir)).toEqual([{ pid: OLD_DOOR_PID, directPort: DOOR_DIRECT_PORT }]);
        expect(parseAllowlistFile(world.fs.readFileUtf8(paths.headroomAllowlistFile) ?? "")).toContain(DOOR_ORIGIN);
        world.processTableUnreadable = undefined;
        readable = true;
      }
    };
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_SHORT });
    expect(readable).toBe(true);
    expect(listFrontDoorDirectRecords(world.fs, paths.frontdoorDirectRecordsDir)).toEqual([]);
    expect(parseAllowlistFile(world.fs.readFileUtf8(paths.headroomAllowlistFile) ?? "")).not.toContain(DOOR_ORIGIN);
  });

  it("keeps ticking past a records entry it cannot read, and clears a record file that holds no record", async () => {
    const world = makeWorld();
    world.alive.add(NEW_DOOR_PID);
    world.frontDoorSupervisors.add(NEW_DOOR_PID);
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { supervisorPid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT });
    world.fs.mkdirp(`${paths.frontdoorDirectRecordsDir}/${String(OLD_DOOR_PID)}.json`);
    world.fs.writeFileUtf8(`${paths.frontdoorDirectRecordsDir}/${String(NEW_DOOR_PID)}.json`, "{ truncated");
    const code = await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_SHORT });
    expect(code).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(world.fs.readdir(paths.frontdoorDirectRecordsDir)).toEqual([`${String(OLD_DOOR_PID)}.json`]);
    expect(parseAllowlistFile(world.fs.readFileUtf8(paths.headroomAllowlistFile) ?? "")).toEqual([MOVED_DOOR_ORIGIN]);
  });

  it("reads the process table once per tick for every recorded door at once", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    for (const pid of [OLD_DOOR_PID, NEW_DOOR_PID]) {
      world.alive.add(pid);
      world.frontDoorSupervisors.add(pid);
    }
    writeFrontDoorDirectRecord(world.fs, paths.frontdoorDirectRecordsDir, { pid: OLD_DOOR_PID, directPort: DOOR_DIRECT_PORT });
    writeFrontDoorDirectRecord(world.fs, paths.frontdoorDirectRecordsDir, { pid: NEW_DOOR_PID, directPort: MOVED_DOOR_DIRECT_PORT });
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_INSTALL_TEST });
    // One read for the start-up log line, then one per tick.
    expect(world.livenessReads).toEqual(Array.from({ length: TICKS_INSTALL_TEST + 1 }, () => [OLD_DOOR_PID, NEW_DOOR_PID]));
  });

  it("never rewrites the allowlist file for a provider file added, saved half-written or deleted, since no provider is on it", async () => {
    const world = makeWorld([{ name: "z", baseUrl: "https://api.z.ai/api/anthropic" }]);
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    const allowlistWrites: string[] = [];
    const ports: SupervisorPorts = {
      ...world.ports,
      fs: {
        ...world.fs,
        writeFilePrivate: (file: string, contents: string) => {
          if (file === paths.headroomAllowlistFile) {
            allowlistWrites.push(contents);
          }
          world.fs.writeFilePrivate(file, contents);
        },
      },
    };
    let ticks = 0;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === 1) {
        world.fs.writeFileUtf8(`${paths.providersDir}/m.json`, JSON.stringify({ displayName: "MiniMax", baseUrl: "https://api.minimax.io", credential: { sources: [{ env: "T" }] } }));
      }
      if (ticks === 2) {
        world.fs.writeFileUtf8(`${paths.providersDir}/z.json`, '{ "displayName": "z", "baseUrl": ');
      }
      if (ticks === TICKS_INSTALL_TEST) {
        world.fs.removeRecursive(`${paths.providersDir}/m.json`);
      }
    };
    world.setConfig({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES });
    await runSupervisor({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, ports, { tickLimit: TICKS_INSTALL_TEST + 1 });
    expect(allowlistWrites).toEqual([formatAllowlistFile([DOOR_ORIGIN])]);
    expect(world.spawns).toHaveLength(1);
  });

  it("keeps the allowlist file in the owner-only run directory, narrowing a headroom directory tree left group-writable", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    // A umask of 002, or an older release, left both directories group-writable; headroom refuses an allowlist file whose directory is.
    world.fs.mkdirp(paths.headroomSocketDir);
    world.fs.setMode(paths.headroomDir, GROUP_WRITABLE_DIR_MODE);
    world.fs.setMode(paths.headroomSocketDir, GROUP_WRITABLE_DIR_MODE);
    await supervise(world, config, { tickLimit: TICKS_SHORT });
    expect(path.dirname(paths.headroomAllowlistFile)).toBe(paths.headroomSocketDir);
    expect(world.fs.modeOf(paths.headroomSocketDir)).toBe(OWNER_ONLY_DIR_MODE);
    expect(world.fs.modeOf(paths.headroomAllowlistFile)).toBe(OWNER_ONLY_FILE_MODE);
    expect(readHeadroomState(world.fs, paths.headroomStateFile)?.allowlistHash).toBe(hashAllowlist([DOOR_ORIGIN]));
  });

  it("stops the daemon at once, changing nothing outside its own root, when a home directory above the root is group-writable", async () => {
    const world = makeWorld();
    const home = path.dirname(paths.root);
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    let widened = false;
    world.onSleep = () => {
      if (!widened && world.spawns.length === 1) {
        world.socketStats = { [home]: { kind: "dir", uid: FAKE_UID, mode: GROUP_WRITABLE_DIR_MODE } };
        widened = true;
      }
    };
    world.setConfig({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES });
    const writesBefore = (): readonly string[] => world.fs.writes.filter((write) => !write.path.startsWith(paths.root)).map((write) => write.path);
    const code = await runSupervisor({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_INSTALL_TEST });
    expect(code).toBe(1);
    expect(world.stops).toEqual([world.spawns[0]?.pid]);
    expect(writesBefore()).toEqual([]);
    expect(readHeadroomState(world.fs, paths.headroomStateFile)?.lastError).toBe(
      `headroom would refuse its allowlist file, and agent-shim cannot repair it: the directory ${home} on the allowlist file's path is writable by group or others (mode 0775), so headroom refuses the file; run \`chmod go-w ${home}\``,
    );
  });

  it("repairs a group-readable allowlist file in place, with no daemon restart", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    let widened = false;
    world.onSleep = () => {
      if (!widened && world.spawns.length === 1) {
        world.fs.setMode(paths.headroomAllowlistFile, GROUP_READABLE_FILE_MODE);
        widened = true;
      }
    };
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_INSTALL_TEST });
    expect(world.fs.modeOf(paths.headroomAllowlistFile)).toBe(OWNER_ONLY_FILE_MODE);
    expect(world.spawns).toHaveLength(1);
    expect(world.stops).toEqual([]);
    expect(readHeadroomState(world.fs, paths.headroomStateFile)?.lastError).toBeUndefined();
  });

  it("narrows a widened run directory, with no daemon restart", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    let widened = false;
    world.onSleep = () => {
      if (!widened && world.spawns.length === 1) {
        world.fs.setMode(paths.headroomSocketDir, GROUP_READABLE_DIR_MODE);
        widened = true;
      }
    };
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_INSTALL_TEST });
    expect(world.fs.modeOf(paths.headroomSocketDir)).toBe(OWNER_ONLY_DIR_MODE);
    expect(world.spawns).toHaveLength(1);
    expect(world.stops).toEqual([]);
  });

  it("replaces a symlink left at the allowlist file's path with the real file", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    world.fs.mkdirPrivate(paths.headroomSocketDir);
    world.fs.seed({ [paths.headroomAllowlistFile]: { symlink: "/somewhere/else" } });
    await supervise(world, config, { tickLimit: TICKS_SHORT });
    expect(world.fs.linkTarget(paths.headroomAllowlistFile)).toBeUndefined();
    expect(world.fs.readFileUtf8(paths.headroomAllowlistFile)).toBe(formatAllowlistFile([DOOR_ORIGIN]));
    expect(world.spawns).toHaveLength(1);
  });

  it("stops the daemon and exits with lastError, recording no hash, when the allowlist file fails the owner-only rule and rewriting it cannot repair it", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    let foreign = false;
    world.onSleep = () => {
      if (!foreign && world.spawns.length === 1) {
        // Another user's file, which this user can neither chmod nor see change by rewriting.
        world.socketStats = { [paths.headroomAllowlistFile]: { kind: "file", uid: OTHER_UID, mode: OWNER_ONLY_FILE_MODE } };
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: MOVED_DOOR_DIRECT_PORT });
        foreign = true;
      }
    };
    world.setConfig({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES });
    const code = await runSupervisor({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_INSTALL_TEST });
    expect(code).toBe(1);
    expect(world.stops).toEqual([world.spawns[0]?.pid]);
    const state = readHeadroomState(world.fs, paths.headroomStateFile);
    expect(state?.allowlistHash).toBeUndefined();
    expect(state?.lastError).toBe(
      `the allowlist file breaks agent-shim's rules for it, and rewriting it did not repair it: the headroom allowlist file ${paths.headroomAllowlistFile} is owned by uid ${String(OTHER_UID)}, not by this user (uid ${String(FAKE_UID)})`,
    );
  });

  it("stops the daemon when a directory sits at the allowlist file's path, which no rewrite can replace", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    let blocked = false;
    world.onSleep = () => {
      if (!blocked && world.spawns.length === 1) {
        world.fs.removeRecursive(paths.headroomAllowlistFile);
        world.fs.mkdirp(`${paths.headroomAllowlistFile}/occupied`);
        blocked = true;
      }
    };
    world.setConfig({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES });
    const code = await runSupervisor({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, world.ports, { tickLimit: TICKS_INSTALL_TEST });
    expect(code).toBe(1);
    expect(world.stops).toEqual([world.spawns[0]?.pid]);
    expect(readHeadroomState(world.fs, paths.headroomStateFile)?.lastError).toContain(`could not write the headroom allowlist file ${paths.headroomAllowlistFile}`);
  });


  it("restores an allowlist file removed or edited behind its back on the next tick", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    let ticks = 0;
    world.onSleep = () => {
      ticks += 1;
      if (ticks === 1) {
        world.fs.removeRecursive(paths.headroomAllowlistFile);
      }
      if (ticks === 2) {
        expect(world.fs.readFileUtf8(paths.headroomAllowlistFile)).toBe(formatAllowlistFile([DOOR_ORIGIN]));
        world.fs.writeFileUtf8(paths.headroomAllowlistFile, "https://example.com\n");
      }
    };
    await supervise(world, { ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, { tickLimit: TICKS_INSTALL_TEST });
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(world.fs.readFileUtf8(paths.headroomAllowlistFile)).toBe(formatAllowlistFile([DOOR_ORIGIN]));
    expect(world.spawns).toHaveLength(1);
  });

  it("exits with lastError naming the file, stopping the daemon, when the allowlist file cannot be written", async () => {
    const world = makeWorld();
    writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: DOOR_DIRECT_PORT });
    let writable = true;
    const ports: SupervisorPorts = {
      ...world.ports,
      fs: {
        ...world.fs,
        writeFilePrivate: (file: string, contents: string) => {
          if (!writable && file === paths.headroomAllowlistFile) {
            throw new Error("EACCES: permission denied");
          }
          world.fs.writeFilePrivate(file, contents);
        },
      },
    };
    world.onSleep = () => {
      if (world.spawns.length === 1 && writable) {
        writable = false;
        writeFrontDoorState(world.fs, paths.frontdoorStateFile, { directPort: MOVED_DOOR_DIRECT_PORT });
      }
    };
    world.setConfig({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES });
    const code = await runSupervisor({ ...config, idleShutdownMinutes: IDLE_NEVER_MINUTES }, ports, { tickLimit: TICKS_DRIFT_TEST });
    expect(code).toBe(1);
    expect(world.stops).toEqual([world.spawns[0]?.pid]);
    expect(readHeadroomState(world.fs, paths.headroomStateFile)?.lastError).toBe(
      `could not write the headroom allowlist file ${paths.headroomAllowlistFile}: EACCES: permission denied`,
    );
  });

  it("never starts a daemon when the allowlist file cannot be written in the first place", async () => {
    const world = makeWorld();
    const ports: SupervisorPorts = {
      ...world.ports,
      fs: {
        ...world.fs,
        writeFilePrivate: (file: string, contents: string) => {
          if (file === paths.headroomAllowlistFile) {
            throw new Error("ENOSPC: no space left on device");
          }
          world.fs.writeFilePrivate(file, contents);
        },
      },
    };
    const code = await runSupervisor(config, ports);
    expect(code).toBe(1);
    expect(world.spawns).toHaveLength(0);
    expect(readHeadroomState(world.fs, paths.headroomStateFile)?.lastError).toContain("ENOSPC");
  });
});

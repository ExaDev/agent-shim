import { describe, expect, it } from "vitest";

import type { LogRotationLimits } from "../logRotation";
import { HEADROOM_LOG_KEPT_GENERATIONS, HEADROOM_LOG_MAX_BYTES, HEADROOM_START_RETRY_BUDGET, runSupervisor, type SupervisorPorts } from "./supervisor";
import { readHeadroomState } from "./state";
import { config, makeWorld, paths, supervise, TICKS_SHORT } from "./supervisorTestWorld";

/** A cap small enough for a test's few bytes of log to pass, standing in for the production cap the supervisor asks with. */
const TEST_CAP_BYTES = 10;

describe("the supervisor's daemon log rotation", () => {
  it("asks for rotation at the production cap on every tick", async () => {
    const world = makeWorld();
    const asked: LogRotationLimits[] = [];
    const ports: SupervisorPorts = {
      ...world.ports,
      rotateDaemonLog: (limits) => {
        asked.push(limits);
        return false;
      },
    };
    world.setConfig(config);
    await runSupervisor(config, ports, { tickLimit: TICKS_SHORT });
    expect(asked).toEqual(Array.from({ length: TICKS_SHORT }, () => ({ maxBytes: HEADROOM_LOG_MAX_BYTES, keptGenerations: HEADROOM_LOG_KEPT_GENERATIONS })));
  });

  it("rotates an oversized log while the daemon keeps running, and says so once", async () => {
    const world = makeWorld();
    world.fs.mkdirp(paths.logsDir);
    world.fs.writeFileUtf8(paths.headroomLogPath, "output the daemon wrote before the cap was passed\n");
    const ports: SupervisorPorts = { ...world.ports, rotateDaemonLog: (limits) => world.ports.rotateDaemonLog({ ...limits, maxBytes: TEST_CAP_BYTES }) };
    world.setConfig(config);
    await runSupervisor(config, ports, { tickLimit: TICKS_SHORT });
    expect(world.fs.readFileUtf8(`${paths.headroomLogPath}.1`)).toBe("output the daemon wrote before the cap was passed\n");
    expect(world.fs.readFileUtf8(paths.headroomLogPath) ?? "").toBe("");
    expect(world.logLines.filter((line) => line.includes("rotated the daemon log"))).toHaveLength(1);
    expect(world.spawns).toHaveLength(1);
  });

  it("leaves a log under the cap alone", async () => {
    const world = makeWorld();
    world.fs.mkdirp(paths.logsDir);
    world.fs.writeFileUtf8(paths.headroomLogPath, "short\n");
    await supervise(world, config, { tickLimit: TICKS_SHORT });
    expect(world.fs.readFileUtf8(paths.headroomLogPath)).toBe("short\n");
    expect(world.fs.lstat(`${paths.headroomLogPath}.1`)).toBeUndefined();
  });

  it("reports an early exit from the start attempt's own output even when the log was rotated between attempts", async () => {
    const world = makeWorld();
    world.autoReady = false;
    world.fs.mkdirp(paths.logsDir);
    const ports: SupervisorPorts = {
      ...world.ports,
      rotateDaemonLog: (limits) => world.ports.rotateDaemonLog({ ...limits, maxBytes: TEST_CAP_BYTES }),
      spawnHeadroom: (socketPath, allowlistFile, settings) => {
        const pid = world.ports.spawnHeadroom(socketPath, allowlistFile, settings);
        world.fs.writeFileUtf8(paths.headroomLogPath, `${world.fs.readFileUtf8(paths.headroomLogPath) ?? ""}attempt ${String(world.spawns.length)}\nError: No such option: --allowed-base-urls-file\n`);
        world.kill(pid);
        return pid;
      },
    };
    world.setConfig(config);
    expect(await runSupervisor(config, ports)).toBe(1);
    expect(world.spawns).toHaveLength(HEADROOM_START_RETRY_BUDGET);
    const lastError = readHeadroomState(world.fs, paths.headroomStateFile)?.lastError ?? "";
    expect(lastError).toContain(`attempt ${String(HEADROOM_START_RETRY_BUDGET)}`);
    expect(lastError).not.toContain("attempt 1 ");
    expect(world.fs.readFileUtf8(`${paths.headroomLogPath}.1`)).toContain("attempt");
  });
});

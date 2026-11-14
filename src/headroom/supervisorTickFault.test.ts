import { describe, expect, it } from "vitest";

import { errorWithCode } from "../test-helpers";
import { HEADROOM_SUPERVISOR_STILL_RUNNING, runSupervisor } from "./supervisor";
import { config, makeWorld } from "./supervisorTestWorld";

/** Ticks enough for one failed tick and the ones after it. */
const TICKS = 3;

describe("the headroom supervisor's loop", () => {
  it("survives a configuration read that fails for the moment, logging it, and reads again on the next tick", async () => {
    const world = makeWorld();
    world.setConfig(config);
    let failing = true;
    let reads = 0;
    const readConfig = (): ReturnType<typeof world.ports.readConfig> => {
      reads += 1;
      if (failing) {
        failing = false;
        throw errorWithCode("EMFILE: too many open files, open '/state/config.json'", "EMFILE");
      }
      return world.ports.readConfig();
    };
    const outcome = await runSupervisor(config, { ...world.ports, readConfig }, { tickLimit: TICKS });
    expect(outcome).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
    expect(reads).toBe(TICKS);
    expect(world.logLines.filter((line) => line.includes("tick failed: EMFILE"))).toHaveLength(1);
  });

  it.each(["EMFILE", "ENOSPC"])("survives a failed tick whose log line fails with %s too", async (code) => {
    const world = makeWorld();
    world.setConfig(config);
    let failing = true;
    const readConfig = (): ReturnType<typeof world.ports.readConfig> => {
      if (failing) {
        failing = false;
        throw errorWithCode(`${code}: failed, open '/state/config.json'`, code);
      }
      return world.ports.readConfig();
    };
    const log = (line: string): void => {
      if (line.includes("tick failed") || line.includes("ticked again")) throw errorWithCode(`${code}: failed, open '/state/headroom/log'`, code);
      world.ports.log(line);
    };
    const outcome = await runSupervisor(config, { ...world.ports, readConfig, log }, { tickLimit: TICKS });
    expect(outcome).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
  });
});


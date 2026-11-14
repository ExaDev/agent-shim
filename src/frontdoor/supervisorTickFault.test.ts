import { describe, expect, it } from "vitest";

import { errorWithCode } from "../test-helpers";
import { FRONTDOOR_SUPERVISOR_STILL_RUNNING, runFrontDoorSupervisor } from "./supervisor";
import { IDLE_MINUTES, makeWorld } from "./supervisorTestWorld";

/** Ticks enough for one failed tick and the ones after it. */
const TICKS = 3;

describe("the front door supervisor's loop", () => {
  it("survives a registry read that fails for the moment, logging it, and reads the registry again on the next tick", async () => {
    const world = makeWorld();
    let failing = true;
    let rescans = 0;
    const registry = { ...world.ports.registry, rescan: () => {
      rescans += 1;
      if (failing) {
        failing = false;
        throw errorWithCode("EMFILE: too many open files, scandir '/state/frontdoor/sessions'", "EMFILE");
      }
      return world.ports.registry.rescan();
    } };
    const outcome = await runFrontDoorSupervisor(IDLE_MINUTES, { ...world.ports, registry }, { tickLimit: TICKS });
    expect(outcome).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
    expect(rescans).toBe(TICKS);
    expect(world.logs.filter((line) => line.includes("tick failed: EMFILE"))).toHaveLength(1);
    expect(world.logs.filter((line) => line.includes("tick ticked again"))).toHaveLength(1);
  });

  it.each(["EMFILE", "ENOSPC"])("survives a failed tick whose log line fails with %s too", async (code) => {
    const world = makeWorld();
    let failing = true;
    const registry = { ...world.ports.registry, rescan: () => {
      if (failing) {
        failing = false;
        throw errorWithCode(`${code}: failed, scandir '/state/frontdoor/sessions'`, code);
      }
      return world.ports.registry.rescan();
    } };
    const log = (line: string): void => {
      if (line.includes("tick failed") || line.includes("ticked again")) throw errorWithCode(`${code}: failed, open '/state/frontdoor/log'`, code);
      world.ports.log(line);
    };
    const outcome = await runFrontDoorSupervisor(IDLE_MINUTES, { ...world.ports, registry, log }, { tickLimit: TICKS });
    expect(outcome).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
  });
});


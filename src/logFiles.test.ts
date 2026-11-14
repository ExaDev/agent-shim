import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HTTP_STATUS } from "./codex/http";
import { createCatalogueKeeper } from "./catalogueKeeper";
import { appendDoorLog } from "./frontdoor/doorLog";
import { FRONTDOOR_SUPERVISOR_STILL_RUNNING, runFrontDoorSupervisor } from "./frontdoor/supervisor";
import { IDLE_MINUTES, makeWorld } from "./frontdoor/supervisorTestWorld";
import { send, startWorld } from "./frontdoor/mainLoopRouteTestWorld";
import { appendHeadroomLog } from "./headroom/headroomLog";
import { HEADROOM_SUPERVISOR_STILL_RUNNING, runSupervisor } from "./headroom/supervisor";
import { config, makeWorld as makeHeadroomWorld } from "./headroom/supervisorTestWorld";
import { keepTicking } from "./keepTicking";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { errorWithCode } from "./test-helpers";

/** Turns of a supervisor's loop: the failed one and the ones after it. */
const SUPERVISOR_TICKS = 3;

let root: string;
let paths: LayoutPaths;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-log-files-"));
  paths = buildLayoutPaths(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Makes each append to a file fail with `code`, as an append opened with no descriptor left (EMFILE) or on a full disk (ENOSPC) does. */
function failAppends(code: string): void {
  vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
    throw errorWithCode(`${code}: failed, open '${paths.logsDir}'`, code);
  });
}

describe.each(["EMFILE", "ENOSPC"])("the door's and headroom's logs when a write fails with %s", (code) => {
  it("drop the door's log line rather than throw it", () => {
    failAppends(code);
    expect(() => { appendDoorLog(paths, "a line"); }).not.toThrow();
  });

  it("drop headroom's log text rather than throw it", () => {
    failAppends(code);
    expect(() => { appendHeadroomLog(paths, "a line\n"); }).not.toThrow();
  });

  it("drop a line when the logs directory cannot be made either", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw errorWithCode(`${code}: failed, mkdir '${paths.logsDir}'`, code);
    });
    expect(() => { appendDoorLog(paths, "a line"); appendHeadroomLog(paths, "a line\n"); }).not.toThrow();
  });

  it("let the front door supervisor's loop go on past a failed tick, through the door's own log", async () => {
    const world = makeWorld();
    let failing = true;
    const registry = { ...world.ports.registry, rescan: () => {
      if (failing) {
        failing = false;
        throw errorWithCode(`${code}: failed, scandir '/state/frontdoor/sessions'`, code);
      }
      return world.ports.registry.rescan();
    } };
    failAppends(code);
    const outcome = await runFrontDoorSupervisor(IDLE_MINUTES, { ...world.ports, registry, log: (line) => { appendDoorLog(paths, line); } }, { tickLimit: SUPERVISOR_TICKS });
    expect(outcome).toBe(FRONTDOOR_SUPERVISOR_STILL_RUNNING);
  });

  it("let the headroom supervisor's loop go on past a failed tick, through headroom's own log", async () => {
    const world = makeHeadroomWorld();
    world.setConfig(config);
    let failing = true;
    const readConfig = (): ReturnType<typeof world.ports.readConfig> => {
      if (failing) {
        failing = false;
        throw errorWithCode(`${code}: failed, open '/state/config.json'`, code);
      }
      return world.ports.readConfig();
    };
    failAppends(code);
    const outcome = await runSupervisor(config, { ...world.ports, readConfig, log: (line) => { appendHeadroomLog(paths, `${line}\n`); } }, { tickLimit: SUPERVISOR_TICKS });
    expect(outcome).toBe(HEADROOM_SUPERVISOR_STILL_RUNNING);
  });

  it("let the catalogue keeper's tick fail to list the providers through the door's timer and its own log", () => {
    const log = (line: string): void => { appendDoorLog(paths, line); };
    const keeper = createCatalogueKeeper({ supervisorPid: 1, providers: () => { throw errorWithCode(`${code}: failed, scandir '/state/providers'`, code); }, readCache: () => undefined, readSettings: () => undefined, refresh: async () => { await Promise.resolve(); }, nowMs: () => 0, log });
    failAppends(code);
    expect(keepTicking("catalogue keeper", keeper.tick, log)).not.toThrow();
  });

  it("let an admission refused for a registry read that failed for the moment be answered, through the door's own log", async () => {
    const world = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, () => { throw errorWithCode("EMFILE: too many open files", "EMFILE"); }, { log: (line) => { appendDoorLog(paths, line); } });
    try {
      failAppends(code);
      const answered = await send(world, { model: "claude-opus-5-5", requestClass: "main" });
      expect(answered.status, answered.text).toBe(HTTP_STATUS.serviceUnavailable);
    } finally {
      vi.restoreAllMocks();
      await world.close();
    }
  });
});

it("appends each line to its log file while the writes succeed", () => {
  appendDoorLog(paths, "door line");
  appendHeadroomLog(paths, "headroom text\n");
  expect(fs.readFileSync(paths.frontdoorLogPath, "utf8")).toMatch(/^\S+ door line\n$/u);
  expect(fs.readFileSync(paths.headroomLogPath, "utf8")).toBe("headroom text\n");
});

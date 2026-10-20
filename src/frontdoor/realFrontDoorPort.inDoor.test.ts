import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { enterProcessRole } from "../processRole";
import { realFrontDoorPort } from "./realFrontDoorPort";
import { declareThisProcessTheFrontDoor, resetFrontDoorDeclarationForTests } from "./selfIdentity";
import { FRONT_DOOR_PROTOCOL, writeFrontDoorState } from "./state";
import { realFarmFs } from "../realPorts";

const SERVING_PORT = 4100;
const SERVING_CONNECT_PORT = 4300;

describe("a launch the front door plans for itself", () => {
  let root: string;
  let leave: (() => void) | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-door-self-"));
  });

  afterEach(() => {
    leave?.();
    leave = undefined;
    resetFrontDoorDeclarationForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("registers against its own serving state without reading the process table, which would block the loop that answers every session", () => {
    const paths = buildLayoutPaths(root);
    writeFrontDoorState(realFarmFs, paths.frontdoorStateFile, { protocol: FRONT_DOOR_PROTOCOL, supervisorPid: process.pid, port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT });
    declareThisProcessTheFrontDoor();
    leave = enterProcessRole("frontdoor-supervisor");
    const up = realFrontDoorPort(paths, () => {
      throw new Error("a door that is serving starts no daemon");
    }).ensure(undefined);
    expect(up).toMatchObject({ port: SERVING_PORT, connectPort: SERVING_CONNECT_PORT });
  });
});

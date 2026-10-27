import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { enterProcessRole } from "../processRole";
import { realFarmFs, realRunningAmong } from "../realPorts";
import { registerSupervised, supervisedSessionOf } from "./registry";

describe("finding a supervised session inside the front door", () => {
  let root: string;
  let leave: (() => void) | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-registry-door-"));
  });

  afterEach(() => {
    leave?.();
    leave = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds the entry of a live launcher without a synchronous process-table read, which the door refuses", async () => {
    const paths = buildLayoutPaths(root);
    registerSupervised(realFarmFs, paths, { pid: process.pid, sessionId: "s1", pool: "subs", identity: "work", cwd: root, since: "2026-10-16T10:00:00.000Z" });
    leave = enterProcessRole("frontdoor-supervisor");

    await expect(supervisedSessionOf(realFarmFs, paths, "s1", realRunningAmong)).resolves.toMatchObject({ pool: "subs", identity: "work" });
  });
});

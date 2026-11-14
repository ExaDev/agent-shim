import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { ModelsConfig } from "../config/schema";
import { readModels } from "../modelsStore";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { realFarmFs } from "../realPorts";
import { errorWithCode } from "../test-helpers";
import { readUsageSnapshot } from "../usage/read";
import { send, startWorld } from "./mainLoopRouteTestWorld";

const TIMEOUT_MS = 30_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function layout(): LayoutPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-branches-"));
  roots.push(root);
  return buildLayoutPaths(root);
}

/** A virtual model with one provider member, so a request for it reads the models block and ranks the member on the identity's usage snapshot. */
const RANKED: ModelsConfig = { virtual: { ranked: { mode: "ordered", members: ["z/glm-9"] } } };

describe("each kind of local file fault the door's boundary refuses", () => {
  it("refuses a models block of another shape, read from config.json as the door reads it, naming the keys and doctor", async () => {
    const paths = layout();
    fs.mkdirSync(path.dirname(paths.globalConfigFile), { recursive: true });
    fs.writeFileSync(paths.globalConfigFile, JSON.stringify({ models: { virtual: { ranked: { mode: "nowhere", members: 5 } } } }));
    const world = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, undefined, { models: () => readModels(paths) });
    try {
      const answered = await send(world, { model: "ranked", requestClass: "main" });
      expect(answered.status, answered.text).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain("agent-shim doctor");
      expect(answered.text).toContain("virtual.ranked");
      expect(answered.text).not.toContain(paths.root);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("logs each refusal beside it, naming the same fault and never the path", async () => {
    const paths = layout();
    fs.mkdirSync(path.dirname(paths.globalConfigFile), { recursive: true });
    fs.writeFileSync(paths.globalConfigFile, JSON.stringify({ models: { virtual: { ranked: { mode: "nowhere", members: 5 } } } }));
    const logged: string[] = [];
    const world = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, undefined, { models: () => readModels(paths), log: (line) => { logged.push(line); } });
    try {
      expect((await send(world, { model: "ranked", requestClass: "main" })).status).toBe(HTTP_STATUS.badRequest);
      expect(logged.filter((line) => line.includes("could not be used") && line.includes("virtual.ranked"))).toHaveLength(1);
      expect(logged.join("\n")).not.toContain(paths.root);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("logs a read that failed for the moment beside its retryable refusal, naming the code", async () => {
    const logged: string[] = [];
    const world = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, undefined, { models: () => { throw errorWithCode("EMFILE: too many open files, open '/state/config.json'", "EMFILE"); }, log: (line) => { logged.push(line); } });
    try {
      expect((await send(world, { model: "ranked", requestClass: "main" })).status).toBe(HTTP_STATUS.serviceUnavailable);
      expect(logged.filter((line) => line.includes("for the moment") && line.includes("EMFILE"))).toHaveLength(1);
      expect(logged.join("\n")).not.toContain("/state/config.json");
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("logs an identity header that names no identity id beside its refusal, never echoing the header", async () => {
    const logged: string[] = [];
    const world = await startWorld(undefined, HTTP_STATUS.ok, RANKED, undefined, undefined, { log: (line) => { logged.push(line); } });
    try {
      expect((await send(world, { model: "ranked", requestClass: "main", identity: ".secret-looking" })).status).toBe(HTTP_STATUS.badRequest);
      expect(logged.filter((line) => line.includes("x-agent-shim-identity"))).toHaveLength(1);
      expect(logged.join("\n")).not.toContain(".secret-looking");
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("refuses a usage snapshot of another schema version, read as the door reads it, naming doctor", async () => {
    const paths = layout();
    fs.mkdirSync(paths.usageSnapshotsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.usageSnapshotsDir, "me.json"), JSON.stringify({ schemaVersion: 999, identity: "me" }));
    const world = await startWorld(undefined, HTTP_STATUS.ok, RANKED, undefined, undefined, { usageSnapshotOf: (identity) => (identity === undefined ? undefined : readUsageSnapshot(realFarmFs, paths.usageSnapshotsDir, identity)) });
    try {
      const answered = await send(world, { model: "ranked", requestClass: "main", identity: "me" });
      expect(answered.status, answered.text).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain("agent-shim doctor");
      expect(answered.text).not.toContain(paths.root);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { ModelsConfig } from "../config/schema";
import { createIdentityNameReader } from "../identityStore";
import { buildLayoutPaths } from "../paths";
import { NO_ROUTE_OVERRIDES } from "../routeOverridesStore";
import { errorWithCode } from "../test-helpers";
import { PROVIDERS_DIR, send, startWorld, type ModelPorts } from "./mainLoopRouteTestWorld";

const TIMEOUT_MS = 30_000;

/** A local file the door reads on the request path that it cannot read: what the system raises for one with no permissions, naming its path as the system does. */
const unreadable = (): Error => errorWithCode(`EACCES: permission denied, open '${PROVIDERS_DIR}/../state/file.json'`, "EACCES");

/** A virtual model with one provider member, so a request for it ranks members on the identity's usage snapshot. */
const MODELS: ModelsConfig = { virtual: { ranked: { mode: "ordered", members: ["z/glm-9"] } } };

/** Each port the door calls on the request path that reads the person's local state, a request that reaches it, and the ports that make it reach it with that port throwing. */
const PORTS: readonly (readonly [string, string, string | undefined, (thrown: () => never) => ModelPorts])[] = [
  ["identityNameOf", "claude-opus-5-5", undefined, (thrown) => ({ routeOverrides: () => ({ table: NO_ROUTE_OVERRIDES }), identityNameOf: () => thrown() })],
  ["routeOverrides", "claude-opus-5-5", undefined, (thrown) => ({ routeOverrides: () => thrown() })],
  ["models", "ranked", undefined, (thrown) => ({ models: () => thrown() })],
  ["targets", "family:opus", undefined, (thrown) => ({ targets: () => thrown() })],
  ["usageSnapshotOf", "ranked", undefined, (thrown) => ({ models: () => MODELS, usageSnapshotOf: () => thrown() })],
  ["accountMoves", "acct:work/opus", undefined, (thrown) => ({ accountMoves: async () => await Promise.resolve(thrown()) })],
  ["selectorState", "auto/work/opus", undefined, (thrown) => ({ selectorState: { profile: () => thrown(), identity: () => thrown(), pool: () => thrown(), poolPick: () => thrown(), sameLogin: () => thrown() } })],
];

describe("a local file the door cannot read on the request path", () => {
  it.each(PORTS)("ends the request in a named refusal with no path when %s throws, never a rejection out of the resolver", async (_port, model, provider, ports) => {
    let calls = 0;
    const thrown = (): never => {
      calls += 1;
      throw unreadable();
    };
    const world = await startWorld(undefined, HTTP_STATUS.ok, MODELS, undefined, undefined, ports(thrown));
    try {
      const answered = await send(world, { model, requestClass: "main", identity: "id-me", ...(provider === undefined ? {} : { provider }) });
      expect(calls).toBeGreaterThan(0);
      expect(answered.status, answered.text).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain("agent-shim doctor");
      expect(answered.text).toContain("EACCES");
      expect(answered.text).not.toContain(PROVIDERS_DIR);
      expect(answered.text).not.toContain("permission denied");
      expect(world.upstream.seen).toEqual([]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("refuses a main-loop Claude name by name, with no path, when a file stands where the identities directory belongs, read by the real identity name reader", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "request-path-faults-"));
    const paths = buildLayoutPaths(root);
    fs.writeFileSync(paths.identitiesDir, "not a directory");
    const world = await startWorld(undefined, HTTP_STATUS.ok, undefined, undefined, undefined, { routeOverrides: () => ({ table: NO_ROUTE_OVERRIDES }), identityNameOf: createIdentityNameReader(paths).nameOf });
    try {
      const answered = await send(world, { model: "claude-opus-5-5", requestClass: "main", identity: "id-me" });
      expect(answered.status, answered.text).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain("ENOTDIR");
      expect(answered.text).not.toContain(root);
    } finally {
      await world.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it("still fails loudly on a defect a port raises, which is no file it could not read", async () => {
    const world = await startWorld(undefined, HTTP_STATUS.ok, MODELS, undefined, undefined, { routeOverrides: () => { throw new TypeError("a defect"); } });
    try {
      const answered = await send(world, { model: "claude-opus-5-5", requestClass: "main", identity: "id-me" });
      expect(answered.status).not.toBe(HTTP_STATUS.badRequest);
      expect(answered.text).not.toContain("agent-shim doctor");
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);
});

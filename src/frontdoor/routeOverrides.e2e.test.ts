import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { realFsPort } from "../realPorts";
import { createRouteOverridesReader, withRouteOverride, writeRouteOverrides, NO_ROUTE_OVERRIDES, type RouteOverrideScope } from "../routeOverridesStore";
import type { RouteOverrides } from "../routeOverridesSchema";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { HAIKU_NAME, Z_HAIKU_MODEL, Z_OPUS_MODEL, Z_SONNET_MODEL, launchOfSession, send, startWorld } from "./mainLoopRouteTestWorld";

const TIMEOUT_MS = 30_000;
const OPUS = "claude-opus-5-5";
/** How many requests each side of a change sends: more than one, so a read per request would show. */
const REQUESTS = 5;

describe("runtime route overrides through the real door, read from a real file", () => {
  let root: string;
  let paths: LayoutPaths;
  /** How many times the door read the overrides file's contents. */
  let reads: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "route-overrides-e2e-"));
    paths = buildLayoutPaths(root);
    reads = 0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Writes the overrides with each entry set, as `route set` would, one entry at a time. */
  function set(entries: readonly (readonly [RouteOverrideScope, string, string])[]): void {
    let overrides: RouteOverrides = NO_ROUTE_OVERRIDES;
    for (const [scope, key, target] of entries) {
      overrides = withRouteOverride(overrides, scope, key, target);
    }
    writeRouteOverrides(paths, overrides);
  }

  /** A door whose overrides are read from the file under `root` through the real file system, counting each read of it. */
  async function door(identityNames: Readonly<Record<string, string>> = { me: "me" }) {
    const counting = { fileRevision: realFsPort.fileRevision, readFileUtf8: (file: string) => {
      if (file === paths.routeOverridesFile) reads += 1;
      return realFsPort.readFileUtf8(file);
    } };
    const record = mainLoopRoutesOfLiveSessions();
    const started = await startWorld(record, HTTP_STATUS.ok, undefined, undefined, undefined, { routeOverrides: createRouteOverridesReader(counting, paths.routeOverridesFile, () => undefined), identityNameOf: (id) => identityNames[id] });
    return { ...started, contextNow: () => record.routeOf(launchOfSession("s-1")) };
  }

  it("routes the main loop's Claude name to the global override's target, records the name asked for, and the helpers follow", async () => {
    set([[{ kind: "global" }, "opus", "z/glm-9"]]);
    const world = await door();
    try {
      expect((await send(world, { model: OPUS, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-9"]);
      expect(world.contextNow()).toMatchObject({ kind: "provider", provider: "z", requestedModel: OPUS, servedModel: "glm-9" });
      expect(world.records.at(0)?.requestedModel).toBe(OPUS);
      await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(world.upstream.seen.at(-1)?.model).toBe(Z_HAIKU_MODEL);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  /** Every pair of scopes, the higher set to one target and the lower to another, for an exact name and a class: the higher wins whichever is exact. */
  const SCOPES: readonly (readonly [string, RouteOverrideScope])[] = [
    ["session", { kind: "session", name: "s-1" }],
    ["identity", { kind: "identity", name: "me" }],
    ["provider", { kind: "provider", name: "z" }],
    ["global", { kind: "global" }],
  ];
  const PAIRS = SCOPES.flatMap(([higher, higherScope], index) => SCOPES.slice(index + 1).flatMap(([lower, lowerScope]) => (["exact", "class"] as const).flatMap((higherKey) => (["exact", "class"] as const).map((lowerKey) => ({ higher, higherScope, lower, lowerScope, higherKey, lowerKey })))));

  it.each(PAIRS)("lets a $higher entry ($higherKey) outrank a $lower entry ($lowerKey)", async ({ higherScope, lowerScope, higherKey, lowerKey }) => {
    set([
      [lowerScope, lowerKey === "exact" ? OPUS : "opus", "z/lower"],
      [higherScope, higherKey === "exact" ? OPUS : "opus", "z/higher"],
    ]);
    const world = await door();
    try {
      // The provider scope covers a request that would reach z, so the session is on z first, by a name no override touches.
      await send(world, { model: "z/start", requestClass: "main", identity: "me" });
      await send(world, { model: OPUS, requestClass: "main", identity: "me" });
      expect(world.upstream.seen.at(-1)?.model).toBe("higher");
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("looks the identity scope up by the name of the identity whose id the session's header carries", async () => {
    set([[{ kind: "identity", name: "work" }, "opus", "z/by-identity"]]);
    // The identity created as "work" (id "work") was renamed "personal"; another identity, id "work-2", is now "work".
    const world = await door({ work: "personal", "work-2": "work" });
    try {
      // The session on the renamed identity is not covered by the "work" scope, so it stays on the Anthropic route.
      await send(world, { model: OPUS, requestClass: "main", identity: "work" });
      expect(world.anthropicModels).toEqual([OPUS]);
      expect(world.upstream.seen).toEqual([]);
      // The session on the identity now called "work" is.
      await send(world, { model: OPUS, requestClass: "main", identity: "work-2", session: "s-2" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["by-identity"]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("prefers a scope's exact name to its class", async () => {
    set([[{ kind: "global" }, "opus", "z/by-class"], [{ kind: "global" }, OPUS, "z/by-name"]]);
    const world = await door();
    try {
      await send(world, { model: OPUS, requestClass: "main" });
      await send(world, { model: "claude-opus-5-1", requestClass: "main" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["by-name", "by-class"]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("applies a change to the next request with no restart, reading the file once per change and never per request", async () => {
    set([[{ kind: "global" }, "opus", "z/first"]]);
    const world = await door();
    try {
      for (let index = 0; index < REQUESTS; index += 1) await send(world, { model: OPUS, requestClass: "main" });
      expect(reads).toBe(1);
      set([[{ kind: "global" }, "opus", "z/second"]]);
      for (let index = 0; index < REQUESTS; index += 1) await send(world, { model: OPUS, requestClass: "main" });
      expect(reads).toBe(2);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([...Array<string>(REQUESTS).fill("first"), ...Array<string>(REQUESTS).fill("second")]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("never reads the file for a helper, a name that is no Claude name, or a request that is no Messages request", async () => {
    set([[{ kind: "global" }, "haiku", "z/never"]]);
    const world = await door();
    try {
      await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      await send(world, { model: "z/glm-9", requestClass: "main" });
      await fetch(`${world.url}/v1/messages/batches`, { method: "GET", headers: { "x-agent-shim-auth": "launch-token-for-tests:s-1", "x-agent-shim-session": "s-1" } });
      expect(reads).toBe(0);
      expect(world.upstream.seen.map((seen) => seen.model)).not.toContain("never");
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("routes by a selector target and by a virtual or Anthropic target", async () => {
    set([[{ kind: "global" }, "sonnet", "auto/provider:z/opus"], [{ kind: "global" }, "haiku", "anthropic/claude-haiku-5-1"]]);
    const world = await door();
    try {
      await send(world, { model: "claude-sonnet-5-5", requestClass: "main" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([Z_OPUS_MODEL]);
      await send(world, { model: HAIKU_NAME, requestClass: "main" });
      expect(world.anthropicModels).toEqual(["claude-haiku-5-1"]);
      expect(world.contextNow()).toMatchObject({ kind: "anthropic", requestedModel: HAIKU_NAME });
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("refuses a main-loop Claude name while the file cannot be used, and serves again once it is fixed", async () => {
    fs.writeFileSync(paths.routeOverridesFile, "{ not json");
    const world = await door();
    try {
      const refused = await send(world, { model: OPUS, requestClass: "main" });
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
      expect(refused.text).toContain("not JSON");
      expect(refused.text).toContain("agent-shim doctor");
      expect(refused.text).not.toContain(root);
      expect(world.upstream.seen).toEqual([]);
      expect(world.toAnthropic).toEqual([]);
      set([[{ kind: "global" }, "opus", "z/fixed"]]);
      expect((await send(world, { model: OPUS, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["fixed"]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("refuses a request whose override routes it by a selector that cannot be routed, naming the override", async () => {
    // Written by hand, since `route set` refuses a target naming nothing.
    fs.writeFileSync(paths.routeOverridesFile, JSON.stringify({ schemaVersion: 1, global: { opus: "auto/nothing" } }));
    const world = await door();
    try {
      const refused = await send(world, { model: OPUS, requestClass: "main" });
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
      expect(refused.text).toContain(`the route override of \\"${OPUS}\\" routes it by \\"auto/nothing\\"`);
      expect(world.upstream.seen).toEqual([]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("refuses an override to the Anthropic route in a session launched on a provider, and serves it in one launched without", async () => {
    set([[{ kind: "global" }, "opus", "anthropic/claude-opus-5-1"]]);
    const world = await door();
    try {
      const refused = await send(world, { model: OPUS, requestClass: "main", provider: "z" });
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
      expect(refused.text).toContain("launched on provider");
      expect(world.upstream.seen).toEqual([]);
      await send(world, { model: OPUS, requestClass: "main", session: "s-2" });
      expect(world.anthropicModels).toEqual(["claude-opus-5-1"]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("leaves a session with no override where its context says", async () => {
    set([[{ kind: "session", name: "another" }, "sonnet", "z/elsewhere"]]);
    const world = await door();
    try {
      await send(world, { model: "z/start", requestClass: "main" });
      await send(world, { model: "claude-sonnet-5-5", requestClass: "main" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["start", Z_SONNET_MODEL]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);
});

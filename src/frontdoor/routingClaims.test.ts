import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { SelectorStatePorts } from "../models/selectorPorts";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { realFsPort } from "../realPorts";
import { createRouteOverridesReader, NO_ROUTE_OVERRIDES, withRouteOverride, writeRouteOverrides } from "../routeOverridesStore";
import type { RouteOverrides } from "../routeOverridesSchema";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { HAIKU_NAME, send, startWorld, Z_HAIKU_MODEL, Z_SONNET_MODEL, type ModelPorts } from "./mainLoopRouteTestWorld";

/** Identities `me` (the session's, id `id-me`) and `work` (another login), and a profile `plain` with no provider. */
const STATE: SelectorStatePorts = {
  profile: (name) => (name === "plain" ? { kind: "found", value: { provider: undefined } } : { kind: "absent" }),
  identity: (name) => (name === "me" || name === "work" ? { kind: "found", value: { provider: undefined } } : { kind: "absent" }),
  pool: () => ({ kind: "absent" }),
  poolPick: (name) => ({ refusal: `no pool "${name}"` }),
  sameLogin: (identity, sessionIdentityId) => sessionIdentityId === "id-me" && identity === "me",
};

const TIMEOUT_MS = 30_000;
const OPUS = "claude-opus-5-5";

/**
 * The routing behaviours `docs/configuration-model.md` states for selectors and overrides, each driven through the real door: these are what the sentences promise.
 */
describe("what the configuration model says the door does", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "routing-claims-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A door over `overrides` and the selector state above, with extra ports. */
  async function door(overrides: RouteOverrides = NO_ROUTE_OVERRIDES, ports: ModelPorts = {}) {
    writeRouteOverrides(paths, overrides);
    return await startWorld(mainLoopRoutesOfLiveSessions(), HTTP_STATUS.ok, undefined, undefined, undefined, { selectorState: STATE, routeOverrides: createRouteOverridesReader(realFsPort, paths.routeOverridesFile, () => undefined), identityNameOf: (id) => (id === "id-me" ? "me" : undefined), ...ports });
  }

  it("leaves a supervised session a move request for a selector that lands on another login, and forwards nothing", async () => {
    const moves: (readonly [string, string, string])[] = [];
    const world = await door(NO_ROUTE_OVERRIDES, { accountMoves: async (sessionId, to, model) => { moves.push([sessionId, to, model]); return await Promise.resolve(true); } });
    try {
      const answered = await send(world, { model: "auto/work/sonnet", requestClass: "main", identity: "id-me" });
      expect(moves).toEqual([["s-1", "work", "sonnet"]]);
      expect(answered.status).not.toBe(HTTP_STATUS.internalServerError);
      expect(world.upstream.seen).toEqual([]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("covers by the provider scope a session launched on the provider and one whose main loop was last served there, and no session on the Anthropic route", async () => {
    const world = await door(withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "provider", name: "z" }, "opus", "z/by-scope"));
    try {
      await send(world, { model: OPUS, requestClass: "main", provider: "z", session: "launched" });
      await send(world, { model: "z/start", requestClass: "main", session: "served" });
      await send(world, { model: OPUS, requestClass: "main", session: "served" });
      await send(world, { model: OPUS, requestClass: "main", session: "anthropic" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["by-scope", "start", "by-scope"]);
      expect(world.anthropicModels).toEqual([OPUS]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("applies a target once: a target another entry would override is sent as itself", async () => {
    const world = await door(withRouteOverride(withRouteOverride(NO_ROUTE_OVERRIDES, { kind: "global" }, "opus", "claude-sonnet-5-5"), { kind: "global" }, "sonnet", "z/never"));
    try {
      await send(world, { model: OPUS, requestClass: "main" });
      expect(world.anthropicModels).toEqual(["claude-sonnet-5-5"]);
      expect(world.upstream.seen).toEqual([]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("lets a provider file called anthropic claim the name in a session launched on a provider", async () => {
    const world = await door();
    try {
      world.setProvider("anthropic", { displayName: "A", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "a" }] } });
      const answered = await send(world, { model: "auto/plain/claude-opus-5-1", requestClass: "main", identity: "id-me", provider: "z" });
      expect(answered.status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["claude-opus-5-1"]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("expands an auto/ name before the session provider's own model names, and reaches a provider model whose id starts auto/ as <provider>/auto/...", async () => {
    const world = await door();
    try {
      // Provider z's own env names a model `auto/z/haiku`, which is still a selector, and a model `auto/tuned`, reached qualified.
      world.setProvider("z", { displayName: "Z", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "z-token" }] }, env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: Z_HAIKU_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: Z_SONNET_MODEL, ANTHROPIC_MODEL: "auto/z/haiku" } });
      await send(world, { model: "auto/z/haiku", requestClass: "main", provider: "z" });
      await send(world, { model: "z/auto/tuned", requestClass: "main", provider: "z" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([Z_HAIKU_MODEL, "auto/tuned"]);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);

  it("refuses a provider selector with no class on a provider that has no default model, naming the fix", async () => {
    const world = await door();
    try {
      world.setProvider("nodefault", { displayName: "N", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "n" }] } });
      const refused = await send(world, { model: "auto/nodefault", requestClass: "main" });
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
      expect(refused.text).toContain("has no default model");
      expect(world.upstream.seen).toEqual([]);
      const helper = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(helper.status).toBe(HTTP_STATUS.badGateway);
    } finally {
      await world.close();
    }
  }, TIMEOUT_MS);
});

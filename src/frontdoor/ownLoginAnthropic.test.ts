import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { SelectorStatePorts } from "../models/selectorPorts";
import { NO_ROUTE_OVERRIDES } from "../routeOverridesStore";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { send, startWorld } from "./mainLoopRouteTestWorld";
import type { RouteOverridesRead } from "../routeOverridesStore";

const TIMEOUT_MS = 30_000;
const OWN_MODEL = "claude-opus-5-1";

/** The session's own identity `me`, no profile or pool, and `me` the login of the session's identity id `id-me`. */
const SELF: SelectorStatePorts = {
  profile: () => ({ kind: "absent" }),
  identity: (name) => (name === "me" ? { kind: "found", value: { provider: undefined } } : { kind: "absent" }),
  pool: () => ({ kind: "absent" }),
  poolPick: (name) => ({ refusal: `pool "${name}" picks nobody` }),
  sameLogin: (identity, sessionIdentityId) => identity === "me" && sessionIdentityId === "id-me",
};

/** A door with a provider file called `anthropic` that serves from the fake upstream, so a request it claims is seen there, and the overrides `table`. */
async function world(table: RouteOverridesRead = { table: NO_ROUTE_OVERRIDES }) {
  const started = await startWorld(mainLoopRoutesOfLiveSessions(), HTTP_STATUS.ok, undefined, undefined, undefined, { selectorState: SELF, routeOverrides: () => table, identityNameOf: (id) => (id === "id-me" ? "me" : undefined) });
  started.setProvider("anthropic", { displayName: "Anthropic-named", baseUrl: `http://127.0.0.1:${String(started.upstreamPort)}`, credential: { sources: [{ literal: "named-token" }] } });
  return started;
}

describe("the session's own login beside a provider file called anthropic", () => {
  it.each<[string, string, RouteOverridesRead | undefined]>([
    ["a selector naming the session's own identity", "auto/me/claude-opus-5-1", undefined],
    ["an account target naming it", "acct:me/claude-opus-5-1", undefined],
    ["an override whose target is that selector", "claude-opus-5-5", { table: { ...NO_ROUTE_OVERRIDES, global: { "claude-opus-5-5": "auto/me/claude-opus-5-1" } } }],
    ["an override whose target is that account target", "claude-opus-5-5", { table: { ...NO_ROUTE_OVERRIDES, global: { "claude-opus-5-5": "acct:me/claude-opus-5-1" } } }],
  ])("serves %s on the Anthropic route, never on that provider's credential", async (_label, model, table) => {
    const door = await world(table);
    try {
      const answered = await send(door, { model, requestClass: "main", identity: "id-me" });
      // The test's stand-in for the Anthropic route answers 502.
      expect(answered.status, answered.text).toBe(HTTP_STATUS.badGateway);
      expect(door.anthropicModels.at(-1)).toBe(OWN_MODEL);
      expect(door.upstream.seen).toEqual([]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("serves a helper's selector naming the session's own identity on the Anthropic route too", async () => {
    const door = await world();
    try {
      expect((await send(door, { model: "auto/me/claude-opus-5-1", requestClass: "subagent", identity: "id-me" })).status).toBe(HTTP_STATUS.badGateway);
      expect(door.anthropicModels.at(-1)).toBe(OWN_MODEL);
      expect(door.upstream.seen).toEqual([]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("still lets the provider claim `anthropic/<model>` when the session itself writes it", async () => {
    const door = await world();
    try {
      expect((await send(door, { model: "anthropic/claude-opus-5-1", requestClass: "main", identity: "id-me" })).status).toBe(HTTP_STATUS.ok);
      expect(door.upstream.seen.map((seen) => seen.model)).toEqual([OWN_MODEL]);
      expect(door.anthropicModels).toEqual([]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("refuses the session's own login in a session launched on a provider, whatever the providers are called, since its requests carry no Anthropic login", async () => {
    const door = await world();
    try {
      const answered = await send(door, { model: "auto/me/claude-opus-5-1", requestClass: "main", identity: "id-me", provider: "z" });
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain("without --provider");
      expect(door.upstream.seen).toEqual([]);
      expect(door.anthropicModels).toEqual([]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);
});

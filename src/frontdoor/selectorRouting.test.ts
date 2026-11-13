import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { SelectorStatePorts } from "../models/selectorPorts";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { PROVIDERS_DIR, HAIKU_NAME, Z_HAIKU_MODEL, Z_OPUS_MODEL, Z_SONNET_MODEL, launchOfSession, send, startWorld } from "./mainLoopRouteTestWorld";

/** The configuration a selector reads: the session's own identity `me` and its twin `twin` (one login), another login `work`, an identity `zid` on provider `z`, a pool `subs` picking `work`, a pool `mine` picking `twin`, a pool named like the provider `z`, a profile `zprof` on `z` and a profile `plain` with no provider. */
const STATE: SelectorStatePorts = {
  profile: (name) => (name === "zprof" ? { kind: "found", value: { provider: "z" } } : name === "plain" ? { kind: "found", value: { provider: undefined } } : { kind: "absent" }),
  identity: (name) => (name === "me" || name === "twin" || name === "work" ? { kind: "found", value: { provider: undefined } } : name === "zid" ? { kind: "found", value: { provider: "z" } } : { kind: "absent" }),
  pool: (name) => (name === "subs" || name === "mine" || name === "z" ? { kind: "found", value: undefined } : { kind: "absent" }),
  poolPick: (name) => (name === "subs" ? { identity: "work" } : name === "mine" ? { identity: "twin" } : { refusal: `pool "${name}" picks nobody` }),
  // The session's header carries its identity's directory id, "id-me", never the name "me".
  sameLogin: (identity, sessionIdentityId) => sessionIdentityId === "id-me" && (identity === "me" || identity === "twin"),
};

const TIMEOUT_MS = 30_000;

/** A door with the selector state above and an empty route record, ready for one session `s-1` running as identity `me`. */
async function world() {
  const record = mainLoopRoutesOfLiveSessions();
  const started = await startWorld(record, HTTP_STATUS.ok, undefined, undefined, undefined, { selectorState: STATE });
  return { ...started, record, contextNow: () => record.routeOf(launchOfSession("s-1")) };
}

describe("a model name auto/<selector>[/<class>] through the real door", () => {
  it("routes a provider selector with a class to the provider's own model for the class, moves the main loop there, and its helpers follow", async () => {
    const door = await world();
    try {
      const main = await send(door, { model: "auto/provider:z/sonnet", requestClass: "main", identity: "id-me" });
      expect(main.status).toBe(HTTP_STATUS.ok);
      expect(door.upstream.seen.at(-1)?.model).toBe(Z_SONNET_MODEL);
      expect(door.contextNow()).toMatchObject({ kind: "provider", provider: "z", requestedModel: "auto/provider:z/sonnet", servedModel: Z_SONNET_MODEL });
      const helper = await send(door, { model: HAIKU_NAME, requestClass: "auxiliary", identity: "id-me" });
      expect(helper.status).toBe(HTTP_STATUS.ok);
      expect(door.upstream.seen.at(-1)?.model).toBe(Z_HAIKU_MODEL);
      expect(door.toAnthropic).toEqual([]);
      expect(door.records.at(0)?.requestedModel).toBe("auto/provider:z/sonnet");
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it.each<[string, string]>([
    ["auto/provider:z/opus", Z_OPUS_MODEL],
    ["auto/provider:z/glm-9", "glm-9"],
    ["auto/zprof/sonnet", Z_SONNET_MODEL],
    ["auto/zid/haiku", Z_HAIKU_MODEL],
    ["auto/provider:z/sonnet[1m]", Z_SONNET_MODEL],
  ])("routes %j to provider z under %j", async (name, model) => {
    const door = await world();
    try {
      expect((await send(door, { model: name, requestClass: "main", identity: "id-me" })).status).toBe(HTTP_STATUS.ok);
      expect(door.upstream.seen.map((seen) => seen.model)).toEqual([model]);
      expect(door.contextNow()).toMatchObject({ kind: "provider", provider: "z", requestedModel: name });
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("serves a provider selector with no class under the model the bare provider name selects", async () => {
    const door = await world();
    try {
      await send(door, { model: "z", requestClass: "main", identity: "id-me" });
      await send(door, { model: "auto/provider:z", requestClass: "main", identity: "id-me" });
      const [bare, selected] = door.upstream.seen.map((seen) => seen.model);
      expect(selected).toBe(bare);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("sends an account selector on the session's own login, with an exact model, to the Anthropic route and moves the context there", async () => {
    const door = await world();
    try {
      await send(door, { model: "z/glm-9", requestClass: "main", identity: "id-me" });
      await send(door, { model: "auto/pool:mine/claude-opus-5-5", requestClass: "main", identity: "id-me" });
      expect(door.anthropicModels).toEqual(["claude-opus-5-5"]);
      expect(door.contextNow()).toMatchObject({ kind: "anthropic", requestedModel: "auto/pool:mine/claude-opus-5-5" });
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it.each<[string, string]>([
    ["auto/work/sonnet", "claude @work --resume"],
    ["auto/pool:subs/sonnet", "claude @work --resume"],
  ])("never forwards %j, an account selector on another login, and names the relaunch", async (name, next) => {
    const door = await world();
    try {
      const answered = await send(door, { model: name, requestClass: "main", identity: "id-me" });
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain(next);
      expect(door.upstream.seen).toEqual([]);
      expect(door.toAnthropic).toEqual([]);
      expect(door.contextNow()).toBeUndefined();
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it.each<[string, readonly string[]]>([
    ["auto/z/sonnet", ["ambiguous", "auto/pool:z/sonnet", "auto/provider:z/sonnet"]],
    ["auto/nobody", ["no configuration profile, identity, pool, provider or model family"]],
    ["auto/me/sonnet", ["no sonnet request", "/model sonnet"]],
    ["auto/plain/opus", ["Anthropic route", "no opus request", "/model opus"]],
    ["auto/opus", ["no opus request", "/model opus"]],
    ["auto//sonnet", ["names no selector"]],
  ])("refuses %j with a 400 naming the cause, reaching nothing and moving no context", async (name, fragments) => {
    const door = await world();
    try {
      const answered = await send(door, { model: name, requestClass: "main", identity: "id-me" });
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      for (const fragment of fragments) expect(answered.text).toContain(fragment);
      expect(door.upstream.seen).toEqual([]);
      expect(door.toAnthropic).toEqual([]);
      expect(door.contextNow()).toBeUndefined();
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("never forwards an account selector on another login from a helper either, and names the same relaunch an acct: name from a helper does", async () => {
    const door = await world();
    try {
      const selector = await send(door, { model: "auto/work/sonnet", requestClass: "subagent", identity: "id-me" });
      const account = await send(door, { model: "acct:work/sonnet", requestClass: "subagent", identity: "id-me" });
      expect(selector.status).toBe(HTTP_STATUS.badRequest);
      expect(selector.status).toBe(account.status);
      expect(selector.text).toContain("claude @work --resume");
      expect(account.text).toContain("claude @work --resume");
      expect(door.upstream.seen).toEqual([]);
      expect(door.toAnthropic).toEqual([]);
      expect(door.contextNow()).toBeUndefined();
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("routes a helper that names a selector by it, and leaves the context where it was", async () => {
    const door = await world();
    try {
      expect((await send(door, { model: "auto/provider:z/opus", requestClass: "subagent", identity: "id-me" })).status).toBe(HTTP_STATUS.ok);
      expect(door.upstream.seen.map((seen) => seen.model)).toEqual([Z_OPUS_MODEL]);
      expect(door.contextNow()).toBeUndefined();
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  /** The model id the session's Claude Code sends for each tier, as a helper or the main loop would. */
  const SENT: Readonly<Record<string, string>> = { fable: "claude-fable-5-1", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };

  it.each(Object.entries(SENT))("sends the class %s on the Anthropic route as the id the session itself last sent for it, %s", async (tier, id) => {
    const door = await world();
    try {
      await send(door, { model: `${id}[1m]`, requestClass: "auxiliary", identity: "id-me" });
      for (const name of [`auto/${tier}`, `auto/me/${tier}`, `auto/plain/${tier.toUpperCase()}`, `auto/pool:mine/${tier}`]) {
        expect((await send(door, { model: name, requestClass: "main", identity: "id-me" })).status).toBe(HTTP_STATUS.badGateway);
      }
      expect(door.anthropicModels).toEqual([`${id}[1m]`, id, id, id, id]);
      expect(door.contextNow()).toMatchObject({ kind: "anthropic", requestedModel: `auto/pool:mine/${tier}` });
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("follows the id the session sends next for a tier, and never takes a bare tier alias as one", async () => {
    const door = await world();
    try {
      await send(door, { model: "claude-opus-5-1", requestClass: "main", identity: "id-me" });
      await send(door, { model: "opus", requestClass: "main", identity: "id-me" });
      await send(door, { model: "auto/opus", requestClass: "main", identity: "id-me" });
      await send(door, { model: "claude-opus-5-5", requestClass: "main", identity: "id-me" });
      await send(door, { model: "auto/opus", requestClass: "main", identity: "id-me" });
      expect(door.anthropicModels).toEqual(["claude-opus-5-1", "opus", "claude-opus-5-1", "claude-opus-5-5", "claude-opus-5-5"]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("keeps one session's ids from another's", async () => {
    const door = await world();
    try {
      await send(door, { model: "claude-sonnet-5-5", requestClass: "main", identity: "id-me", session: "s-2" });
      const refused = await send(door, { model: "auto/sonnet", requestClass: "main", identity: "id-me" });
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
      expect(refused.text).toContain("no sonnet request");
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("sends a class alone on the provider the session is on now under its tier mapping", async () => {
    const door = await world();
    try {
      await send(door, { model: "z/start", requestClass: "main", identity: "id-me" });
      expect((await send(door, { model: "auto/haiku", requestClass: "main", identity: "id-me" })).status).toBe(HTTP_STATUS.ok);
      expect(door.upstream.seen.map((seen) => seen.model)).toEqual(["start", Z_HAIKU_MODEL]);
      expect(door.contextNow()).toMatchObject({ kind: "provider", provider: "z", requestedModel: "auto/haiku" });
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it.each(["constructor", "toString", "__proto__", "auto/constructor", "auto/__proto__/opus", "auto/toString/claude-opus-5-5", "z/constructor"])("answers a name built from %j, which every object inherits, as no virtual model or selector, never with an internal error", async (name) => {
    const record = mainLoopRoutesOfLiveSessions();
    const door = await startWorld(record, HTTP_STATUS.ok, { virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } }, tiers: {} }, undefined, undefined, { selectorState: STATE });
    try {
      const answered = await send(door, { model: name, requestClass: "main", identity: "id-me" });
      expect(answered.status).not.toBe(HTTP_STATUS.internalServerError);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("passes a Messages body that names no model through unrenamed", async () => {
    const door = await world();
    try {
      const answered = await send(door, { model: "", rawBody: JSON.stringify({ max_tokens: 1, messages: [] }), requestClass: "main", identity: "id-me", provider: "z" });
      expect(answered.status).toBe(HTTP_STATUS.ok);
      expect(door.upstream.seen.map((seen) => seen.model)).toEqual([undefined]);
      // A request the rename leaves alone keeps the usage log's name as the resolver read it.
      await send(door, { model: "z/glm-9", requestClass: "main", identity: "id-me" });
      expect(door.records.at(-1)?.requestedModel).toBe("z/glm-9");
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it.each(["auto/plain/claude-opus-5-5", "auto/me/claude-opus-5-5", "auto/pool:mine/claude-opus-5-5"])("refuses %j in a session launched on a provider, whose requests carry no Anthropic login, naming the relaunch", async (name) => {
    const door = await world();
    try {
      const refused = await send(door, { model: name, requestClass: "main", identity: "id-me", provider: "z" });
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
      expect(refused.text).toContain("launched on provider");
      expect(refused.text).toContain("without --provider");
      expect(door.upstream.seen).toEqual([]);
      expect(door.toAnthropic).toEqual([]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("refuses a selector and a qualified name on a provider whose file is of another shape, naming the fault and never the file's path", async () => {
    const fault = "displayName";
    const door = await world();
    try {
      door.setProvider("z", { displayName: 5 });
      for (const name of ["auto/provider:z/sonnet", "z/glm-5.3"]) {
        const refused = await send(door, { model: name, requestClass: "main", identity: "id-me" });
        expect(refused.status).toBe(HTTP_STATUS.badRequest);
        expect(refused.text).toContain('provider \\"z\\" cannot be used because its file is invalid');
        expect(refused.text).toContain(fault);
        expect(refused.text).not.toContain(PROVIDERS_DIR);
        expect(refused.text).not.toContain("z.json");
      }
      expect(door.upstream.seen).toEqual([]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);

  it("expands a selector in a session launched on a provider too", async () => {
    const door = await world();
    try {
      expect((await send(door, { model: "auto/provider:z/haiku", requestClass: "main", identity: "id-me", provider: "m" })).status).toBe(HTTP_STATUS.ok);
      expect(door.upstream.seen.map((seen) => seen.model)).toEqual([Z_HAIKU_MODEL]);
    } finally {
      await door.close();
    }
  }, TIMEOUT_MS);
});

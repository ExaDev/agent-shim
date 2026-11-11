import { describe, expect, it, vi } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { realCatalogueFetch } from "../realCatalogueRefresh";
import { inMemoryRouteStore, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { HAIKU_NAME, LIVE_SERVED_MODEL, launchOfSession, send, startWorld, type World } from "./mainLoopRouteTestWorld";
import { createMainLoopRouteRecord, type MainLoopRouteRecord } from "./mainLoopRoute";

/** The model a provider named `spark` or `opus` serves for its main tier. */
const SPARK_MAIN_MODEL = "spark-main";

/** A world whose door also serves an http provider called `name`, which names `SPARK_MAIN_MODEL` as its main tier. */
async function worldWithProvider(name: string): Promise<{ readonly world: World; readonly record: MainLoopRouteRecord }> {
  const record = mainLoopRoutesOfLiveSessions();
  const world = await startWorld(record);
  world.setProvider(name, { displayName: name, baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: `${name}-token` }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: SPARK_MAIN_MODEL } });
  return { world, record };
}

const contextOfSession = (record: MainLoopRouteRecord): unknown => record.routeOf(launchOfSession("s-1"));

describe("a bare provider name and the route context", () => {
  it("selects the provider from a session still on the Anthropic route, and moves the context there", async () => {
    const { world, record } = await worldWithProvider("spark");
    try {
      expect((await send(world, { model: "spark", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([SPARK_MAIN_MODEL]);
      expect(world.toAnthropic).toEqual([]);
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "spark", requestedModel: "spark", servedModel: SPARK_MAIN_MODEL });
    } finally {
      await world.close();
    }
  });

  it("selects the provider from a session whose main loop is on another provider, and a helper then follows it", async () => {
    const { world, record } = await worldWithProvider("spark");
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "z" });
      expect((await send(world, { model: "spark", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "spark" });
      // The helper is placed by the context the selection updated: spark names no Haiku model, so the Haiku name is served by the model its bare name selects, and no helper reaches Anthropic.
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", SPARK_MAIN_MODEL, SPARK_MAIN_MODEL]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("selects the provider and the model it names, with `spark/<model>`", async () => {
    const { world, record } = await worldWithProvider("spark");
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: "spark/chosen-model", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", "chosen-model"]);
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "spark", requestedModel: "spark/chosen-model", servedModel: "chosen-model" });
    } finally {
      await world.close();
    }
  });

  it("follows the server's live model for `spark/auto`, and records the provider as the route", async () => {
    const { world, record } = await worldWithProvider("spark");
    try {
      expect((await send(world, { model: "spark/auto", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.filter((seen) => seen.url === "/v1/messages").map((seen) => seen.model)).toEqual([LIVE_SERVED_MODEL]);
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "spark", requestedModel: "spark/auto", servedModel: LIVE_SERVED_MODEL });
    } finally {
      await world.close();
    }
  });

  it("serves the bare name `auto` on the provider a session is on, and on the Anthropic route for a session that is on it", async () => {
    const { world, record } = await worldWithProvider("spark");
    try {
      await send(world, { model: "auto", requestClass: "main" });
      expect(world.anthropicModels).toEqual(["auto"]);
      expect(contextOfSession(record)).toMatchObject({ kind: "anthropic" });
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: "auto", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.filter((seen) => seen.url === "/v1/messages").map((seen) => seen.model)).toEqual(["glm-5.3", LIVE_SERVED_MODEL]);
      expect(world.anthropicModels).toEqual(["auto"]);
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "z" });
    } finally {
      await world.close();
    }
  });

  it("keeps a bare name the session's own provider maps in its env on that provider, though a provider of that name exists", async () => {
    const { world } = await worldWithProvider("spark");
    try {
      world.setProvider("z", { displayName: "Z", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "z-token" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "spark" } });
      expect((await send(world, { model: "spark", requestClass: "main", provider: "z" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["spark"]);
    } finally {
      await world.close();
    }
  });

  it.each([["a virtual model", "fast"], ["a family", "family:glm-5-3"]])("records the member %s selected as the served model, and the name asked for", async (_label, model) => {
    const record = mainLoopRoutesOfLiveSessions();
    const world = await startWorld(record, HTTP_STATUS.ok, { virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } } }, undefined, undefined, { targets: () => ["z/glm-5.3"] });
    try {
      expect((await send(world, { model, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3"]);
      const context = contextOfSession(record);
      expect(context).toMatchObject({ kind: "provider", provider: "z", requestedModel: model, servedModel: "glm-5.3" });
    } finally {
      await world.close();
    }
  });

  // Only a virtual model is driven with an `auto` member here: a family is built from the targets the providers list, by name, so it cannot hold the member `auto` by construction.
  it("records the live model the member sent when a virtual model selects an auto member, never auto", async () => {
    const model = "fast";
    const record = mainLoopRoutesOfLiveSessions();
    const world = await startWorld(record, HTTP_STATUS.ok, { virtual: { fast: { mode: "ordered", members: ["z/auto"] } } }, undefined, undefined, { targets: () => ["z/auto"] });
    try {
      world.upstream.serveOnly("live-m");
      expect((await send(world, { model, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.filter((seen) => seen.url === "/v1/messages").map((seen) => seen.model)).toEqual(["live-m"]);
      expect(contextOfSession(record)).toMatchObject({ provider: "z", requestedModel: "fast", servedModel: "live-m" });
    } finally {
      await world.close();
    }
  });

  it("serves a bare name no provider claims on the provider the session is on, leaving its context where it was", async () => {
    const { world, record } = await worldWithProvider("spark");
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: "some-model", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", "some-model"]);
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "z", requestedModel: "z/glm-5.3" });
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(["opus", "auto", "claude-opus-5-5"])("never lets a provider file called %j claim that bare name: it follows the session's route, and the provider stays reachable qualified", async (name) => {
    const { world, record } = await worldWithProvider(name);
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: name, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "z" });
      expect(world.upstream.seen.map((seen) => seen.model).slice(1)).not.toContain(SPARK_MAIN_MODEL);
      expect(world.toAnthropic).toEqual([]);
      expect((await send(world, { model: `${name}/chosen`, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: name });
    } finally {
      await world.close();
    }
  });

  it.each(["auxiliary", "compaction"])("resolves a bare provider name sent by a %s request to that provider and leaves the context where it was", async (requestClass) => {
    const { world, record } = await worldWithProvider("spark");
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      const helper = await send(world, { model: "spark", requestClass });
      expect(helper.status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", SPARK_MAIN_MODEL]);
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "z", requestedModel: "z/glm-5.3" });
    } finally {
      await world.close();
    }
  });

  it("sends and records a qualified name without the context-window marker, which Claude Code strips from the names it sends", async () => {
    const { world, record } = await worldWithProvider("spark");
    try {
      expect((await send(world, { model: "z/glm-5.3[1m]", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.filter((seen) => seen.url === "/v1/messages").map((seen) => seen.model)).toEqual(["glm-5.3"]);
      expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "z", servedModel: "glm-5.3" });
    } finally {
      await world.close();
    }
  });

  it("records the name an Anthropic-route request was served under when no provider chose a model: the requested name itself", async () => {
    const record = mainLoopRoutesOfLiveSessions();
    const world = await startWorld(record);
    try {
      await send(world, { model: HAIKU_NAME, requestClass: "main" });
      expect(world.toAnthropic).toEqual(["main"]);
      expect(contextOfSession(record)).toMatchObject({ kind: "anthropic", requestedModel: HAIKU_NAME, servedModel: HAIKU_NAME });
    } finally {
      await world.close();
    }
  });

  it("maps a helper's bare Claude name through the provider's tier, and never a qualified name that only starts like one", async () => {
    const { world } = await worldWithProvider("spark");
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: "claude-opus-5/x", requestClass: "auxiliary" })).status).toBeLessThan(HTTP_STATUS.internalServerError);
      expect(world.upstream.seen.filter((seen) => seen.url === "/v1/messages").map((seen) => seen.model)).toEqual(["glm-5.3", "claude-opus-5/x"]);
    } finally {
      await world.close();
    }
  });

  it("records the live model when a provider context's tier value names the provider itself under auto, which the provider then serves renamed", async () => {
    const record = mainLoopRoutesOfLiveSessions();
    const world = await startWorld(record);
    try {
      world.setProvider("spark", { displayName: "spark", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "spark/auto" } });
      world.upstream.serveOnly("live-m");
      await send(world, { model: "spark/chosen", requestClass: "main" });
      expect((await send(world, { model: HAIKU_NAME, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.filter((seen) => seen.url === "/v1/messages").at(-1)?.model).toBe("live-m");
      expect(contextOfSession(record)).toMatchObject({ provider: "spark", requestedModel: HAIKU_NAME, servedModel: "live-m" });
    } finally {
      await world.close();
    }
  });

  describe("the credential a context records, and the Anthropic way back", () => {
    it("names the launch's login for the Anthropic route and the provider's credential for a provider", async () => {
      const record = mainLoopRoutesOfLiveSessions();
      const world = await startWorld(record);
      try {
        await send(world, { model: HAIKU_NAME, requestClass: "main" });
        expect(contextOfSession(record)).toMatchObject({ kind: "anthropic", credential: "the launch's login" });
        await send(world, { model: "z/glm-5.3", requestClass: "main" });
        expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "z", credential: "bearer from literal (non-secret placeholder)" });
      } finally {
        await world.close();
      }
    });

    it("records the launch's login and the requested name for `anthropic/<model>`, and the provider's credential and the sent model for a bare Claude name on a provider context", async () => {
      const record = mainLoopRoutesOfLiveSessions();
      const world = await startWorld(record);
      try {
        await send(world, { model: "z/glm-5.3", requestClass: "main" });
        await send(world, { model: "anthropic/claude-haiku-5-5", requestClass: "main" });
        expect(contextOfSession(record)).toMatchObject({ kind: "anthropic", credential: "the launch's login", requestedModel: "anthropic/claude-haiku-5-5", servedModel: "claude-haiku-5-5" });
        await send(world, { model: "z/glm-5.3", requestClass: "main" });
        await send(world, { model: HAIKU_NAME, requestClass: "main" });
        expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "z", credential: "bearer from literal (non-secret placeholder)", requestedModel: HAIKU_NAME });
        expect(contextOfSession(record)).toHaveProperty("servedModel");
      } finally {
        await world.close();
      }
    });

    it("records `anthropic/auto` as the literal model `auto` the Anthropic route was sent", async () => {
      const record = mainLoopRoutesOfLiveSessions();
      const world = await startWorld(record);
      try {
        await send(world, { model: "z/glm-5.3", requestClass: "main" });
        await send(world, { model: "anthropic/auto", requestClass: "main" });
        expect(world.anthropicModels).toEqual(["auto"]);
        expect(contextOfSession(record)).toMatchObject({ kind: "anthropic", requestedModel: "anthropic/auto", servedModel: "auto" });
      } finally {
        await world.close();
      }
    });

    it("refuses `anthropic/<model>` with two top-level model fields, and sends one with a single field on without the prefix", async () => {
      const world = await startWorld();
      try {
        await send(world, { model: "z/glm-5.3", requestClass: "main" });
        const doubled = await send(world, { model: "anthropic/claude-haiku-5-5", requestClass: "main", rawBody: '{"model":"anthropic/claude-haiku-5-5","model":"x","max_tokens":16,"messages":[]}' });
        expect(doubled.status).toBe(HTTP_STATUS.badRequest);
        expect(doubled.text).toContain("more than one");
        expect(world.toAnthropic).toEqual([]);
        await send(world, { model: "anthropic/claude-haiku-5-5", requestClass: "main" });
        expect(world.toAnthropic).toEqual(["main"]);
        expect(world.anthropicModels).toEqual(["claude-haiku-5-5"]);
      } finally {
        await world.close();
      }
    });
  });

  describe("while the model `auto` has not been sent", () => {
    it("records no served model, never auto, when the server's list cannot be read", async () => {
      const record = mainLoopRoutesOfLiveSessions();
      const world = await startWorld(record, HTTP_STATUS.ok, undefined, undefined, undefined, { catalogueFetch: async () => await Promise.resolve({ status: HTTP_STATUS.internalServerError, body: undefined }) });
      try {
        world.setProvider("spark", { displayName: "spark", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] } });
        expect((await send(world, { model: "spark/auto", requestClass: "main" })).status).toBe(HTTP_STATUS.badGateway);
        const context = contextOfSession(record);
        expect(context).toMatchObject({ kind: "provider", provider: "spark", requestedModel: "spark/auto" });
        expect(context).not.toHaveProperty("servedModel");
        expect(world.upstream.seen.filter((seen) => seen.url === "/v1/messages")).toEqual([]);
      } finally {
        await world.close();
      }
    });

    it("keeps the launch's context on the later request when an earlier one's list read ends after it", async () => {
      const record = mainLoopRoutesOfLiveSessions();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const world = await startWorld(record, HTTP_STATUS.ok, undefined, undefined, undefined, { catalogueFetch: async (url, headers, timeoutMs) => { await gate; return await realCatalogueFetch(url, headers, timeoutMs); } });
      try {
        world.setProvider("spark", { displayName: "spark", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] } });
        const first = send(world, { model: "spark/auto", requestClass: "main" });
        await vi.waitFor(() => {
          expect(contextOfSession(record)).toMatchObject({ provider: "spark", requestedModel: "spark/auto" });
        });
        expect((await send(world, { model: "z/glm-5.3", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
        expect(contextOfSession(record)).toMatchObject({ provider: "z" });
        release();
        expect((await first).status).toBe(HTTP_STATUS.ok);
        expect(contextOfSession(record)).toMatchObject({ provider: "z", servedModel: "glm-5.3" });
      } finally {
        release();
        await world.close();
      }
    });
  });

  it("writes nothing for a launch that ended while its list read was in flight", async () => {
    let live = true;
    const writes: string[] = [];
    const store = inMemoryRouteStore();
    const reads = { count: 0 };
    const record = createMainLoopRouteRecord({ holdsLaunch: () => live, stored: { ...store, read: (launch) => { reads.count += 1; return store.read(launch); }, write: (launch, route) => { writes.push(JSON.stringify(route)); store.write(launch, route); } }, log: () => undefined });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const world = await startWorld(record, HTTP_STATUS.ok, undefined, undefined, undefined, { catalogueFetch: async (url, headers, timeoutMs) => { await gate; return await realCatalogueFetch(url, headers, timeoutMs); } });
    try {
      world.setProvider("spark", { displayName: "spark", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] } });
      const pending = send(world, { model: "spark/auto", requestClass: "main" });
      await vi.waitFor(() => {
        expect(writes.length).toBeGreaterThan(0);
      });
      const before = writes.length;
      const readsBefore = reads.count;
      live = false;
      release();
      expect((await pending).status).toBe(HTTP_STATUS.ok);
      expect(writes).toHaveLength(before);
      // The report neither reads the ended launch's context file nor leaves a cache entry for it.
      expect(reads.count).toBe(readsBefore);
    } finally {
      release();
      await world.close();
    }
  });

  it("records no served model, never auto, for the bare `auto` or a Claude name whose tier value is auto when the server's list cannot be read", async () => {
    const record = mainLoopRoutesOfLiveSessions();
    const world = await startWorld(record, HTTP_STATUS.ok, undefined, undefined, undefined, { catalogueFetch: async () => await Promise.resolve({ status: HTTP_STATUS.internalServerError, body: undefined }) });
    try {
      world.setProvider("spark", { displayName: "spark", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "auto" } });
      await send(world, { model: "spark/chosen", requestClass: "main" });
      await send(world, { model: "auto", requestClass: "main" });
      expect(contextOfSession(record)).toMatchObject({ provider: "spark", requestedModel: "auto" });
      expect(contextOfSession(record)).not.toHaveProperty("servedModel");
      await send(world, { model: "claude-sonnet-5-5", requestClass: "main" });
      expect(contextOfSession(record)).toMatchObject({ provider: "spark", requestedModel: "claude-sonnet-5-5" });
      expect(contextOfSession(record)).not.toHaveProperty("servedModel");
    } finally {
      await world.close();
    }
  });

  describe("under a provider context whose tier model is auto", () => {
    it("records the live model a bare Claude name was sent, and the live model of the bare `auto`, never auto", async () => {
      const record = mainLoopRoutesOfLiveSessions();
      const world = await startWorld(record);
      try {
        world.setProvider("spark", { displayName: "spark", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "auto" } });
        world.upstream.serveOnly("m1");
        await send(world, { model: "spark", requestClass: "main" });
        expect(contextOfSession(record)).toMatchObject({ provider: "spark", servedModel: "m1" });
        await send(world, { model: "claude-sonnet-5-5", requestClass: "main" });
        expect(contextOfSession(record)).toMatchObject({ provider: "spark", requestedModel: "claude-sonnet-5-5", servedModel: "m1" });
        await send(world, { model: "auto", requestClass: "main" });
        expect(contextOfSession(record)).toMatchObject({ provider: "spark", requestedModel: "auto", servedModel: "m1" });
      } finally {
        await world.close();
      }
    });

    it("records the model the retry sent for a bare Claude name when the server's model changed", async () => {
      const record = mainLoopRoutesOfLiveSessions();
      const world = await startWorld(record);
      try {
        world.setProvider("spark", { displayName: "spark", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "auto" } });
        world.upstream.serveOnly("m1");
        await send(world, { model: "spark", requestClass: "main" });
        world.upstream.serveOnly("m2");
        expect((await send(world, { model: "claude-sonnet-5-5", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
        expect(contextOfSession(record)).toMatchObject({ provider: "spark", requestedModel: "claude-sonnet-5-5", servedModel: "m2" });
      } finally {
        await world.close();
      }
    });
  });

  describe("when the server's model changes between the list and the request", () => {
    it("records the model the retry finally sent, not the one read first", async () => {
      const { world, record } = await worldWithProvider("spark");
      try {
        world.upstream.serveOnly("m1");
        expect((await send(world, { model: "spark/auto", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
        expect(contextOfSession(record)).toMatchObject({ provider: "spark", requestedModel: "spark/auto", servedModel: "m1" });
        world.upstream.serveOnly("m2");
        // The list is still fresh and names m1, which the server now refuses: the wrapper reads it again and serves the request once more under m2.
        expect((await send(world, { model: "spark/auto", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
        expect(world.upstream.seen.filter((seen) => seen.url === "/v1/messages").map((seen) => seen.model)).toEqual(["m1", "m1", "m2"]);
        expect(contextOfSession(record)).toMatchObject({ provider: "spark", servedModel: "m2" });
      } finally {
        await world.close();
      }
    });
  });

  describe("when a route of the provider the name chose names the model auto, or matches nothing", () => {
    const MATCHES_CHOSEN = { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: "chosen" } };

    it.each([
      ["a route sends the request on under auto", "a/chosen", "b"],
      ["no route matches, so the provider serves auto itself", "a/auto", "a"],
    ])("records the live model that was sent when %s", async (_label, model, provider) => {
      const record = mainLoopRoutesOfLiveSessions();
      const world = await startWorld(record);
      try {
        const base = `http://127.0.0.1:${String(world.upstreamPort)}`;
        world.setProvider("a", { displayName: "A", baseUrl: base, credential: { sources: [{ literal: "a-token" }] }, routes: [{ when: MATCHES_CHOSEN, provider: "b", model: "auto" }] });
        world.setProvider("b", { displayName: "B", baseUrl: base, credential: { sources: [{ literal: "b-token" }] } });
        world.upstream.serveOnly("live-m");
        expect((await send(world, { model, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
        expect(world.upstream.seen.filter((seen) => seen.url === "/v1/messages").map((seen) => seen.model)).toEqual(["live-m"]);
        expect(contextOfSession(record)).toMatchObject({ provider, requestedModel: model, servedModel: "live-m" });
      } finally {
        await world.close();
      }
    });
  });

  describe("when the provider the name chose has a route that rewrites the model", () => {
    const MATCHES_CHOSEN = { kind: "textCompare", op: "matches", left: { kind: "reference", key: "request.model" }, right: { kind: "textLiteral", value: "chosen|auto" } };
    const REWRITTEN = "rewritten";

    /** A world with providers `a`, whose route sends a matching request to `b` under `routeModel` (or under its own name), and `b`. */
    async function worldWithRoute(routeModel: string | undefined): Promise<{ readonly world: World; readonly record: MainLoopRouteRecord }> {
      const record = mainLoopRoutesOfLiveSessions();
      const world = await startWorld(record);
      const base = `http://127.0.0.1:${String(world.upstreamPort)}`;
      world.setProvider("a", { displayName: "A", baseUrl: base, credential: { sources: [{ literal: "a-token" }] }, routes: [{ when: MATCHES_CHOSEN, provider: "b", ...(routeModel === undefined ? {} : { model: routeModel }) }] });
      world.setProvider("b", { displayName: "B", baseUrl: base, credential: { sources: [{ literal: "b-token" }] } });
      return { world, record };
    }

    it("records the provider and the model the request was sent to, not the name's own", async () => {
      const { world, record } = await worldWithRoute(REWRITTEN);
      try {
        expect((await send(world, { model: "a/chosen", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
        const sent = world.upstream.seen.filter((seen) => seen.url === "/v1/messages").map((seen) => seen.model);
        expect(sent).toEqual([REWRITTEN]);
        expect(contextOfSession(record)).toMatchObject({ kind: "provider", provider: "b", requestedModel: "a/chosen", servedModel: REWRITTEN });
      } finally {
        await world.close();
      }
    });

    it("makes no live read of the first provider's list for `a/auto` that the route sends elsewhere", async () => {
      const { world, record } = await worldWithRoute(REWRITTEN);
      try {
        expect((await send(world, { model: "a/auto", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
        expect(world.upstream.seen.map((seen) => seen.url)).toEqual(["/v1/messages"]);
        expect(contextOfSession(record)).toMatchObject({ provider: "b", requestedModel: "a/auto", servedModel: REWRITTEN });
      } finally {
        await world.close();
      }
    });

    it("records nothing for a matched route when the body names no model, since no model was sent for the context to hold", async () => {
      const record = mainLoopRoutesOfLiveSessions();
      const world = await startWorld(record);
      try {
        const base = `http://127.0.0.1:${String(world.upstreamPort)}`;
        world.setProvider("a", { displayName: "A", baseUrl: base, credential: { sources: [{ literal: "a-token" }] }, routes: [{ when: { kind: "allOf", operands: [] }, provider: "b" }] });
        world.setProvider("b", { displayName: "B", baseUrl: base, credential: { sources: [{ literal: "b-token" }] } });
        expect((await send(world, { model: "", requestClass: "main", provider: "a", rawBody: '{"max_tokens":16,"messages":[]}' })).status).toBe(HTTP_STATUS.ok);
        expect(contextOfSession(record)).toBeUndefined();
      } finally {
        await world.close();
      }
    });

    it("records the name the target is sent when the route does not rewrite it", async () => {
      const { world, record } = await worldWithRoute(undefined);
      try {
        expect((await send(world, { model: "a/chosen", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
        expect(contextOfSession(record)).toMatchObject({ provider: "b", servedModel: "chosen" });
      } finally {
        await world.close();
      }
    });
  });
});

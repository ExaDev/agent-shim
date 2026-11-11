import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { ANTIGRAVITY_DEFAULT_TIER_MODELS, CODEX_DEFAULT_TIER_MODELS } from "../config/schema";
import { FAKE_HOME, createFakeFarmFs, fakeAsyncCredentials, fakeFs, followsLaunchFlag, inMemoryRouteStore, mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { createMainLoopRouteRecord, followingMainLoop, requestClassOf, withModelInHead, type MainLoopRouteRecord } from "./mainLoopRoute";
import { admitLaunch } from "./assembly";
import { createLiveSessionRegistry } from "./liveSessionRegistry";
import { serveRouted, type RouteResolution } from "./pipeline";
import { createProviderRouteResolver } from "./providerRoute";
import { AUTH_HEADER, SESSION_HEADER, type RoutedRequest } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";
import { writeFrontDoorSession } from "./state";
import { FIRST_SPLIT, HAIKU_NAME, ORDINARY_MAX_TOKENS, OWN_PORT, PROVIDERS_DIR, REPEATS, SECOND_SPLIT, Z_HAIKU_MODEL, Z_OPUS_MODEL, Z_SONNET_MODEL, Z_TIER_MODELS, admitLaunchPerSession, codexModel, fakeGeminiBackend, launchOfSession, send, sendBare, standingInForAnthropic, startWorld, tokenOf, unusedCodexPorts } from "./mainLoopRouteTestWorld";

describe("a provider-less session's helper requests follow its main loop", () => {
  it("sends an auxiliary request for a Claude haiku name to the provider the main loop is on, under that provider's haiku mapping", async () => {
    const world = await startWorld();
    try {
      expect((await send(world, { model: "z/glm-5.3", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      const helper = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(helper.status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen).toEqual([
        { url: "/v1/messages", model: "glm-5.3" },
        { url: "/v1/messages", model: Z_HAIKU_MODEL },
      ]);
      // A main request with no class header is the main loop too, and moves the session to the codex provider, whose own translator maps the haiku name by tier.
      expect((await send(world, { model: "cx/gpt-5.6" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "compaction" })).status).toBe(HTTP_STATUS.ok);
      expect(codexModel(world, 1)).toBe(CODEX_DEFAULT_TIER_MODELS.haiku);
      expect(world.upstream.seen).toHaveLength(2);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("maps a helper of a session whose main loop is on a router provider through the models block's tier pointer", async () => {
    // A qualified name that matches no target stays on the router provider itself (the resolver answers it with the router's passthrough), so a router is a route the record can hold. It is written to the record directly, so no test sends the main request to the passthrough.
    const stored = inMemoryRouteStore();
    stored.write(launchOfSession("s-1"), { kind: "provider", provider: "r" });
    const world = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored, log: () => undefined }), HTTP_STATUS.ok, { tiers: { haiku: "z/glm-5.3" } });
    try {
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3"]);
    } finally {
      await world.close();
    }
  });

  it("sends a helper to an http provider under a tier model name holding a multi-byte character, intact", async () => {
    const model = "glm-4.5-空气";
    const world = await startWorld(mainLoopRoutesOfLiveSessions(), HTTP_STATUS.ok, undefined, { ANTHROPIC_DEFAULT_HAIKU_MODEL: model });
    try {
      expect((await send(world, { model: "z/glm-5.3", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", model]);
    } finally {
      await world.close();
    }
  });

  it("serves every request of a launch whose route store fails to write, on the route kept in memory, and reports the failure once", async () => {
    const lines: string[] = [];
    const record = createMainLoopRouteRecord({
      holdsLaunch: () => true,
      stored: {
        read: () => undefined,
        identity: () => undefined,
        write: () => {
          throw new Error("disk full");
        },
      },
      log: (line) => {
        lines.push(line);
      },
    });
    const world = await startWorld(record);
    try {
      expect((await send(world, { model: "z/glm-5.3", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: "cx/gpt-5.6", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "subagent" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(codexModel(world, 1)).toBe(CODEX_DEFAULT_TIER_MODELS.haiku);
      expect(world.toAnthropic).toEqual([]);
      expect(lines).toHaveLength(1);
      // The door's own log prefixes the process, so the line starts with the subsystem and repeats no product name.
      expect(lines[0]).toMatch(/^front door: could not record where launch \d+'s main loop went.*disk full$/);
    } finally {
      await world.close();
    }
  });

  it("sends a helper to an http provider under its tier variable's model name without the context marker the variable may carry", async () => {
    const world = await startWorld(mainLoopRoutesOfLiveSessions(), HTTP_STATUS.ok, undefined, { ANTHROPIC_DEFAULT_HAIKU_MODEL: `${Z_HAIKU_MODEL}[1m]` });
    try {
      expect((await send(world, { model: "z/glm-5.3", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
    } finally {
      await world.close();
    }
  });

  it("refuses a helper of a router session whose models block has no pointer for the helper's tier, naming the tier and the provider and reaching no upstream", async () => {
    const stored = inMemoryRouteStore();
    stored.write(launchOfSession("s-1"), { kind: "provider", provider: "r" });
    const world = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored, log: () => undefined }), HTTP_STATUS.ok, { tiers: { sonnet: "z/glm-4.7" } });
    try {
      const helper = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(helper.status).toBe(HTTP_STATUS.badRequest);
      expect(helper.text).toContain("haiku");
      expect(helper.text).toContain('provider \\"r\\"');
      expect(world.upstream.seen).toEqual([]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("records a router provider as the route of a main request whose qualified name matches no target, resolving it without serving it", async () => {
    const record = mainLoopRoutesOfLiveSessions();
    const resolve = createProviderRouteResolver({ log: () => undefined, now: () => 0, mainLoopRoutes: record, fs: fakeFs({ [`${PROVIDERS_DIR}/r.json`]: { kind: "router", displayName: "Router" } }), providersDir: PROVIDERS_DIR, codexPorts: unusedCodexPorts(), directPort: () => OWN_PORT, env: {}, credentials: fakeAsyncCredentials() });
    const resolution = await resolve({ method: "POST", url: "/v1/messages", headers: { "x-claude-code-request-class": "main" }, body: Readable.from([Buffer.from(JSON.stringify({ model: "r/anything", messages: [] }))]), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s-1", provider: undefined, headroom: false, projectId: undefined, launch: launchOfSession("s-1") } });
    expect(resolution.ok && resolution.route.name).toBe("router:r");
    expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ kind: "provider", provider: "r", requestedModel: "r/anything", servedModel: "anything" });
  });

  it("sends the helpers back to the Anthropic route once the main loop returns there", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      // `/model anthropic/<model>`: the main loop is on Anthropic again, and the helper after it follows.
      await send(world, { model: "anthropic/claude-opus-5-5", requestClass: "main" });
      await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(world.toAnthropic).toEqual(["main", "auxiliary"]);
      expect(world.anthropicModels).toEqual(["claude-opus-5-5", HAIKU_NAME]);
    } finally {
      await world.close();
    }
  });

  it("sends a helper request from a session with no main-loop request yet down the route the session was launched on", async () => {
    const world = await startWorld();
    try {
      // The shape of Claude Code's startup quota check: class auxiliary, a Claude haiku name, one output token, ahead of the first main-loop request.
      const quota = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", maxTokens: 1 });
      expect(quota.status).toBe(HTTP_STATUS.badGateway);
      expect(world.toAnthropic).toEqual(["auxiliary"]);
      expect(world.upstream.seen).toEqual([]);
      expect(world.codexCalls).toEqual([]);
      // The helper recorded nothing: the main loop still decides where the next helper goes.
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(world.toAnthropic).toEqual(["auxiliary"]);
    } finally {
      await world.close();
    }
  });

  it("keeps a session's helpers on its provider across a door restart, a subagent included", async () => {
    const stored = inMemoryRouteStore();
    const ports = { holdsLaunch: () => true, stored, log: () => undefined };
    const first = await startWorld(createMainLoopRouteRecord(ports));
    try {
      await send(first, { model: "z/glm-5.3", requestClass: "main" });
    } finally {
      await first.close();
    }
    // The replacement door has the registry directory and nothing else.
    const second = await startWorld(createMainLoopRouteRecord(ports));
    try {
      expect((await send(second, { model: HAIKU_NAME, requestClass: "subagent" })).status).toBe(HTTP_STATUS.ok);
      expect(second.upstream.seen.map((seen) => seen.model)).toEqual([Z_HAIKU_MODEL]);
      expect(second.toAnthropic).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("fails a helper naming the provider when the provider its main loop was on is no longer defined", async () => {
    const stored = inMemoryRouteStore();
    stored.write(launchOfSession("s-1"), { kind: "provider", provider: "removed" });
    const world = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored, log: () => undefined }));
    try {
      const helper = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(helper.status).toBe(HTTP_STATUS.notFound);
      expect(helper.text).toContain('no provider named \\"removed\\"');
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("leaves a session launched on a provider routing by its launch header, helpers included", async () => {
    const record = mainLoopRoutesOfLiveSessions();
    const world = await startWorld(record);
    try {
      // No main request first: the launch header alone routes the helper.
      expect((await send(world, { model: Z_HAIKU_MODEL, requestClass: "auxiliary", provider: "z" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: Z_HAIKU_MODEL, requestClass: "main", provider: "z" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([Z_HAIKU_MODEL, Z_HAIKU_MODEL]);
      expect(record.routeOf(launchOfSession("s-1"))).toBeUndefined();
    } finally {
      await world.close();
    }
  });

  it("keeps each session's main loop its own", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main", session: "s-a" });
      await send(world, { model: "cx/gpt-5.6", requestClass: "main", session: "s-b" });
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", session: "s-a" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", session: "s-b" })).status).toBe(HTTP_STATUS.ok);
      // A session that has recorded nothing is still on its launch's route.
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", session: "s-c" })).status).toBe(HTTP_STATUS.badGateway);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(codexModel(world, 1)).toBe(CODEX_DEFAULT_TIER_MODELS.haiku);
    } finally {
      await world.close();
    }
  });

  it("keeps two live launches that carry one session id on routes of their own, whichever records first", async () => {
    for (const order of [["a", "b"], ["b", "a"]] as const) {
      const world = await startWorld();
      try {
        const models = { a: "z/glm-5.3", b: "cx/gpt-5.6" } as const;
        for (const launch of order) {
          await send(world, { model: models[launch], requestClass: "main", session: "s-shared", token: tokenOf(`${launch}-${order.join("")}`) });
        }
        const upstreamBefore = world.upstream.seen.length;
        const codexBefore = world.codexCalls.length;
        // Each launch's helper follows its own main loop though both present the same session id.
        expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", session: "s-shared", token: tokenOf(`a-${order.join("")}`) })).status).toBe(HTTP_STATUS.ok);
        expect(world.upstream.seen.length).toBe(upstreamBefore + 1);
        expect(world.codexCalls.length).toBe(codexBefore);
        expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary", session: "s-shared", token: tokenOf(`b-${order.join("")}`) })).status).toBe(HTTP_STATUS.ok);
        expect(world.upstream.seen.length).toBe(upstreamBefore + 1);
        expect(world.codexCalls.length).toBe(codexBefore + 1);
        expect(world.toAnthropic).toEqual([]);
      } finally {
        await world.close();
      }
    }
  });

  it("leaves the clients of the door's own transparent-surface session out of the record, so one client's main loop is never another's route", async () => {
    const fs = createFakeFarmFs();
    const dir = `${FAKE_HOME}/.agent-shim/frontdoor/sessions`;
    writeFrontDoorSession(fs, dir, { pid: 4242, startedAt: 1, token: "transparent-token" });
    const registry = createLiveSessionRegistry({ fs, sessionsDir: dir });
    registry.rescan();
    const admit = admitLaunch(registry.admits, registry.identityOf, registry.launchOfToken);
    const world = await startWorld(mainLoopRoutesOfLiveSessions(), HTTP_STATUS.ok, undefined, undefined, admit);
    try {
      // Redirected clients carry no session header and no provider: both share the transparent session's capability.
      await sendBare(world, { model: "z/glm-5.3", requestClass: "main" }, "transparent-token");
      expect((await sendBare(world, { model: HAIKU_NAME, requestClass: "subagent" }, "transparent-token")).status).toBe(HTTP_STATUS.badGateway);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3"]);
      expect(world.toAnthropic).toEqual(["subagent"]);
    } finally {
      await world.close();
    }
  });

  it("records the request class and the requested model in the usage log, on an error response too", async () => {
    const world = await startWorld(mainLoopRoutesOfLiveSessions(), HTTP_STATUS.tooManyRequests);
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(world.records.map((entry) => ({ provider: entry.provider, status: entry.status, requestClass: entry.requestClass, requestedModel: entry.requestedModel }))).toEqual([
        { provider: "z", status: HTTP_STATUS.tooManyRequests, requestClass: "main", requestedModel: "z/glm-5.3" },
        { provider: "z", status: HTTP_STATUS.tooManyRequests, requestClass: "auxiliary", requestedModel: HAIKU_NAME },
      ]);
    } finally {
      await world.close();
    }
  });
});

/** Every Claude name a subagent asks for, with the tier it selects: the versioned names and the unversioned family names. */
const CLAUDE_NAMES = [
  ["claude-opus-5-5", "opus"],
  ["opus", "opus"],
  ["claude-sonnet-5-5", "sonnet"],
  ["sonnet", "sonnet"],
  ["claude-haiku-5-5", "haiku"],
  ["haiku", "haiku"],
] as const;
const AGENT_CLASSES = ["subagent", "workflow"] as const;
/** One case per class and Claude name. */
const SUBAGENT_CASES = AGENT_CLASSES.flatMap((requestClass) => CLAUDE_NAMES.map(([name, tier]) => ({ requestClass, name, tier })));

describe("a subagent or workflow request follows the provider its main loop is on, under that provider's tier mapping", () => {
  it.each(SUBAGENT_CASES)("on an http provider: $requestClass asking for $name is served as the provider's $tier model", async ({ requestClass, name, tier }) => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: name, requestClass })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_TIER_MODELS[tier]]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(SUBAGENT_CASES)("on a codex provider: $requestClass asking for $name is served as the codex $tier model", async ({ requestClass, name, tier }) => {
    const world = await startWorld();
    try {
      await send(world, { model: "cx/gpt-5.6", requestClass: "main" });
      expect((await send(world, { model: name, requestClass })).status).toBe(HTTP_STATUS.ok);
      expect(codexModel(world, 1)).toBe(CODEX_DEFAULT_TIER_MODELS[tier]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(SUBAGENT_CASES)("on an antigravity provider: $requestClass asking for $name is served as the antigravity $tier model", async ({ requestClass, name, tier }) => {
    const world = await startWorld();
    try {
      await send(world, { model: "ag/auto", requestClass: "main" });
      expect((await send(world, { model: name, requestClass })).status).toBe(HTTP_STATUS.ok);
      expect(world.generated).toHaveLength(2);
      expect(world.generated[1]).toBe(ANTIGRAVITY_DEFAULT_TIER_MODELS[tier][0]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(SUBAGENT_CASES)("on a router provider: $requestClass asking for $name goes through the models block's $tier pointer", async ({ requestClass, name, tier }) => {
    const stored = inMemoryRouteStore();
    stored.write(launchOfSession("s-1"), { kind: "provider", provider: "r" });
    const world = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored, log: () => undefined }), HTTP_STATUS.ok, { tiers: { haiku: "z/glm-5.3-haiku", sonnet: "z/glm-5.3-sonnet", opus: "z/glm-5.3-opus" } });
    try {
      expect((await send(world, { model: name, requestClass })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([`glm-5.3-${tier}`]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(AGENT_CLASSES)("leaves a %s that inherits the main model, and so arrives with its qualified name, exactly as it is", async (requestClass) => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: "z/glm-5.3", requestClass })).status).toBe(HTTP_STATUS.ok);
      // The same name as the main loop, not a tier-mapped one.
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", "glm-5.3"]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it.each(AGENT_CLASSES)("sends a %s of a session whose main loop is on Anthropic to Anthropic, whatever Claude name it asks for", async (requestClass) => {
    const world = await startWorld();
    try {
      await send(world, { model: "claude-opus-5-5", requestClass: "main" });
      await send(world, { model: "claude-sonnet-5-5", requestClass });
      await send(world, { model: HAIKU_NAME, requestClass });
      expect(world.toAnthropic).toEqual(["main", requestClass, requestClass]);
      expect(world.upstream.seen).toEqual([]);
      expect(world.codexCalls).toEqual([]);
      expect(world.generated).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("keeps a subagent across a door restart on the provider, asking for any tier", async () => {
    const stored = inMemoryRouteStore();
    const ports = { holdsLaunch: () => true, stored, log: () => undefined };
    const first = await startWorld(createMainLoopRouteRecord(ports));
    try {
      await send(first, { model: "z/glm-5.3", requestClass: "main" });
    } finally {
      await first.close();
    }
    const second = await startWorld(createMainLoopRouteRecord(ports));
    try {
      await send(second, { model: "claude-opus-5-5", requestClass: "subagent" });
      await send(second, { model: "claude-sonnet-5-5", requestClass: "workflow" });
      expect(second.upstream.seen.map((seen) => seen.model)).toEqual([Z_OPUS_MODEL, Z_SONNET_MODEL]);
      expect(second.toAnthropic).toEqual([]);
    } finally {
      await second.close();
    }
  });
});

describe("a request that states class main but carries an agent id", () => {
  it("follows the main loop's provider and does not move the record, since a request with an agent id is never the main loop", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3" });
      expect((await send(world, { model: "claude-haiku-5-5", requestClass: "main", agentId: "agent-1" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(world.toAnthropic).toEqual([]);
      // The record still names z: a later helper follows it there.
      expect((await send(world, { model: "claude-haiku-5-5", requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL, Z_HAIKU_MODEL]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });
});

describe("a session launched before the class header was asked for", () => {
  it("sends a request carrying only an agent id, which Claude Code attaches to every non-main agent's request whatever the header setting, to the main loop's provider", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3" });
      expect((await send(world, { model: "claude-opus-5-5", agentId: "agent-1" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_OPUS_MODEL]);
      expect(world.toAnthropic).toEqual([]);
      // The agent's request did not move the main loop: a request with neither header is still the main loop's.
      expect((await send(world, { model: "z/glm-5.3" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_OPUS_MODEL, "glm-5.3"]);
    } finally {
      await world.close();
    }
  });

  it("still counts a request with neither header as the main loop, which re-points the record when it names Anthropic", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3" });
      await send(world, { model: "anthropic/claude-opus-5-5" });
      await send(world, { model: "claude-sonnet-5-5", agentId: "agent-1" });
      expect(world.toAnthropic).toEqual(["(no class)", "(no class)"]);
    } finally {
      await world.close();
    }
  });
});

describe("a native session on antigravity/auto", () => {
  it("sends the /goal judge's auxiliary request for a Claude haiku name to antigravity under its haiku mapping, and nothing to the Anthropic route", async () => {
    const backend = await fakeGeminiBackend();
    const resolveRoute = createProviderRouteResolver({ log: () => undefined, now: () => 0,
      mainLoopRoutes: mainLoopRoutesOfLiveSessions(),
      fs: fakeFs({ [`${PROVIDERS_DIR}/antigravity.json`]: { kind: "antigravity", displayName: "Antigravity", credential: { sources: [{ literal: "ag-token" }] }, antigravity: { mode: "cloud", cloud: { endpoint: backend.endpoint } } } }),
      providersDir: PROVIDERS_DIR,
      codexPorts: unusedCodexPorts(),
      directPort: () => OWN_PORT,
      env: {},
      credentials: fakeAsyncCredentials(),
    });
    const toAnthropic: string[] = [];
    const guarded = standingInForAnthropic(resolveRoute, (requestClass) => {
      toAnthropic.push(requestClass);
    });
    const server = createFrontDoorServer(
      async (pipelineRequest) => {
        await serveRouted(pipelineRequest, { resolveRoute: guarded, canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: admitLaunchPerSession, now: () => 0, log: () => undefined });
      },
      () => undefined,
    );
    const handle = await listenFrontDoor(server);
    const url = `http://127.0.0.1:${String(handle.port)}`;
    // A native launch: no provider header, only the capability and the session id.
    const post = async (model: string, requestClass: string): Promise<number> => {
      const response = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", [AUTH_HEADER]: tokenOf("s-native"), [SESSION_HEADER]: "s-native", "x-claude-code-request-class": requestClass },
        body: JSON.stringify({ model, stream: true, max_tokens: ORDINARY_MAX_TOKENS, messages: [{ role: "user", content: "hi" }] }),
      });
      await response.text();
      return response.status;
    };
    try {
      expect(await post("antigravity/auto", "main")).toBe(HTTP_STATUS.ok);
      // What Claude Code's prompt-hook judge (query source hook_prompt) sends: class auxiliary, a Claude haiku name.
      expect(await post(HAIKU_NAME, "auxiliary")).toBe(HTTP_STATUS.ok);
      expect(toAnthropic).toEqual([]);
      expect(backend.generated).toHaveLength(2);
      expect(backend.generated[1]).toBe(ANTIGRAVITY_DEFAULT_TIER_MODELS.haiku[0]);
    } finally {
      await handle.close();
    }
  });
});

describe("the request class header", () => {
  it("is read whatever the header's case, and only the classes Claude Code sends are kept", () => {
    expect(requestClassOf({})).toBeUndefined();
    expect(requestClassOf({ "x-claude-code-request-class": "auxiliary" })).toBe("auxiliary");
    expect(requestClassOf({ "X-Claude-Code-Request-Class": "side_reply" })).toBe("side_reply");
    expect(requestClassOf({ "x-claude-code-request-class": "something-new" })).toBe("unknown");
    expect(requestClassOf({ "x-claude-code-request-class": "" })).toBe("unknown");
  });

  it("is subagent for a request that names no class but carries an agent id, the one signal of a subagent a launch not asked for the class header still sends", () => {
    expect(requestClassOf({ "x-claude-code-agent-id": "agent-1" })).toBe("subagent");
    expect(requestClassOf({ "X-Claude-Code-Agent-Id": "agent-1" })).toBe("subagent");
    expect(requestClassOf({ "x-claude-code-agent-id": "" })).toBeUndefined();
    expect(requestClassOf({ "x-claude-code-agent-id": "agent-1", "x-claude-code-request-class": "workflow" })).toBe("workflow");
  });

  it("is subagent for a request that states class main but carries an agent id, since Claude Code attaches an agent id to every request from a non-main context and so a request with one is never the main loop, and keeps any other stated class", () => {
    expect(requestClassOf({ "x-claude-code-agent-id": "agent-1", "x-claude-code-request-class": "main" })).toBe("subagent");
    expect(requestClassOf({ "X-Claude-Code-Agent-Id": "agent-1", "X-Claude-Code-Request-Class": "main" })).toBe("subagent");
    expect(requestClassOf({ "x-claude-code-agent-id": "agent-1", "x-claude-code-request-class": "compaction" })).toBe("compaction");
    expect(requestClassOf({ "x-claude-code-agent-id": "agent-1", "x-claude-code-request-class": "something-new" })).toBe("unknown");
    // An empty agent id is no agent id: the stated class stands.
    expect(requestClassOf({ "x-claude-code-agent-id": "", "x-claude-code-request-class": "main" })).toBe("main");
    expect(requestClassOf({ "x-claude-code-agent-id": "", "x-claude-code-request-class": "workflow" })).toBe("workflow");
  });

  it("is unknown for a header sent twice, which Node joins into one string, and never carries the client's own text", () => {
    expect(requestClassOf({ "x-claude-code-request-class": "main, main" })).toBe("unknown");
    expect(requestClassOf({ "x-claude-code-request-class": ["main", "main"] })).toBe("unknown");
  });
});

describe("followingMainLoop over a resolver that records what it is asked", () => {
  /** A resolver that answers `ok` for any request, serving it from the route its path scopes (a bare path being Anthropic), and records the urls it was asked about. */
  function fixture(refuseMain = false): { readonly follow: (url: string, requestClass: string | undefined, session?: string, model?: string) => Promise<RouteResolution>; readonly asked: string[]; readonly record: MainLoopRouteRecord } {
    const asked: string[] = [];
    const record = mainLoopRoutesOfLiveSessions();
    const resolve = async (request: RoutedRequest): Promise<RouteResolution> => {
      asked.push(request.url);
      if (request.url.startsWith("/providers/removed/")) {
        return Promise.resolve({ ok: false, status: HTTP_STATUS.notFound, message: 'no provider named "removed"' });
      }
      if (refuseMain && request.headers["x-claude-code-request-class"] === "main") {
        return Promise.resolve({ ok: false, status: HTTP_STATUS.notFound, message: "refused" });
      }
      // As the real resolver does for a request with a body: it reads the model name and hands back the request it served, with the body replayed.
      const chunks: Buffer[] = [];
      for await (const chunk of request.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const parsed: unknown = JSON.parse(text);
      const requestedModel = typeof parsed === "object" && parsed !== null && "model" in parsed && typeof parsed.model === "string" ? parsed.model : undefined;
      return { ok: true, route: { name: "stand-in", headroomEligible: false, headroomUpstream: undefined, serve: async () => Promise.resolve() }, request: { ...request, body: Readable.from([Buffer.from(text)]) }, ...(requestedModel === undefined ? {} : { requestedModel }) };
    };
    const follow = async (url: string, requestClass: string | undefined, session = "s-1", model: string = HAIKU_NAME): Promise<RouteResolution> =>
      await followingMainLoop(resolve, { record, providerMapping: () => ({ model: { kind: "as-is" }, credential: undefined }), loginOf: () => "the launch's login", definesProvider: () => false })({
        method: "POST",
        url,
        headers: requestClass === undefined ? {} : { "x-claude-code-request-class": requestClass },
        body: Readable.from([Buffer.from(JSON.stringify({ model, messages: [] }))]),
        signal: new AbortController().signal,
        session: { identity: undefined, sessionId: session, provider: undefined, headroom: false, projectId: undefined, launch: launchOfSession(session) },
      });
    return { follow, asked, record };
  }

  it("refuses a helper whose resolver served it without saying which request, rather than serving the unscoped one", async () => {
    const record = mainLoopRoutesOfLiveSessions();
    record.record(launchOfSession("s-1"), { kind: "provider", provider: "z" });
    const resolve = async (): Promise<RouteResolution> => await Promise.resolve({ ok: true, route: { name: "stand-in", headroomEligible: false, headroomUpstream: undefined, serve: async () => Promise.resolve() } });
    const resolution = await followingMainLoop(resolve, { record, providerMapping: () => ({ model: { kind: "as-is" }, credential: undefined }), loginOf: () => "the launch's login", definesProvider: () => false })({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-claude-code-request-class": "auxiliary" },
      body: Readable.from([Buffer.from(JSON.stringify({ model: HAIKU_NAME, messages: [] }))]),
      signal: new AbortController().signal,
      session: { identity: undefined, sessionId: "s-1", provider: undefined, headroom: false, projectId: undefined, launch: launchOfSession("s-1") },
    });
    expect(resolution).toMatchObject({ ok: false, status: HTTP_STATUS.internalServerError });
  });

  it("leaves a main request refused by the resolver out of the record", async () => {
    const { follow, record } = fixture(true);
    record.record(launchOfSession("s-1"), { kind: "provider", provider: "z" });
    expect((await follow("/v1/messages", "main")).ok).toBe(false);
    expect(record.routeOf(launchOfSession("s-1"))).toEqual({ kind: "provider", provider: "z" });
  });

  it("answers a helper with the refusal of the provider its main loop was on, never resolving it again on the route it was launched on", async () => {
    const { follow, asked, record } = fixture();
    record.record(launchOfSession("s-1"), { kind: "provider", provider: "removed" });
    const resolution = await follow("/v1/messages", "auxiliary");
    expect(resolution).toMatchObject({ ok: false, status: HTTP_STATUS.notFound });
    expect(asked).toEqual(["/providers/removed/v1/messages"]);
  });

  it("counts a request with no class header as a main request, so a launch that was not asked for the header behaves as every request main: it is placed by the context, and moves it only when it chooses a route", async () => {
    const { follow, asked, record } = fixture();
    record.record(launchOfSession("s-1"), { kind: "provider", provider: "z" });
    await follow("/v1/messages", undefined);
    expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ kind: "provider", provider: "z" });
    expect(asked.at(-1)).toBe("/providers/z/v1/messages");
    await follow("/v1/messages", undefined, "s-1", `anthropic/${HAIKU_NAME}`);
    expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ kind: "anthropic" });
  });

  it("sends a helper whose class is not one Claude Code sends where the main loop is, as it does any other helper", async () => {
    const { follow, asked, record } = fixture();
    record.record(launchOfSession("s-1"), { kind: "provider", provider: "z" });
    await follow("/v1/messages", "main, main");
    expect(asked).toEqual(["/providers/z/v1/messages"]);
  });

  it("scopes a count_tokens helper under the provider too, and leaves a path that is no inference call alone", async () => {
    const { follow, asked, record } = fixture();
    record.record(launchOfSession("s-1"), { kind: "provider", provider: "z" });
    await follow("/v1/messages/count_tokens?beta=true", "auxiliary");
    await follow("/v1/models", "auxiliary");
    expect(asked).toEqual(["/providers/z/v1/messages/count_tokens?beta=true", "/v1/models"]);
  });
});

describe("rewriting the model field in a body's head", () => {
  /** The bytes the rewrite of `chunks` produces, read whole. */
  async function rewrittenBytes(chunks: readonly Buffer[], headBytes: number, from: string, to: string): Promise<Buffer> {
    const request: RoutedRequest = { method: "POST", url: "/v1/messages", headers: { "content-length": "1" }, body: Readable.from(chunks), signal: new AbortController().signal, session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined } };
    const rewritten = withModelInHead(request, headBytes, from, to);
    expect(rewritten.headers).not.toHaveProperty("content-length");
    const out: Buffer[] = [];
    for await (const chunk of rewritten.body) {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError("the rewritten body emitted something other than a Buffer");
      }
      out.push(chunk);
    }
    return Buffer.concat(out);
  }

  it("rewrites a model key written with whitespace before its colon, as the scan finds it, changing the value alone", async () => {
    const body = Buffer.from('{"model" : "' + HAIKU_NAME + '", "messages": []}', "utf8");
    const out = await rewrittenBytes([body], body.length, HAIKU_NAME, "glm-4.5-air");
    expect(out.toString("utf8")).toBe('{"model" : "glm-4.5-air", "messages": []}');
  });

  it("rewrites a model value written with an escaped quote whole, as the scan reads it", async () => {
    const body = Buffer.from('{"model":"a\\"b","messages":[]}', "utf8");
    const out = await rewrittenBytes([body], body.length, 'a\\"b', "glm-4.5-air");
    expect(out.toString("utf8")).toBe('{"model":"glm-4.5-air","messages":[]}');
  });

  it("changes only the model field and leaves a multi-byte character split across the head's end, and everything after, byte for byte", async () => {
    const body = Buffer.from(JSON.stringify({ model: HAIKU_NAME, messages: [{ role: "user", content: "日本語の会話🙂".repeat(REPEATS) }] }), "utf8");
    // The head ends inside a three-byte character, and the chunks split the body at other odd places too.
    const headBytes = body.indexOf(Buffer.from("日")) + 1;
    const chunks = [body.subarray(0, FIRST_SPLIT), body.subarray(FIRST_SPLIT, headBytes), body.subarray(headBytes, headBytes + SECOND_SPLIT), body.subarray(headBytes + SECOND_SPLIT)];
    const out = await rewrittenBytes(chunks, headBytes, HAIKU_NAME, "glm-4.5-air");
    expect(out.toString("utf8")).toBe(body.toString("utf8").replace(`"model":"${HAIKU_NAME}"`, '"model":"glm-4.5-air"'));
  });
});

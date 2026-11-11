import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { ANTIGRAVITY_DEFAULT_TIER_MODELS, CODEX_DEFAULT_TIER_MODELS } from "../config/schema";
import { FAKE_HOME, createFakeFarmFs } from "../test-helpers";
import { createMainLoopRouteRecord } from "./mainLoopRoute";
import { HAIKU_NAME, PROVIDERS_DIR, launchOfSession, send, startWorld, Z_HAIKU_MODEL, Z_OPUS_MODEL, Z_SONNET_MODEL } from "./mainLoopRouteTestWorld";
import { MAX_CONTEXT_TEXT_LENGTH, launchRouteStore, writeFrontDoorSession } from "./state";

const SONNET_NAME = "claude-sonnet-5-5";
const OPUS_NAME = "claude-opus-5-5";
const SESSIONS_DIR = `${FAKE_HOME}/.agent-shim/frontdoor/sessions`;

/** What is on disk for a launch: the route file as an old door reads it, the facts file beside it, and both texts. */
function onDisk(fs: ReturnType<typeof createFakeFarmFs>, pid: number): { readonly route: unknown; readonly facts: unknown; readonly text: string } {
  const routeText = fs.readFileUtf8(`${SESSIONS_DIR}/${String(pid)}.route.json`) ?? "";
  const factsText = fs.readFileUtf8(`${SESSIONS_DIR}/${String(pid)}.context.json`) ?? "";
  return { route: routeText === "" ? undefined : JSON.parse(routeText), facts: factsText === "" ? undefined : JSON.parse(factsText), text: `${routeText}${factsText}` };
}

describe("a bare Claude model name from a session whose main loop is on a provider", () => {
  it("is mapped through that provider's tier mapping on the main loop too, and nothing reaches Anthropic", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: SONNET_NAME, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_SONNET_MODEL]);
      expect(world.toAnthropic).toEqual([]);
      // The context stays on the provider: the next bare name follows it as well.
      await send(world, { model: OPUS_NAME, requestClass: "main" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_SONNET_MODEL, Z_OPUS_MODEL]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("is followed by a main request that states no class too, which is every request of a session launched before the class header", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3" });
      await send(world, { model: SONNET_NAME });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_SONNET_MODEL]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("is mapped by a codex provider's own tier mapping", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "cx/gpt-5.6", requestClass: "main" });
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      expect(world.codexCalls).toHaveLength(2);
      expect(world.toAnthropic).toEqual([]);
      expect(JSON.parse(world.codexCalls[1]?.init.body ?? "{}")).toMatchObject({ model: CODEX_DEFAULT_TIER_MODELS.sonnet });
    } finally {
      await world.close();
    }
  });

  it("reaches Anthropic when the person selects an Anthropic model by name, with the prefix removed, and the next bare names follow Anthropic", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: `anthropic/${SONNET_NAME}`, requestClass: "main" })).status).toBe(HTTP_STATUS.badGateway);
      expect(world.anthropicModels).toEqual([SONNET_NAME]);
      await send(world, { model: OPUS_NAME, requestClass: "main" });
      expect(world.anthropicModels).toEqual([SONNET_NAME, OPUS_NAME]);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3"]);
      // A switch to the provider again moves the context back.
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", "glm-5.3", Z_SONNET_MODEL]);
    } finally {
      await world.close();
    }
  });

  it("passes the name after the anthropic/ prefix upstream exactly as the person wrote it, whether or not it is a Claude name the door knows", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: "anthropic/some-model-the-door-has-never-heard-of", requestClass: "main" });
      await send(world, { model: "anthropic/claude-sonnet-4-20250514[1m]", requestClass: "main" });
      expect(world.anthropicModels).toEqual(["some-model-the-door-has-never-heard-of", "claude-sonnet-4-20250514[1m]"]);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3"]);
    } finally {
      await world.close();
    }
  });

  it("reaches Anthropic with the prefix removed from a session that never left it, and for a helper", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: `anthropic/${HAIKU_NAME}`, requestClass: "auxiliary" });
      expect(world.anthropicModels).toEqual([HAIKU_NAME]);
    } finally {
      await world.close();
    }
  });

  it("leaves anthropic/<model> to a provider called anthropic when one is defined, for the main loop and for a helper", async () => {
    const world = await startWorld();
    try {
      world.setProvider("anthropic", { displayName: "Anthropic", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "a-token" }] } });
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: "anthropic/model-x", requestClass: "main" });
      await send(world, { model: "anthropic/model-y", requestClass: "auxiliary" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", "model-x", "model-y"]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("serves a tier the provider does not map by the model its bare name selects, never on the launch's account", async () => {
    const world = await startWorld(undefined, HTTP_STATUS.ok, undefined, { ANTHROPIC_DEFAULT_HAIKU_MODEL: Z_HAIKU_MODEL });
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: SONNET_NAME, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      // The provider's env names only a haiku model, which is therefore the one model it selects.
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("is mapped by an antigravity provider's own tier mapping, and never reaches the launch's account", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "ag/auto", requestClass: "main" });
      expect((await send(world, { model: SONNET_NAME, requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.generated).toHaveLength(2);
      expect(world.generated[1]).toBe(ANTIGRAVITY_DEFAULT_TIER_MODELS.sonnet[0]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("is refused with the reason by a router that has no pointer for the tier, never sent to the launch's account", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "r/glm-5.3", requestClass: "main" });
      const refused = await send(world, { model: SONNET_NAME, requestClass: "main" });
      expect(refused.status).toBe(HTTP_STATUS.badRequest);
      expect(refused.text).toContain("sonnet");
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("applies a provider file changed since the last request to the next one", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      world.setProvider("z", { displayName: "Z", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "z-token" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-next" } });
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_SONNET_MODEL, "glm-next"]);
    } finally {
      await world.close();
    }
  });

  it("keeps following the provider after a door restart: the context is read from the launch's route file", async () => {
    const fs = createFakeFarmFs();
    const launch = launchOfSession("s-1");
    writeFrontDoorSession(fs, SESSIONS_DIR, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    const store = launchRouteStore(fs, SESSIONS_DIR, () => undefined);
    const before = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored: store, log: () => undefined }));
    try {
      await send(before, { model: "z/glm-5.3", requestClass: "main" });
    } finally {
      await before.close();
    }
    const after = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored: store, log: () => undefined }));
    try {
      await send(after, { model: SONNET_NAME, requestClass: "main" });
      expect(after.upstream.seen.map((seen) => seen.model)).toEqual([Z_SONNET_MODEL]);
      expect(after.toAnthropic).toEqual([]);
    } finally {
      await after.close();
    }
  });

  it("is unchanged for a session launched on a provider, which carries its provider on every request", async () => {
    const world = await startWorld();
    try {
      expect((await send(world, { model: SONNET_NAME, provider: "z", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([SONNET_NAME]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });
});

describe("the route context the door keeps for a launch", () => {
  const SECRET = "z-token";

  async function recordedWorld(): Promise<{ readonly fs: ReturnType<typeof createFakeFarmFs>; readonly lines: string[]; readonly world: Awaited<ReturnType<typeof startWorld>>; readonly pid: number }> {
    const fs = createFakeFarmFs();
    const launch = launchOfSession("s-1");
    writeFrontDoorSession(fs, SESSIONS_DIR, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    const lines: string[] = [];
    const log = (line: string): void => {
      lines.push(line);
    };
    const store = launchRouteStore(fs, SESSIONS_DIR, log);
    const world = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored: store, log }));
    return { fs, lines, world, pid: launch.pid };
  }

  it("names the credential and the models, as names, and holds no value", async () => {
    const { fs, lines, world, pid } = await recordedWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      const { route, facts, text } = onDisk(fs, pid);
      expect(route).toMatchObject({ version: 1, route: { kind: "provider", provider: "z" } });
      expect(facts).toMatchObject({ version: 1, facts: { requestedModel: SONNET_NAME, servedModel: Z_SONNET_MODEL } });
      expect(text).toContain("bearer from literal");
      expect(text).not.toContain(SECRET);
      expect(lines.join("\n")).not.toContain(SECRET);
    } finally {
      await world.close();
    }
  });

  it("holds no value of any credential source: a literal, a command's arguments or an environment variable's value reach neither the route file, nor a log line, nor the usage log", async () => {
    const { fs, lines, world, pid } = await recordedWorld();
    try {
      const LITERAL = "LITERAL-VALUE-7f3a";
      const ARGUMENT = "COMMAND-ARGUMENT-9c1d";
      const ENV_VALUE = "ENV-VALUE-5b2e";
      process.env.Q_TOKEN_FOR_TEST = ENV_VALUE;
      world.setProvider("q", { displayName: "Q", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ env: "Q_TOKEN_FOR_TEST" }, { command: ["/usr/bin/true", ARGUMENT] }, { literal: LITERAL }] } });
      await send(world, { model: "q/glm-5.3", requestClass: "main" });
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      const { text } = onDisk(fs, pid);
      expect(text).toContain("Q_TOKEN_FOR_TEST");
      for (const value of [LITERAL, ARGUMENT, ENV_VALUE]) {
        expect(text).not.toContain(value);
        expect(lines.join("\n")).not.toContain(value);
        expect(JSON.stringify(world.records)).not.toContain(value);
      }
    } finally {
      delete process.env.Q_TOKEN_FOR_TEST;
      await world.close();
    }
  });

  it("names the credential from the provider's file as read for each request, so an edited credential block shows its new name at the next one", async () => {
    const { fs, world, pid } = await recordedWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect(JSON.stringify(onDisk(fs, pid).facts)).toContain("literal");
      world.setProvider("z", { displayName: "Z", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ env: "Z_RENAMED_TOKEN" }, { literal: "z-token" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: Z_SONNET_MODEL } });
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      expect(JSON.stringify(onDisk(fs, pid).facts)).toContain("Z_RENAMED_TOKEN");
    } finally {
      await world.close();
    }
  });

  it("records the Anthropic route with the session's login and no provider", async () => {
    const { fs, world, pid } = await recordedWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: `anthropic/${SONNET_NAME}`, requestClass: "main" });
      const { route, facts } = onDisk(fs, pid);
      expect(route).toMatchObject({ version: 1, route: { kind: "anthropic" } });
      expect(facts).toMatchObject({ facts: { credential: "the launch's login", requestedModel: `anthropic/${SONNET_NAME}`, servedModel: SONNET_NAME } });
    } finally {
      await world.close();
    }
  });

  it("names no served model for a virtual model, whose member the resolution does not carry", async () => {
    const fs = createFakeFarmFs();
    const launch = launchOfSession("s-1");
    writeFrontDoorSession(fs, SESSIONS_DIR, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    const log = (): void => undefined;
    const world = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored: launchRouteStore(fs, SESSIONS_DIR, log), log }), HTTP_STATUS.ok, { virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } } });
    try {
      await send(world, { model: "fast", requestClass: "main" });
      const { facts } = onDisk(fs, launch.pid);
      expect(facts).toMatchObject({ facts: { requestedModel: "fast" } });
      expect(JSON.stringify(facts)).not.toContain("servedModel");
    } finally {
      await world.close();
    }
  });

  it("keeps a model name of exactly the bound (the next test leaves out one a character over it)", async () => {
    const { fs, world, pid } = await recordedWorld();
    try {
      const atBound = `z/${"a".repeat(MAX_CONTEXT_TEXT_LENGTH - "z/".length)}`;
      expect(atBound).toHaveLength(MAX_CONTEXT_TEXT_LENGTH);
      await send(world, { model: atBound, requestClass: "main" });
      expect(onDisk(fs, pid).facts).toMatchObject({ facts: { requestedModel: atBound } });
    } finally {
      await world.close();
    }
  });

  it("records the model a tier the provider's env does not name was served by, not the Claude name sent", async () => {
    const { fs, world, pid } = await recordedWorld();
    try {
      world.setProvider("sparse", { displayName: "sparse", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "sparse-token" }] }, env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "sparse-main" } });
      await send(world, { model: "sparse/chosen", requestClass: "main" });
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["chosen", "sparse-main"]);
      expect(onDisk(fs, pid).facts).toMatchObject({ facts: { requestedModel: SONNET_NAME, servedModel: "sparse-main" } });
    } finally {
      await world.close();
    }
  });

  it("leaves out a model name too long to keep, so the file stays readable", async () => {
    const { fs, world, pid } = await recordedWorld();
    try {
      const long = `z/${"a".repeat(MAX_CONTEXT_TEXT_LENGTH + 1)}`;
      await send(world, { model: long, requestClass: "main" });
      const { route, text } = onDisk(fs, pid);
      expect(route).toMatchObject({ route: { kind: "provider", provider: "z" } });
      expect(text).not.toContain("requestedModel");
      expect(text).not.toContain("servedModel");
      expect(launchRouteStore(fs, SESSIONS_DIR, () => undefined).read(launchOfSession("s-1"))).toMatchObject({ kind: "provider", provider: "z" });
    } finally {
      await world.close();
    }
  });

  it("reads a version-1 route file, which names a provider only, as a context with that provider", async () => {
    const fs = createFakeFarmFs();
    const launch = launchOfSession("s-1");
    writeFrontDoorSession(fs, SESSIONS_DIR, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    fs.writeFilePrivate(`${SESSIONS_DIR}/${String(launch.pid)}.route.json`, `${JSON.stringify({ version: 1, startedAt: launch.startedAt, route: { kind: "provider", provider: "z" } })}\n`);
    const world = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored: launchRouteStore(fs, SESSIONS_DIR, () => undefined), log: () => undefined }));
    try {
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual([Z_SONNET_MODEL]);
      expect(PROVIDERS_DIR).toContain("providers");
    } finally {
      await world.close();
    }
  });
});

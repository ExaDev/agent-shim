import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { HAIKU_NAME, launchOfSession, send, startWorld, type World } from "./mainLoopRouteTestWorld";
import type { MainLoopRouteRecord } from "./mainLoopRoute";

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
});

import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { HAIKU_NAME, send, startWorld, type ModelPorts, type World } from "./mainLoopRouteTestWorld";

const SONNET_NAME = "claude-sonnet-5-5";
const OPUS_NAME = "claude-opus-5-5";

const SONNET = "ANTHROPIC_DEFAULT_SONNET_MODEL";
const OPUS = "ANTHROPIC_DEFAULT_OPUS_MODEL";
const HAIKU = "ANTHROPIC_DEFAULT_HAIKU_MODEL";

/** A model name longer than any file name may be, which no provider file can have. */
const LONG_NAME_LENGTH = 300;

/** A world whose door also serves an http provider called `name` with `env` and, when given, the rest of its file. */
async function worldWith(name: string, env: Readonly<Record<string, string>>, file: Readonly<Record<string, unknown>> = {}, modelPorts: ModelPorts = {}): Promise<World> {
  const world = await startWorld(mainLoopRoutesOfLiveSessions(), undefined, undefined, undefined, undefined, modelPorts);
  world.setProvider(name, { displayName: name, baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: `${name}-token` }] }, env, ...file });
  return world;
}

/** The models the provider's server was sent, in order, for the Messages requests only. */
const sentModels = (world: World): readonly unknown[] => world.upstream.seen.filter((seen) => seen.url === "/v1/messages").map((seen) => seen.model);

/** A session switched to the provider `spark` by its bare name, then sent a Claude name by each kind of request that can carry one. */
describe("a Claude name sent to a provider a bare name selected", () => {
  const ENVS: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
    ["only the Sonnet tier", { [SONNET]: "s-model" }, "s-model"],
    ["only the Opus tier", { [OPUS]: "o-model" }, "o-model"],
    ["Haiku and Sonnet, no Opus", { [HAIKU]: "h-model", [SONNET]: "s-model" }, "s-model"],
  ];
  const TIER_OF_NAME: readonly (readonly [string, string, string])[] = [
    [HAIKU_NAME, HAIKU, "h-model"],
    [SONNET_NAME, SONNET, "s-model"],
    [OPUS_NAME, OPUS, "o-model"],
  ];
  const CLASSES = ["main", "auxiliary", "compaction"] as const;

  it.each(ENVS.flatMap(([label, env, selected]) => TIER_OF_NAME.flatMap(([name, variable, own]) => CLASSES.map((requestClass) => [label, env, selected, name, variable, own, requestClass] as const))))(
    "with %s, sent as %s %s by a %s request, is the provider's own tier model when its env names the tier, else the model its bare name selects",
    async (_label, env, selected, name, variable, own, requestClass) => {
      const world = await worldWith("spark", env);
      try {
        expect((await send(world, { model: "spark", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
        expect((await send(world, { model: name, requestClass })).status).toBe(HTTP_STATUS.ok);
        expect(sentModels(world)).toEqual([selected, variable in env ? own : selected]);
      } finally {
        await world.close();
      }
    },
  );
});

describe("a bare provider name and the model a provider's env names", () => {
  it("is served on the session's own provider when that provider's env names it, whichever variable names it", async () => {
    for (const variable of [SONNET, OPUS, HAIKU, "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL"]) {
      const world = await worldWith("spark", { [SONNET]: "spark-main" });
      try {
        world.setProvider("z", { displayName: "Z", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "z-token" }] }, env: { [variable]: "spark" } });
        expect((await send(world, { model: "spark", requestClass: "main", provider: "z" })).status).toBe(HTTP_STATUS.ok);
        expect(sentModels(world), variable).toEqual(["spark"]);
      } finally {
        await world.close();
      }
    }
  });

  it("selects the provider, and sends its default model, from a session already on that provider", async () => {
    const world = await worldWith("spark", { [SONNET]: "spark-main" });
    try {
      expect((await send(world, { model: "spark", requestClass: "main", provider: "spark" })).status).toBe(HTTP_STATUS.ok);
      expect(sentModels(world)).toEqual(["spark-main"]);
    } finally {
      await world.close();
    }
  });

  it("takes a default from an env entry without the context-window marker", async () => {
    const world = await worldWith("spark", { [SONNET]: "glm[1m]" });
    try {
      expect((await send(world, { model: "spark", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(sentModels(world)).toEqual(["glm", "glm"]);
    } finally {
      await world.close();
    }
  });

  it("passes over an env entry that is empty when it takes a default, and when it maps a tier", async () => {
    const world = await worldWith("spark", { [SONNET]: "", [OPUS]: "o-model", [HAIKU]: "" });
    try {
      expect((await send(world, { model: "spark", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(sentModels(world)).toEqual(["o-model", "o-model"]);
    } finally {
      await world.close();
    }
  });
});

describe("a provider file that is listed and invalid", () => {
  it.each([["a bare name", "broken"], ["a qualified name", "broken/some-model"]])("is named in the refusal of %s, never taken for a name no provider has", async (_label, model) => {
    const world = await startWorld(mainLoopRoutesOfLiveSessions());
    try {
      world.setProvider("broken", { displayName: 5 });
      const answered = await send(world, { model, requestClass: "main" });
      expect(answered.status).toBe(HTTP_STATUS.badRequest);
      expect(answered.text).toContain('provider \\"broken\\" cannot be used because its file is invalid');
      expect(world.toAnthropic).toEqual([]);
      expect(sentModels(world)).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("is no reason to refuse a name that no file has, however it is spelt", async () => {
    const world = await startWorld(mainLoopRoutesOfLiveSessions());
    try {
      world.setProvider("broken", { displayName: 5 });
      expect((await send(world, { model: "some-model", requestClass: "main", provider: "z" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: "x".repeat(LONG_NAME_LENGTH), requestClass: "main", provider: "z" })).status).toBe(HTTP_STATUS.ok);
    } finally {
      await world.close();
    }
  });
});

describe("a Claude name an http provider serves itself", () => {
  const OPUS_ONLY = { [OPUS]: "claude-opus-x" } as const;

  it("reaches it as asked when its env maps a model to the name through a variable that is no tier", async () => {
    const world = await worldWith("relay", { ...OPUS_ONLY, ANTHROPIC_SMALL_FAST_MODEL: HAIKU_NAME });
    try {
      expect((await send(world, { model: "relay", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: SONNET_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      // The main model is the Opus entry; the Haiku name is served by the provider itself, the Sonnet name is not and takes the default.
      expect(sentModels(world)).toEqual(["claude-opus-x", HAIKU_NAME, "claude-opus-x"]);
    } finally {
      await world.close();
    }
  });

  it("reaches it as asked when the provider declares it as a picker model, and not when only another provider does", async () => {
    const world = await worldWith("relay", OPUS_ONLY, { pickerModels: [{ model: HAIKU_NAME, tier: "haiku" }] });
    world.setProvider("other", { displayName: "other", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "other-token" }] }, pickerModels: [{ model: SONNET_NAME, tier: "sonnet" }] });
    try {
      expect((await send(world, { model: "relay", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: SONNET_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(sentModels(world)).toEqual(["claude-opus-x", HAIKU_NAME, "claude-opus-x"]);
    } finally {
      await world.close();
    }
  });
});

describe("the model a bare provider name selects when its env sets ANTHROPIC_MODEL", () => {
  it("is ANTHROPIC_MODEL, ahead of the tier variables, and the only one needed", async () => {
    const both = await worldWith("spark", { ANTHROPIC_MODEL: "main-model", [SONNET]: "s-model" });
    const only = await worldWith("quiet", { ANTHROPIC_MODEL: "only-model" });
    try {
      expect((await send(both, { model: "spark", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(sentModels(both)).toEqual(["main-model"]);
      expect((await send(only, { model: "quiet", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect(sentModels(only)).toEqual(["only-model"]);
    } finally {
      await both.close();
      await only.close();
    }
  });
});

describe("the work a Claude name costs the tier mapping of an http provider", () => {
  const REQUESTS = 4;

  it("reads the provider's own catalogue for each request that needs it, and no targets at all", async () => {
    let catalogueReads = 0;
    let targetReads = 0;
    const world = await worldWith("relay", { [OPUS]: "claude-opus-x" }, { catalogue: { tier: "sonnet" } }, {
      catalogueModelsOf: () => {
        catalogueReads += 1;
        return [{ id: HAIKU_NAME }];
      },
      targets: () => {
        targetReads += 1;
        return [];
      },
    });
    try {
      expect((await send(world, { model: "relay", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      for (let index = 0; index < REQUESTS; index += 1) {
        expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      }
      // The catalogue lists the Haiku name, so the provider serves it as asked, and asking costs one catalogue read a request.
      expect(sentModels(world)).toEqual(["claude-opus-x", ...Array.from({ length: REQUESTS }, () => HAIKU_NAME)]);
      expect(catalogueReads).toBe(REQUESTS);
      expect(targetReads).toBe(0);
    } finally {
      await world.close();
    }
  });

  it("asks nothing wider when the env already maps the tier", async () => {
    let catalogueReads = 0;
    const world = await worldWith("relay", { [HAIKU]: "h-model", [SONNET]: "s-model" }, { catalogue: { tier: "sonnet" } }, {
      catalogueModelsOf: () => {
        catalogueReads += 1;
        return [];
      },
    });
    try {
      expect((await send(world, { model: "relay", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      catalogueReads = 0;
      expect((await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" })).status).toBe(HTTP_STATUS.ok);
      expect(sentModels(world)).toEqual(["s-model", "h-model"]);
      expect(catalogueReads).toBe(0);
    } finally {
      await world.close();
    }
  });
});

describe("a model a session provider serves under a context-window marker", () => {
  it.each([
    ["its env writes the marker and the request does not", { [SONNET]: "glm-5[1m]" }, "glm-5"],
    ["the request writes the marker and its env does not", { [SONNET]: "glm-5" }, "glm-5[1m]"],
  ])("stays on that provider when %s, though another provider is called by the bare name", async (_label, env, requested) => {
    const world = await worldWith("z", env);
    world.setProvider("glm-5", { displayName: "other", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "other-token" }] }, env: { [SONNET]: "other-main" } });
    try {
      expect((await send(world, { model: requested, requestClass: "main", provider: "z" })).status).toBe(HTTP_STATUS.ok);
      expect(sentModels(world)).toHaveLength(1);
      expect(sentModels(world)).not.toContain("other-main");
    } finally {
      await world.close();
    }
  });
});

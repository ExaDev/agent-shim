import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { ModelsConfig } from "../config/schema";
import { inMemoryRouteStore } from "../test-helpers";
import { createMainLoopRouteRecord } from "./mainLoopRoute";
import { HAIKU_NAME, launchOfSession, send, startWorld, Z_HAIKU_MODEL } from "./mainLoopRouteTestWorld";

describe("the model a helper is sent under, by the provider its main loop is on", () => {
  it("leaves a provider-qualified name alone, since a qualified ref names its target and is no Claude name to map by tier", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3" });
      const helper = await send(world, { model: `z/${HAIKU_NAME}`, requestClass: "auxiliary" });
      expect(helper.status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.map((seen) => seen.model)).not.toContain(Z_HAIKU_MODEL);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("does not take an empty tier variable for a mapping: the helper keeps its own name", async () => {
    const world = await startWorld(undefined, HTTP_STATUS.ok, undefined, { ANTHROPIC_DEFAULT_HAIKU_MODEL: "" });
    try {
      await send(world, { model: "z/glm-5.3" });
      await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", HAIKU_NAME]);
    } finally {
      await world.close();
    }
  });

  it("leaves a helper whose main loop was recorded on an invalid provider file to the routing loop's own refusal, never mapped and never sent on to the launch's account", async () => {
    const stored = inMemoryRouteStore();
    stored.write(launchOfSession("s-1"), { kind: "provider", provider: "bad" });
    const world = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored, log: () => undefined }));
    try {
      const helper = await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(helper.status).toBe(HTTP_STATUS.internalServerError);
      expect(helper.text).toContain("provider bad is invalid");
      expect(world.upstream.seen).toEqual([]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });
});

describe("the usage log's requested model", () => {
  it("names the model the client asked for when the routing scans the request a second time, as a provider with routes does", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "m/glm-9" });
      expect(world.records.map((entry) => entry.requestedModel)).toEqual(["m/glm-9"]);
    } finally {
      await world.close();
    }
  });

  it("names the model the client asked for, not the name a virtual model or a later turn of the routing rewrote it to", async () => {
    const models: ModelsConfig = { virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } } };
    const world = await startWorld(undefined, HTTP_STATUS.ok, models);
    try {
      await send(world, { model: "fast" });
      await send(world, { model: HAIKU_NAME, requestClass: "auxiliary" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", Z_HAIKU_MODEL]);
      expect(world.records.map((entry) => entry.requestedModel)).toEqual(["fast", HAIKU_NAME]);
    } finally {
      await world.close();
    }
  });
});

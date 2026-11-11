import { afterEach, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { LIVE_SERVED_MODEL, launchOfSession, send, startWorld, type World } from "./mainLoopRouteTestWorld";

/** A port nothing listens on, so a provider that lives there cannot be read. */
const CLOSED_PORT = 1;

const worlds: World[] = [];
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(async (world) => {
    await world.close();
  }));
});

async function worldWithRecord(): Promise<{ readonly world: World; readonly contextOf: () => unknown }> {
  const record = mainLoopRoutesOfLiveSessions();
  const world = await startWorld(record);
  worlds.push(world);
  return { world, contextOf: () => record.routeOf(launchOfSession("s-1")) };
}

/** What a main-loop request records about the session's route context depends on the route it is on and what it asks for. */
describe("what a main-loop request records when the session's context is a provider", () => {
  it("is nothing for a name that is neither a Claude name nor `auto`: the provider serves it as asked and the context stays as the request that chose the route left it", async () => {
    const { world, contextOf } = await worldWithRecord();
    expect((await send(world, { model: "z/glm-5.3", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
    const chosen = contextOf();
    expect((await send(world, { model: "some-vendor-model", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
    expect(contextOf()).toEqual(chosen);
  });

  it("is the name and the model the server served for the model `auto`, on the provider the session is on", async () => {
    const { world, contextOf } = await worldWithRecord();
    await send(world, { model: "z/glm-5.3", requestClass: "main" });
    expect((await send(world, { model: "auto", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
    expect(contextOf()).toMatchObject({ kind: "provider", provider: "z", requestedModel: "auto", servedModel: LIVE_SERVED_MODEL });
  });

  it("is the Claude name asked for and the model its tier mapped to", async () => {
    const { world, contextOf } = await worldWithRecord();
    await send(world, { model: "z/glm-5.3", requestClass: "main" });
    expect((await send(world, { model: "claude-haiku-5-5", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
    expect(contextOf()).toMatchObject({ kind: "provider", provider: "z", requestedModel: "claude-haiku-5-5", servedModel: "glm-4.5-air" });
  });
});

describe("what a main-loop request records of the model `auto`", () => {
  it("is no model for a provider whose list could not be read, never the word `auto`, since nothing was sent", async () => {
    const { world, contextOf } = await worldWithRecord();
    world.setProvider("dead", { displayName: "Dead", baseUrl: `http://127.0.0.1:${String(CLOSED_PORT)}`, credential: { sources: [{ literal: "t" }] } });
    expect((await send(world, { model: "dead/auto", requestClass: "main" })).status).toBe(HTTP_STATUS.badGateway);
    const context = contextOf();
    expect(context).toMatchObject({ kind: "provider", provider: "dead", requestedModel: "dead/auto" });
    expect(context).not.toHaveProperty("servedModel");
  });

  it("is the word `auto` as the name asked for and served on the Anthropic route, where the door does not resolve it", async () => {
    const { world, contextOf } = await worldWithRecord();
    expect((await send(world, { model: "auto", requestClass: "main" })).status).toBe(HTTP_STATUS.badGateway);
    expect(contextOf()).toMatchObject({ kind: "anthropic", requestedModel: "auto", servedModel: "auto" });
  });

  it("is the model a request for anthropic/<model> asked for on the Anthropic route, and `auto` through it is recorded as the name it is", async () => {
    const { world, contextOf } = await worldWithRecord();
    await send(world, { model: "anthropic/claude-sonnet-5-5", requestClass: "main" });
    expect(contextOf()).toMatchObject({ kind: "anthropic", requestedModel: "anthropic/claude-sonnet-5-5", servedModel: "claude-sonnet-5-5" });
    await send(world, { model: "anthropic/auto", requestClass: "main" });
    expect(contextOf()).toMatchObject({ kind: "anthropic", requestedModel: "anthropic/auto", servedModel: "auto" });
  });
});

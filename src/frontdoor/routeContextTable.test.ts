import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { createFakeFarmFs, FAKE_HOME } from "../test-helpers";
import { createMainLoopRouteRecord } from "./mainLoopRoute";
import { HAIKU_NAME, Z_OPUS_MODEL, launchOfSession, send, startWorld, Z_SONNET_MODEL } from "./mainLoopRouteTestWorld";
import { launchRouteStore, writeFrontDoorSession } from "./state";

const SONNET_NAME = "claude-sonnet-5-5";

/** Every request class a session's requests carry, as the header and agent id Claude Code sends them with. */
const CLASSES: readonly { readonly name: string; readonly options: { readonly requestClass?: string; readonly agentId?: string } }[] = [
  { name: "main", options: { requestClass: "main" } },
  { name: "no class", options: {} },
  { name: "auxiliary", options: { requestClass: "auxiliary" } },
  { name: "subagent", options: { requestClass: "subagent" } },
  { name: "main with an agent id", options: { requestClass: "main", agentId: "agent-1" } },
  { name: "compaction", options: { requestClass: "compaction" } },
];

/** What a request can name, each as the body it is sent with: a Claude name, names no provider claims and that are no Claude name, and a body that names no model. */
const SHAPES: readonly { readonly name: string; readonly body: (model?: string) => { readonly model: string; readonly rawBody?: string } }[] = [
  { name: "a typo of a Claude name", body: () => ({ model: "claude-sonet-5" }) },
  { name: "a typo of a provider prefix", body: () => ({ model: "nope/model" }) },
  { name: "a name of another vendor", body: () => ({ model: "gpt-5" }) },
  { name: "a name that only contains a tier word", body: () => ({ model: "magnum-opus" }) },
  { name: "a virtual model nobody defined", body: () => ({ model: "fast-undefined" }) },
  { name: "an empty name", body: () => ({ model: "" }) },
  { name: "no model field", body: () => ({ model: "", rawBody: JSON.stringify({ messages: [], max_tokens: 5 }) }) },
  { name: "a body that is not JSON", body: () => ({ model: "", rawBody: "not json" }) },
];

/** The providers a session can be switched to by a qualified name, and the name that switches to each. */
const PROVIDERS: readonly { readonly name: string; readonly switchTo: string }[] = [
  { name: "an http provider", switchTo: "z/glm-5.3" },
  { name: "a codex provider", switchTo: "cx/gpt-5.6" },
  { name: "an antigravity provider", switchTo: "ag/auto" },
  { name: "a router", switchTo: "r/glm-5.3" },
];

describe("under a provider context, a request that chose no route never reaches the launch's account, whatever it names and whichever class it is", () => {
  const cases = PROVIDERS.flatMap((provider) => CLASSES.flatMap((requestClass) => SHAPES.map((shape) => ({ provider, requestClass, shape }))));

  it.each(cases.map((entry) => [`${entry.provider.name}, ${entry.requestClass.name}, ${entry.shape.name}`, entry] as const))("%s", async (_name, { provider, requestClass, shape }) => {
    const world = await startWorld();
    try {
      await send(world, { model: provider.switchTo, requestClass: "main" });
      await send(world, { ...shape.body(), ...requestClass.options });
      expect(world.toAnthropic).toEqual([]);
      // Nothing that chose no route moved the context: the next ordinary Claude name still follows the provider.
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });
});

describe("a main-loop request that names nothing the door can place, on an http provider's context", () => {
  it("is served by the provider as asked, and the next Claude name still follows it", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect((await send(world, { model: "gpt-5", requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      expect((await send(world, { model: "", rawBody: JSON.stringify({ messages: [], max_tokens: 5 }), requestClass: "main" })).status).toBe(HTTP_STATUS.ok);
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", "gpt-5", undefined, Z_SONNET_MODEL]);
      expect(world.toAnthropic).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("is served as asked after the provider's file became invalid, with the refusal naming it, and never by the launch's account", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      world.setProvider("z", { displayName: 5 });
      const refused = await send(world, { model: "z/glm-5.3", requestClass: "main" });
      expect(refused.status).not.toBe(HTTP_STATUS.ok);
      expect(world.toAnthropic).toEqual([]);
      expect(HAIKU_NAME).toContain("haiku");
    } finally {
      await world.close();
    }
  });
});

describe("what a request that chose no route leaves in the context", () => {
  it("leaves the recorded models as the last Claude name left them, for a name no provider claims and for a body with no model", async () => {
    const fs = createFakeFarmFs();
    const launch = launchOfSession("s-1");
    const dir = `${FAKE_HOME}/.agent-shim/frontdoor/sessions`;
    writeFrontDoorSession(fs, dir, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    const store = launchRouteStore(fs, dir, () => undefined);
    const world = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored: store, log: () => undefined }));
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: SONNET_NAME, requestClass: "main" });
      const recorded = store.read(launch);
      expect(recorded).toMatchObject({ kind: "provider", provider: "z", requestedModel: SONNET_NAME, servedModel: Z_SONNET_MODEL });
      await send(world, { model: "gpt-5", requestClass: "main" });
      await send(world, { model: "", rawBody: JSON.stringify({ messages: [], max_tokens: 5 }), requestClass: "main" });
      expect(store.read(launch)).toEqual(recorded);
    } finally {
      await world.close();
    }
  });

  it("serves a name that only contains a tier word as asked, not as the tier's model", async () => {
    const world = await startWorld();
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      await send(world, { model: "magnum-opus", requestClass: "main" });
      await send(world, { model: "magnum-opus", requestClass: "auxiliary" });
      expect(world.upstream.seen.map((seen) => seen.model)).toEqual(["glm-5.3", "magnum-opus", "magnum-opus"]);
      expect(world.upstream.seen.map((seen) => seen.model)).not.toContain(Z_OPUS_MODEL);
    } finally {
      await world.close();
    }
  });

  it("is refused by a router with no pointer without moving the context", async () => {
    const fs = createFakeFarmFs();
    const launch = launchOfSession("s-1");
    const dir = `${FAKE_HOME}/.agent-shim/frontdoor/sessions`;
    writeFrontDoorSession(fs, dir, { pid: launch.pid, startedAt: launch.startedAt, token: "t" });
    const store = launchRouteStore(fs, dir, () => undefined);
    const world = await startWorld(createMainLoopRouteRecord({ holdsLaunch: () => true, stored: store, log: () => undefined }));
    try {
      await send(world, { model: "r/glm-5.3", requestClass: "main" });
      const recorded = store.read(launch);
      expect(recorded).toMatchObject({ kind: "provider", provider: "r" });
      expect((await send(world, { model: SONNET_NAME, requestClass: "main" })).status).toBe(HTTP_STATUS.badRequest);
      expect(store.read(launch)).toEqual(recorded);
    } finally {
      await world.close();
    }
  });
});

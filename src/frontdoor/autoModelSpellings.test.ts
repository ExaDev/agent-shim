import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { mainLoopRoutesOfLiveSessions } from "../test-helpers";
import { LIVE_SERVED_MODEL, launchOfSession, send, startWorld } from "./mainLoopRouteTestWorld";

/** The model `auto`, as Claude Code writes it with and without the context-window marker. */
const SPELLINGS = ["auto", "auto[1m]", "auto[1M]"] as const;

interface SessionKind {
  readonly label: string;
  /** The requests that put the session on the provider before the one under test. */
  readonly establish: readonly string[];
  readonly options: { readonly requestClass: string; readonly provider?: string };
  /** Whether the request under test is a turn of the main loop, whose recorded context follows it. */
  readonly recorded: boolean;
}

const SESSION_KINDS: readonly SessionKind[] = [
  { label: "a provider context chosen by a qualified name", establish: ["z/glm-5.3"], options: { requestClass: "main" }, recorded: true },
  { label: "a session launched on the provider", establish: [], options: { requestClass: "main", provider: "z" }, recorded: false },
  { label: "a helper of a provider context", establish: ["z/glm-5.3"], options: { requestClass: "auxiliary" }, recorded: false },
];

/**
 * The name `auto` is the same name whether or not the marker follows it: the upstream is sent the model its list names, and the context a provider session is on records it, for every spelling and every kind of session that sends it.
 */
describe.each(SESSION_KINDS)("the model auto sent by $label", (kind) => {
  it.each(SPELLINGS)("as %s is rewritten to the live served model and never reaches the server as the literal name", async (spelling) => {
    const record = mainLoopRoutesOfLiveSessions();
    const world = await startWorld(record);
    try {
      for (const model of kind.establish) await send(world, { model, requestClass: "main" });
      const before = world.upstream.seen.length;
      const answered = await send(world, { model: spelling, ...kind.options });
      expect(answered.status).toBe(HTTP_STATUS.ok);
      expect(world.upstream.seen.slice(before).map((seen) => seen.model)).toEqual([LIVE_SERVED_MODEL]);
      if (kind.recorded) expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ kind: "provider", provider: "z", servedModel: LIVE_SERVED_MODEL });
    } finally {
      await world.close();
    }
  });
});

/** The same name decides the refusals that guard the rewrite of it: a body that names it twice, and one the door cannot rewrite, never reach the server. */
describe("a body naming the model auto with the marker that cannot be rewritten", () => {
  it.each(SPELLINGS)("is refused for %s when it names a model twice or is no JSON object, and the server is sent nothing", async (spelling) => {
    const world = await startWorld(mainLoopRoutesOfLiveSessions());
    try {
      await send(world, { model: "z/glm-5.3", requestClass: "main" });
      const before = world.upstream.seen.length;
      const twice = await send(world, { model: spelling, requestClass: "main", rawBody: `{"model":"${spelling}","model":"other","max_tokens":16,"messages":[]}` });
      expect(twice.status).toBe(HTTP_STATUS.badRequest);
      expect(twice.text).toContain("more than one top-level model");
      const broken = await send(world, { model: spelling, requestClass: "main", rawBody: `{"model":"${spelling}","max_tokens":16,"messages":[}` });
      expect(broken.status).toBe(HTTP_STATUS.badRequest);
      expect(world.upstream.seen).toHaveLength(before);
    } finally {
      await world.close();
    }
  });

  it.each(SPELLINGS)("records no served model for %s when the provider's list cannot be read, never the literal name", async (spelling) => {
    const record = mainLoopRoutesOfLiveSessions();
    const world = await startWorld(record);
    try {
      world.setProvider("dead", { displayName: "Dead", baseUrl: "http://127.0.0.1:1", credential: { sources: [{ literal: "t" }] } });
      await send(world, { model: "dead/glm", requestClass: "main" });
      expect((await send(world, { model: spelling, requestClass: "main" })).status).toBe(HTTP_STATUS.badGateway);
      expect(record.routeOf(launchOfSession("s-1"))).toMatchObject({ kind: "provider", provider: "dead" });
      expect(record.routeOf(launchOfSession("s-1"))).not.toHaveProperty("servedModel", spelling);
    } finally {
      await world.close();
    }
  });
});

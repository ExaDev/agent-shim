import { describe, expect, it } from "vitest";

import type { RcDialTarget } from "./connectEffects";
import { rcSelfHostEventDial, rcSelfHostStreamDial, selfHostSurfaceUnboundReason, type RcSelfHostDialSource } from "./rcSelfHostDial";
import type { RcPresenceAnswer, RcStreamDial } from "./rcStream";
import { answerRcControlRequest, injectRcUserMessage, interruptRcSession, type RcEventDial } from "./rcWrites";

const SESSION = "cse_00000000-0000-4000-8000-000000000000";
const REASON = "AGENT_SHIM_TRANSPARENT_SURFACE is not set, so the door has no surface of its own to write to";
const LOOPBACK: RcDialTarget = { host: "127.0.0.1", port: 47_592, servername: "api.anthropic.com" };
const HEADERS = { authorization: "Bearer sk-ant-oat" };
const ANSWERED = { status: 200, body: "{}" };
const PRESENCE: RcPresenceAnswer = { status: 200, body: "{}" };

/** The targets a dial the door builds must never reach: the real API host first, then every other address that is not a loopback literal. */
const NOT_THIS_MACHINE: readonly string[] = ["api.anthropic.com", "localhost", "10.0.0.5", "127.0.0.1.example.com", "::ffff:127.0.0.1", "0.0.0.0"];

/** An empty byte stream: the opened stream these worlds hand back. */
const NO_CHUNKS: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => ({ next: async () => await Promise.resolve({ done: true, value: undefined }) }),
};

/** A world whose dial factories record every target they are asked to build for, and whose dials record every request they carry. */
function makeWorld(resolve: () => RcDialTarget | undefined) {
  const built: RcDialTarget[] = [];
  const sent: string[] = [];
  const source: RcSelfHostDialSource = { resolve, unboundReason: () => REASON };
  const makeEventDial = (target: RcDialTarget): RcEventDial => {
    built.push(target);
    return {
      writeEvents: async () => {
        sent.push(`events@${target.host}`);
        return await Promise.resolve(ANSWERED);
      },
      writeTeleportEvents: async () => {
        sent.push(`teleport@${target.host}`);
        return await Promise.resolve(ANSWERED);
      },
    };
  };
  const makeStreamDial = (target: RcDialTarget): RcStreamDial => {
    built.push(target);
    return {
      announcePresence: async () => {
        sent.push(`presence@${target.host}`);
        return await Promise.resolve(PRESENCE);
      },
      markRead: async () => {
        sent.push(`mark-read@${target.host}`);
        return await Promise.resolve(PRESENCE);
      },
      openStream: async () => {
        sent.push(`stream@${target.host}`);
        return await Promise.resolve({ status: 200, chunks: NO_CHUNKS });
      },
    };
  };
  return { source, built, sent, eventDial: rcSelfHostEventDial(source, makeEventDial), streamDial: rcSelfHostStreamDial(source, makeStreamDial) };
}

describe("the door's dials in the self-hosted mode", () => {
  it("refuse every request while the surface is unbound, naming why, and build no dial at all", async () => {
    const world = makeWorld(() => undefined);
    const signal = new AbortController().signal;
    const refusals = [
      world.eventDial.writeEvents(SESSION, HEADERS, "{}"),
      world.eventDial.writeTeleportEvents(SESSION, HEADERS, "{}"),
      world.streamDial.announcePresence(SESSION, HEADERS, "client", false),
      world.streamDial.markRead(SESSION, HEADERS, undefined),
      world.streamDial.openStream(SESSION, HEADERS, undefined, signal),
    ];
    for (const refusal of refusals) {
      await expect(refusal).rejects.toThrow(REASON);
    }
    expect(world.built).toEqual([]);
    expect(world.sent).toEqual([]);
  });

  it.each(NOT_THIS_MACHINE)("refuse a surface that resolved to %s, which is not this machine", async (host) => {
    const world = makeWorld(() => ({ ...LOOPBACK, host }));
    await expect(world.eventDial.writeEvents(SESSION, HEADERS, "{}")).rejects.toThrow("which is not this machine");
    await expect(world.eventDial.writeTeleportEvents(SESSION, HEADERS, "{}")).rejects.toThrow("which is not this machine");
    await expect(world.streamDial.announcePresence(SESSION, HEADERS, "client", false)).rejects.toThrow("which is not this machine");
    await expect(world.streamDial.markRead(SESSION, HEADERS, undefined)).rejects.toThrow("which is not this machine");
    await expect(world.streamDial.openStream(SESSION, HEADERS, undefined, new AbortController().signal)).rejects.toThrow("which is not this machine");
    expect(world.built).toEqual([]);
    expect(world.sent).toEqual([]);
  });

  it("carry a request to a loopback surface, building one dial per resolved target and rebuilding when it changes", async () => {
    let target: RcDialTarget = LOOPBACK;
    const world = makeWorld(() => target);
    await world.eventDial.writeEvents(SESSION, HEADERS, "{}");
    await world.eventDial.writeTeleportEvents(SESSION, HEADERS, "{}");
    await world.streamDial.announcePresence(SESSION, HEADERS, "client", false);
    expect(world.sent).toEqual(["events@127.0.0.1", "teleport@127.0.0.1", "presence@127.0.0.1"]);
    expect(world.built).toEqual([LOOPBACK, LOOPBACK]);
    target = { ...LOOPBACK, host: "::1" };
    await world.eventDial.writeEvents(SESSION, HEADERS, "{}");
    expect(world.built).toEqual([LOOPBACK, LOOPBACK, target]);
  });

  it("never let any client-half verb reach a host that is not this machine, whatever the surface resolves to", async () => {
    const resolutions: readonly (RcDialTarget | undefined)[] = [undefined, ...NOT_THIS_MACHINE.map((host) => ({ ...LOOPBACK, host })), LOOPBACK];
    for (const resolution of resolutions) {
      const world = makeWorld(() => resolution);
      const deps = { credentialOf: () => ({ authorization: "Bearer sk-ant-oat", anthropicVersion: undefined, anthropicClientPlatform: "claude_code_cli" }), noteSequenceNums: () => undefined, dial: world.eventDial, newUuid: () => "00000000-0000-4000-8000-000000000001" };
      const results = [
        await injectRcUserMessage(deps, SESSION, "hello"),
        await interruptRcSession(deps, SESSION),
        await answerRcControlRequest({ ...deps, pendingOf: () => [{ sessionId: SESSION, requestId: "req_1", type: "can_use_tool", summary: "Bash", observedAt: 0 }], completePending: () => undefined }, SESSION, "req_1", { approve: true, message: undefined }),
      ];
      for (const sent of world.sent) {
        expect(sent.endsWith("@127.0.0.1") || sent.endsWith("@::1")).toBe(true);
      }
      for (const target of world.built) {
        expect(["127.0.0.1", "::1"]).toContain(target.host);
      }
      if (resolution === undefined) {
        const refused = results[0];
        expect(refused?.ok === false ? refused.message : "").toContain(REASON);
        expect(world.sent).toEqual([]);
      }
    }
  });

  it("name why the surface is unbound: unset, not a port, or set but not bound", () => {
    expect(selfHostSurfaceUnboundReason(undefined)).toContain("is not set");
    expect(selfHostSurfaceUnboundReason("abc")).toContain('is "abc", which is not a port');
    expect(selfHostSurfaceUnboundReason("47592")).toContain("on port 47592 is not bound");
  });
});

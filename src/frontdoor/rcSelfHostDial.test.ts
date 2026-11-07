import { describe, expect, it } from "vitest";

import type { RcDialTarget } from "./connectEffects";
import { rcSelfHostEventDial, rcSelfHostStreamDial, rcSelfHostedDials, selfHostSurfaceUnboundReason, type RcSelfHostDialSource } from "./rcSelfHostDial";
import type { RcPresenceAnswer, RcStreamDial } from "./rcStream";
import { RcDialRefusal, answerRcControlRequest, endRcSession, injectRcUserMessage, interruptRcSession, setRcSessionModel, teleportRcSession, type RcControlRequestDeps, type RcEventDial, type RcObservedCredential } from "./rcWrites";

const SESSION = "cse_00000000-0000-4000-8000-000000000000";
const REASON = "AGENT_SHIM_TRANSPARENT_SURFACE is not set, so the door has no surface of its own to reach";
const LOOPBACK: RcDialTarget = { host: "127.0.0.1", port: 47_592, servername: "api.anthropic.com" };
const HEADERS = { authorization: "Bearer sk-ant-oat" };
const ANSWERED = { status: 200, body: "{}" };
/** An accepting service's answer to a write: the sequence number it assigned. */
const NUMBERED = { status: 200, body: JSON.stringify({ results: [{ sequence_num: "1" }] }) };
const PRESENCE: RcPresenceAnswer = { status: 200, body: "{}" };

/** The targets a dial the door builds must never reach: the real API host first, then every other address that is not a loopback literal. */
const NOT_THIS_MACHINE: readonly string[] = [
  "api.anthropic.com",
  "localhost",
  "10.0.0.5",
  "127.0.0.1.example.com",
  "::ffff:127.0.0.1",
  "0.0.0.0",
  // Other spellings of this machine, and of an address the host field must not carry: a dial's host is a literal address and nothing else.
  "127.0.0.2",
  "127.1",
  "0x7f.1",
  "2130706433",
  "127.0.0.1.",
  "[::1]",
  "0:0:0:0:0:0:0:1",
  "user@127.0.0.1",
  "127.0.0.1:8080",
  " 127.0.0.1",
];

/** The only hosts a dial to the door's own surface may reach: the two loopback literals, exactly. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1"];

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
  it("refuse with an error that is recognisably the guard's own, whose reason is neutral about whether the request reads or writes", async () => {
    const world = makeWorld(() => undefined);
    const writes = world.eventDial.writeEvents(SESSION, HEADERS, "{}");
    await expect(writes).rejects.toBeInstanceOf(RcDialRefusal);
    await expect(world.streamDial.openStream(SESSION, HEADERS, undefined, new AbortController().signal)).rejects.toBeInstanceOf(RcDialRefusal);
    const elsewhere = makeWorld(() => ({ ...LOOPBACK, host: "api.anthropic.com" }));
    await expect(elsewhere.eventDial.writeEvents(SESSION, HEADERS, "{}")).rejects.toBeInstanceOf(RcDialRefusal);
    for (const unset of [undefined, "abc", "47592"]) {
      expect(selfHostSurfaceUnboundReason(unset)).not.toMatch(/\bwrite\b/);
    }
  });

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

  it.each(LOOPBACK_HOSTS)("accept exactly the loopback literal %s", async (host) => {
    const world = makeWorld(() => ({ ...LOOPBACK, host }));
    await world.eventDial.writeEvents(SESSION, HEADERS, "{}");
    await world.streamDial.announcePresence(SESSION, HEADERS, "client", false);
    expect(world.sent).toEqual([`events@${host}`, `presence@${host}`]);
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
        expect(world.sent).toEqual([]);
      }
      if (resolution === undefined || !LOOPBACK_HOSTS.includes(resolution.host)) {
        // The guard's refusal is not a network failure, so no verb words it as one: the target was never the API host, and the dial never tried it.
        for (const result of results) {
          expect(result.ok ? "" : result.message).toMatch(/^the door refused to /);
          expect(result.ok ? "" : result.message).not.toContain("could not reach");
        }
      }
    }
  });

  it("name why the surface is unbound: unset, not a port, or set but not bound", () => {
    expect(selfHostSurfaceUnboundReason(undefined)).toContain("is not set");
    expect(selfHostSurfaceUnboundReason("abc")).toContain('is "abc", which is not a port');
    expect(selfHostSurfaceUnboundReason("47592")).toContain("on port 47592 is not bound");
  });
});

describe("the self-hosted mode's per-session dials", () => {
  const OWNED = "cse_00000000-0000-4000-8000-0000000000a1";
  const NATIVE = "cse_00000000-0000-4000-8000-0000000000b2";
  const OWNED_CREDENTIAL = "Bearer minted";

  /** A world whose real dials record what reaches the real service, over a surface that owns one session and the credential it minted. */
  function makeComposedWorld(resolve: () => RcDialTarget | undefined) {
    const realSent: string[] = [];
    const source: RcSelfHostDialSource = { resolve, unboundReason: () => REASON };
    const real = {
      event: { writeEvents: async (sessionId: string) => { realSent.push(`events:${sessionId}`); return await Promise.resolve(NUMBERED); }, writeTeleportEvents: async (sessionId: string) => { realSent.push(`teleport:${sessionId}`); return await Promise.resolve(NUMBERED); } } satisfies RcEventDial,
      stream: { announcePresence: async (sessionId: string) => { realSent.push(`presence:${sessionId}`); return await Promise.resolve(PRESENCE); }, markRead: async (sessionId: string) => { realSent.push(`mark-read:${sessionId}`); return await Promise.resolve(PRESENCE); }, openStream: async (sessionId: string) => { realSent.push(`stream:${sessionId}`); return await Promise.resolve({ status: 200, chunks: NO_CHUNKS }); } } satisfies RcStreamDial,
    };
    const surface = { ownsSession: (sessionId: string, authorization: string | undefined) => sessionId === OWNED || authorization === OWNED_CREDENTIAL };
    const credentials = new Map([[OWNED, { authorization: OWNED_CREDENTIAL, anthropicVersion: undefined, anthropicClientPlatform: undefined }]]);
    const selfHostedBuilt: RcDialTarget[] = [];
    const makers = {
      event: (target: RcDialTarget): RcEventDial => {
        selfHostedBuilt.push(target);
        return { writeEvents: async () => await Promise.resolve(ANSWERED), writeTeleportEvents: async () => await Promise.resolve(ANSWERED) };
      },
      stream: (target: RcDialTarget): RcStreamDial => {
        selfHostedBuilt.push(target);
        return real.stream;
      },
    };
    return { realSent, selfHostedBuilt, dials: rcSelfHostedDials(surface, source, (id) => credentials.get(id), real, makers) };
  }

  it("never offer an owned session to the real service, refusing while the surface is unbound, and still reach a native session's real service", async () => {
    const world = makeComposedWorld(() => undefined);
    const signal = new AbortController().signal;
    await expect(world.dials.event.writeEvents(OWNED, { authorization: OWNED_CREDENTIAL }, "{}")).rejects.toThrow(REASON);
    await expect(world.dials.event.writeTeleportEvents(OWNED, { authorization: OWNED_CREDENTIAL }, "{}")).rejects.toThrow(REASON);
    await expect(world.dials.stream.openStream(OWNED, { authorization: OWNED_CREDENTIAL }, undefined, signal)).rejects.toThrow(REASON);
    await expect(world.dials.stream.announcePresence(OWNED, { authorization: OWNED_CREDENTIAL }, "client", false)).rejects.toThrow(REASON);
    await expect(world.dials.event.writeEvents("cse_00000000-0000-4000-8000-0000000000c3", { authorization: OWNED_CREDENTIAL }, "{}")).rejects.toThrow(REASON);
    expect(world.realSent).toEqual([]);
    await world.dials.event.writeEvents(NATIVE, { authorization: "Bearer native" }, "{}");
    await world.dials.stream.openStream(NATIVE, { authorization: "Bearer native" }, undefined, signal);
    expect(world.realSent).toEqual([`events:${NATIVE}`, `stream:${NATIVE}`]);
  });

  it("answers whether the door's own service owns a session by what the surface holds and the credential the tracker observed", () => {
    const world = makeComposedWorld(() => LOOPBACK);
    expect(world.dials.owns(OWNED)).toBe(true);
    expect(world.dials.owns(NATIVE)).toBe(false);
  });
  it("never lets a verb reach a dial without an observed OAuth credential, whichever backend the session would choose", async () => {
    const withoutOAuth: readonly (RcObservedCredential | undefined)[] = [undefined, { authorization: undefined, anthropicVersion: undefined, anthropicClientPlatform: "claude_code_cli" }];
    for (const surface of [() => undefined, () => LOOPBACK]) {
      for (const credential of withoutOAuth) {
        for (const session of [OWNED, NATIVE]) {
          const world = makeComposedWorld(surface);
          const deps: RcControlRequestDeps = { credentialOf: () => credential, noteSequenceNums: () => undefined, dial: world.dials.event, newUuid: () => "00000000-0000-4000-8000-000000000001" };
          const results = [
            await injectRcUserMessage(deps, session, "hello"),
            await interruptRcSession(deps, session),
            await setRcSessionModel(deps, session, "model"),
            await endRcSession(deps, session, undefined),
            await teleportRcSession(deps, session, "marker"),
            await answerRcControlRequest({ ...deps, pendingOf: () => [{ sessionId: session, requestId: "req_1", type: "can_use_tool", summary: "Bash", observedAt: 0 }], completePending: () => undefined }, session, "req_1", { approve: true, message: undefined }),
          ];
          for (const result of results) {
            expect(result.ok).toBe(false);
          }
          expect(world.realSent).toEqual([]);
          expect(world.selfHostedBuilt).toEqual([]);
        }
      }
    }
  });

  it("sends a native session's verbs to the real service and refuses an owned session's while the surface is unbound, never dialling a non-loopback host for it", async () => {
    const signal = new AbortController().signal;
    const unbound = makeComposedWorld(() => undefined);
    const native: RcObservedCredential = { authorization: "Bearer native", anthropicVersion: undefined, anthropicClientPlatform: "claude_code_cli" };
    const owned: RcObservedCredential = { authorization: OWNED_CREDENTIAL, anthropicVersion: undefined, anthropicClientPlatform: "claude_code_cli" };
    const verbsOf = (credential: RcObservedCredential): RcControlRequestDeps => ({ credentialOf: () => credential, noteSequenceNums: () => undefined, dial: unbound.dials.event, newUuid: () => "00000000-0000-4000-8000-000000000001" });
    const nativeResult = await interruptRcSession(verbsOf(native), NATIVE);
    expect(nativeResult.ok).toBe(true);
    await unbound.dials.stream.openStream(NATIVE, { authorization: "Bearer native" }, undefined, signal);
    expect(unbound.realSent).toEqual([`events:${NATIVE}`, `stream:${NATIVE}`]);
    unbound.realSent.length = 0;
    const ownedResult = await interruptRcSession(verbsOf(owned), OWNED);
    expect(ownedResult.ok ? "" : ownedResult.message).toMatch(/^the door refused to /);
    expect(ownedResult.ok ? "" : ownedResult.message).toContain(REASON);
    expect(unbound.realSent).toEqual([]);
    expect(unbound.selfHostedBuilt).toEqual([]);
    for (const host of NOT_THIS_MACHINE) {
      const elsewhere = makeComposedWorld(() => ({ ...LOOPBACK, host }));
      const refused = await interruptRcSession({ ...verbsOf(owned), dial: elsewhere.dials.event }, OWNED);
      expect(refused.ok ? "" : refused.message).toMatch(/^the door refused to /);
      expect(elsewhere.realSent).toEqual([]);
      expect(elsewhere.selfHostedBuilt).toEqual([]);
    }
  });
});

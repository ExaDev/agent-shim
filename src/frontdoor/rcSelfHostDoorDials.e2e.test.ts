import { afterEach, describe, expect, it } from "vitest";

import type { RcDialTarget } from "./connectEffects";
import { createRcSelfHostSurface, type RcSelfHostCredentialRecord } from "./rcSelfHost";
import { doorRcDials, type DoorRcDials, type RcSelfHostDialSource } from "./rcSelfHostDial";
import { createRcSessionCommands, RC_SESSION_COMMAND_VERIFIED_VERSIONS } from "./rcSessionCommands";
import { createRcSessionTracker, type RcSessionTracker } from "./rcSessions";
import { createRcEventFanout, createRcStreamHub, type RcStreamDial, type RcStreamHub } from "./rcStream";
import { injectRcUserMessage, interruptRcSession, type RcEventDial } from "./rcWrites";

/**
 * The door's client-half dials as the door assembles them, over the real pieces they decide between: the real self-hosted surface (which says what it owns), the real session tracker (which holds each session's observed credential), the real read stream hub and the real verbs. Only the two network ends are stand-ins: the real service's dials (recorders) and the loopback target of the door's own surface (a recording factory), since both need a certificate authority and a listener this case has no use for.
 */

const MINTED = "sk-ant-oat1";
const NATIVE_BEARER = "Bearer sk-ant-oat9";
const OWNED_ID = "cse_00000000-0000-4000-8000-0000000000a1";
const NATIVE_ID = "cse_00000000-0000-4000-8000-0000000000b2";
const RECORD: RcSelfHostCredentialRecord = { accessToken: MINTED, refreshToken: "selfhost-refresh", organizationUuid: "11111111-1111-4111-8111-111111111111", accountUuid: "22222222-2222-4222-8222-222222222222" };
const LOOPBACK: RcDialTarget = { host: "127.0.0.1", port: 47_592, servername: "api.anthropic.com" };
const UNBOUND_REASON = "AGENT_SHIM_TRANSPARENT_SURFACE is not set, so the door has no surface of its own to reach";
/** The HTTP status of an accepting service. */
const HTTP_OK = 200;
const NUMBERED = { status: HTTP_OK, body: JSON.stringify({ results: [{ sequence_num: "1" }] }) };
const VERIFIED = RC_SESSION_COMMAND_VERIFIED_VERSIONS[0] ?? "";
const POLL_MS = 5;
const SETTLE_TIMEOUT_MS = 2_000;

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}

/** Files a created session with the tracker the way the door's observing route does: the create exchange, with its bearer. */
function trackSession(tracker: RcSessionTracker, id: string, authorization: string): void {
  const observed = tracker.observeExchange({ method: "POST", url: "/v1/code/sessions", headers: { authorization } });
  observed?.onResponse(HTTP_OK, {});
  observed?.onBodyChunk(Buffer.from(JSON.stringify({ session: { id } }), "utf8"));
  observed?.onEnd();
}

const worlds: { readonly hub: RcStreamHub; readonly surface: { readonly close: () => void }; readonly tracker: RcSessionTracker }[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.hub.close();
    world.surface.close();
    world.tracker.close();
  }
});

/** The door's assembly in the self-hosted mode (or, with `selfHosting` false, outside it), over a surface that is bound or not. */
function makeDoor(options: { readonly bound: boolean; readonly selfHosting?: boolean }) {
  const realSent: string[] = [];
  const ownedBuilt: RcDialTarget[] = [];
  const ownedSent: string[] = [];
  const logs: string[] = [];
  const surface = createRcSelfHostSurface({ now: () => Date.now(), newUuid: () => "00000000-0000-4000-8000-000000000001", randomToken: () => "random-token-material", credentialRecord: () => RECORD, webFetch: async (url) => await Promise.resolve({ kind: "fetched", url, destinationUrl: url, contentType: "text/html", text: "" }) });
  const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: 60_000 });
  const source: RcSelfHostDialSource = { resolve: () => (options.bound ? LOOPBACK : undefined), unboundReason: () => UNBOUND_REASON };
  const realStream: RcStreamDial = {
    announcePresence: async (sessionId) => {
      realSent.push(`presence:${sessionId}`);
      return await Promise.resolve({ status: HTTP_OK, body: "{}" });
    },
    markRead: async () => await Promise.resolve({ status: HTTP_OK, body: "{}" }),
    openStream: async (sessionId, _headers, _resume, signal) => {
      realSent.push(`stream:${sessionId}`);
      const chunks: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => ({
          next: async () => {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => {
                resolve();
              });
            });
            return { done: true, value: undefined };
          },
        }),
      };
      return await Promise.resolve({ status: HTTP_OK, chunks });
    },
  };
  const realEvent: RcEventDial = {
    writeEvents: async (sessionId) => {
      realSent.push(`events:${sessionId}`);
      return await Promise.resolve(NUMBERED);
    },
    writeTeleportEvents: async (sessionId) => {
      realSent.push(`teleport:${sessionId}`);
      return await Promise.resolve(NUMBERED);
    },
  };
  const dials: DoorRcDials = doorRcDials(options.selfHosting === false ? undefined : surface, source, tracker.credentialOf, { event: realEvent, stream: realStream }, {
    event: (target) => {
      ownedBuilt.push(target);
      return {
        writeEvents: async (sessionId) => {
          ownedSent.push(`events:${sessionId}@${target.host}`);
          return await Promise.resolve(NUMBERED);
        },
        writeTeleportEvents: async () => await Promise.resolve(NUMBERED),
      };
    },
    stream: (target) => {
      ownedBuilt.push(target);
      return { ...realStream, announcePresence: async (sessionId) => {
          ownedSent.push(`presence:${sessionId}@${target.host}`);
          return await Promise.resolve({ status: HTTP_OK, body: "{}" });
        } };
    },
  });
  const hub = createRcStreamHub({
    now: () => Date.now(),
    credentialOf: tracker.credentialOf,
    trackedSessions: () => tracker.list().map((session) => session.id),
    fileStreamEvent: tracker.fileStreamEvent,
    sequenceNumOf: tracker.sequenceNumOf,
    dial: dials.stream,
    fanout: createRcEventFanout(),
    newClientId: () => "client-1",
    backoffMs: 1,
    // A failed attachment backs off for as long as the test needs: the first failure is the evidence.
    sleep: async () => {
      await new Promise<void>(() => undefined);
    },
    log: (line) => {
      logs.push(line);
    },
  });
  worlds.push({ hub, surface, tracker });
  trackSession(tracker, OWNED_ID, `Bearer ${MINTED}`);
  trackSession(tracker, NATIVE_ID, NATIVE_BEARER);
  const verbs = (sessionId: string) => ({ credentialOf: tracker.credentialOf, noteSequenceNums: tracker.noteSequenceNums, dial: dials.event, newUuid: () => "00000000-0000-4000-8000-000000000002", sessionId });
  return { dials, hub, tracker, realSent, ownedBuilt, ownedSent, logs, verbs };
}

describe("the door's client-half dials, assembled as the door assembles them", () => {
  it("refuses an owned session's verb while the surface is unbound, naming why, and dials nothing at all", async () => {
    const door = makeDoor({ bound: false });
    const sent = await injectRcUserMessage(door.verbs(OWNED_ID), OWNED_ID, "hello");
    expect(sent.ok ? "" : sent.message).toMatch(/^the door refused to /);
    expect(sent.ok ? "" : sent.message).toContain(UNBOUND_REASON);
    const interrupted = await interruptRcSession(door.verbs(OWNED_ID), OWNED_ID);
    expect(interrupted.ok ? "" : interrupted.message).toContain(UNBOUND_REASON);
    expect(door.realSent).toEqual([]);
    expect(door.ownedBuilt).toEqual([]);
    expect(door.ownedSent).toEqual([]);
  });

  it("sends a native session's verb to the real service while the surface is unbound", async () => {
    const door = makeDoor({ bound: false });
    const sent = await injectRcUserMessage(door.verbs(NATIVE_ID), NATIVE_ID, "hello");
    expect(sent.ok).toBe(true);
    expect(door.realSent).toEqual([`events:${NATIVE_ID}`]);
    expect(door.ownedBuilt).toEqual([]);
  });

  it("sends an owned session's verb to the door's own surface and a native one to the real service when the surface is bound", async () => {
    const door = makeDoor({ bound: true });
    expect((await injectRcUserMessage(door.verbs(OWNED_ID), OWNED_ID, "hello")).ok).toBe(true);
    expect((await injectRcUserMessage(door.verbs(NATIVE_ID), NATIVE_ID, "hello")).ok).toBe(true);
    expect(door.ownedSent).toEqual([`events:${OWNED_ID}@127.0.0.1`]);
    expect(door.realSent).toEqual([`events:${NATIVE_ID}`]);
    expect(door.ownedBuilt).toEqual([LOOPBACK]);
  });

  it("makes the read stream follow the same choice: the owned session's attachment refuses while unbound, the native one's reaches the real service", async () => {
    const door = makeDoor({ bound: false });
    door.hub.reconcile();
    await waitUntil(() => door.logs.some((line) => line.includes(OWNED_ID) && line.includes("attachment failed") && line.includes(UNBOUND_REASON)) && door.realSent.includes(`stream:${NATIVE_ID}`), "both attachments to settle");
    expect(door.realSent).toContain(`presence:${NATIVE_ID}`);
    expect(door.realSent.filter((entry) => entry.endsWith(OWNED_ID))).toEqual([]);
    expect(door.ownedBuilt).toEqual([]);
  });

  it("makes the read stream follow the same choice when the surface is bound: the owned session's attachment reaches the door's own surface, the native one's the real service", async () => {
    const door = makeDoor({ bound: true });
    door.hub.reconcile();
    await waitUntil(() => door.ownedSent.includes(`presence:${OWNED_ID}@127.0.0.1`) && door.realSent.includes(`presence:${NATIVE_ID}`), "both attachments to announce");
    expect(door.realSent.filter((entry) => entry.endsWith(OWNED_ID))).toEqual([]);
  });

  it("writes goal and compaction commands as a person's app only to an owned session, and refuses a native session without writing", async () => {
    const door = makeDoor({ bound: true });
    const selfHost = door.dials.selfHost;
    if (selfHost === undefined) {
      throw new Error("expected the self-hosted mode's dials");
    }
    const commands = createRcSessionCommands({
      supervisedOf: async () => {
        await Promise.resolve();
        return undefined;
      },
      goalOf: async () => {
        await Promise.resolve();
        return undefined;
      },
      isObserved: (sessionId) => door.tracker.statusOf(sessionId).length > 0,
      selfHost: {
        personWrite: { credentialOf: door.tracker.credentialOf, noteSequenceNums: door.tracker.noteSequenceNums, newUuid: () => "00000000-0000-4000-8000-000000000003", dial: selfHost.event },
        owns: selfHost.owns,
        unavailable: () => undefined,
        fanout: createRcEventFanout(),
        versionOf: () => VERIFIED,
        setTimer: () => () => undefined,
        defaultWaitMs: 1,
      },
    });
    const native = await commands.goalSet(NATIVE_ID, "tests pass");
    expect(native.ok ? "" : native.message).toContain("not launched under an agent-shim supervisor");
    expect(door.ownedSent).toEqual([]);
    expect(door.realSent).toEqual([]);
    await commands.goalSet(OWNED_ID, "tests pass");
    expect(door.ownedSent).toEqual([`events:${OWNED_ID}@127.0.0.1`]);
    expect(door.realSent).toEqual([]);
  });

  it("reaches the real service for every session when the door is not self-hosting", async () => {
    const door = makeDoor({ bound: false, selfHosting: false });
    expect(door.dials.selfHost).toBeUndefined();
    expect((await injectRcUserMessage(door.verbs(OWNED_ID), OWNED_ID, "hello")).ok).toBe(true);
    expect((await injectRcUserMessage(door.verbs(NATIVE_ID), NATIVE_ID, "hello")).ok).toBe(true);
    expect(door.realSent).toEqual([`events:${OWNED_ID}`, `events:${NATIVE_ID}`]);
  });
});

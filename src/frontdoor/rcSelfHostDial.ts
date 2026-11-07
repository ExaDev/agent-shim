import { realRcEventDial, realRcStreamDial, type RcDialTarget } from "./connectEffects";
import { rcSelfHostedChoiceOf, type RcSelfHostSurface } from "./rcSelfHost";
import { perSessionRcStreamDial, type RcStreamDial } from "./rcStream";
import { perSessionRcEventDial, type RcEventDial, type RcObservedCredential } from "./rcWrites";

/** The brand only `rcSelfHostEventDial` and `rcSelfHostStreamDial` put on a dial: not exported, so no other code can make a value of either type. */
const SELF_HOST_DIAL: unique symbol = Symbol("the door's own self-hosted surface");

/** The loopback addresses a dial to the door's own surface may name, as literals: a name would make the guard depend on how it resolves. Anything else is another machine, the real API host above all. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1"];

/**
 * Where the door's own client half dials while the door is the Remote Control service: `resolve` is the late-bound target of the door's own transparent surface (known only once its listener has bound, so undefined before) and `unboundReason` says why it is undefined, for the refusal that follows. There is deliberately no default target: a dial built over this source has nowhere else to go.
 */
export interface RcSelfHostDialSource {
  readonly resolve: () => RcDialTarget | undefined;
  readonly unboundReason: () => string;
}

/**
 * The client half's event dial in the self-hosted mode: it reaches the door's own self-hosted surface and nothing else. Unlike `realRcEventDial`, which dials the real API host by default, it refuses a request whose target is not resolved or resolves to anything but a loopback address, so a tracked session's credential and a verb's content can never be sent to another machine. It is also the one dial a command written as a person's app may ride.
 */
export interface RcSelfHostEventDial extends RcEventDial {
  readonly [SELF_HOST_DIAL]: true;
}

/** The client read stream's dial in the self-hosted mode, bound to the door's own surface exactly as `RcSelfHostEventDial` is. */
export interface RcSelfHostStreamDial extends RcStreamDial {
  readonly [SELF_HOST_DIAL]: true;
}

/**
 * The target a request may dial, or an error naming why none may: an unresolved surface and a resolved non-loopback address are both refused before any dial exists.
 */
function loopbackTargetOf(source: RcSelfHostDialSource): RcDialTarget {
  const target = source.resolve();
  if (target === undefined) {
    throw new Error(`${source.unboundReason()}; nothing is sent, because with no surface of its own to dial the request would go to the real API host`);
  }
  if (!LOOPBACK_HOSTS.includes(target.host)) {
    throw new Error(`the door's self-hosted surface resolved to ${target.host}, which is not this machine, so nothing is sent there`);
  }
  return target;
}

/** Builds each dial once per resolved target and reuses it, so the connection pooling a real dial exists for is kept while the target stays the same. */
function dialPerTarget<D>(source: RcSelfHostDialSource, makeDial: (target: RcDialTarget) => D): () => D {
  let built: { readonly for: RcDialTarget; readonly dial: D } | undefined;
  return () => {
    const target = loopbackTargetOf(source);
    if (built?.for !== target) {
      built = { for: target, dial: makeDial(target) };
    }
    return built.dial;
  };
}

/** Builds the event dial to the door's own self-hosted surface over `source`; `makeDial` is the real event dial in production and a fake in tests. */
export function rcSelfHostEventDial(source: RcSelfHostDialSource, makeDial: (target: RcDialTarget) => RcEventDial = realRcEventDial): RcSelfHostEventDial {
  const dialFor = dialPerTarget(source, makeDial);
  return {
    [SELF_HOST_DIAL]: true,
    writeEvents: async (sessionId, headers, body) => await dialFor().writeEvents(sessionId, headers, body),
    writeTeleportEvents: async (sessionId, headers, body) => await dialFor().writeTeleportEvents(sessionId, headers, body),
  };
}

/** Builds the client read stream's dial to the door's own self-hosted surface over `source`; `makeDial` is the real stream dial in production and a fake in tests. */
export function rcSelfHostStreamDial(source: RcSelfHostDialSource, makeDial: (target: RcDialTarget) => RcStreamDial = realRcStreamDial): RcSelfHostStreamDial {
  const dialFor = dialPerTarget(source, makeDial);
  return {
    [SELF_HOST_DIAL]: true,
    announcePresence: async (sessionId, headers, clientId, clear) => await dialFor().announcePresence(sessionId, headers, clientId, clear),
    markRead: async (sessionId, headers, eventId) => await dialFor().markRead(sessionId, headers, eventId),
    openStream: async (sessionId, headers, resume, signal) => await dialFor().openStream(sessionId, headers, resume, signal),
  };
}

/**
 * Why the door's own self-hosted surface is not bound, from the one input that decides whether it ever will be: `AGENT_SHIM_TRANSPARENT_SURFACE` as the door started with it. Unset or not a port, it never binds; set to a port, the listener has not bound it yet or could not.
 */
export function selfHostSurfaceUnboundReason(transparentSurface: string | undefined): string {
  const port = transparentSurface === undefined ? Number.NaN : Number(transparentSurface);
  if (transparentSurface === undefined) {
    return "AGENT_SHIM_TRANSPARENT_SURFACE is not set, so the door has no surface of its own to write to";
  }
  if (!Number.isInteger(port) || port <= 0) {
    return `AGENT_SHIM_TRANSPARENT_SURFACE is "${transparentSurface}", which is not a port, so the door has no surface of its own to write to`;
  }
  return `the door's transparent surface on port ${String(port)} is not bound: its listener has not started yet or could not bind the port (the door's log says which)`;
}

/**
 * The self-hosted mode's dials, chosen per session: `event` and `stream` are the real service's for a native session and the branded loopback dials for a session the door's own service owns, so an owned session's credential is never offered to the real service and a native session is never sent to the door's own surface. `selfHostEvent` is the branded event dial alone, the one a command written as a person's app may ride; `owns` says whether the door's own service owns a session, by what it holds and by the credential the tracker observed for it.
 */
export interface RcSelfHostedDials {
  readonly event: RcEventDial;
  readonly stream: RcStreamDial;
  readonly selfHostEvent: RcSelfHostEventDial;
  readonly owns: (sessionId: string) => boolean;
}

/** Builds the self-hosted mode's per-session dials over the surface that decides ownership, the source of the door's own surface, and the real dials a native session uses. */
export function rcSelfHostedDials(
  surface: Pick<RcSelfHostSurface, "ownsSession">,
  source: RcSelfHostDialSource,
  credentialOf: (sessionId: string) => RcObservedCredential | undefined,
  real: { readonly event: RcEventDial; readonly stream: RcStreamDial },
): RcSelfHostedDials {
  const choice = rcSelfHostedChoiceOf(surface);
  const selfHostEvent = rcSelfHostEventDial(source);
  return {
    event: perSessionRcEventDial(choice, selfHostEvent, real.event),
    stream: perSessionRcStreamDial(choice, rcSelfHostStreamDial(source), real.stream),
    selfHostEvent,
    owns: (sessionId) => surface.ownsSession(sessionId, credentialOf(sessionId)?.authorization),
  };
}

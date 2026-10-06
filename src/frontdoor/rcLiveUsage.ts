import { DOOR_EVENT_SOURCE_RC } from "./eventSchemas";
import type { DoorEventHub } from "./eventHub";
import { RcRateLimitInfoSchema, RcStreamEventSchema, type RcLiveRateLimit, type RcRateLimitInfo, type RcStreamEvent } from "./rcSchemas";

/**
 * The door's live quota state: the first consumer the door's event backbone owns, and the reason the backbone exists. It subscribes once to the backbone's Remote Control source, so every `rate_limit_event` envelope the held client stream files (the worker emits one after each completed turn, carrying the account's unified rate-limit windows) becomes the door's latest per-session rate-limit observation, and the control plane's `usage.live` read serves that state beside the snapshot readers it already serves.
 *
 * Freshness is the payload's own cadence, not a clock's: the worker files an envelope only once a turn has completed, so an observation is exactly as fresh as the `observedAt` it carries (the door's clock at the moment it filed the envelope), and the surface fabricates nothing beyond that. The reset instants are the payload's own `resetsAt` values carried verbatim (unix epoch seconds, the unit the CLI's own schema states); no countdown is derived from them, because a ticking derivation would claim a freshness the event stream never promised.
 *
 * The state is per door process and in memory only, and an observation deliberately outlives its session's own idle expiry: the quota the payload states is the account's, not the session's, so the last observation before a session went quiet remains the freshest statement there is until another session files a newer one. The map is bounded by the session ids one door generation ever observes, one small record each.
 */

/** The payload discriminator the worker's rate-limit envelope carries, the one event type this module files. */
const RC_RATE_LIMIT_EVENT_TYPE = "rate_limit_event";

/** The guard every payload narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The rate-limit facts one client read stream event carries, or undefined when the event is not a `rate_limit_event` this module can read: a payload of another type, a payload without the family's own one required field, or one whose `rate_limit_info` does not parse. An envelope the door cannot read is one it knows nothing about, never a failure, exactly as the stream's own parser treats an envelope it cannot read. Exported because the renderers (`frontdoor rc watch`, the web client's twin) narrow the same payload through the same one definition.
 */
export function rcRateLimitInfoOf(event: RcStreamEvent): RcRateLimitInfo | undefined {
  const payload = event.envelope.payload;
  if (!isRecord(payload) || payload.type !== RC_RATE_LIMIT_EVENT_TYPE) {
    return undefined;
  }
  if (!isRecord(payload.rate_limit_info)) {
    return undefined;
  }
  const parsed = RcRateLimitInfoSchema.safeParse(payload.rate_limit_info);
  return parsed.success ? parsed.data : undefined;
}

/** Everything the live quota state needs, injected so its filing runs against fakes in unit tests. */
export interface RcLiveUsageDeps {
  /** The door's clock, read at the moment an envelope is filed: the observation's `observedAt`. */
  readonly now: () => number;
  /** The door's event backbone, whose Remote Control source the state subscribes to. */
  readonly hub: DoorEventHub;
}

/** The door's live quota state, one per door process. */
export interface RcLiveUsage {
  /** Every observation the door holds, oldest-observed first, filtered to one session when named: the state the control plane's `usage.live` read serves. */
  readonly liveOf: (sessionId?: string) => readonly RcLiveRateLimit[];
  /** The freshest observation across every session, whatever filter a read names, because it is the door's single latest statement of the account's quota. */
  readonly latestOf: () => RcLiveRateLimit | undefined;
}

/** Creates the live quota state and subscribes it to the backbone, so every rate-limit envelope published from now on is filed the moment it arrives. One per door process; everything it holds dies with it. */
export function createRcLiveUsage(deps: RcLiveUsageDeps): RcLiveUsage {
  const observed = new Map<string, RcLiveRateLimit>();
  deps.hub.subscribe([DOOR_EVENT_SOURCE_RC], (event) => {
    // The backbone's payload for the rc source is the fan-out event (the session beside the envelope); anything else published under the tag is not this family's shape and is left alone rather than guessed at.
    const stream = RcStreamEventSchema.safeParse(event.payload);
    if (!stream.success) {
      return;
    }
    const rateLimit = rcRateLimitInfoOf(stream.data);
    if (rateLimit === undefined) {
      return;
    }
    observed.set(stream.data.session, { session: stream.data.session, observedAt: deps.now(), rateLimit });
  });
  const sorted = (): readonly RcLiveRateLimit[] => [...observed.values()].sort((left, right) => left.observedAt - right.observedAt || (left.session < right.session ? -1 : 1));
  return {
    liveOf: (sessionId) => sorted().filter((entry) => sessionId === undefined || entry.session === sessionId),
    latestOf: () => sorted().at(-1),
  };
}

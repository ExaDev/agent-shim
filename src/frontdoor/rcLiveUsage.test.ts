import { describe, expect, it } from "vitest";

import { DOOR_EVENT_SOURCE_RC, LAUNCH_EVENT_SOURCE } from "./eventSchemas";
import { createDoorEventHub } from "./eventHub";
import { createRcLiveUsage, rcRateLimitInfoOf } from "./rcLiveUsage";
import type { RcStreamEvent } from "./rcSchemas";

/** The milliseconds in one second, the unit that converts the fixed ISO instants into the unix epoch seconds the payload states. */
const MS_PER_SECOND = 1_000;

/** The instants the injected clock returns across the filings below, so each observation's stamp is a named value. */
const FIRST_OBSERVED_AT = 1_000;
const SECOND_OBSERVED_AT = 2_000;
const THIRD_OBSERVED_AT = 3_000;

/** The reset instants the fixed payloads state, in unix epoch seconds, chosen so the ISO instants they name are fixed values. */
const FIVE_HOUR_RESETS_AT = Date.parse("2025-10-06T16:00:00.000Z") / MS_PER_SECOND;
const SEVEN_DAY_RESETS_AT = Date.parse("2025-10-13T16:00:00.000Z") / MS_PER_SECOND;

/** The envelope sequence numbers the filings below carry, distinct so each publish is a new envelope on the stream. */
const FIRST_ENVELOPE_SEQUENCE = 7;
const OTHER_SESSION_SEQUENCE = 3;
const LATER_ENVELOPE_SEQUENCE = 9;
const UNRELATED_SEQUENCE = 8;
const MISSING_INFO_SEQUENCE = 10;

/** The launch pid one launch lifecycle event carries, an unrelated source's payload this state must ignore. */
const UNRELATED_PID = 20;

/**
 * One worker-sourced `rate_limit_event` envelope, carrying the payload the 2.1.289 bundle's own schema declares: the limiting window's fields, the overage fields, and the unified per-window usage, exactly as the live capture observed the family.
 */
function rateLimitEnvelope(sequenceNum: number, info: Record<string, unknown>): RcStreamEvent {
  return {
    session: "cse_live",
    envelope: {
      event_type: "rate_limit_event",
      sequence_num: sequenceNum,
      source: "worker",
      payload: { type: "rate_limit_event", rate_limit_info: info, uuid: "00000000-0000-4000-8000-000000000000", session_id: "cse_live" },
    },
  };
}

/** The full rate_limit_info the fixed envelopes carry. */
function fullInfo(): Record<string, unknown> {
  return {
    status: "allowed_warning",
    resetsAt: FIVE_HOUR_RESETS_AT,
    rateLimitType: "five_hour",
    utilization: 0.42,
    overageStatus: "allowed",
    overageResetsAt: SEVEN_DAY_RESETS_AT,
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: FIVE_HOUR_RESETS_AT }, seven_day: { utilization: 0.12, resetsAt: SEVEN_DAY_RESETS_AT } },
  };
}

describe("the live quota state on the door's event backbone", () => {
  it("holds nothing until the first rate_limit_event is filed, so absence is the honest label rather than a fabricated zero", () => {
    const hub = createDoorEventHub();
    const live = createRcLiveUsage({ now: () => FIRST_OBSERVED_AT, hub });

    expect(live.liveOf()).toEqual([]);
    expect(live.liveOf("cse_live")).toEqual([]);
    expect(live.latestOf()).toBeUndefined();

    // Even a busy backbone files nothing until a rate_limit_event arrives: another rc envelope and another source entirely both leave the state empty.
    hub.publisher(DOOR_EVENT_SOURCE_RC).publish({ session: "cse_live", envelope: { event_type: "assistant", sequence_num: FIRST_ENVELOPE_SEQUENCE, source: "worker", payload: { content: [] } } });
    hub.publisher(LAUNCH_EVENT_SOURCE).publish({ kind: "registered", pid: UNRELATED_PID, startedAt: FIRST_OBSERVED_AT, observedAt: FIRST_OBSERVED_AT });
    expect(live.liveOf()).toEqual([]);
    expect(live.latestOf()).toBeUndefined();
  });

  it("files a published rate_limit_event as the session's latest observation, stamped with the door's clock, carrying the payload's own fields and its extras verbatim", () => {
    const hub = createDoorEventHub();
    const live = createRcLiveUsage({ now: () => FIRST_OBSERVED_AT, hub });

    hub.publisher(DOOR_EVENT_SOURCE_RC).publish(rateLimitEnvelope(FIRST_ENVELOPE_SEQUENCE, fullInfo()));

    expect(live.liveOf()).toEqual([
      {
        session: "cse_live",
        observedAt: FIRST_OBSERVED_AT,
        rateLimit: {
          status: "allowed_warning",
          resetsAt: FIVE_HOUR_RESETS_AT,
          rateLimitType: "five_hour",
          utilization: 0.42,
          overageStatus: "allowed",
          overageResetsAt: SEVEN_DAY_RESETS_AT,
          isUsingOverage: false,
          unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: FIVE_HOUR_RESETS_AT }, seven_day: { utilization: 0.12, resetsAt: SEVEN_DAY_RESETS_AT } },
        },
      },
    ]);
    expect(live.latestOf()).toEqual(live.liveOf()[0]);
  });

  it("replaces a session's observation with each newer envelope and keeps every session's beside it, latestOf naming the freshest across them", () => {
    const hub = createDoorEventHub();
    let now = FIRST_OBSERVED_AT;
    const live = createRcLiveUsage({ now: () => now, hub });

    hub.publisher(DOOR_EVENT_SOURCE_RC).publish(rateLimitEnvelope(FIRST_ENVELOPE_SEQUENCE, { status: "allowed" }));
    now = SECOND_OBSERVED_AT;
    const other: RcStreamEvent = { session: "cse_other", envelope: { event_type: "rate_limit_event", sequence_num: OTHER_SESSION_SEQUENCE, source: "worker", payload: { type: "rate_limit_event", rate_limit_info: { status: "rejected" } } } };
    hub.publisher(DOOR_EVENT_SOURCE_RC).publish(other);
    now = THIRD_OBSERVED_AT;
    hub.publisher(DOOR_EVENT_SOURCE_RC).publish(rateLimitEnvelope(LATER_ENVELOPE_SEQUENCE, { status: "allowed_warning", utilization: 0.9 }));

    // Each session holds only its latest envelope, ordered oldest-observed first (the second envelope replaced the first's stamp), and the door-wide latest is the freshest of them regardless of which session filed it.
    expect(live.liveOf().map((entry) => [entry.session, entry.observedAt, entry.rateLimit.status])).toEqual([
      ["cse_other", SECOND_OBSERVED_AT, "rejected"],
      ["cse_live", THIRD_OBSERVED_AT, "allowed_warning"],
    ]);
    expect(live.latestOf()).toMatchObject({ session: "cse_live", observedAt: THIRD_OBSERVED_AT });
    expect(live.liveOf("cse_other")).toMatchObject([{ session: "cse_other", observedAt: SECOND_OBSERVED_AT }]);
  });

  it("does not file an envelope whose payload is not a readable rate_limit_event: another type, a missing rate_limit_info, one without the family's own required status, or a backbone payload that is not a stream event at all", () => {
    const hub = createDoorEventHub();
    const live = createRcLiveUsage({ now: () => FIRST_OBSERVED_AT, hub });

    hub.publisher(DOOR_EVENT_SOURCE_RC).publish(rateLimitEnvelope(FIRST_ENVELOPE_SEQUENCE, fullInfo()));
    const before = live.liveOf().length;

    // A different payload type on the same stream: not this family.
    hub.publisher(DOOR_EVENT_SOURCE_RC).publish({ session: "cse_live", envelope: { event_type: "assistant", sequence_num: UNRELATED_SEQUENCE, source: "worker", payload: { type: "assistant", content: [] } } });
    // The event type without a rate_limit_info object to read.
    hub.publisher(DOOR_EVENT_SOURCE_RC).publish({ session: "cse_live", envelope: { event_type: "rate_limit_event", sequence_num: LATER_ENVELOPE_SEQUENCE, source: "worker", payload: { type: "rate_limit_event" } } });
    // A rate_limit_info the family's own schema refuses (no status): the whole envelope is left unfiled rather than half-read.
    hub.publisher(DOOR_EVENT_SOURCE_RC).publish(rateLimitEnvelope(MISSING_INFO_SEQUENCE, { utilization: 0.5 }));
    // A backbone payload published under the rc tag that is not a stream event at all.
    hub.publisher(DOOR_EVENT_SOURCE_RC).publish({ not: "a stream event" });

    expect(live.liveOf().length).toBe(before);
    expect(live.latestOf()?.rateLimit.status).toBe("allowed_warning");
  });
});

describe("the rate-limit narrowing every renderer shares", () => {
  it("reads the info out of a rate_limit_event envelope and returns undefined for every other payload", () => {
    expect(rcRateLimitInfoOf(rateLimitEnvelope(FIRST_ENVELOPE_SEQUENCE, fullInfo()))).toMatchObject({ status: "allowed_warning", rateLimitType: "five_hour" });
    expect(rcRateLimitInfoOf({ session: "cse_live", envelope: { event_type: "assistant", sequence_num: UNRELATED_SEQUENCE, source: "worker", payload: { type: "assistant" } } })).toBeUndefined();
    expect(rcRateLimitInfoOf({ session: "cse_live", envelope: { event_type: "user", sequence_num: LATER_ENVELOPE_SEQUENCE, source: "worker" } })).toBeUndefined();
    expect(rcRateLimitInfoOf(rateLimitEnvelope(MISSING_INFO_SEQUENCE, {}))).toBeUndefined();
  });
});

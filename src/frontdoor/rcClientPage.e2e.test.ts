import vm from "node:vm";
import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { createDoorApiNodeHandler } from "./controlApi";
import { DOOR_EVENT_SOURCE_RC, LAUNCH_EVENT_SOURCE } from "./eventSchemas";
import { createDoorEventHub } from "./eventHub";
import type { RcLiveRateLimit } from "./rcSchemas";
import { RC_CLIENT_PAGE_HTML, RC_CLIENT_PAGE_SCRIPT, RC_CLIENT_PATH, createRcClientPage } from "./rcClientPage";
import { createRcSessionTracker, RC_IDLE_EXPIRY_MS } from "./rcSessions";
import type { RcEventWriteResult } from "./rcWrites";
import { generateCa, LOOPBACK_LEAF_NAMES, mintLeaf, type CaMaterial } from "./connect";
import { KEYGEN_TIMEOUT_MS } from "./connectTestWorld";
import { createFrontDoorServer, listenFrontDoor, type PrePipelineApi } from "./server";

/** The token the mounted door accepts, standing in for the per-generation value the real door writes owner-only. */
const CONTROL_TOKEN = "e2e-page-control-token";
/** The sequence numbers the recording write fakes answer with, so the assertions name what the page renders. */
const SEND_SEQUENCE_NUM = 41;
const ANSWER_SEQUENCE_NUM = 42;
/** The supervisor and launch pids the fixed front-door status carries, and the port it names. */
const SUPERVISOR_PID = 10;
const STATUS_PORT = 4300;
/** The envelope sequence_num values of the published rc events, and the backbone sequences they arrive with (the backbone counts per source from one; the fourth publish of this case is the rc source's third event). */
const FIRST_ENVELOPE_SEQUENCE = 9;
const SECOND_ENVELOPE_SEQUENCE = 10;
const THIRD_ENVELOPE_SEQUENCE = 13;
const THIRD_BACKBONE_SEQUENCE = 3;
/** How many events the stream case drives before it leaves the subscription. */
const STREAM_EVENT_COUNT = 4;
/** The sequence the gap arithmetic jumps to from the high-water the stream left, and the dropped count it must report. */
const GAPPED_SEQUENCE = 7;
const DROPPED_BY_GAP = 3;
/** The milliseconds in one second, the unit that converts the fixed ISO instants into the unix epoch seconds the payload states. */
const MS_PER_SECOND = 1_000;

/** A write the tests never expect to reach the real dial: the steering procedures resolve through it. */
const unexercised = async (): Promise<RcEventWriteResult> => await Promise.resolve({ ok: false, message: "this test drives no Remote Control write" });

/** How long the stream case may wait for the publishes it drives to cross the wire, so an overloaded machine fails visibly instead of hanging the suite. */
const WAIT_BUDGET_MS = 5_000;
const SETTLE_MS = 50;

/** Waits until the condition holds, failing loudly at the budget rather than hanging. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("the door did not reach the awaited state within the test's wait budget");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });
  }
}

/** One parsed SSE frame, exactly as the page's parser returns it. */
interface SseFrame {
  readonly event: string;
  readonly id: string;
  readonly data: string;
}

/** One source-tagged door event, the shape the page's feed handling narrows every frame's data to. */
interface DoorEventLike {
  readonly source: string;
  readonly sequence: number;
  readonly payload?: unknown;
}

/**
 * The shipped page script as a typed object, the same contract the unit suite drives (see there for the mechanics): the object handed to `vm.createContext` is the global the script's declarations land on, the placeholders are overwritten by the real definitions, and no `document` is provided so the boot guard skips.
 */
interface PageSandbox {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly window: { readonly location: { readonly origin: string; readonly search: string } };
  rpc: (path: string, input: Readonly<Record<string, unknown>> | undefined) => Promise<unknown>;
  parseSseFrames: (buffer: string) => { readonly frames: readonly SseFrame[]; readonly rest: string };
  sequenceGap: (tracker: Readonly<Record<string, number>>, event: Readonly<DoorEventLike>) => number;
  /** The page's quota rendering of the live read's freshest observation. */
  quotaText: (latest: Readonly<{ observedAt: number; rateLimit: Readonly<Record<string, unknown>> }> | undefined) => string;
  token: string;
}

/** Fails naming the definition the script was expected to provide, so a missing one is loud rather than a silent pass. */
function notDefined(name: string): never {
  throw new Error(`the page script did not define ${name}`);
}

describe("the door's web client page and its API calls over the door's own TLS", () => {
  let ca: CaMaterial;
  let port: number;
  let close: (() => Promise<void>) | undefined;
  // The writes the page drives, recorded so the e2e proves the page's send and answer reach the door's operations.
  const writes: { readonly kind: "inject" | "answer"; readonly detail: string }[] = [];
  // The door's event backbone, hoisted so the stream case can publish on it and read the event back through the page's own parser.
  const doorEvents = createDoorEventHub();
  /** The live quota observation the mounted door's `usage/live` answers, mutable so the quota case can file one through the door's real read. */
  let liveLatest: RcLiveRateLimit | undefined;
  /** Every pathname the mounted door served, so the stream case can await the subscription having landed before publishing what it must deliver. */
  const served: string[] = [];

  // The listener shape the door serves for its operator surfaces: the real server builder with the merged typed API and the page route as its pre-pipeline surfaces, TLS signed by a freshly generated CA, so the page's own GET through the token gate, its fetch calls and the SSE stream all run exactly as they do on a serving door.
  beforeAll(async () => {
    ca = generateCa(new Date());
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS });
    const doorApi = createDoorApiNodeHandler({
      expectedToken: CONTROL_TOKEN,
      list: tracker.list,
      statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
      pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
      inject: async (session, text) => {
        writes.push({ kind: "inject", detail: `${session}:${text}` });
        return await Promise.resolve({ ok: true, sequenceNums: [SEND_SEQUENCE_NUM] });
      },
      answer: async (session, request) => {
        writes.push({ kind: "answer", detail: `${session}:${request}` });
        return await Promise.resolve({ ok: true, sequenceNums: [ANSWER_SEQUENCE_NUM] });
      },
      interrupt: unexercised,
      setModel: unexercised,
      setPermissionMode: unexercised,
      endSession: unexercised,
      getUsage: unexercised,
      getContextUsage: unexercised,
      readFile: unexercised,
      fileSuggestions: unexercised,
      keepAlive: unexercised,
      mcpStatus: unexercised,
      mcpReconnect: unexercised,
      mcpAuthenticate: unexercised,
      mcpOAuthCallbackUrl: unexercised,
      teleport: unexercised,
      fanout: { publish: () => undefined, subscribe: () => () => undefined },
      events: doorEvents,
      liveRateLimits: () => (liveLatest === undefined ? [] : [liveLatest]),
      latestRateLimit: () => liveLatest,
      usageSnapshots: () => [],
      usageSnapshotOf: () => undefined,
      now: () => 0,
      frontDoorStatus: () => ({ state: { supervisorPid: SUPERVISOR_PID, port: STATUS_PORT, lastPort: STATUS_PORT }, supervisorAlive: true, sessions: [], headroomSocket: undefined, logPath: "/home/testuser/.agent-shim/logs/frontdoor.log", logExists: false }),
      checkReport: () => {
        throw new Error("the e2e page drives no check");
      },
      doctorReport: () => {
        throw new Error("the e2e page drives no doctor");
      },
    });
    const page = createRcClientPage(CONTROL_TOKEN);
    // Both pre-pipeline surfaces record the pathnames they serve, so the stream case can await a subscription having landed before publishing what it must deliver.
    const recordUrl = (surface: PrePipelineApi): PrePipelineApi => ({ pathPrefix: surface.pathPrefix, handle: async (request, response) => { served.push(new URL(request.url ?? "/", "https://door.invalid").pathname); return await surface.handle(request, response); } });
    const server = createFrontDoorServer(
      async () => {
        await Promise.resolve();
      },
      () => undefined,
      mintLeaf(ca, LOOPBACK_LEAF_NAMES, new Date()),
      undefined,
      [recordUrl(doorApi), recordUrl(page)],
    );
    const handle = await listenFrontDoor(server, { ca: ca.certPem });
    port = handle.port;
    close = handle.close;
  }, KEYGEN_TIMEOUT_MS);

  afterAll(async () => {
    await close?.();
  });

  /** The fetch the page itself uses in a browser, here against the door's real TLS: same origin, trusting only the door's CA, exactly the trust the browser gets from the operator installing that CA once. The answer is rebuilt through the global constructors the page's script reads, for the same reason the door's own client link rebuilds them: undici's bundled types are distinct declarations of the same standard shapes. */
  const pageFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const answered = await undiciFetch(input, { ...(init ?? {}), dispatcher: new Agent({ connect: { ca: ca.certPem } }) });
    return new Response(answered.body, { status: answered.status, statusText: answered.statusText, headers: [...answered.headers] });
  };

  /** The shipped page script evaluated the way its unit suite evaluates it, with the door's real TLS as its origin and the generation's token presented. */
  const pageScript = (): PageSandbox => {
    const sandbox: PageSandbox & Record<string, unknown> = {
      fetch: pageFetch,
      window: { location: { origin: `https://127.0.0.1:${String(port)}`, search: "" } },
      rpc: () => notDefined("rpc"),
      parseSseFrames: () => notDefined("parseSseFrames"),
      sequenceGap: () => notDefined("sequenceGap"),
      quotaText: () => notDefined("quotaText"),
      token: "",
    };
    vm.runInContext(RC_CLIENT_PAGE_SCRIPT, vm.createContext(sandbox));
    sandbox.token = CONTROL_TOKEN;
    return sandbox;
  };

  it("serves the page through the token gate over TLS, and refuses the browser's unauthenticated navigation", async () => {
    const refused = await pageFetch(`https://127.0.0.1:${String(port)}${RC_CLIENT_PATH}`);
    expect(refused.status).toBe(HTTP_STATUS.unauthorized);

    // The one way a pasted URL authenticates: the token as the query parameter the page's GET accepts.
    const servedPage = await pageFetch(`https://127.0.0.1:${String(port)}${RC_CLIENT_PATH}?token=${encodeURIComponent(CONTROL_TOKEN)}`);
    expect(servedPage.status).toBe(HTTP_STATUS.ok);
    expect(servedPage.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await servedPage.text()).toBe(RC_CLIENT_PAGE_HTML);
  });

  it("drives the page's own rpc() across the door's real TLS: list, status, pending, send, answer", async () => {
    const page = pageScript();

    expect(await page.rpc("rc/list", {})).toEqual({ sessions: [] });
    expect(await page.rpc("rc/status", {})).toEqual({ statuses: [] });
    expect(await page.rpc("rc/pending", {})).toEqual({ pending: [] });

    expect(await page.rpc("rc/send", { session: "cse_page", text: "run the tests" })).toEqual({ session: "cse_page", sequenceNums: [SEND_SEQUENCE_NUM] });
    expect(writes.at(-1)).toEqual({ kind: "inject", detail: "cse_page:run the tests" });

    expect(await page.rpc("rc/answer", { session: "cse_page", request: "req_page", approve: false, text: "not today" })).toEqual({ session: "cse_page", request: "req_page", sequenceNums: [ANSWER_SEQUENCE_NUM] });
    expect(writes.at(-1)).toEqual({ kind: "answer", detail: "cse_page:req_page" });

    // The live quota read answers empty while no rate_limit_event has been filed, and the page's own header text states that plainly.
    expect(await page.rpc("usage/live", {})).toEqual({ sessions: [] });
    expect(page.quotaText(undefined)).toBe("quota: not observed yet");
  });

  it("renders the live quota the door's own read filed, through the page's own summary", async () => {
    const page = pageScript();
    // The reset instants the payload states, as unix epoch seconds, chosen so the ISO instants they name are fixed values the assertion spells out.
    const FIVE_HOUR_RESETS_AT = Date.parse("2025-10-06T16:00:00.000Z") / MS_PER_SECOND;
    const SEVEN_DAY_RESETS_AT = Date.parse("2025-10-13T16:00:00.000Z") / MS_PER_SECOND;
    const OBSERVED_AT = Date.parse("2026-10-06T12:00:00.000Z");
    liveLatest = {
      session: "cse_page",
      observedAt: OBSERVED_AT,
      rateLimit: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        resetsAt: FIVE_HOUR_RESETS_AT,
        utilization: 0.42,
        unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: FIVE_HOUR_RESETS_AT }, seven_day: { utilization: 0.12, resetsAt: SEVEN_DAY_RESETS_AT } },
        overageStatus: "allowed",
      },
    };
    try {
      // The read crosses the door's real TLS, through the same output validation the control plane applies, and the page's header text renders what came back: the quota summary the payload's own words state, then the observation time in the browser's own clock rendering (locale-dependent, so asserted by shape).
      const answered = (await page.rpc("usage/live", {})) as { latest: { observedAt: number; rateLimit: Record<string, unknown> } | undefined; sessions: readonly unknown[] };
      expect(answered.sessions.length).toBe(1);
      expect(answered.latest?.rateLimit.status).toBe("allowed_warning");
      const rendered = page.quotaText(answered.latest);
      const summary = "quota: allowed_warning five_hour 42% resets 2025-10-06T16:00:00.000Z windows five_hour 42% resets 2025-10-06T16:00:00.000Z, seven_day 12% resets 2025-10-13T16:00:00.000Z overage allowed  observed ";
      // The summary is pinned exactly; the observation time after it renders in the browser's own clock, whose locale the test does not fix.
      expect(rendered.startsWith(summary)).toBe(true);
      expect(rendered.length).toBeGreaterThan(summary.length);
    } finally {
      liveLatest = undefined;
    }
  });

  it("streams the door's events to the page's own parser, sequence gaps included", async () => {
    const page = pageScript();
    const stop = new AbortController();

    // The request the page's feed loop issues: POST with the json envelope, the token as a Bearer credential, every source.
    const response = await pageFetch(`https://127.0.0.1:${String(port)}/__agent-shim/orpc/events/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CONTROL_TOKEN}` },
      body: JSON.stringify({ json: {} }),
      signal: stop.signal,
    });
    expect(response.status).toBe(HTTP_STATUS.ok);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    if (response.body === null) {
      throw new Error("expected the subscription to stream a body");
    }
    const stream = response.body;

    const received: { readonly source: string; readonly sequence: number; readonly payload: unknown }[] = [];
    const tracker: Record<string, number> = {};
    const gaps: number[] = [];
    const reading = (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          continue;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = page.parseSseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          const event = (JSON.parse(frame.data) as { json: { source: string; sequence: number; payload: unknown } }).json;
          gaps.push(page.sequenceGap(tracker, event));
          received.push(event);
          if (received.length >= STREAM_EVENT_COUNT) {
            stop.abort();
            return;
          }
        }
      }
    })().catch(() => {
      // Leaving the subscription aborts its request; the reader ending on that abort is the expected shape, not a failure to surface.
    });

    try {
      await until(() => served.includes("/__agent-shim/orpc/events/subscribe"));
      // One Remote Control stream event (an assistant reply the feed renders), one launch lifecycle event, and two more rc events whose envelope sequence_num jumps, exercising the gap arithmetic on real bytes.
      doorEvents.publisher(DOOR_EVENT_SOURCE_RC).publish({ session: "cse_page", envelope: { event_type: "assistant", sequence_num: FIRST_ENVELOPE_SEQUENCE, source: "worker", payload: { content: [{ type: "text", text: "the tests pass" }] } } });
      doorEvents.publisher(LAUNCH_EVENT_SOURCE).publish({ kind: "registered", pid: 20, startedAt: 0, observedAt: 0 });
      doorEvents.publisher(DOOR_EVENT_SOURCE_RC).publish({ session: "cse_page", envelope: { event_type: "user", sequence_num: SECOND_ENVELOPE_SEQUENCE, source: "cse_page", payload: {} } });
      doorEvents.publisher(DOOR_EVENT_SOURCE_RC).publish({ session: "cse_page", envelope: { event_type: "user", sequence_num: THIRD_ENVELOPE_SEQUENCE, source: "cse_page", payload: {} } });
      await until(() => received.length >= STREAM_EVENT_COUNT);
      expect(received.map((event) => [event.source, event.sequence])).toEqual([
        [DOOR_EVENT_SOURCE_RC, 1],
        [LAUNCH_EVENT_SOURCE, 1],
        [DOOR_EVENT_SOURCE_RC, 2],
        [DOOR_EVENT_SOURCE_RC, THIRD_BACKBONE_SEQUENCE],
      ]);
      // The backbone assigns per-source sequences consecutively, so the real stream reports no drops; the visibility the page adds is the arithmetic over these numbers, proven on the high-water the real events left.
      expect(gaps).toEqual([0, 0, 0, 0]);
      expect(page.sequenceGap(tracker, { source: DOOR_EVENT_SOURCE_RC, sequence: GAPPED_SEQUENCE })).toBe(DROPPED_BY_GAP);
    } finally {
      stop.abort();
      await reading;
    }
  });
});

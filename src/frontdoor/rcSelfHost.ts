import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { isLiveCapability } from "./capability";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";
import type { RcStreamEnvelope } from "./rcSchemas";

/**
 * The self-hosted Remote Control service: the door serving, locally, the CCR surface it normally only observes (ExaDev/agent-shim#207). When the mode is on, a Claude Code session activates Remote Control against this surface and is controlled through it with no Anthropic credential anywhere: the door answers the session family itself instead of piping it to the real API host, so the `cse_` sessions, their sequence numbers, their worker and client streams and their event writes all live on this machine.
 *
 * The protocol spoken is exactly the one the door already speaks as a client, which is what makes this honest: every path, envelope, sequence rule and resume pair below is the shape the merged client-half machinery (`rcSessions.ts`, `rcStream.ts`, `connectEffects.ts`) dials the real host with, cross-checked against the CLI source (the 2.1.88 source-map dump behind the issue's spike) and live 2.1.289 envelopes captured through the interception rig. The transport is version-unstable (CCRv1 websocket to CCRv2 SSE plus POST within the 2.1.x line), so this surface pins what the rig's pinned CLI speaks and must be re-verified on upgrades; that standing caveat is issue #207's own.
 *
 * Division of the surface: the session family (`/v1/code/sessions...` and the `/v1/sessions` compatibility list) rides the routed pipeline as a `FrontDoorRoute`, so it flows through the same admission and middleware as any routed request and, above all, through the same observation wrapper that feeds the tracker (the door's own client half learns each session's credential precisely because the create is observed like any other exchange). The non-`/v1/` answers the CLI needs around activation (feature eval, profile, telemetry no-ops) and the OAuth refresh on the control-plane host have no pipeline to ride, so they are served by `local`, which the connect surface consults before routing or piping; that surface also takes over the control-plane host's terminated session as ordinary HTTP (it is normally byte-tapped) because answering `/v1/oauth/token` requires parsing it.
 *
 * The one network lever this uses is the bridge response's `api_base_url`: the protocol lets the server name where the worker dials, so the door names the API host it itself terminates, and the worker's `/worker/...` calls arrive straight back at this surface over the same interception that carried the create.
 *
 * Everything is in memory only and dies with the door process: sessions, events, worker JWTs. No credential this door authenticates against is ever written or logged by this module; the minting command owns the files.
 */

/** The environment variable that turns the self-hosted Remote Control service on, read once at door start like the door's other mode selections: the door is one process serving every launch, so the mode is a property of the door, not of any one launch. Anything but `1` means off, the same exact-value vocabulary the capture toggle uses. */
export const RC_SELF_HOST_ENV = "AGENT_SHIM_FRONTDOOR_RC_SELF_HOST";

/** Whether the environment asked for the self-hosted Remote Control service. */
export function rcSelfHostFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env[RC_SELF_HOST_ENV] === "1";
}

/** The full scope list the minting writes and the local refresh echoes: the CLI's own claude.ai login scope set (`CLAUDE_AI_OAUTH_SCOPES` in its source), whose `user:inference` and `user:profile` members are exactly the two the Remote Control gate demands. */
export const RC_SELF_HOST_SCOPE_LIST: readonly string[] = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];

/** The path prefix of the whole session family this service serves, the same prefix the tracker observes. */
const RC_SESSIONS_PATH_PREFIX = "/v1/code/sessions";

/** The compatibility list the CLI's claude.ai-side session picker reads (`fetchCodeSessionsFromSessionsAPI` in its source, under the `ccr-byoc-2025-07-29` beta), answered locally so the picker needs no claude.ai behind it. */
const RC_COMPAT_SESSIONS_PATH = "/v1/sessions";

/** The id prefix the protocol's own clients validate, so the service mints ids of the same shape. */
const RC_SESSION_ID_PREFIX = "cse_";

/** The API host this service answers as, and the host its minted bridge response names as the worker's base: the door terminates this host on both of its surfaces, so naming it sends the worker's calls straight back here. */
const RC_SELF_HOST_API_BASE_URL = "https://api.anthropic.com";

/** The control-plane host whose OAuth refresh this service answers locally; when the mode is on, its terminated session is parsed as HTTP (it is normally byte-tapped) so the refresh can be served. */
const RC_SELF_HOST_OAUTH_HOST = "platform.claude.com";

/** The status the protocol's epoch conflict answers with, alongside its own `x-ccr-conflict-reason` header; the CLI's worker transport treats a 409 as "superseded, shut down". */
const HTTP_CONFLICT = 409;

/** Milliseconds per second, so every second-denominated conversion reads as the seconds it names. */
const MS_PER_SECOND = 1_000;

/** The status every authenticated call answers while the mode is on but its minting never ran: the surface exists, its credential does not. */
const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * How long a minted worker JWT is good for. Not a fresh number: 46800 seconds is the `expires_in` the real bridge handed the live rig session (13 hours), so the local surface keeps the CLI's refresh cadence exactly where the real one put it.
 */
export const RC_SELF_HOST_WORKER_JWT_TTL_SECONDS = 46_800;

/**
 * The expiry the local OAuth refresh names, in seconds. One hour is the convention the real token endpoint's answers establish; the value only positions the CLI's next scheduled refresh, which lands back here whatever it says, because the minted pair never changes.
 */
const RC_SELF_HOST_OAUTH_TOKEN_TTL_SECONDS = 3_600;

/**
 * How often the SSE streams send a keepalive comment. Not a fresh number: it is the protocol's own keepalive cadence (the 15 s comments the door's client-half parser documents from live captures), and it must beat the worker transport's 45 s liveness bound (`DIY` in the CLI source), which a 15 s cadence does with two comments to spare.
 */
export const RC_SELF_HOST_KEEPALIVE_MS = 15_000;

/**
 * How long a session's events are retained for stream resume, and how long a streamless, trafficless session survives. One number serves both because one protocol constant derives them: the worker transport's reconnection budget is 600000 ms (`WIY` in the CLI source), so a resume can only ever name a cursor whose events are at most that old, and a worker that has been gone longer has given up by its own rules.
 */
export const RC_SELF_HOST_RETENTION_MS = 600_000;

/** The presence answer's refresh hint, in seconds: a modest cadence the door's own presence dialler already tolerates (the rig's fake upstream used the same value), never a promise the surface depends on. */
const RC_PRESENCE_REFRESH_SECONDS = 60;

/**
 * How many events one write body may carry. Not a fresh number: 100 is the protocol's own documented batch cap (the CLI's event uploader is built with `maxBatchSize: 100`), so a body past it is not a batch this protocol has a shape for.
 */
const RC_SELF_HOST_MAX_BATCH_EVENTS = 100;

/** The epoch this single-worker service hands every bridge registration: one worker per session, so there is never a superseding epoch to bump to, and the conflict path stays a refusal for a genuinely stale caller rather than a routine. */
const RC_SELF_HOST_WORKER_EPOCH = 1;

/** The SSE event name both streams dispatch their envelopes under: the name the door's own client-half parser accepts and the CLI's worker transport demands. */
const RC_STREAM_EVENT_NAME = "client_event";

/** The envelope source for events the worker wrote (the CLI's half), the value the tracker's trust rule reads. */
const RC_SOURCE_WORKER = "worker";

/** The envelope source for events a client wrote: the value observed on the live rig's stream for the door's own injected user event. */
const RC_SOURCE_CLIENT = "client";

/** The response header the protocol uses to tell a worker it is no longer the live one; sent with the epoch refusal so a superseded worker shuts down by its own rules instead of retrying. */
const CONFLICT_REASON_HEADER = "x-ccr-conflict-reason";

/** The conflict reason for a write whose worker_epoch is not the session's: the protocol's own vocabulary for exactly this. */
const CONFLICT_REASON_EPOCH_STALE = "epoch_stale";

/** The guard every payload narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A record's string field when it is a non-empty string, else undefined. */
function nonEmptyString(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record === undefined ? undefined : record[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A record's finite number field, accepting a numeric string too, because the real service has been observed serialising the protocol's numbers both ways (the write answer's `sequence_num` above all). */
function numberOf(record: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = record === undefined ? undefined : record[field];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** One header's single value, or undefined when absent or an unusable repeat. */
function singleHeader(headers: Readonly<IncomingHttpHeaders>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/** The Authorization bearer a request presented, whatever capitalisation its scheme word carried. */
function bearerOf(headers: Readonly<IncomingHttpHeaders>): string | undefined {
  const presented = singleHeader(headers, "authorization");
  if (presented === undefined) {
    return undefined;
  }
  return presented.slice(0, "bearer ".length).toLowerCase() === "bearer " ? presented.slice("bearer ".length) : undefined;
}

/** The whole credential this door's self-hosted mode mints, read back for every authenticated call and never logged: the token pair the identity's Claude Code presents, beside the organisation the minting chose. */
export interface RcSelfHostCredentialRecord {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly organizationUuid: string;
  readonly accountUuid: string;
}

/** One stored event: the envelope the streams replay, minus the SSE framing derived at delivery. */
interface StoredEvent {
  readonly sequenceNum: number;
  readonly eventId: string;
  readonly source: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  /** Whether the worker's stream receives it: client-originated events only, since feeding a worker its own writes back would loop its REPL. */
  readonly toWorker: boolean;
  readonly storedAt: number;
}

/** One internal event the worker filed through its own channel, replayed only through that channel's paginated read. */
interface StoredInternalEvent {
  readonly cursor: string;
  readonly body: Record<string, unknown>;
}

/** One open SSE stream this service is holding, whichever half it serves. */
interface StreamSink {
  /** Writes one already-framed SSE block, serialised behind whatever the sink is still sending. */
  readonly write: (frame: string) => void;
  /** Retires the sink from its session's set; the response's own end is what closes the stream. */
  readonly retire: () => void;
}

/** One self-hosted session's whole state, in memory only. */
interface SelfHostSession {
  readonly id: string;
  readonly createdAt: number;
  title: string | undefined;
  /** Every worker JWT this service minted for the session: all stay valid, because the reconnect flow's fresh `/bridge` must not invalidate the JWT a still-live transport holds. */
  readonly workerJwts: Set<string>;
  sequenceNum: number;
  readonly events: StoredEvent[];
  /** The payload uuids already written, for the write answer's duplicate flag: pruned with the events, so it names the same window. */
  readonly seenPayloadUuids: Set<string>;
  readonly workerStreams: Set<StreamSink>;
  readonly clientStreams: Set<StreamSink>;
  readonly internalEvents: StoredInternalEvent[];
  workerStatus: string | undefined;
  externalMetadata: Record<string, unknown> | undefined;
  lastTrafficAt: number;
}

/** Everything the service needs, injected so the decision logic runs against fakes in unit tests. */
export interface RcSelfHostDeps {
  readonly now: () => number;
  /** Mints the session and event ids: a v4 UUID or better in production. */
  readonly newUuid: () => string;
  /** Mints opaque token material (the worker JWTs): cryptographically random in production. */
  readonly randomToken: () => string;
  /** The minted credential this door authenticates against, read fresh so a re-mint takes effect without restarting the door; undefined while none was ever minted, in which case every authenticated call is refused. */
  readonly credentialRecord: () => RcSelfHostCredentialRecord | undefined;
  readonly log?: (line: string) => void;
}

/** Reads one request's whole body as text, refusing a body past the protocol's own batch cap by rejecting: the caller answers 413. */
async function readBody(request: IncomingMessage, capBytes: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > capBytes) {
        request.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", () => {
      reject(new Error("the request body ended early"));
    });
  });
}

/** Parses JSON, yielding undefined for anything that is not one JSON object. */
function parseJsonObject(body: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** A JWT-shaped but locally minted worker credential: three base64url segments with an expiry inside the payload, because the CLI's 401 path decodes `exp` from its session token and a well-formed value keeps that decode on its happy path. The signature segment is random: nothing in the client ever verifies it ("JWT is opaque - do not decode", the trust rule the issue's spike verified). */
function mintWorkerJwt(randomToken: () => string, issuedAt: number): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ exp: Math.floor((issuedAt + RC_SELF_HOST_WORKER_JWT_TTL_SECONDS * MS_PER_SECOND) / MS_PER_SECOND), iat: Math.floor(issuedAt / MS_PER_SECOND) });
  return `${header}.${payload}.${Buffer.from(randomToken(), "utf8").toString("base64url")}`;
}

/** The feature payload the local eval answers: exactly the gates the Remote Control activation path reads (the GrowthBook check in `getBridgeDisabledReason`, and the env-less v2 bridge selector), each at the value that enables the feature, and nothing else, so every unrelated flag keeps evaluating to its default as though the eval had never run. */
function growthBookFeatures(): Record<string, unknown> {
  return {
    tengu_ccr_bridge: { defaultValue: true },
    tengu_bridge_repl_v2: { defaultValue: true },
    tengu_bridge_repl_v2_cse_shim_enabled: { defaultValue: true },
    tengu_bridge_min_version: { defaultValue: { minVersion: "0.0.0" } },
  };
}

/** The self-hosted Remote Control service: the session-family route for the pipeline, and the local answers the connect surface consults before routing or piping. */
export interface RcSelfHostSurface {
  /** The pipeline route serving the whole `/v1/code/sessions` family and the `/v1/sessions` compatibility list. */
  readonly route: FrontDoorRoute;
  /** The connect surface's local answers: which hosts it takes over as HTTP, and the requests it answers itself. */
  readonly local: {
    /** The hosts whose terminated sessions this surface needs parsed as HTTP (the control-plane host, normally byte-tapped). */
    readonly parsesHost: (host: string) => boolean;
    /** Serves one request locally; resolves false when the surface does not own the path, so routing or piping continues unchanged. */
    readonly serve: (host: string, request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  };
  /** Stops the service's timers and retires every open stream. The sessions themselves are unreachable the moment the door drops them. */
  readonly close: () => void;
}

/** Creates the self-hosted Remote Control service. One per door process; everything it holds dies with it. */
export function createRcSelfHostSurface(deps: RcSelfHostDeps): RcSelfHostSurface {
  const sessions = new Map<string, SelfHostSession>();

  /** Sweeps what retention owns: events past the resume window, and sessions no stream holds and no traffic has touched for the same window. */
  const sweep = (): void => {
    const now = deps.now();
    for (const session of sessions.values()) {
      while (session.events[0] !== undefined && now - session.events[0].storedAt > RC_SELF_HOST_RETENTION_MS) {
        const dropped = session.events.shift();
        const uuid = dropped === undefined ? undefined : nonEmptyString(dropped.payload, "uuid");
        if (uuid !== undefined) {
          session.seenPayloadUuids.delete(uuid);
        }
      }
      if (session.workerStreams.size === 0 && session.clientStreams.size === 0 && now - session.lastTrafficAt > RC_SELF_HOST_RETENTION_MS) {
        sessions.delete(session.id);
      }
    }
  };
  // The sweep only bounds memory between writes: every write sweeps first, so what the streams serve is always exact however long the timer waits.
  const timer = setInterval(sweep, RC_SELF_HOST_RETENTION_MS);
  timer.unref();
  const keepalive = setInterval(() => {
    for (const session of sessions.values()) {
      for (const sink of [...session.workerStreams, ...session.clientStreams]) {
        sink.write(": keep-alive\n\n");
      }
    }
  }, RC_SELF_HOST_KEEPALIVE_MS);
  keepalive.unref();

  /** Whether a request's Authorization presents the minted credential, checked in constant time like every capability the door accepts. */
  const presentsCredential = (headers: Readonly<IncomingHttpHeaders>): boolean => {
    const expected = deps.credentialRecord()?.accessToken;
    const presented = bearerOf(headers);
    return expected !== undefined && presented !== undefined && isLiveCapability(presented, [expected]);
  };

  /** Whether a request's Authorization presents one of the session's minted worker JWTs, in constant time. */
  const presentsWorkerJwt = (headers: Readonly<IncomingHttpHeaders>, session: SelfHostSession): boolean => {
    const presented = bearerOf(headers);
    if (presented === undefined) {
      return false;
    }
    for (const minted of session.workerJwts) {
      if (isLiveCapability(presented, [minted])) {
        return true;
      }
    }
    return false;
  };

  /** Frames one stored event exactly as both streams deliver it. */
  const frameOf = (event: StoredEvent): string => {
    const envelope: RcStreamEnvelope = {
      event_id: event.eventId,
      event_type: nonEmptyString(event.payload, "type") ?? "event",
      sequence_num: event.sequenceNum,
      source: event.source,
      payload: event.payload,
      created_at: event.createdAt,
    };
    return `event: ${RC_STREAM_EVENT_NAME}\nid: ${String(event.sequenceNum)}\ndata: ${JSON.stringify(envelope)}\n\n`;
  };

  /**
   * Holds one SSE stream open over a routed response. Registration and the resume replay are one synchronous step (the snapshot is taken, the sink registered, and only then is the snapshot written through it), so no published event can be lost or doubled across the gap: everything after the snapshot is delivered live because the sink is already registered, and everything in the snapshot predates it.
   */
  const holdStream = async (session: SelfHostSession, which: "workerStreams" | "clientStreams", wantsReplay: (event: StoredEvent) => boolean, request: RoutedRequest, response: RoutedResponse): Promise<void> => {
    const url = new URL(request.url, "http://127.0.0.1");
    // The protocol's documented resume pair: the query parameter and the header arrive together, so either supplies the cursor; a first connection sends neither and reads from the stream's own head.
    const cursor = numberOf({ value: url.searchParams.get("from_sequence_num") }, "value") ?? numberOf({ value: singleHeader(request.headers, "last-event-id") }, "value");
    const replay = cursor === undefined ? [] : session.events.filter((event) => wantsReplay(event) && event.sequenceNum > cursor);
    response.start(HTTP_STATUS.ok, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // The head goes out before any event exists: a stream that has said nothing yet is still an open stream, and a client that has not seen the head would otherwise wait on it while the surface waits on events (the deadlock the first e2e run surfaced).
    response.flush();
    let pending: Promise<void> = Promise.resolve();
    const sink: StreamSink = {
      write: (frame) => {
        pending = pending.then(async () => {
          await response.write(frame);
        }).catch(() => {
          // A write to a response whose client went away resolves early by that response's own contract, so this only guards a raced destroy; the retirement below is what stops further writes either way.
        });
      },
      retire: () => {
        session[which].delete(sink);
      },
    };
    session[which].add(sink);
    session.lastTrafficAt = deps.now();
    for (const event of replay) {
      sink.write(frameOf(event));
    }
    // The stream is the response: this handler resolves only when the client goes away, which is what keeps the route's serve promise from settling early and the pipeline from tearing the stream down.
    await new Promise<void>((resolve) => {
      request.signal.addEventListener("abort", () => {
        resolve(undefined);
      }, { once: true });
    });
    sink.retire();
    response.end();
  };

  /** Files one event and delivers it to exactly the streams whose half it belongs on: assigns the next sequence number, records it, and returns the write answer's facts. */
  const publish = (session: SelfHostSession, source: string, payload: Record<string, unknown>): { readonly sequenceNum: number; readonly eventId: string; readonly duplicate: boolean } => {
    const uuid = nonEmptyString(payload, "uuid");
    const duplicate = uuid !== undefined && session.seenPayloadUuids.has(uuid);
    session.sequenceNum += 1;
    const event: StoredEvent = {
      sequenceNum: session.sequenceNum,
      eventId: uuid ?? deps.newUuid(),
      source,
      // The one enrichment the real service was observed making on the live rig's stream: the wall-clock instant it took the write. The worker's handler ignores it; the door's own parser forwards it verbatim.
      payload: source === RC_SOURCE_CLIENT ? { ...payload, server_received_wall_ms: deps.now() } : payload,
      createdAt: new Date(deps.now()).toISOString(),
      toWorker: source === RC_SOURCE_CLIENT,
      storedAt: deps.now(),
    };
    session.events.push(event);
    if (uuid !== undefined) {
      session.seenPayloadUuids.add(uuid);
    }
    session.lastTrafficAt = event.storedAt;
    const frame = frameOf(event);
    if (event.toWorker) {
      for (const sink of [...session.workerStreams]) {
        sink.write(frame);
      }
    }
    for (const sink of [...session.clientStreams]) {
      sink.write(frame);
    }
    return { sequenceNum: event.sequenceNum, eventId: event.eventId, duplicate };
  };

  /** Answers one JSON object through a routed response and ends it, content-length framed the way the real host frames its JSON answers. */
  const answerJson = async (response: RoutedResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): Promise<void> => {
    const text = JSON.stringify(body);
    response.start(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text, "utf8")), ...extraHeaders });
    await response.write(text);
    response.end();
  };

  /** The refusal every authenticated call answers when the mode is on but its minting never ran. */
  const noCredential = async (response: RoutedResponse): Promise<void> => {
    await answerJson(response, HTTP_SERVICE_UNAVAILABLE, { type: "error", error: { type: "api_error", message: "the front door's self-hosted Remote Control surface is on but no credential has been minted for it; run agent-shim frontdoor rc selfhost mint first" } });
  };

  /** The protocol's own conflict answer for a stale epoch: a 409 whose header names the reason the worker transport acts on. */
  const epochStale = async (response: RoutedResponse): Promise<void> => {
    await answerJson(response, HTTP_CONFLICT, { type: "error", error: { type: "api_error", message: "worker_epoch does not match the session's live epoch" } }, { [CONFLICT_REASON_HEADER]: CONFLICT_REASON_EPOCH_STALE });
  };

  /** The refusal for a credential this surface did not mint, shaped as the real host answers an unknown bearer. */
  const unauthorized = async (response: RoutedResponse): Promise<void> => {
    await answerJson(response, HTTP_STATUS.unauthorized, { type: "error", error: { type: "authentication_error", message: "the self-hosted Remote Control surface did not recognise the presented credential" } });
  };

  /** Serves one path of the session family, already split into its session and tail; the session is absent only for a path naming one this door never created. */
  const serveSessionPath = async (session: SelfHostSession | undefined, tail: string, request: RoutedRequest, response: RoutedResponse): Promise<void> => {
    const method = request.method.toUpperCase();
    if (session === undefined) {
      await answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: "no such Remote Control session on this door" } });
      return;
    }
    session.lastTrafficAt = deps.now();

    if (tail === "") {
      if (method !== "GET") {
        await answerJson(response, HTTP_STATUS.methodNotAllowed, { type: "error", error: { type: "api_error", message: "the session read is a GET" } });
        return;
      }
      await answerJson(response, HTTP_STATUS.ok, { session: { id: session.id, title: session.title, created_at: new Date(session.createdAt).toISOString(), status: "active" } });
      return;
    }

    if (tail === "bridge" && method === "POST") {
      if (!presentsCredential(request.headers)) {
        await unauthorized(response);
        return;
      }
      const workerJwt = mintWorkerJwt(deps.randomToken, deps.now());
      session.workerJwts.add(workerJwt);
      deps.log?.(`rc selfhost ${session.id}: bridge registration minted a worker credential`);
      await answerJson(response, HTTP_STATUS.ok, { worker_jwt: workerJwt, expires_in: RC_SELF_HOST_WORKER_JWT_TTL_SECONDS, api_base_url: RC_SELF_HOST_API_BASE_URL, worker_epoch: RC_SELF_HOST_WORKER_EPOCH });
      return;
    }

    if (tail === "archive" && method === "POST") {
      if (!presentsCredential(request.headers)) {
        await unauthorized(response);
        return;
      }
      for (const sink of [...session.workerStreams, ...session.clientStreams]) {
        sink.retire();
      }
      sessions.delete(session.id);
      deps.log?.(`rc selfhost ${session.id}: archived at its client's request`);
      await answerJson(response, HTTP_STATUS.ok, {});
      return;
    }

    if (tail === "worker" || tail.startsWith("worker/")) {
      if (!presentsWorkerJwt(request.headers, session)) {
        await unauthorized(response);
        return;
      }
      const workerTail = tail === "worker" ? "" : tail.slice("worker/".length);

      if (workerTail === "" && method === "GET") {
        await answerJson(response, HTTP_STATUS.ok, { worker: { external_metadata: session.externalMetadata ?? null } });
        return;
      }
      if (workerTail === "" && method === "PUT") {
        const body = parseJsonObject(await readBody(request.body, CONTROL_BODY_CAP_BYTES));
        const claimedEpoch = numberOf(body, "worker_epoch");
        if (claimedEpoch !== undefined && claimedEpoch !== RC_SELF_HOST_WORKER_EPOCH) {
          await epochStale(response);
          return;
        }
        const status = nonEmptyString(body, "worker_status");
        if (status !== undefined) {
          session.workerStatus = status;
        }
        if (isRecord(body?.external_metadata)) {
          session.externalMetadata = body.external_metadata;
        }
        await answerJson(response, HTTP_STATUS.ok, {});
        return;
      }
      if (workerTail === "register" && method === "POST") {
        await readBody(request.body, CONTROL_BODY_CAP_BYTES);
        await answerJson(response, HTTP_STATUS.ok, { worker_epoch: RC_SELF_HOST_WORKER_EPOCH });
        return;
      }
      if (workerTail === "heartbeat" && method === "POST") {
        await readBody(request.body, CONTROL_BODY_CAP_BYTES);
        await answerJson(response, HTTP_STATUS.ok, {});
        return;
      }
      if (workerTail === "events" && method === "POST") {
        const body = parseJsonObject(await readBody(request.body, CONTROL_BODY_CAP_BYTES));
        const claimedEpoch = numberOf(body, "worker_epoch");
        if (claimedEpoch !== undefined && claimedEpoch !== RC_SELF_HOST_WORKER_EPOCH) {
          await epochStale(response);
          return;
        }
        const events = body?.events;
        if (!Array.isArray(events) || events.length === 0 || events.length > RC_SELF_HOST_MAX_BATCH_EVENTS) {
          await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: `a worker event batch is a non-empty array of at most ${String(RC_SELF_HOST_MAX_BATCH_EVENTS)} events` } });
          return;
        }
        const results: Record<string, unknown>[] = [];
        for (const event of events) {
          if (!isRecord(event) || !isRecord(event.payload)) {
            await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "every event in a batch is an object carrying one payload object" } });
            return;
          }
          const published = publish(session, RC_SOURCE_WORKER, event.payload);
          results.push({ event_id: published.eventId, sequence_num: String(published.sequenceNum) });
        }
        sweep();
        await answerJson(response, HTTP_STATUS.ok, { results });
        return;
      }
      if (workerTail === "events/stream" && method === "GET") {
        await holdStream(session, "workerStreams", (event) => event.toWorker, request, response);
        return;
      }
      if (workerTail === "events/delivery" && method === "POST") {
        await readBody(request.body, CONTROL_BODY_CAP_BYTES);
        await answerJson(response, HTTP_STATUS.ok, {});
        return;
      }
      if (workerTail === "internal-events" && method === "POST") {
        const body = parseJsonObject(await readBody(request.body, CONTROL_BODY_CAP_BYTES));
        const claimedEpoch = numberOf(body, "worker_epoch");
        if (claimedEpoch !== undefined && claimedEpoch !== RC_SELF_HOST_WORKER_EPOCH) {
          await epochStale(response);
          return;
        }
        const events = body?.events;
        if (!Array.isArray(events)) {
          await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "an internal event batch is an array" } });
          return;
        }
        for (const event of events) {
          if (isRecord(event)) {
            session.internalEvents.push({ cursor: deps.newUuid(), body: event });
          }
        }
        await answerJson(response, HTTP_STATUS.ok, {});
        return;
      }
      if (workerTail === "internal-events" && method === "GET") {
        // The channel's own paginated read: every stored internal event after the caller's cursor, with the protocol's `next_cursor` shape naming where a further page starts; an empty page names none, because the local channel is complete the moment it is written.
        const url = new URL(request.url, "http://127.0.0.1");
        const cursor = url.searchParams.get("cursor");
        const from = cursor === null ? 0 : session.internalEvents.findIndex((event) => event.cursor === cursor) + 1;
        const page = session.internalEvents.slice(from);
        await answerJson(response, HTTP_STATUS.ok, { data: page.map((event) => event.body), next_cursor: page.length === 0 ? undefined : page[page.length - 1]?.cursor });
        return;
      }
      if (workerTail === "diagnostics" && method === "POST") {
        await readBody(request.body, CONTROL_BODY_CAP_BYTES);
        await answerJson(response, HTTP_STATUS.ok, {});
        return;
      }
      await answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `the self-hosted Remote Control surface serves no worker path "${workerTail}"` } });
      return;
    }

    // Everything else on the session is the client half, authenticated by the minted credential.
    if (!presentsCredential(request.headers)) {
      await unauthorized(response);
      return;
    }

    if (tail === "events" && method === "POST") {
      const body = parseJsonObject(await readBody(request.body, CONTROL_BODY_CAP_BYTES));
      const events = body?.events;
      if (!Array.isArray(events) || events.length === 0 || events.length > RC_SELF_HOST_MAX_BATCH_EVENTS) {
        await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: `a client event write is a non-empty array of at most ${String(RC_SELF_HOST_MAX_BATCH_EVENTS)} events` } });
        return;
      }
      const results: Record<string, unknown>[] = [];
      for (const event of events) {
        if (!isRecord(event) || !isRecord(event.payload)) {
          await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "every event in a write is an object carrying one payload object" } });
          return;
        }
        const published = publish(session, RC_SOURCE_CLIENT, event.payload);
        // The write answer the door's own client half parses: per-event sequence numbers as strings (the form the real endpoint was observed returning) beside the duplicate flag the live proof saw.
        results.push({ sequence_num: String(published.sequenceNum), duplicate: published.duplicate });
      }
      sweep();
      await answerJson(response, HTTP_STATUS.ok, { results });
      return;
    }
    if (tail === "events" && method === "GET") {
      await answerJson(response, HTTP_STATUS.ok, { data: session.events.map((event) => ({ event_id: event.eventId, event_type: nonEmptyString(event.payload, "type") ?? "event", sequence_num: event.sequenceNum, source: event.source, payload: event.payload, created_at: event.createdAt })) });
      return;
    }
    if (tail === "events/stream" && method === "GET") {
      await holdStream(session, "clientStreams", () => true, request, response);
      return;
    }
    if (tail === "client/presence" && method === "POST") {
      await readBody(request.body, CONTROL_BODY_CAP_BYTES);
      await answerJson(response, HTTP_STATUS.ok, { refresh_after_seconds: RC_PRESENCE_REFRESH_SECONDS });
      return;
    }
    if (tail === "mark_read" && method === "POST") {
      await readBody(request.body, CONTROL_BODY_CAP_BYTES);
      await answerJson(response, HTTP_STATUS.ok, {});
      return;
    }
    if (tail === "teleport-events" && method === "POST") {
      await readBody(request.body, CONTROL_BODY_CAP_BYTES);
      await answerJson(response, HTTP_STATUS.ok, {});
      return;
    }
    await answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `the self-hosted Remote Control surface serves no path "${tail}"` } });
  };

  /** Whether the minted credential is missing, which every path under the session family refuses on before anything else. */
  const recordMissing = (): boolean => deps.credentialRecord() === undefined;

  const route: FrontDoorRoute = {
    name: "rc-selfhost",
    headroomEligible: false,
    headroomUpstream: undefined,
    serve: async (request, response) => {
      const method = request.method.toUpperCase();
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (recordMissing()) {
        await noCredential(response);
        return;
      }
      if (pathname === RC_COMPAT_SESSIONS_PATH) {
        if (method !== "GET") {
          await answerJson(response, HTTP_STATUS.methodNotAllowed, { type: "error", error: { type: "api_error", message: "the compatibility session list is a GET" } });
          return;
        }
        if (!presentsCredential(request.headers)) {
          await unauthorized(response);
          return;
        }
        await answerJson(response, HTTP_STATUS.ok, { data: [] });
        return;
      }
      if (pathname !== RC_SESSIONS_PATH_PREFIX && !pathname.startsWith(`${RC_SESSIONS_PATH_PREFIX}/`)) {
        await answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `the self-hosted Remote Control surface serves no path "${pathname}"` } });
        return;
      }
      if (pathname === RC_SESSIONS_PATH_PREFIX) {
        if (method === "POST") {
          if (!presentsCredential(request.headers)) {
            await unauthorized(response);
            return;
          }
          const body = parseJsonObject(await readBody(request.body, CONTROL_BODY_CAP_BYTES));
          const session: SelfHostSession = {
            id: `${RC_SESSION_ID_PREFIX}${deps.newUuid()}`,
            createdAt: deps.now(),
            title: nonEmptyString(body, "title"),
            workerJwts: new Set<string>(),
            sequenceNum: 0,
            events: [],
            seenPayloadUuids: new Set<string>(),
            workerStreams: new Set<StreamSink>(),
            clientStreams: new Set<StreamSink>(),
            internalEvents: [],
            workerStatus: undefined,
            externalMetadata: undefined,
            lastTrafficAt: deps.now(),
          };
          sessions.set(session.id, session);
          deps.log?.(`rc selfhost ${session.id}: session created on the door's own surface`);
          await answerJson(response, HTTP_STATUS.ok, { session: { id: session.id, title: session.title, created_at: new Date(session.createdAt).toISOString(), status: "active" } });
          return;
        }
        if (method === "GET") {
          if (!presentsCredential(request.headers)) {
            await unauthorized(response);
            return;
          }
          await answerJson(response, HTTP_STATUS.ok, { data: [...sessions.values()].map((session) => ({ id: session.id, title: session.title, created_at: new Date(session.createdAt).toISOString(), updated_at: new Date(session.lastTrafficAt).toISOString(), session_status: "active" })) });
          return;
        }
        await answerJson(response, HTTP_STATUS.methodNotAllowed, { type: "error", error: { type: "api_error", message: "the session collection is a POST (create) and a GET (list)" } });
        return;
      }
      const rest = pathname.slice(`${RC_SESSIONS_PATH_PREFIX}/`.length);
      const slash = rest.indexOf("/");
      const id = slash === -1 ? rest : rest.slice(0, slash);
      const tail = slash === -1 ? "" : rest.slice(slash + 1);
      if (!id.startsWith(RC_SESSION_ID_PREFIX)) {
        await answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: "the session family names one cse_-prefixed session id" } });
        return;
      }
      await serveSessionPath(sessions.get(id), tail, request, response);
    },
  };

  /** Answers one JSON body on the connect surface's plain response shape; the local answers ride no pipeline. */
  const answerServerJson = (response: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text, "utf8")) });
    response.end(text);
  };

  const local = {
    parsesHost: (host: string): boolean => host === RC_SELF_HOST_OAUTH_HOST,
    serve: async (host: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
      const method = (request.method ?? "").toUpperCase();
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (host === RC_SELF_HOST_OAUTH_HOST) {
        if (method === "POST" && pathname === "/v1/oauth/token") {
          const body = parseJsonObject(await readBody(request, CONTROL_BODY_CAP_BYTES));
          const record = deps.credentialRecord();
          if (record === undefined) {
            answerServerJson(response, HTTP_SERVICE_UNAVAILABLE, { error: "the front door's self-hosted Remote Control surface is on but no credential has been minted for it" });
            return true;
          }
          if (body?.grant_type !== undefined && body.grant_type !== "refresh_token") {
            answerServerJson(response, HTTP_STATUS.badRequest, { error: "unsupported_grant_type" });
            return true;
          }
          // The refresh this surface always answers: the minted pair itself, unchanged. The minting sets no expiry, so nothing schedules a refresh; a forced one (a 401 from elsewhere) lands here, is answered with the same pair, and the session carries on exactly as it stood.
          answerServerJson(response, HTTP_STATUS.ok, { access_token: record.accessToken, refresh_token: record.refreshToken, expires_in: RC_SELF_HOST_OAUTH_TOKEN_TTL_SECONDS, scope: RC_SELF_HOST_SCOPE_LIST.join(" ") });
          return true;
        }
        if (method === "GET" && pathname === "/v1/oauth/hello") {
          answerServerJson(response, HTTP_STATUS.ok, {});
          return true;
        }
        return false;
      }
      // The API host's activation neighbours: exactly the calls the gate and the session's own bookkeeping make around Remote Control, answered so a self-hosted session needs no claude.ai behind it.
      if (method === "POST" && pathname.startsWith("/api/eval/")) {
        await readBody(request, CONTROL_BODY_CAP_BYTES);
        answerServerJson(response, HTTP_STATUS.ok, { features: growthBookFeatures(), dateUpdated: Math.floor(deps.now() / MS_PER_SECOND) });
        return true;
      }
      if (method === "GET" && pathname === "/api/oauth/profile") {
        const record = deps.credentialRecord();
        if (record === undefined) {
          answerServerJson(response, HTTP_SERVICE_UNAVAILABLE, { error: "the front door's self-hosted Remote Control surface is on but no credential has been minted for it" });
          return true;
        }
        answerServerJson(response, HTTP_STATUS.ok, {
          account: { uuid: record.accountUuid, display_name: "agent-shim self-hosted", created_at: new Date(0).toISOString() },
          organization: { uuid: record.organizationUuid, organization_type: "claude_max" },
        });
        return true;
      }
      if (method === "GET" && pathname === "/api/claude_code/policy_limits") {
        answerServerJson(response, HTTP_STATUS.ok, {});
        return true;
      }
      if (method === "POST" && (pathname === "/api/event_logging/v2/batch" || pathname === "/api/claude_code/metrics" || pathname === "/api/claude_cli_feedback")) {
        await readBody(request, CONTROL_BODY_CAP_BYTES);
        answerServerJson(response, HTTP_STATUS.ok, {});
        return true;
      }
      if (method === "GET" && pathname === "/api/hello") {
        answerServerJson(response, HTTP_STATUS.ok, {});
        return true;
      }
      return false;
    },
  };

  return {
    route,
    local,
    close: () => {
      clearInterval(timer);
      clearInterval(keepalive);
      for (const session of sessions.values()) {
        for (const sink of [...session.workerStreams, ...session.clientStreams]) {
          sink.retire();
        }
      }
      sessions.clear();
    },
  };
}

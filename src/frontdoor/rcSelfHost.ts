import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { isLiveCapability } from "./capability";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import { RC_SOURCE_CLIENT, RC_SOURCE_WORKER, pageOfRcChannel, serveRcClientChannels, serveRcCompatSessions } from "./rcSelfHostEndpoints";
import { RC_CONVERSATIONS_PATH_PREFIX, newRcSelfHostConversation, serveRcConversations } from "./rcSelfHostConversations";
import { createRcSelfHostLocal, type RcSelfHostLocal } from "./rcSelfHostLocal";
import { RC_WEB_FETCH_MAX_BYTES, type RcWebFetcher } from "./rcWebFetch";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";
import type { RcStreamEnvelope } from "./rcSchemas";

/**
 * The self-hosted Remote Control service: the door serving, locally, the CCR surface it normally only observes (ExaDev/agent-shim#207). When the mode is on, a Claude Code session activates Remote Control against this surface and is controlled through it with no Anthropic credential anywhere: the door answers the session family itself instead of piping it to the real API host, so the `cse_` sessions, their sequence numbers, their worker and client streams and their event writes all live on this machine.
 *
 * The protocol spoken is exactly the one the door already speaks as a client, which is what makes this honest: every path, envelope, sequence rule and resume pair below is the shape the merged client-half machinery (`rcSessions.ts`, `rcStream.ts`, `connectEffects.ts`) dials the real host with, cross-checked against the CLI source (the 2.1.88 source-map dump behind the issue's spike) and live 2.1.289 envelopes captured through the interception rig. The transport is version-unstable (CCRv1 websocket to CCRv2 SSE plus POST within the 2.1.x line), so this surface pins what the rig's pinned CLI speaks and must be re-verified on upgrades; that standing caveat is issue #207's own.
 *
 * Division of the surface: the session family (`/v1/code/sessions...` and the `/v1/sessions` compatibility list) rides the routed pipeline as a `FrontDoorRoute`, so it flows through the same admission and middleware as any routed request and, above all, through the same observation wrapper that feeds the tracker (the door's own client half learns each session's credential precisely because the create is observed like any other exchange). The non-`/v1/` answers the CLI needs around activation (feature eval, profile, telemetry no-ops) and the OAuth refresh on the control-plane host have no pipeline to ride, so they are served by `local`, which the connect surface consults before routing or piping; that surface also takes over the control-plane host's terminated session as ordinary HTTP (it is normally byte-tapped) because answering `/v1/oauth/token` requires parsing it.
 *
 * Above the sessions sits the conversation, the native service's own keying as observed through two bridged TUIs holding two distinct `cse_` ids over one live conversation (#238's finding): the event log and its sequence space belong to the conversation, and the `cse_` sessions are attachments to it. A create that names no conversation mints a fresh one, so the single-session shape every door-observed CLI runs keeps exactly its previous behaviour under a wrapper; a create that names one attaches to it, and every write through either attachment numbers in the one shared space and fans to every stream the conversation holds, each worker's own writes excepted (feeding a worker its own writes back would loop its REPL, while the other attachment's worker writes are the other client's half of the conversation, exactly what a second TUI joins to see). No observed wire shape names the link: the create body, the bridge answer and every envelope the captures and the 2.1.289 bundle show carry no conversation id, so the linking vocabulary here (the create body's `conversation` field, the `conv_` id prefix, the session rows' `conversation_id`, and the `/v1/code/conversations` family a sessionless client reads, writes and subscribes through) is this door's own design, named as such; should the real service's shape ever surface, these are the pieces to realign.
 *
 * The worker family includes the two web proxies the CLI dials only when its environment opts in (`CLAUDE_CODE_WEBFETCH_USE_CCR_PROXY` and `CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY`, both unset by default and both verified absent from the rig session, so the default session fetches directly and never dials them): `/{cse}/worker/web-fetch` carries the CLI's URL fetch (a POST of `{url}` answered with the fetched facts or a target refusal, both shapes the 2.1.289 client's own schema reads), and `/{cse}/worker/web-search` carries its search. The wire facts the live rig settled beside the source: the session id the proxy URL names comes from a `CLAUDE_CODE_SESSION_ID` latch that only the cloud worker shape provisions (a locally launched bridge never sets it), and the credential the client presents is the session ingress token read from `CLAUDE_SESSION_INGRESS_TOKEN_FILE` or the well-known remote directory, which locally is nothing at all, so a bare local launch sends no Authorization and is refused; when the ingress token is one of this surface's own worker JWTs it authenticates exactly as the worker family's other paths do. The paths also accept the minted credential itself, the shape the client's login-bearer fallback presents, whose principal is the same credential that created the session. The fetch's bounds live in `rcWebFetch.ts`; the search is served as a clear refusal naming that no backend ships, with the injection point a real backend answers through.
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

/** The path prefix of the whole session family this service serves, the same prefix the tracker observes. */
const RC_SESSIONS_PATH_PREFIX = "/v1/code/sessions";

/** The compatibility session family the CLI's claude.ai-side session manager speaks (`fetchCodeSessionsFromSessionsAPI` and the Get/Update/Archive/Unarchive dispatch in its source, under the `ccr-byoc-2025-07-29` beta), served against the door's own sessions so the manager needs no claude.ai behind it. */
const RC_COMPAT_SESSIONS_PATH = "/v1/sessions";

/** The id prefix the protocol's own clients validate, so the service mints ids of the same shape. */
const RC_SESSION_ID_PREFIX = "cse_";

/** The API host this service answers as, and the host its minted bridge response names as the worker's base: the door terminates this host on both of its surfaces, so naming it sends the worker's calls straight back here. */
const RC_SELF_HOST_API_BASE_URL = "https://api.anthropic.com";

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

/** The response header the protocol uses to tell a worker it is no longer the live one; sent with the epoch refusal so a superseded worker shuts down by its own rules instead of retrying. */
const CONFLICT_REASON_HEADER = "x-ccr-conflict-reason";

/** The conflict reason for a write whose worker_epoch is not the session's: the protocol's own vocabulary for exactly this. */
const CONFLICT_REASON_EPOCH_STALE = "epoch_stale";

/** The guard every payload narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a search backend's answer is its refusal rather than its result list: `Array.isArray` alone cannot narrow a readonly array out of the union, so the guard spells the refusal shape it checks for. */
function isWebSearchRefusal(value: readonly RcWebSearchResult[] | { readonly errorType: string; readonly errorMessage: string }): value is { readonly errorType: string; readonly errorMessage: string } {
  return !Array.isArray(value);
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

/** A record's field as a string array when every member is a string, else undefined: the shape the web-search request's domain filters carry. */
function stringArray(record: Record<string, unknown> | undefined, field: string): readonly string[] | undefined {
  const value = record === undefined ? undefined : record[field];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const members: string[] = [];
  for (const member of value) {
    if (typeof member !== "string") {
      return undefined;
    }
    members.push(member);
  }
  return members;
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

/**
 * Why an Authorization header did not authenticate, as a fact about its shape rather than its value: no header at all, a scheme word that is not Bearer, the Bearer scheme word carried twice, or a well-formed bearer that is simply not one this surface minted. The refusal names the class and nothing else, so a caller with a malformed presentation is told that (a fact it can act on without knowing any credential) instead of a mismatch it will go and disprove (ExaDev/agent-shim#264: a rig proof that prefixed the scheme word onto the whole header value a persisted session record holds presented a different credential, and the one-message refusal sent the investigation fingerprinting three stores to prove a match that was never in question).
 */
/** The refusal classes an Authorization presentation can fall into; exported as the type the split-out compatibility family's refusal threading carries. */
export type PresentationRefusal = "absent" | "not-a-bearer" | "doubled-scheme-word" | "unrecognised";

/** Classifies one refused presentation by shape alone. The doubled scheme word is its own class because it is the natural malformation of this door's own persisted shape: the credential a session's persisted record holds is the whole header value, scheme word included, so a caller that adds `Bearer ` to it presents `Bearer Bearer <token>`, which strips to `Bearer <token>` and matches nothing. */
function presentationRefusal(headers: Readonly<IncomingHttpHeaders>): PresentationRefusal {
  const presented = singleHeader(headers, "authorization");
  if (presented === undefined) {
    return "absent";
  }
  if (presented.slice(0, "bearer ".length).toLowerCase() !== "bearer ") {
    return "not-a-bearer";
  }
  const bearer = presented.slice("bearer ".length);
  return bearer.slice(0, "bearer ".length).toLowerCase() === "bearer " ? "doubled-scheme-word" : "unrecognised";
}

/** The whole credential this door's self-hosted mode mints, read back for every authenticated call and never logged: the token pair the identity's Claude Code presents, beside the organisation the minting chose. */
export interface RcSelfHostCredentialRecord {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly organizationUuid: string;
  readonly accountUuid: string;
}

/**
 * Which attachment wrote one event: the cse session the write arrived through, and the half it rode. The half decides worker-stream delivery (the `reachesWorkerStream` rule below): a worker half's own writes never return to that session's worker stream, but do reach every other attachment's, which is what lets a second TUI see the first's replies without either looping itself. Exported as the type the split-out client-channel handlers publish under.
 */
export interface RcEventWriter {
  /** The cse session the write arrived through, or undefined for a write the conversation family itself received (which has no worker half at all). */
  readonly session: string | undefined;
  /** Whether the write rode a session's worker half (its own event batch) or a client half (every other write path, sessions' and conversations' alike). */
  readonly half: "worker" | "client";
}

/** One stored event: the envelope the streams replay, minus the SSE framing derived at delivery. Exported as the element type of the conversation's event log, which the split-out conversation family pages and replays. */
export interface StoredEvent {
  readonly sequenceNum: number;
  readonly eventId: string;
  readonly source: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  /** Which attachment wrote the event, the fact every stream's delivery rule reads. */
  readonly writer: RcEventWriter;
  readonly storedAt: number;
}

/** One internal event the worker filed through its own channel, replayed only through that channel's paginated read: the id the reader echoes back as its `cursor` or `after_event_id` anchor, beside the event's own body. */
interface StoredInternalEvent {
  readonly eventId: string;
  readonly body: Record<string, unknown>;
}

/** One open SSE stream this service is holding, whichever half it serves. */
interface StreamSink {
  /** The attachment the stream belongs to: the cse session whose path dialed it, or the conversation's own id for a stream held through the conversation family. The worker-half delivery rule and archive's retirement both read it. */
  readonly owner: string;
  /** Writes one already-framed SSE block, serialised behind whatever the sink is still sending. */
  readonly write: (frame: string) => void;
  /** Retires the sink from its conversation's set; the response's own end is what closes the stream. */
  readonly retire: () => void;
}

/**
 * One conversation: the event log and sequence space its attached `cse_` sessions share, in memory only. The native service's own keying (#238's two-TUI observation); the linking vocabulary on the wire is this door's design (see the module comment). Exported as the type the split-out endpoint handlers in `rcSelfHostEndpoints.ts` act on.
 */
export interface SelfHostConversation {
  readonly id: string;
  readonly createdAt: number;
  sequenceNum: number;
  readonly events: StoredEvent[];
  /** The payload uuids already written, for the write answer's duplicate flag: pruned with the events, so it names the same window. */
  readonly seenPayloadUuids: Set<string>;
  /** The worker streams held through the attached sessions; there is no worker half on the conversation family itself, so every owner here is a cse session id. */
  readonly workerStreams: Set<StreamSink>;
  /** The client streams held through the attached sessions and through the conversation family alike. */
  readonly clientStreams: Set<StreamSink>;
  /**
   * The clients the conversation family's own presence channel has announced, by id, each with the instant of its last pulse, the same registry shape and semantics the sessions keep: a clear deletes, and the retention sweep prunes an id no pulse has refreshed for a retention window.
   */
  readonly clients: Map<string, number>;
  /** The live sessions attached to this conversation, exactly the ids their own creates named or minted. */
  readonly sessionIds: Set<string>;
  lastTrafficAt: number;
}

/** One self-hosted session's whole state, in memory only. Exported as the type the split-out endpoint handlers in `rcSelfHostEndpoints.ts` act on. */
export interface SelfHostSession {
  readonly id: string;
  readonly createdAt: number;
  title: string | undefined;
  /** The conversation this session is attached to: the owner of its event log, sequence space and streams. */
  readonly conversation: SelfHostConversation;
  /** Every worker JWT this service minted for the session: all stay valid, because the reconnect flow's fresh `/bridge` must not invalidate the JWT a still-live transport holds. */
  readonly workerJwts: Set<string>;
  readonly internalEvents: StoredInternalEvent[];
  /**
   * The clients the presence channel has announced, by id, each with the instant of its last pulse. The CLI's own sender posts one body shape for every client (`{client_id, clear}`, verified in the 2.1.289 bundle), so the registry is keyed by exactly that id; a clear deletes, and the retention sweep prunes an id no pulse has refreshed for a retention window, the same bound the session's own traffic answers to.
   */
  readonly clients: Map<string, number>;
  workerStatus: string | undefined;
  externalMetadata: Record<string, unknown> | undefined;
  lastTrafficAt: number;
}

/** One search result a backend answers with: the three fields the CLI's web-search schema reads, of which only `url` must be present (the client filters on it). */
interface RcWebSearchResult {
  readonly title?: string;
  readonly url: string;
  readonly snippet?: string;
}

/**
 * A real search backend for the worker's web-search proxy, injectable because the door ships none: it receives the query exactly as the CLI sent it (with its domain filters and search profile when it named any) and answers either the result list or a refusal shaped like the fetch's. This is the documented hook a future backend plugs into; the door's own answer while none is wired is the clear refusal below, never an invented engine and never a silent empty success.
 */
export type RcWebSearchBackend = (request: { readonly query: string; readonly allowedDomains?: readonly string[]; readonly blockedDomains?: readonly string[]; readonly searchProfile?: string }) => Promise<readonly RcWebSearchResult[] | { readonly errorType: string; readonly errorMessage: string }>;

/** Everything the service needs, injected so the decision logic runs against fakes in unit tests. */
export interface RcSelfHostDeps {
  readonly now: () => number;
  /** Mints the session and event ids: a v4 UUID or better in production. */
  readonly newUuid: () => string;
  /** Mints opaque token material (the worker JWTs): cryptographically random in production. */
  readonly randomToken: () => string;
  /** The minted credential this door authenticates against, read fresh so a re-mint takes effect without restarting the door; undefined while none was ever minted, in which case every authenticated call is refused. */
  readonly credentialRecord: () => RcSelfHostCredentialRecord | undefined;
  /** The URL fetch behind the worker's web-fetch proxy: the door's own exempt-agent dial in production (`realRcWebFetch`), a fake in tests. */
  readonly webFetch: RcWebFetcher;
  /** A real search backend for the worker's web-search proxy, when one is wired; while undefined the proxy answers the clear refusal naming that no backend serves this door. */
  readonly webSearch?: RcWebSearchBackend;
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

/** The self-hosted Remote Control service: the session-family route for the pipeline, and the local answers the connect surface consults before routing or piping. */
export interface RcSelfHostSurface {
  /** The pipeline route serving the whole `/v1/code/sessions` family, the `/v1/sessions` compatibility list and the `/v1/code/conversations` family. */
  readonly route: FrontDoorRoute;
  /** The connect surface's local answers: which hosts it takes over as HTTP, and the requests it answers itself. */
  readonly local: RcSelfHostLocal;
  /** Stops the service's timers and retires every open stream. The sessions themselves are unreachable the moment the door drops them. */
  readonly close: () => void;
}

/** Creates the self-hosted Remote Control service. One per door process; everything it holds dies with it. */
export function createRcSelfHostSurface(deps: RcSelfHostDeps): RcSelfHostSurface {
  const sessions = new Map<string, SelfHostSession>();
  const conversations = new Map<string, SelfHostConversation>();

  /** Ends one session on this surface: retires exactly its own streams from its conversation, detaches it, and drops the record. The conversation itself is left to live or die by its own remaining attachments, which is what keeps a second client's attachment alive through the first's archive. */
  const retireSession = (session: SelfHostSession): void => {
    for (const sink of [...session.conversation.workerStreams, ...session.conversation.clientStreams]) {
      if (sink.owner === session.id) {
        sink.retire();
      }
    }
    session.conversation.sessionIds.delete(session.id);
    sessions.delete(session.id);
  };

  /** Sweeps what retention owns: events past the resume window, presence registrations no pulse has refreshed for the same window, sessions no stream holds and no traffic has touched for the same window, and conversations no attachment, stream or traffic keeps alive for the same window. */
  const sweep = (): void => {
    const now = deps.now();
    for (const session of sessions.values()) {
      for (const [clientId, lastSeenAt] of session.clients) {
        if (now - lastSeenAt > RC_SELF_HOST_RETENTION_MS) {
          session.clients.delete(clientId);
        }
      }
      const holdsStream = [...session.conversation.workerStreams, ...session.conversation.clientStreams].some((sink) => sink.owner === session.id);
      if (!holdsStream && now - session.lastTrafficAt > RC_SELF_HOST_RETENTION_MS) {
        retireSession(session);
      }
    }
    for (const conversation of conversations.values()) {
      while (conversation.events[0] !== undefined && now - conversation.events[0].storedAt > RC_SELF_HOST_RETENTION_MS) {
        const dropped = conversation.events.shift();
        const uuid = dropped === undefined ? undefined : nonEmptyString(dropped.payload, "uuid");
        if (uuid !== undefined) {
          conversation.seenPayloadUuids.delete(uuid);
        }
      }
      for (const [clientId, lastSeenAt] of conversation.clients) {
        if (now - lastSeenAt > RC_SELF_HOST_RETENTION_MS) {
          conversation.clients.delete(clientId);
        }
      }
      if (conversation.sessionIds.size === 0 && conversation.workerStreams.size === 0 && conversation.clientStreams.size === 0 && now - conversation.lastTrafficAt > RC_SELF_HOST_RETENTION_MS) {
        conversations.delete(conversation.id);
      }
    }
  };
  // The sweep only bounds memory between writes: every write sweeps first, so what the streams serve is always exact however long the timer waits.
  const timer = setInterval(sweep, RC_SELF_HOST_RETENTION_MS);
  timer.unref();
  const keepalive = setInterval(() => {
    for (const conversation of conversations.values()) {
      for (const sink of [...conversation.workerStreams, ...conversation.clientStreams]) {
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

  /** The refusal class for a call the minted credential did not authenticate (the client half's family), or undefined when it did. */
  const credentialRefusal = (headers: Readonly<IncomingHttpHeaders>): PresentationRefusal | undefined => (presentsCredential(headers) ? undefined : presentationRefusal(headers));

  /** The refusal class for a call the session's worker JWTs did not authenticate (the worker family's own paths), or undefined when one did. */
  const workerRefusal = (headers: Readonly<IncomingHttpHeaders>, session: SelfHostSession): PresentationRefusal | undefined => (presentsWorkerJwt(headers, session) ? undefined : presentationRefusal(headers));

  /** The refusal class for a call neither the session's worker JWTs nor the minted credential authenticated (the two web proxies' union), or undefined when one did. */
  const workerOrCredentialRefusal = (headers: Readonly<IncomingHttpHeaders>, session: SelfHostSession): PresentationRefusal | undefined =>
    presentsWorkerJwt(headers, session) || presentsCredential(headers) ? undefined : presentationRefusal(headers);

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
   * Whether one event belongs on the worker stream of the named attachment: everything except the writes that attachment's own worker half made, since feeding a worker its own writes back would loop its REPL. A worker half's writes through any other attachment do reach it, and every client-half write does whatever session it rode, which is the delivery rule a conversation's attachments fan out under.
   */
  const reachesWorkerStream = (event: StoredEvent, owner: string): boolean => !(event.writer.half === "worker" && event.writer.session === owner);

  /**
   * Holds one SSE stream open over a routed response. Registration and the resume replay are one synchronous step (the snapshot is taken, the sink registered, and only then is the snapshot written through it), so no published event can be lost or doubled across the gap: everything after the snapshot is delivered live because the sink is already registered, and everything in the snapshot predates it.
   */
  const holdStream = async (conversation: SelfHostConversation, owner: string, which: "workerStreams" | "clientStreams", wantsReplay: (event: StoredEvent) => boolean, request: RoutedRequest, response: RoutedResponse): Promise<void> => {
    const url = new URL(request.url, "http://127.0.0.1");
    // The protocol's documented resume pair: the query parameter and the header arrive together, so either supplies the cursor; a first connection sends neither and reads from the stream's own head.
    const cursor = numberOf({ value: url.searchParams.get("from_sequence_num") }, "value") ?? numberOf({ value: singleHeader(request.headers, "last-event-id") }, "value");
    const replay = cursor === undefined ? [] : conversation.events.filter((event) => wantsReplay(event) && event.sequenceNum > cursor);
    response.start(HTTP_STATUS.ok, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // The head goes out before any event exists: a stream that has said nothing yet is still an open stream, and a client that has not seen the head would otherwise wait on it while the surface waits on events (the deadlock the first e2e run surfaced).
    response.flush();
    let pending: Promise<void> = Promise.resolve();
    const sink: StreamSink = {
      owner,
      write: (frame) => {
        pending = pending.then(async () => {
          await response.write(frame);
        }).catch(() => {
          // A write to a response whose client went away resolves early by that response's own contract, so this only guards a raced destroy; the retirement below is what stops further writes either way.
        });
      },
      retire: () => {
        conversation[which].delete(sink);
      },
    };
    conversation[which].add(sink);
    conversation.lastTrafficAt = deps.now();
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

  /**
   * Files one event into its conversation and delivers it to the streams whose half it belongs on: assigns the next sequence number in the conversation's one shared space, records it, and returns the write answer's facts. The worker streams receive the event under the `reachesWorkerStream` rule (everything but each worker's own writes), and every client stream receives everything, whichever attachment the write rode.
   */
  const publish = (conversation: SelfHostConversation, writer: RcEventWriter, source: string, payload: Record<string, unknown>): { readonly sequenceNum: number; readonly eventId: string; readonly duplicate: boolean } => {
    const uuid = nonEmptyString(payload, "uuid");
    const duplicate = uuid !== undefined && conversation.seenPayloadUuids.has(uuid);
    conversation.sequenceNum += 1;
    const event: StoredEvent = {
      sequenceNum: conversation.sequenceNum,
      eventId: uuid ?? deps.newUuid(),
      source,
      // The one enrichment the real service was observed making on the live rig's stream: the wall-clock instant it took the write. The worker's handler ignores it; the door's own parser forwards it verbatim.
      payload: source === RC_SOURCE_WORKER ? payload : { ...payload, server_received_wall_ms: deps.now() },
      createdAt: new Date(deps.now()).toISOString(),
      writer,
      storedAt: deps.now(),
    };
    conversation.events.push(event);
    if (uuid !== undefined) {
      conversation.seenPayloadUuids.add(uuid);
    }
    conversation.lastTrafficAt = event.storedAt;
    const frame = frameOf(event);
    for (const sink of [...conversation.workerStreams]) {
      if (reachesWorkerStream(event, sink.owner)) {
        sink.write(frame);
      }
    }
    for (const sink of [...conversation.clientStreams]) {
      sink.write(frame);
    }
    return { sequenceNum: event.sequenceNum, eventId: event.eventId, duplicate };
  };

  /** The session row the create, read and list answers carry: the observed members plus the door's own `conversation_id`, the one field a second client needs to learn where to join (a door-designed field; the observed shapes name no conversation). */
  const sessionRow = (session: SelfHostSession): Record<string, unknown> => ({ id: session.id, title: session.title, created_at: new Date(session.createdAt).toISOString(), status: "active", conversation_id: session.conversation.id });

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

  /** Each refusal class's message: shape facts only, never a credential's value, so the answer stays diagnosable without disclosing anything. */
  const refusalMessages: Readonly<Record<PresentationRefusal, string>> = {
    absent: "the self-hosted Remote Control surface authenticates by the Authorization header, and this call carried none",
    "not-a-bearer": "the self-hosted Remote Control surface reads a Bearer authorization, and this call's Authorization header did not carry the Bearer scheme word",
    "doubled-scheme-word": "the self-hosted Remote Control surface reads one Bearer scheme word, and this call's Authorization header carried it twice: a persisted session record holds the whole header value with the scheme word included, so prefixing Bearer onto it presents a different credential",
    unrecognised: "the self-hosted Remote Control surface did not recognise the presented credential",
  };

  /** The refusal for an Authorization this surface did not accept, shaped as the real host answers an unknown bearer and naming the presentation's class so a wrong shape is never mistaken for a wrong credential. */
  const unauthorized = async (response: RoutedResponse, refusal: PresentationRefusal): Promise<void> => {
    await answerJson(response, HTTP_STATUS.unauthorized, { type: "error", error: { type: "authentication_error", message: refusalMessages[refusal] } });
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
      if (method === "PATCH" || method === "PUT") {
        const refusal = credentialRefusal(request.headers);
        if (refusal !== undefined) {
          await unauthorized(response, refusal);
          return;
        }
        // The session update the CLI's own title writer performs (`updateSessionTitle`, verified in the 2.1.289 bundle: a PUT of `{title}` to this very path), served for the PATCH the compat family's v1 update uses too, because the two verbs carry the same body on the two URL forms of one operation.
        const body = parseJsonObject(await readBody(request.body, CONTROL_BODY_CAP_BYTES));
        const title = nonEmptyString(body, "title");
        if (title === undefined) {
          await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "a session update is JSON naming a non-empty title" } });
          return;
        }
        session.title = title;
        session.lastTrafficAt = deps.now();
        deps.log?.(`rc selfhost ${session.id}: retitled at its client's request`);
        await answerJson(response, HTTP_STATUS.ok, {});
        return;
      }
      if (method !== "GET") {
        await answerJson(response, HTTP_STATUS.methodNotAllowed, { type: "error", error: { type: "api_error", message: "the session read is a GET, and its update a PATCH or PUT" } });
        return;
      }
      await answerJson(response, HTTP_STATUS.ok, { session: sessionRow(session) });
      return;
    }

    if (tail === "bridge" && method === "POST") {
      const refusal = credentialRefusal(request.headers);
      if (refusal !== undefined) {
        await unauthorized(response, refusal);
        return;
      }
      const workerJwt = mintWorkerJwt(deps.randomToken, deps.now());
      session.workerJwts.add(workerJwt);
      deps.log?.(`rc selfhost ${session.id}: bridge registration minted a worker credential`);
      await answerJson(response, HTTP_STATUS.ok, { worker_jwt: workerJwt, expires_in: RC_SELF_HOST_WORKER_JWT_TTL_SECONDS, api_base_url: RC_SELF_HOST_API_BASE_URL, worker_epoch: RC_SELF_HOST_WORKER_EPOCH });
      return;
    }

    if (tail === "archive" && method === "POST") {
      const refusal = credentialRefusal(request.headers);
      if (refusal !== undefined) {
        await unauthorized(response, refusal);
        return;
      }
      // The archive ends this session, not its conversation: a second attachment's streams and the shared log live on through their own attachment.
      retireSession(session);
      deps.log?.(`rc selfhost ${session.id}: archived at its client's request`);
      await answerJson(response, HTTP_STATUS.ok, {});
      return;
    }

    if (tail === "worker" || tail.startsWith("worker/")) {
      const workerTail = tail === "worker" ? "" : tail.slice("worker/".length);
      // The two web proxies are the one worker family the CLI's own half dials as well: its proxy client presents the login bearer whenever it holds no worker session url (the 2.1.289 source sets `ccrSessionUrl` from nowhere a local bridge reaches, and its auth falls back to the session credential), so these paths accept the minted credential beside the bridge's own worker JWT. The principal is the same either way: the credential that created the session.
      const webProxy = workerTail === "web-fetch" || workerTail === "web-search";
      const refusal = webProxy ? workerOrCredentialRefusal(request.headers, session) : workerRefusal(request.headers, session);
      if (refusal !== undefined) {
        await unauthorized(response, refusal);
        return;
      }

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
          const published = publish(session.conversation, { session: session.id, half: "worker" }, RC_SOURCE_WORKER, event.payload);
          results.push({ event_id: published.eventId, sequence_num: String(published.sequenceNum) });
        }
        sweep();
        await answerJson(response, HTTP_STATUS.ok, { results });
        return;
      }
      if (workerTail === "events/stream" && method === "GET") {
        await holdStream(session.conversation, session.id, "workerStreams", (event) => reachesWorkerStream(event, session.id), request, response);
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
            session.internalEvents.push({ eventId: deps.newUuid(), body: event });
          }
        }
        await answerJson(response, HTTP_STATUS.ok, {});
        return;
      }
      if (workerTail === "internal-events" && method === "GET") {
        // The channel's own paginated read, in the shape the CLI's reader pages (verified in the 2.1.289 bundle): rows of `{event_id, payload}`, the anchor the reader's own vocabulary names (`after_event_id`, or the `cursor` a previous page's `next_cursor` became), and the whole channel served because this surface keeps exactly one per session. An agent-scoped read is refused rather than answered with the full channel, because silently serving rows the reader did not ask for is the one lie this endpoint could tell. An unknown anchor answers the protocol's own `after_event_id_not_found` error type, the code the CLI's reader matches to refetch without its anchor.
        const query = new URL(request.url, "http://127.0.0.1").searchParams;
        if (query.get("session_agent_id") !== null || query.get("subagents") !== null) {
          await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "this surface keeps one internal-events channel per session, so an agent-scoped read has no subset to serve" } });
          return;
        }
        const page = pageOfRcChannel(request.url, session.internalEvents, (event) => event.eventId, (event) => ({ event_id: event.eventId, payload: event.body }));
        if ("error" in page) {
          const anchorUnknown = query.get("after_event_id") !== null && page.error.startsWith("the anchor names an event id");
          await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: anchorUnknown ? "after_event_id_not_found" : "invalid_request_error", message: page.error } });
          return;
        }
        await answerJson(response, HTTP_STATUS.ok, page);
        return;
      }
      if (workerTail === "diagnostics" && method === "POST") {
        await readBody(request.body, CONTROL_BODY_CAP_BYTES);
        await answerJson(response, HTTP_STATUS.ok, {});
        return;
      }
      if (workerTail === "web-fetch" && method === "POST") {
        // The worker-side URL fetch the CLI delegates when its environment sends it through the Remote Control host: a POST of one url, answered with the fetched facts or the target refusal, both as 200 bodies because the CLI's client retries HTTP errors but surfaces an error object as the tool's own failure.
        const body = parseJsonObject(await readBody(request.body, CONTROL_BODY_CAP_BYTES));
        const target = nonEmptyString(body, "url");
        if (target === undefined) {
          await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "a worker web-fetch carries one url" } });
          return;
        }
        const outcome = await deps.webFetch(target);
        if (outcome.kind === "fetched") {
          const answer = { url: target, destination_url: outcome.destinationUrl, text: outcome.text, ...(outcome.contentType === undefined ? {} : { content_type: outcome.contentType }) };
          // The serialised answer must fit the CLI proxy client's own reader cap: JSON escaping can inflate a body that fitted the byte cap, and an answer past the cap is dropped unread, so the honest reply is the refusal.
          if (Buffer.byteLength(JSON.stringify(answer), "utf8") > RC_WEB_FETCH_MAX_BYTES) {
            deps.log?.(`rc selfhost ${session.id}: worker web-fetch of ${target} escaped past the reader cap when framed`);
            await answerJson(response, HTTP_STATUS.ok, { error: { error_type: "web_fetch_too_large", error_message: `the answer for ${target} exceeds the ${String(RC_WEB_FETCH_MAX_BYTES)} byte cap the CLI's proxy client reads` } });
            return;
          }
          deps.log?.(`rc selfhost ${session.id}: worker web-fetch served ${target} as ${outcome.destinationUrl}`);
          await answerJson(response, HTTP_STATUS.ok, answer);
          return;
        }
        deps.log?.(`rc selfhost ${session.id}: worker web-fetch of ${target} refused: ${outcome.errorType}`);
        await answerJson(response, HTTP_STATUS.ok, { error: { error_type: outcome.errorType, error_message: outcome.errorMessage } });
        return;
      }
      if (workerTail === "web-search" && method === "POST") {
        const body = parseJsonObject(await readBody(request.body, CONTROL_BODY_CAP_BYTES));
        const query = nonEmptyString(body, "query");
        if (query === undefined) {
          await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "a worker web-search carries one query" } });
          return;
        }
        const allowedDomains = stringArray(body, "allowed_domains");
        const blockedDomains = stringArray(body, "blocked_domains");
        if ((body?.allowed_domains !== undefined && allowedDomains === undefined) || (body?.blocked_domains !== undefined && blockedDomains === undefined)) {
          await answerJson(response, HTTP_STATUS.badRequest, { type: "error", error: { type: "invalid_request_error", message: "the domain filters of a worker web-search are string arrays" } });
          return;
        }
        const searchProfile = nonEmptyString(body, "search_profile");
        const backend = deps.webSearch;
        if (backend === undefined) {
          // The door ships no search engine, and pretending otherwise (an empty result list reads as a search that found nothing) would be the silent failure; the refusal names the gap, and a real backend answers through the same shape once one is wired.
          deps.log?.(`rc selfhost ${session.id}: worker web-search of "${query}" refused: no search backend serves this door`);
          await answerJson(response, HTTP_STATUS.ok, { results: [], error: { error_type: "web_search_unavailable", error_message: "this front door serves the Remote Control web-search proxy without a search backend, so no query can be served here" } });
          return;
        }
        const answered = await backend({ query, ...(allowedDomains === undefined ? {} : { allowedDomains }), ...(blockedDomains === undefined ? {} : { blockedDomains }), ...(searchProfile === undefined ? {} : { searchProfile }) });
        deps.log?.(`rc selfhost ${session.id}: worker web-search of "${query}" answered by its backend`);
        if (isWebSearchRefusal(answered)) {
          await answerJson(response, HTTP_STATUS.ok, { results: [], error: { error_type: answered.errorType, error_message: answered.errorMessage } });
          return;
        }
        await answerJson(response, HTTP_STATUS.ok, { results: answered.map((result) => ({ title: result.title ?? "", url: result.url, snippet: result.snippet ?? "" })) });
        return;
      }
      await answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `the self-hosted Remote Control surface serves no worker path "${workerTail}"` } });
      return;
    }

    // Everything else on the session is the client half, authenticated by the minted credential.
    const clientRefusal = credentialRefusal(request.headers);
    if (clientRefusal !== undefined) {
      await unauthorized(response, clientRefusal);
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
        const published = publish(session.conversation, { session: session.id, half: "client" }, RC_SOURCE_CLIENT, event.payload);
        // The write answer the door's own client half parses: per-event sequence numbers as strings (the form the real endpoint was observed returning) beside the duplicate flag the live proof saw.
        results.push({ sequence_num: String(published.sequenceNum), duplicate: published.duplicate });
      }
      sweep();
      await answerJson(response, HTTP_STATUS.ok, { results });
      return;
    }
    if (tail === "events" && method === "GET") {
      await answerJson(response, HTTP_STATUS.ok, { data: session.conversation.events.map((event) => ({ event_id: event.eventId, event_type: nonEmptyString(event.payload, "type") ?? "event", sequence_num: event.sequenceNum, source: event.source, payload: event.payload, created_at: event.createdAt })) });
      return;
    }
    if (tail === "events/stream" && method === "GET") {
      await holdStream(session.conversation, session.id, "clientStreams", () => true, request, response);
      return;
    }
    // The client-half channels this surface serves through the split-out endpoint handlers: presence, read receipts and the teleport channel.
    if (await serveRcClientChannels({ request, response, host: { id: session.id, clients: session.clients, conversation: session.conversation, writer: { session: session.id, half: "client" } }, answerJson, readBody, publish, sweep, now: deps.now, presenceRefreshSeconds: RC_PRESENCE_REFRESH_SECONDS, ...(deps.log === undefined ? {} : { log: deps.log }) }, tail, method, RC_SELF_HOST_MAX_BATCH_EVENTS)) {
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
      if (pathname === RC_COMPAT_SESSIONS_PATH || pathname.startsWith(`${RC_COMPAT_SESSIONS_PATH}/`)) {
        // The compatibility `/v1/sessions` family, served through the split-out endpoint handlers against this door's own sessions.
        await serveRcCompatSessions({ request, response, sessions, retireSession, answerJson, readBody, credentialRefusal, unauthorized, now: deps.now, ...(deps.log === undefined ? {} : { log: deps.log }) }, pathname, RC_COMPAT_SESSIONS_PATH);
        return;
      }
      if (pathname === RC_CONVERSATIONS_PATH_PREFIX || pathname.startsWith(`${RC_CONVERSATIONS_PATH_PREFIX}/`)) {
        // The conversation family, the door's own sessionless surface, served through its split-out handlers against this surface's conversations.
        await serveRcConversations({ request, response, conversations, answerJson, readBody, credentialRefusal, unauthorized, publish, holdStream, sweep, now: deps.now, presenceRefreshSeconds: RC_PRESENCE_REFRESH_SECONDS, maxBatchEvents: RC_SELF_HOST_MAX_BATCH_EVENTS, ...(deps.log === undefined ? {} : { log: deps.log }) }, pathname, method);
        return;
      }
      if (pathname !== RC_SESSIONS_PATH_PREFIX && !pathname.startsWith(`${RC_SESSIONS_PATH_PREFIX}/`)) {
        await answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `the self-hosted Remote Control surface serves no path "${pathname}"` } });
        return;
      }
      if (pathname === RC_SESSIONS_PATH_PREFIX) {
        if (method === "POST") {
          const createRefusal = credentialRefusal(request.headers);
          if (createRefusal !== undefined) {
            await unauthorized(response, createRefusal);
            return;
          }
          const body = parseJsonObject(await readBody(request.body, CONTROL_BODY_CAP_BYTES));
          // The joining handshake: a create that names a conversation attaches the new session to it (the multi-TUI native shape, two cse ids over one event log); a create that names none mints a fresh one. The body field is this door's own design, named in the module comment: no observed create carries a conversation link.
          const namedConversation = nonEmptyString(body, "conversation");
          let conversation: SelfHostConversation | undefined;
          if (namedConversation === undefined) {
            conversation = newRcSelfHostConversation(deps.newUuid, deps.now);
            conversations.set(conversation.id, conversation);
          } else {
            conversation = conversations.get(namedConversation);
            if (conversation === undefined) {
              await answerJson(response, HTTP_STATUS.notFound, { type: "error", error: { type: "api_error", message: `no such Remote Control conversation on this door: ${namedConversation}` } });
              return;
            }
            conversation.lastTrafficAt = deps.now();
          }
          const session: SelfHostSession = {
            id: `${RC_SESSION_ID_PREFIX}${deps.newUuid()}`,
            createdAt: deps.now(),
            title: nonEmptyString(body, "title"),
            conversation,
            workerJwts: new Set<string>(),
            internalEvents: [],
            clients: new Map<string, number>(),
            workerStatus: undefined,
            externalMetadata: undefined,
            lastTrafficAt: deps.now(),
          };
          conversation.sessionIds.add(session.id);
          sessions.set(session.id, session);
          deps.log?.(`rc selfhost ${session.id}: session created on the door's own surface, attached to conversation ${conversation.id}${namedConversation === undefined ? "" : " at its client's request"}`);
          await answerJson(response, HTTP_STATUS.ok, { session: sessionRow(session) });
          return;
        }
        if (method === "GET") {
          const readRefusal = credentialRefusal(request.headers);
          if (readRefusal !== undefined) {
            await unauthorized(response, readRefusal);
            return;
          }
          await answerJson(response, HTTP_STATUS.ok, { data: [...sessions.values()].map((session) => ({ id: session.id, title: session.title, created_at: new Date(session.createdAt).toISOString(), updated_at: new Date(session.lastTrafficAt).toISOString(), session_status: "active", conversation_id: session.conversation.id })) });
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

  const local = createRcSelfHostLocal({ now: deps.now, credentialRecord: deps.credentialRecord, readBody });

  return {
    route,
    local,
    close: () => {
      clearInterval(timer);
      clearInterval(keepalive);
      for (const conversation of conversations.values()) {
        for (const sink of [...conversation.workerStreams, ...conversation.clientStreams]) {
          sink.retire();
        }
      }
      sessions.clear();
      conversations.clear();
    },
  };
}

import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";

import { HTTP_STATUS } from "../codex/http";
import { isLiveCapability } from "./capability";
import type { RcPendingRequestSummary, RcSessionStatus, RcSessionSummary } from "./rcSessions";
import { RC_CONTEXT_USAGE_DETAILS, RC_PERMISSION_MODES, RC_READ_FILE_ENCODINGS, isRcContextUsageDetail, isRcPermissionMode, isRcReadFileEncoding, rcSessionNotObservedMessage, type RcAnswerDecision, type RcContextUsageDetail, type RcEventWriteResult, type RcPermissionMode, type RcReadFileOptions } from "./rcWrites";

/** The SDK's own permission modes as one readable list, so a body refused for a bad mode names exactly what is permitted. */
const RC_PERMISSION_MODE_LIST = RC_PERMISSION_MODES.join(", ");

/**
 * The Remote Control control surface: the small HTTP namespace the serving door answers on its provider listener, next to `/healthz`, through which `agent-shim frontdoor rc` lists the observed sessions, reports each one's status and pending control requests, injects a prompt into one, answers one of its pending requests, and sends its own control requests into one (interrupt, set-model, set-permission-mode, and the wider client-half verb family: end-session, the usage and context queries, read-file, file-suggestions, keep-alive, and the mcp_* family).
 *
 * This rides the listener `frontdoor status` already knows the door by (its address comes from the same state file, its trust anchor from the same CA path) rather than any second channel. The routes sit under one prefix the routed pipeline never serves, and every request must present the serving generation's control token as a Bearer credential: a fresh random value per door start, written owner-only under the front door's state directory so only this user's CLI can read it, and checked in constant time like every other capability the door accepts. An inject, answer or control request is carried out by the door itself over its interception-proof dials, which is the whole point: the CLI never dials the API host directly, so nothing about the write depends on the caller's own network path.
 */

/** The one path prefix every Remote Control control route sits under, answered before the routed pipeline like `/healthz` is. */
export const CONTROL_PATH_PREFIX = "/__agent-shim/rc";

/**
 * The largest control request body accepted: 10 MiB, the protocol's own documented cap on one event batch, so a control body holding a single user turn is bounded by the same protocol limit. Anything larger is not a control body, and refusing it keeps the door from buffering an unbounded prompt. Exported because the typed API's handler bounds its own request bodies by the same protocol limit.
 */
export const CONTROL_BODY_CAP_BYTES = 10_485_760;

/** The one JSON error shape every control route answers a failure with. */
interface ControlErrorBody {
  readonly error: string;
}

/** Everything the control handler needs, injected so it serves against fakes in unit tests. */
export interface RcControlHandlerDeps {
  /** This generation's control token: the value the door wrote owner-only for its CLI to present. */
  readonly expectedToken: string;
  /** The observed sessions as the tracker lists them. */
  readonly list: () => readonly RcSessionSummary[];
  /** The observed sessions as the tracker reports their status, filtered to one when named. */
  readonly statusOf: (sessionId?: string) => readonly RcSessionStatus[];
  /** The control requests awaiting an answer, filtered to one session when named. */
  readonly pendingOf: (sessionId?: string) => readonly RcPendingRequestSummary[];
  /** The inject operation, already wired to the tracker and the door's API-host dial. */
  readonly inject: (sessionId: string, text: string) => Promise<RcEventWriteResult>;
  /** The answer operation, already wired to the tracker and the door's API-host dial. */
  readonly answer: (sessionId: string, requestId: string, decision: RcAnswerDecision) => Promise<RcEventWriteResult>;
  /** The interrupt operation, already wired to the tracker and the door's API-host dial. */
  readonly interrupt: (sessionId: string) => Promise<RcEventWriteResult>;
  /** The set-model operation, already wired to the tracker and the door's API-host dial. */
  readonly setModel: (sessionId: string, model: string) => Promise<RcEventWriteResult>;
  /** The set-permission-mode operation, already wired to the tracker and the door's API-host dial. */
  readonly setPermissionMode: (sessionId: string, mode: RcPermissionMode) => Promise<RcEventWriteResult>;
  /** The end-session operation, already wired to the tracker and the door's API-host dial. */
  readonly endSession: (sessionId: string, reason: string | undefined) => Promise<RcEventWriteResult>;
  /** The get-usage operation, already wired to the tracker and the door's API-host dial. */
  readonly getUsage: (sessionId: string, skipBehaviors: boolean | undefined) => Promise<RcEventWriteResult>;
  /** The get-context-usage operation, already wired to the tracker and the door's API-host dial. */
  readonly getContextUsage: (sessionId: string, detail: RcContextUsageDetail | undefined) => Promise<RcEventWriteResult>;
  /** The read-file operation, already wired to the tracker and the door's API-host dial. */
  readonly readFile: (sessionId: string, path: string, options: RcReadFileOptions | undefined) => Promise<RcEventWriteResult>;
  /** The file-suggestions operation, already wired to the tracker and the door's API-host dial. */
  readonly fileSuggestions: (sessionId: string, query: string) => Promise<RcEventWriteResult>;
  /** The keep-alive operation, already wired to the tracker and the door's API-host dial. */
  readonly keepAlive: (sessionId: string) => Promise<RcEventWriteResult>;
  /** The mcp-status operation, already wired to the tracker and the door's API-host dial. */
  readonly mcpStatus: (sessionId: string) => Promise<RcEventWriteResult>;
  /** The mcp-reconnect operation, already wired to the tracker and the door's API-host dial. */
  readonly mcpReconnect: (sessionId: string, serverName: string) => Promise<RcEventWriteResult>;
  /** The mcp-authenticate operation, already wired to the tracker and the door's API-host dial. */
  readonly mcpAuthenticate: (sessionId: string, serverName: string, redirectUri: string) => Promise<RcEventWriteResult>;
  /** The mcp-oauth-callback-url operation, already wired to the tracker and the door's API-host dial. */
  readonly mcpOAuthCallbackUrl: (sessionId: string, serverName: string, callbackUrl: string) => Promise<RcEventWriteResult>;
}

/** Writes one JSON answer: the status, the object, and the connection closed after it. */
function answerJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text, "utf8")) });
  response.end(text);
}

/** Whether one value is a plain JSON object, the guard every route body's narrowing goes through. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One route body's string field when it is a non-empty string, else undefined: the shape every id and name extraction narrows to. */
function bodyString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** One route body's string field when it is present as a string (the empty string included), else undefined: the one field family whose emptiness is a value of its own (the file-suggestions query). */
function bodyStringAllowingEmpty(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" ? value : undefined;
}

/** One route body's boolean field, else undefined. */
function bodyBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === "boolean" ? value : undefined;
}

/** One route body's field when it is a positive whole number, else undefined: the read-file byte cap's own shape. */
function bodyPositiveInteger(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * One control-write route the handler serves: its name (the words its refusals carry), its path under the control prefix, and its body reader, which either refuses with the route's own words or yields the session and the already-bound operation call. The table exists because every control write is the same route shape (one POST, one JSON body, one operation, one answer naming the minted request id and the assigned sequence numbers), so the mechanics are stated once and each entry states only its own fields.
 */
interface ControlWriteRoute {
  readonly name: string;
  readonly path: string;
  readonly read: (body: Record<string, unknown>) => { readonly error: string } | { readonly session: string; readonly run: () => Promise<RcEventWriteResult> };
}

/** Reads one request's whole body as text, refusing a body past the cap with 413. */
async function readBody(request: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > CONTROL_BODY_CAP_BYTES) {
        request.destroy();
        reject(new Error("too large"));
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

/**
 * Builds the control handler the provider listener serves under `CONTROL_PATH_PREFIX`. Every route demands the generation's control token first, so nothing about the sessions (their ids, their timing, and most of all the prompts and approvals carried into them) is reachable by a process that did not read the owner-only token file.
 */
export function createRcControlHandler(deps: RcControlHandlerDeps): (request: IncomingMessage, response: ServerResponse) => void {
  const sessionsPath = `${CONTROL_PATH_PREFIX}/sessions`;
  const statusPath = `${CONTROL_PATH_PREFIX}/status`;
  const pendingPath = `${CONTROL_PATH_PREFIX}/pending`;
  const injectPath = `${CONTROL_PATH_PREFIX}/inject`;
  const answerPath = `${CONTROL_PATH_PREFIX}/answer`;
  /** Every control-write route, one entry per operation; the mechanics they share (the POST, the JSON body, the answer shape) live in the one loop below. */
  const controlWrites: readonly ControlWriteRoute[] = [
    {
      name: "interrupt",
      path: "interrupt",
      read: (body) => {
        const session = bodyString(body, "session");
        return session === undefined ? { error: "the interrupt body must be JSON naming a non-empty session id" } : { session, run: async () => await deps.interrupt(session) };
      },
    },
    {
      name: "set-model",
      path: "set-model",
      read: (body) => {
        const session = bodyString(body, "session");
        const model = bodyString(body, "model");
        return session === undefined || model === undefined ? { error: "the set-model body must be JSON naming a non-empty session id and model id" } : { session, run: async () => await deps.setModel(session, model) };
      },
    },
    {
      name: "set-permission-mode",
      path: "set-permission-mode",
      read: (body) => {
        const session = bodyString(body, "session");
        const mode = body.mode;
        return session === undefined || !isRcPermissionMode(mode) ? { error: `the set-permission-mode body must be JSON naming a non-empty session id and a mode the SDK's own type permits (${RC_PERMISSION_MODE_LIST})` } : { session, run: async () => await deps.setPermissionMode(session, mode) };
      },
    },
    {
      name: "end-session",
      path: "end-session",
      read: (body) => {
        const session = bodyString(body, "session");
        const reason = "reason" in body ? bodyString(body, "reason") : undefined;
        return session === undefined || ("reason" in body && reason === undefined) ? { error: "the end-session body must be JSON naming a non-empty session id, and a reason only as a non-empty string or absent" } : { session, run: async () => await deps.endSession(session, reason) };
      },
    },
    {
      name: "get-usage",
      path: "get-usage",
      read: (body) => {
        const session = bodyString(body, "session");
        const skipBehaviors = "skipBehaviors" in body ? bodyBoolean(body, "skipBehaviors") : undefined;
        return session === undefined || ("skipBehaviors" in body && skipBehaviors === undefined) ? { error: "the get-usage body must be JSON naming a non-empty session id, and skipBehaviors only as a boolean or absent" } : { session, run: async () => await deps.getUsage(session, skipBehaviors) };
      },
    },
    {
      name: "get-context-usage",
      path: "get-context-usage",
      read: (body) => {
        const session = bodyString(body, "session");
        const detail = "detail" in body && isRcContextUsageDetail(body.detail) ? body.detail : undefined;
        return session === undefined || ("detail" in body && detail === undefined) ? { error: `the get-context-usage body must be JSON naming a non-empty session id, and a detail level the SDK's own type permits (${RC_CONTEXT_USAGE_DETAILS.join(", ")}) or none` } : { session, run: async () => await deps.getContextUsage(session, detail) };
      },
    },
    {
      name: "read-file",
      path: "read-file",
      read: (body) => {
        const session = bodyString(body, "session");
        const path = bodyString(body, "path");
        const maxBytes = "maxBytes" in body ? bodyPositiveInteger(body, "maxBytes") : undefined;
        const encoding = "encoding" in body && isRcReadFileEncoding(body.encoding) ? body.encoding : undefined;
        const refused = session === undefined || path === undefined || ("maxBytes" in body && maxBytes === undefined) || ("encoding" in body && encoding === undefined);
        return refused
          ? { error: `the read-file body must be JSON naming a non-empty session id and path, maxBytes only as a positive whole number or absent, and an encoding the SDK's own type permits (${RC_READ_FILE_ENCODINGS.join(", ")}) or none` }
          : { session, run: async () => await deps.readFile(session, path, { ...(maxBytes === undefined ? {} : { maxBytes }), ...(encoding === undefined ? {} : { encoding }) }) };
      },
    },
    {
      name: "file-suggestions",
      path: "file-suggestions",
      read: (body) => {
        const session = bodyString(body, "session");
        const query = bodyStringAllowingEmpty(body, "query");
        return session === undefined || query === undefined ? { error: "the file-suggestions body must be JSON naming a non-empty session id and a query string, which may be empty" } : { session, run: async () => await deps.fileSuggestions(session, query) };
      },
    },
    {
      name: "keep-alive",
      path: "keep-alive",
      read: (body) => {
        const session = bodyString(body, "session");
        return session === undefined ? { error: "the keep-alive body must be JSON naming a non-empty session id" } : { session, run: async () => await deps.keepAlive(session) };
      },
    },
    {
      name: "mcp-status",
      path: "mcp-status",
      read: (body) => {
        const session = bodyString(body, "session");
        return session === undefined ? { error: "the mcp-status body must be JSON naming a non-empty session id" } : { session, run: async () => await deps.mcpStatus(session) };
      },
    },
    {
      name: "mcp-reconnect",
      path: "mcp-reconnect",
      read: (body) => {
        const session = bodyString(body, "session");
        const serverName = bodyString(body, "serverName");
        return session === undefined || serverName === undefined ? { error: "the mcp-reconnect body must be JSON naming a non-empty session id and server name" } : { session, run: async () => await deps.mcpReconnect(session, serverName) };
      },
    },
    {
      name: "mcp-authenticate",
      path: "mcp-authenticate",
      read: (body) => {
        const session = bodyString(body, "session");
        const serverName = bodyString(body, "serverName");
        const redirectUri = bodyString(body, "redirectUri");
        return session === undefined || serverName === undefined || redirectUri === undefined ? { error: "the mcp-authenticate body must be JSON naming a non-empty session id, server name, and redirect URI" } : { session, run: async () => await deps.mcpAuthenticate(session, serverName, redirectUri) };
      },
    },
    {
      name: "mcp-oauth-callback-url",
      path: "mcp-oauth-callback-url",
      read: (body) => {
        const session = bodyString(body, "session");
        const serverName = bodyString(body, "serverName");
        const callbackUrl = bodyString(body, "callbackUrl");
        return session === undefined || serverName === undefined || callbackUrl === undefined ? { error: "the mcp-oauth-callback-url body must be JSON naming a non-empty session id, server name, and callback URL" } : { session, run: async () => await deps.mcpOAuthCallbackUrl(session, serverName, callbackUrl) };
      },
    },
  ];
  return (request, response) => {
    const presented = request.headers.authorization;
    const bearerPrefix = "bearer ".length;
    const token = typeof presented === "string" && presented.slice(0, bearerPrefix).toLowerCase() === "bearer " ? presented.slice(bearerPrefix) : undefined;
    if (token === undefined || !isLiveCapability(token, [deps.expectedToken])) {
      answerJson(response, HTTP_STATUS.unauthorized, { error: "the front door's control routes demand this generation's control token as a Bearer credential" } satisfies ControlErrorBody);
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const handle = async (): Promise<void> => {
      if (url.pathname === sessionsPath) {
        if (request.method !== "GET") {
          answerJson(response, HTTP_STATUS.methodNotAllowed, { error: "the session list is a GET" } satisfies ControlErrorBody);
          return;
        }
        answerJson(response, HTTP_STATUS.ok, { sessions: deps.list() });
        return;
      }
      if (url.pathname === statusPath || url.pathname === pendingPath) {
        if (request.method !== "GET") {
          answerJson(response, HTTP_STATUS.methodNotAllowed, { error: "the status and pending reads are GETs" } satisfies ControlErrorBody);
          return;
        }
        const session = url.searchParams.get("session") ?? undefined;
        // A named session that is not tracked is refused rather than answered as empty, so a mistyped id never reads as "observed, nothing pending".
        if (session !== undefined && !deps.statusOf(session).some((entry) => entry.id === session)) {
          answerJson(response, HTTP_STATUS.notFound, { error: rcSessionNotObservedMessage(session) } satisfies ControlErrorBody);
          return;
        }
        answerJson(response, HTTP_STATUS.ok, url.pathname === statusPath ? { statuses: deps.statusOf(session) } : { pending: deps.pendingOf(session) });
        return;
      }
      if (url.pathname === injectPath) {
        if (request.method !== "POST") {
          answerJson(response, HTTP_STATUS.methodNotAllowed, { error: "the inject operation is a POST" } satisfies ControlErrorBody);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(request));
        } catch {
          answerJson(response, HTTP_STATUS.badRequest, { error: "the inject body is not readable JSON within the control body cap" } satisfies ControlErrorBody);
          return;
        }
        if (typeof parsed !== "object" || parsed === null || !("session" in parsed) || !("text" in parsed) || typeof parsed.session !== "string" || typeof parsed.text !== "string" || parsed.session === "" || parsed.text === "") {
          answerJson(response, HTTP_STATUS.badRequest, { error: "the inject body must be JSON naming a non-empty session id and text" } satisfies ControlErrorBody);
          return;
        }
        const result = await deps.inject(parsed.session, parsed.text);
        if (result.ok) {
          answerJson(response, HTTP_STATUS.ok, { session: parsed.session, sequenceNums: result.sequenceNums });
          return;
        }
        answerJson(response, HTTP_STATUS.badGateway, { error: result.message } satisfies ControlErrorBody);
        return;
      }
      if (url.pathname === answerPath) {
        if (request.method !== "POST") {
          answerJson(response, HTTP_STATUS.methodNotAllowed, { error: "the answer operation is a POST" } satisfies ControlErrorBody);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(request));
        } catch {
          answerJson(response, HTTP_STATUS.badRequest, { error: "the answer body is not readable JSON within the control body cap" } satisfies ControlErrorBody);
          return;
        }
        if (typeof parsed !== "object" || parsed === null || !("session" in parsed) || !("request" in parsed) || !("approve" in parsed) || typeof parsed.session !== "string" || typeof parsed.request !== "string" || typeof parsed.approve !== "boolean" || parsed.session === "" || parsed.request === "") {
          answerJson(response, HTTP_STATUS.badRequest, { error: "the answer body must be JSON naming a non-empty session id, request id, and an approve boolean" } satisfies ControlErrorBody);
          return;
        }
        const text = "text" in parsed && typeof parsed.text === "string" ? parsed.text : undefined;
        // The protocol's allow result has no text field, so an approval with a message would silently drop it; refuse the combination rather than lose the caller's words.
        if (parsed.approve && text !== undefined && text !== "") {
          answerJson(response, HTTP_STATUS.badRequest, { error: "an approval carries no text (the protocol's allow result has no message field); text is the denial message" } satisfies ControlErrorBody);
          return;
        }
        const result = await deps.answer(parsed.session, parsed.request, { approve: parsed.approve, message: parsed.approve ? undefined : text });
        if (result.ok) {
          answerJson(response, HTTP_STATUS.ok, { session: parsed.session, request: parsed.request, sequenceNums: result.sequenceNums });
          return;
        }
        answerJson(response, HTTP_STATUS.badGateway, { error: result.message } satisfies ControlErrorBody);
        return;
      }
      for (const route of controlWrites) {
        if (url.pathname !== `${CONTROL_PATH_PREFIX}/${route.path}`) {
          continue;
        }
        if (request.method !== "POST") {
          answerJson(response, HTTP_STATUS.methodNotAllowed, { error: `the ${route.name} operation is a POST` } satisfies ControlErrorBody);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(request));
        } catch {
          answerJson(response, HTTP_STATUS.badRequest, { error: `the ${route.name} body is not readable JSON within the control body cap` } satisfies ControlErrorBody);
          return;
        }
        if (!isJsonObject(parsed)) {
          answerJson(response, HTTP_STATUS.badRequest, { error: `the ${route.name} body must be a JSON object` } satisfies ControlErrorBody);
          return;
        }
        const read = route.read(parsed);
        if ("error" in read) {
          answerJson(response, HTTP_STATUS.badRequest, { error: read.error } satisfies ControlErrorBody);
          return;
        }
        const result = await read.run();
        if (result.ok) {
          // The minted request id is named beside the sequence numbers because the worker's `control_response` echoes exactly it, and only the door ever knew it.
          answerJson(response, HTTP_STATUS.ok, { session: read.session, ...(result.requestId === undefined ? {} : { request: result.requestId }), sequenceNums: result.sequenceNums });
          return;
        }
        answerJson(response, HTTP_STATUS.badGateway, { error: result.message } satisfies ControlErrorBody);
        return;
      }
      answerJson(response, HTTP_STATUS.notFound, { error: `no such control route: ${url.pathname}` } satisfies ControlErrorBody);
    };
    handle().catch((error: unknown) => {
      answerJson(response, HTTP_STATUS.internalServerError, { error: `the control route failed: ${error instanceof Error ? error.message : String(error)}` } satisfies ControlErrorBody);
    });
  };
}

/** One answer from the door's control listener. */
export interface RcControlAnswer {
  readonly status: number;
  readonly body: string;
}

/** The one transport the control client needs, injected so the client runs against a local plain-HTTP server in tests and the door's real TLS listener in production. */
export interface RcControlTransport {
  readonly request: (options: { readonly method: "GET" | "POST"; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string }) => Promise<RcControlAnswer>;
}

/** The real transport: HTTPS to the door's provider listener on loopback, trusting only the CA file the door's own state names, so a process merely holding the port cannot answer as the door. */
export function realRcControlTransport(port: number, ca: string): RcControlTransport {
  return {
    request: async (options) =>
      await new Promise<RcControlAnswer>((resolve, reject) => {
        const request = https.request(
          {
            host: "127.0.0.1",
            port,
            method: options.method,
            path: options.path,
            headers: options.body === undefined ? options.headers : { ...options.headers, "content-length": String(Buffer.byteLength(options.body, "utf8")) },
            agent: false,
            ca: [ca],
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
            });
            response.on("end", () => {
              resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
            });
          },
        );
        request.once("error", reject);
        if (options.body === undefined) {
          request.end();
        } else {
          request.end(options.body);
        }
      }),
  };
}

/** The error message a control answer carried, when it carried one. */
function controlErrorOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    return body;
  }
  return undefined;
}

/** Whether one value is a session summary as this surface defines it, narrowed field by field rather than asserted. */
function isRcSessionSummary(value: unknown): value is RcSessionSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("id" in value) || !("createdAt" in value) || !("lastSeenAt" in value)) {
    return false;
  }
  return typeof value.id === "string" && typeof value.createdAt === "number" && typeof value.lastSeenAt === "number";
}

/** Whether one value is one worker fact as this surface defines it: the value and the instant of the exchange that carried it. */
function isRcWorkerFact(value: unknown, valueIs: (candidate: unknown) => boolean): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("value" in value) || !("observedAt" in value)) {
    return false;
  }
  return valueIs(value.value) && typeof value.observedAt === "number";
}

/** Whether one value is a session status as this surface defines it: a summary plus the worker facts and the pending list. The worker facts may be absent, since a door that observed none serialises no field for them. */
function isRcSessionStatus(value: unknown): value is RcSessionStatus {
  if (!isRcSessionSummary(value)) {
    return false;
  }
  if (!("pending" in value) || !Array.isArray(value.pending)) {
    return false;
  }
  if ("workerState" in value && value.workerState !== undefined && !isRcWorkerFact(value.workerState, (candidate) => typeof candidate === "string")) {
    return false;
  }
  if ("workerIdleSeconds" in value && value.workerIdleSeconds !== undefined && !isRcWorkerFact(value.workerIdleSeconds, (candidate) => typeof candidate === "number")) {
    return false;
  }
  return value.pending.every((candidate) => isRcPendingRequestSummary(candidate));
}

/** Whether one value is a pending control request as this surface defines it, narrowed field by field rather than asserted. */
function isRcPendingRequestSummary(value: unknown): value is RcPendingRequestSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("sessionId" in value) || !("requestId" in value) || !("type" in value) || !("summary" in value) || !("observedAt" in value)) {
    return false;
  }
  return typeof value.sessionId === "string" && typeof value.requestId === "string" && typeof value.type === "string" && typeof value.summary === "string" && typeof value.observedAt === "number";
}

/** Parses a JSON body's `sequenceNums` array, narrowed element by element, or undefined when the body names none. */
function sequenceNumsOfBody(body: string): readonly number[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("sequenceNums" in parsed) || !Array.isArray(parsed.sequenceNums)) {
    return undefined;
  }
  const sequenceNums: number[] = [];
  const values: readonly unknown[] = parsed.sequenceNums;
  for (const value of values) {
    if (typeof value !== "number") {
      return undefined;
    }
    sequenceNums.push(value);
  }
  return sequenceNums;
}

/** Parses a JSON body's `request` field, the minted request id a control write's answer names, when it carries one. */
function requestIdOfBody(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("request" in parsed)) {
    return undefined;
  }
  const value: unknown = parsed.request;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The door-facing client the `frontdoor rc` verbs use: the session list, the status and pending reads, the inject and answer operations, and the door's own control requests (interrupt, set-model, set-permission-mode, and the wider verb family: end-session, the usage and context queries, read-file, file-suggestions, keep-alive, and the mcp_* family), over the injected transport. */
export interface FrontDoorRcControl {
  /** The observed sessions, oldest-created first. Throws with the door's verbose reason when the list cannot be had. */
  readonly listSessions: () => Promise<readonly RcSessionSummary[]>;
  /** The observed sessions' status, oldest-created first and filtered to one when named. Throws with the door's verbose reason when the read cannot be had, including a named session the door has not observed. */
  readonly statusOf: (sessionId?: string) => Promise<readonly RcSessionStatus[]>;
  /** The control requests awaiting an answer, oldest-observed first and filtered to one session when named. Throws with the door's verbose reason when the read cannot be had. */
  readonly pendingOf: (sessionId?: string) => Promise<readonly RcPendingRequestSummary[]>;
  /** Injects one prompt, returning the sequence numbers the real service assigned or the verbose failure. */
  readonly sendPrompt: (sessionId: string, text: string) => Promise<RcEventWriteResult>;
  /** Answers one pending control request, returning the sequence numbers the real service assigned or the verbose failure. */
  readonly answerRequest: (sessionId: string, requestId: string, decision: RcAnswerDecision) => Promise<RcEventWriteResult>;
  /** Interrupts one session's running turn, returning the minted request id and the sequence numbers the real service assigned, or the verbose failure. */
  readonly interruptSession: (sessionId: string) => Promise<RcEventWriteResult>;
  /** Sets the model one session's subsequent turns use, returning the minted request id and the sequence numbers the real service assigned, or the verbose failure. */
  readonly setModel: (sessionId: string, model: string) => Promise<RcEventWriteResult>;
  /** Sets one session's permission mode, returning the minted request id and the sequence numbers the real service assigned, or the verbose failure. */
  readonly setPermissionMode: (sessionId: string, mode: RcPermissionMode) => Promise<RcEventWriteResult>;
  /** Ends one session, returning the minted request id and the sequence numbers the real service assigned, or the verbose failure. */
  readonly endSession: (sessionId: string, reason: string | undefined) => Promise<RcEventWriteResult>;
  /** Asks one session's worker for its structured usage, returning the minted request id (the id its `control_response` answer echoes) and the sequence numbers, or the verbose failure. */
  readonly getUsage: (sessionId: string, skipBehaviors: boolean | undefined) => Promise<RcEventWriteResult>;
  /** Asks one session's worker for its context-window breakdown, returning the minted request id and the sequence numbers, or the verbose failure. */
  readonly getContextUsage: (sessionId: string, detail: RcContextUsageDetail | undefined) => Promise<RcEventWriteResult>;
  /** Asks one session's worker to read one file, returning the minted request id and the sequence numbers, or the verbose failure. */
  readonly readFile: (sessionId: string, path: string, options: RcReadFileOptions | undefined) => Promise<RcEventWriteResult>;
  /** Asks one session's worker for its at-mention file suggestions, returning the minted request id and the sequence numbers, or the verbose failure. */
  readonly fileSuggestions: (sessionId: string, query: string) => Promise<RcEventWriteResult>;
  /** Sends one liveness heartbeat into a session, returning the sequence numbers the real service assigned or the verbose failure. */
  readonly keepAlive: (sessionId: string) => Promise<RcEventWriteResult>;
  /** Asks one session's worker for the status of its MCP server connections, returning the minted request id and the sequence numbers, or the verbose failure. */
  readonly mcpStatus: (sessionId: string) => Promise<RcEventWriteResult>;
  /** Asks one session's worker to reconnect one MCP server, returning the minted request id and the sequence numbers, or the verbose failure. */
  readonly mcpReconnect: (sessionId: string, serverName: string) => Promise<RcEventWriteResult>;
  /** Starts one MCP server's OAuth handshake on a session, returning the minted request id and the sequence numbers, or the verbose failure. */
  readonly mcpAuthenticate: (sessionId: string, serverName: string, redirectUri: string) => Promise<RcEventWriteResult>;
  /** Hands one MCP server's OAuth callback to a session's worker, returning the minted request id and the sequence numbers, or the verbose failure. */
  readonly mcpOAuthCallbackUrl: (sessionId: string, serverName: string, callbackUrl: string) => Promise<RcEventWriteResult>;
}

/** Builds the control client: every request presents the control token, and a non-2xx answer becomes the verbose message the door sent with it. */
export function frontDoorRcControl(transport: RcControlTransport, token: string): FrontDoorRcControl {
  const headers = { authorization: `Bearer ${token}` };
  const listAnswerOf = async (path: string, what: string): Promise<RcControlAnswer> => {
    try {
      return await transport.request({ method: "GET", path, headers });
    } catch (error) {
      throw new Error(`${what}: could not reach the front door's control listener: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  const sessionsOf = (answer: RcControlAnswer, what: string): readonly RcSessionSummary[] => {
    if (answer.status !== HTTP_STATUS.ok) {
      throw new Error(`${what} failed (HTTP ${String(answer.status)}): ${controlErrorOf(answer.body) ?? answer.body}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw new Error(`${what}: the door's answer was not JSON: ${answer.body}`);
    }
    if (typeof parsed !== "object" || parsed === null || !("sessions" in parsed) || !Array.isArray(parsed.sessions)) {
      throw new Error(`${what}: the door's answer named no sessions list: ${answer.body}`);
    }
    const candidates: readonly unknown[] = parsed.sessions;
    const sessions: RcSessionSummary[] = [];
    for (const value of candidates) {
      if (!isRcSessionSummary(value)) {
        throw new Error(`${what}: the door's answer named no sessions list: ${answer.body}`);
      }
      sessions.push(value);
    }
    return sessions;
  };
  const statusesOf = (answer: RcControlAnswer, what: string): readonly RcSessionStatus[] => {
    if (answer.status !== HTTP_STATUS.ok) {
      throw new Error(`${what} failed (HTTP ${String(answer.status)}): ${controlErrorOf(answer.body) ?? answer.body}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw new Error(`${what}: the door's answer was not JSON: ${answer.body}`);
    }
    if (typeof parsed !== "object" || parsed === null || !("statuses" in parsed) || !Array.isArray(parsed.statuses)) {
      throw new Error(`${what}: the door's answer named no status list: ${answer.body}`);
    }
    const statuses: RcSessionStatus[] = [];
    for (const value of parsed.statuses) {
      if (!isRcSessionStatus(value)) {
        throw new Error(`${what}: the door's answer named no status list: ${answer.body}`);
      }
      statuses.push(value);
    }
    return statuses;
  };
  const pendingOfAnswer = (answer: RcControlAnswer, what: string): readonly RcPendingRequestSummary[] => {
    if (answer.status !== HTTP_STATUS.ok) {
      throw new Error(`${what} failed (HTTP ${String(answer.status)}): ${controlErrorOf(answer.body) ?? answer.body}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw new Error(`${what}: the door's answer was not JSON: ${answer.body}`);
    }
    if (typeof parsed !== "object" || parsed === null || !("pending" in parsed) || !Array.isArray(parsed.pending)) {
      throw new Error(`${what}: the door's answer named no pending list: ${answer.body}`);
    }
    const pending: RcPendingRequestSummary[] = [];
    for (const value of parsed.pending) {
      if (!isRcPendingRequestSummary(value)) {
        throw new Error(`${what}: the door's answer named no pending list: ${answer.body}`);
      }
      pending.push(value);
    }
    return pending;
  };
  const writeOf = async (path: string, body: string, describeFailure: (status: number, message: string) => string): Promise<RcEventWriteResult> => {
    let answer: RcControlAnswer;
    try {
      answer = await transport.request({ method: "POST", path, headers: { ...headers, "content-type": "application/json" }, body });
    } catch (error) {
      return { ok: false, message: `could not reach the front door's control listener: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (answer.status === HTTP_STATUS.ok) {
      const sequenceNums = sequenceNumsOfBody(answer.body);
      if (sequenceNums === undefined) {
        return { ok: false, message: `the door accepted the event but its answer named no sequence numbers: ${answer.body}` };
      }
      const requestId = requestIdOfBody(answer.body);
      return requestId === undefined ? { ok: true, sequenceNums } : { ok: true, sequenceNums, requestId };
    }
    return { ok: false, message: describeFailure(answer.status, controlErrorOf(answer.body) ?? answer.body) };
  };
  const sessionQuery = (sessionId: string | undefined): string => (sessionId === undefined ? "" : `?session=${encodeURIComponent(sessionId)}`);
  return {
    listSessions: async () =>
      sessionsOf(await listAnswerOf(`${CONTROL_PATH_PREFIX}/sessions`, "listing the door's Remote Control sessions"), "listing the door's Remote Control sessions"),
    statusOf: async (sessionId) =>
      statusesOf(await listAnswerOf(`${CONTROL_PATH_PREFIX}/status${sessionQuery(sessionId)}`, "reading the door's Remote Control session status"), "reading the door's Remote Control session status"),
    pendingOf: async (sessionId) =>
      pendingOfAnswer(await listAnswerOf(`${CONTROL_PATH_PREFIX}/pending${sessionQuery(sessionId)}`, "listing the door's pending Remote Control control requests"), "listing the door's pending Remote Control control requests"),
    sendPrompt: async (sessionId, text) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/inject`, JSON.stringify({ session: sessionId, text }), (status, message) => `injecting into ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    answerRequest: async (sessionId, requestId, decision) =>
      await writeOf(
        `${CONTROL_PATH_PREFIX}/answer`,
        JSON.stringify({ session: sessionId, request: requestId, approve: decision.approve, ...(decision.approve || decision.message === undefined ? {} : { text: decision.message }) }),
        (status, message) => `answering control request ${requestId} on ${sessionId} failed (HTTP ${String(status)}): ${message}`,
      ),
    interruptSession: async (sessionId) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/interrupt`, JSON.stringify({ session: sessionId }), (status, message) => `interrupting ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    setModel: async (sessionId, model) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/set-model`, JSON.stringify({ session: sessionId, model }), (status, message) => `setting the model on ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    setPermissionMode: async (sessionId, mode) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/set-permission-mode`, JSON.stringify({ session: sessionId, mode }), (status, message) => `setting the permission mode on ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    endSession: async (sessionId, reason) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/end-session`, JSON.stringify({ session: sessionId, ...(reason === undefined ? {} : { reason }) }), (status, message) => `ending ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    getUsage: async (sessionId, skipBehaviors) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/get-usage`, JSON.stringify({ session: sessionId, ...(skipBehaviors === undefined ? {} : { skipBehaviors }) }), (status, message) => `requesting the usage of ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    getContextUsage: async (sessionId, detail) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/get-context-usage`, JSON.stringify({ session: sessionId, ...(detail === undefined ? {} : { detail }) }), (status, message) => `requesting the context usage of ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    readFile: async (sessionId, path, options) =>
      await writeOf(
        `${CONTROL_PATH_PREFIX}/read-file`,
        JSON.stringify({ session: sessionId, path, ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }), ...(options?.encoding === undefined ? {} : { encoding: options.encoding }) }),
        (status, message) => `reading ${path} from ${sessionId} failed (HTTP ${String(status)}): ${message}`,
      ),
    fileSuggestions: async (sessionId, query) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/file-suggestions`, JSON.stringify({ session: sessionId, query }), (status, message) => `requesting file suggestions from ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    keepAlive: async (sessionId) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/keep-alive`, JSON.stringify({ session: sessionId }), (status, message) => `keeping ${sessionId} alive failed (HTTP ${String(status)}): ${message}`),
    mcpStatus: async (sessionId) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/mcp-status`, JSON.stringify({ session: sessionId }), (status, message) => `requesting the MCP status of ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    mcpReconnect: async (sessionId, serverName) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/mcp-reconnect`, JSON.stringify({ session: sessionId, serverName }), (status, message) => `reconnecting MCP server ${serverName} on ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    mcpAuthenticate: async (sessionId, serverName, redirectUri) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/mcp-authenticate`, JSON.stringify({ session: sessionId, serverName, redirectUri }), (status, message) => `authenticating MCP server ${serverName} on ${sessionId} failed (HTTP ${String(status)}): ${message}`),
    mcpOAuthCallbackUrl: async (sessionId, serverName, callbackUrl) =>
      await writeOf(`${CONTROL_PATH_PREFIX}/mcp-oauth-callback-url`, JSON.stringify({ session: sessionId, serverName, callbackUrl }), (status, message) => `handing MCP server ${serverName}'s OAuth callback to ${sessionId} failed (HTTP ${String(status)}): ${message}`),
  };
}

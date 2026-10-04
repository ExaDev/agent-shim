import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";

import { HTTP_STATUS } from "../codex/http";
import { isLiveCapability } from "./capability";
import type { RcInjectResult, RcSessionSummary } from "./rcSessions";

/**
 * The Remote Control control surface: the small HTTP namespace the serving door answers on its provider listener, next to `/healthz`, through which `agent-shim frontdoor rc` lists the observed sessions and injects a prompt into one.
 *
 * This rides the listener `frontdoor status` already knows the door by (its address comes from the same state file, its trust anchor from the same CA path) rather than any second channel. The routes sit under one prefix the routed pipeline never serves, and every request must present the serving generation's control token as a Bearer credential: a fresh random value per door start, written owner-only under the front door's state directory so only this user's CLI can read it, and checked in constant time like every other capability the door accepts. An inject request is carried out by the door itself over its interception-proof dials, which is the whole point: the CLI never dials the API host directly, so nothing about the injection depends on the caller's own network path.
 */

/** The one path prefix every Remote Control control route sits under, answered before the routed pipeline like `/healthz` is. */
export const CONTROL_PATH_PREFIX = "/__agent-shim/rc";

/**
 * The largest control request body accepted: 10 MiB, the protocol's own documented cap on one event batch, so a control body holding a single user turn is bounded by the same protocol limit. Anything larger is not a control body, and refusing it keeps the door from buffering an unbounded prompt.
 */
const CONTROL_BODY_CAP_BYTES = 10_485_760;

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
  /** The inject operation, already wired to the tracker and the door's API-host dial. */
  readonly inject: (sessionId: string, text: string) => Promise<RcInjectResult>;
}

/** Writes one JSON answer: the status, the object, and the connection closed after it. */
function answerJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text, "utf8")) });
  response.end(text);
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
 * Builds the control handler the provider listener serves under `CONTROL_PATH_PREFIX`. Every route demands the generation's control token first, so nothing about the sessions (their ids, their timing, and most of all the prompts injected into them) is reachable by a process that did not read the owner-only token file.
 */
export function createRcControlHandler(deps: RcControlHandlerDeps): (request: IncomingMessage, response: ServerResponse) => void {
  const sessionsPath = `${CONTROL_PATH_PREFIX}/sessions`;
  const injectPath = `${CONTROL_PATH_PREFIX}/inject`;
  return (request, response) => {
    const presented = request.headers.authorization;
    const bearerPrefix = "bearer ".length;
    const token = typeof presented === "string" && presented.slice(0, bearerPrefix).toLowerCase() === "bearer " ? presented.slice(bearerPrefix) : undefined;
    if (token === undefined || !isLiveCapability(token, [deps.expectedToken])) {
      answerJson(response, HTTP_STATUS.unauthorized, { error: "the front door's control routes demand this generation's control token as a Bearer credential" } satisfies ControlErrorBody);
      return;
    }
    const url = request.url ?? "/";
    const handle = async (): Promise<void> => {
      if (url === sessionsPath) {
        if (request.method !== "GET") {
          answerJson(response, HTTP_STATUS.methodNotAllowed, { error: "the session list is a GET" } satisfies ControlErrorBody);
          return;
        }
        answerJson(response, HTTP_STATUS.ok, { sessions: deps.list() });
        return;
      }
      if (url === injectPath) {
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
      answerJson(response, HTTP_STATUS.notFound, { error: `no such control route: ${url}` } satisfies ControlErrorBody);
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

/** The door-facing client the `frontdoor rc` verbs use: the session list and the inject operation, over the injected transport. */
export interface FrontDoorRcControl {
  /** The observed sessions, oldest-created first. Throws with the door's verbose reason when the list cannot be had. */
  readonly listSessions: () => Promise<readonly RcSessionSummary[]>;
  /** Injects one prompt, returning the sequence numbers the real service assigned or the verbose failure. */
  readonly sendPrompt: (sessionId: string, text: string) => Promise<RcInjectResult>;
}

/** Builds the control client: every request presents the control token, and a non-2xx answer becomes the verbose message the door sent with it. */
export function frontDoorRcControl(transport: RcControlTransport, token: string): FrontDoorRcControl {
  const headers = { authorization: `Bearer ${token}` };
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
  return {
    listSessions: async () =>
      sessionsOf(await transport.request({ method: "GET", path: `${CONTROL_PATH_PREFIX}/sessions`, headers }), "listing the door's Remote Control sessions"),
    sendPrompt: async (sessionId, text) => {
      let answer: RcControlAnswer;
      try {
        answer = await transport.request({
          method: "POST",
          path: `${CONTROL_PATH_PREFIX}/inject`,
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ session: sessionId, text }),
        });
      } catch (error) {
        return { ok: false, message: `could not reach the front door's control listener: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (answer.status === HTTP_STATUS.ok) {
        const sequenceNums = sequenceNumsOfBody(answer.body);
        if (sequenceNums === undefined) {
          return { ok: false, message: `the door accepted the event but its answer named no sequence numbers: ${answer.body}` };
        }
        return { ok: true, sequenceNums };
      }
      return { ok: false, message: `injecting into ${sessionId} failed (HTTP ${String(answer.status)}): ${controlErrorOf(answer.body) ?? answer.body}` };
    },
  };
}

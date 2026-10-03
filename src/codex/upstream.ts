import { createHash } from "node:crypto";

import type { CodexAuthStore, CodexCredentials } from "./auth";
import { HTTP_STATUS } from "./http";
import type { ResponsesRequest } from "./translate";
import type { UpstreamFetch, UpstreamResponse } from "./upstreamPort";

/** ChatGPT's Codex Responses endpoint, the one the Codex CLI itself talks to. */
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/**
 * The ceiling on one whole upstream call, response body included. A call with no deadline wedges when it is handed a keep-alive socket the server already dropped: the write succeeds into a dead connection and no response ever arrives. Bounded, the wedge becomes a 502 and the pool discards the socket. Observed turns finish well inside this.
 */
const CODEX_UPSTREAM_TIMEOUT_MS = 300_000;

/**
 * The deadline for the response headers alone, after which the call is retried once on a fresh connection. Aborting makes the pool discard the suspect socket, so the retry reconnects; a stall before headers then costs one short hiccup instead of a failed turn. A retry can re-deliver a request that did reach the backend, doubling that turn's quota spend, which is preferable to losing the turn.
 */
const CODEX_HEADERS_TIMEOUT_MS = 15_000;

/** The timers the upstream call needs, injected so the headers deadline is testable without waiting for it. */
export interface UpstreamTimers {
  /** Runs `callback` after `ms` unless the returned cancel function is called first. */
  readonly after: (ms: number, callback: () => void) => () => void;
}

/** Real timers. */
export const realTimers: UpstreamTimers = {
  after: (ms, callback) => {
    const handle = setTimeout(callback, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

/**
 * One fetch with a deadline on its response headers, retried exactly once when that deadline (and not the caller's own signal) fired. The caller's signal still bounds the whole attempt, body included.
 */
export async function fetchUntilHeaders(fetch: UpstreamFetch, timers: UpstreamTimers, url: string, init: Parameters<UpstreamFetch>[1]): Promise<UpstreamResponse> {
  for (let attempt = 1; ; attempt += 1) {
    init.signal.throwIfAborted();
    const deadline = new AbortController();
    const cancel = timers.after(CODEX_HEADERS_TIMEOUT_MS, () => {
      deadline.abort();
    });
    try {
      return await fetch(url, { ...init, signal: AbortSignal.any([init.signal, deadline.signal]) });
    } catch (error) {
      // Only this attempt's own deadline aborts `deadline`, so its state says whether the deadline, rather than the caller, ended the attempt.
      if (deadline.signal.aborted && !init.signal.aborted && attempt === 1) {
        continue;
      }
      throw error;
    } finally {
      cancel();
    }
  }
}

/** The shape of a UUID: each `x` is filled with the next hex digit of the hash. */
const UUID_TEMPLATE = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";

/**
 * The `session_id` header for one request, derived from Claude Code's `metadata.user_id`, which is stable for one Claude Code session and differs between sessions. Hashing it gives each session its own stable, UUID-shaped id, so the backend sees one session per Claude Code session rather than one for the whole daemon's life, without the user id itself leaving the machine a second time. A request with no user id belongs to no session, so it gets a fresh id of its own.
 */
export function sessionIdFor(userId: string | undefined, randomId: () => string): string {
  if (userId === undefined || userId === "") {
    return randomId();
  }
  const hex = createHash("sha256").update(`agent-shim codex session\n${userId}`).digest("hex");
  let next = 0;
  return UUID_TEMPLATE.replace(/x/g, () => hex.charAt(next++));
}

/** Everything a call to the backend depends on. */
export interface CodexUpstreamPorts {
  readonly fetch: UpstreamFetch;
  readonly auth: CodexAuthStore;
  readonly timers: UpstreamTimers;
  readonly randomId: () => string;
  /** Overrides `CODEX_RESPONSES_URL`; tests and a local stand-in backend use it. */
  readonly url?: string;
}

function headersFor(credentials: CodexCredentials, sessionId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${credentials.accessToken}`,
    ...(credentials.accountId === undefined ? {} : { "chatgpt-account-id": credentials.accountId }),
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    session_id: sessionId,
  };
}

/**
 * Sends one translated request to the backend. A 401 refreshes the login once (through the auth store's single in-flight refresh) and resends; anything else is returned as it came. `signal` is the client's: aborting it (the client disconnected) aborts the upstream call, and `CODEX_UPSTREAM_TIMEOUT_MS` bounds it regardless.
 */
export async function callCodex(ports: CodexUpstreamPorts, request: ResponsesRequest, sessionId: string, signal: AbortSignal): Promise<UpstreamResponse> {
  const url = ports.url ?? CODEX_RESPONSES_URL;
  const body = JSON.stringify(request);
  const send = async (credentials: CodexCredentials): Promise<UpstreamResponse> =>
    await fetchUntilHeaders(ports.fetch, ports.timers, url, {
      method: "POST",
      headers: headersFor(credentials, sessionId),
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(CODEX_UPSTREAM_TIMEOUT_MS)]),
    });
  const credentials = await ports.auth.current();
  const first = await send(credentials);
  if (first.status !== HTTP_STATUS.unauthorized) {
    return first;
  }
  return await send(await ports.auth.refresh(credentials.accessToken));
}

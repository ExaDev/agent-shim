import { Agent, fetch } from "undici";

import type { UpstreamFetch } from "./upstreamPort";

/**
 * The longest a pooled upstream socket may sit idle before this side closes it. The backend's keep-alive hint can outlive the socket (the far end drops it silently), and undici's default lets the server's hint win, so an idle daemon's next call rode a dead socket and hung (the 2026-08-27 wedge). Capping both the default and the hint-derived timeout retires genuinely idle sockets while pooling still works through a burst of turns.
 */
export const CODEX_KEEP_ALIVE_CEILING_MS = 10_000;

/** An undici dispatcher whose idle keep-alive sockets are closed after `ceilingMs`, whatever the server's `Keep-Alive` header says. */
export function createUpstreamAgent(ceilingMs: number = CODEX_KEEP_ALIVE_CEILING_MS): Agent {
  return new Agent({ keepAliveTimeout: ceilingMs, keepAliveMaxTimeout: ceilingMs });
}

/** The real `UpstreamFetch`: undici's own `fetch` over `agent`, so the keep-alive ceiling applies to every upstream call. */
export function createUpstreamFetch(agent: Agent): UpstreamFetch {
  return async (url, init) => {
    const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, dispatcher: agent });
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: response.body,
      text: async () => await response.text(),
      json: async () => {
        const value: unknown = await response.json();
        return value;
      },
    };
  };
}

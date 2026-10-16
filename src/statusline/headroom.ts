import http from "node:http";

import { z } from "zod";

/**
 * How long one lookup may take. The statusline runs on every interaction, so a slow or wedged proxy must cost a bounded slice of a render and then lose the segment, never stall the line.
 */
const HEADROOM_TIMEOUT_MS = 500;

const HTTP_OK = 200;

/** What a session's savings segment shows, each figure absent when the proxy's row omits it. */
export interface HeadroomStats {
  readonly tokensSaved: number | undefined;
  readonly savingsPercent: number | undefined;
  readonly savingsUsd: number | undefined;
}

/** Where a headroom proxy can be reached: the unix socket agent-shim's supervisor keeps it on, or an http base URL for a proxy run on its own. */
export type HeadroomTarget = { readonly kind: "socket"; readonly socketPath: string } | { readonly kind: "http"; readonly baseUrl: string };

/** One `GET` against a target, answering the status and body text; rejects when the target cannot be reached in time. Injected so the lookup is testable without a daemon. */
export type HeadroomGet = (target: HeadroomTarget, requestPath: string, timeoutMs: number) => Promise<{ readonly status: number; readonly text: string }>;

/** One row of `GET /stats/sessions/<id>`: the savings the proxy attributes to that session. */
const SessionRowSchema = z.object({
  tokens_saved: z.number().nonnegative().optional(),
  savings_percent: z.number().nonnegative().optional(),
  compression_savings_usd: z.number().nonnegative().optional(),
});

/**
 * The session id the proxy knows this session by. Claude Code sends its own session id, which is the payload's `session_id` and what the proxy attributes under in preference to anything else; the launcher's `x-agent-shim-session` header is the fallback for a client whose payload carries none.
 */
export function headroomSessionIdOf(payload: unknown, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (typeof payload === "object" && payload !== null && "session_id" in payload && typeof payload.session_id === "string" && payload.session_id.trim() !== "") {
    return payload.session_id.trim();
  }
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator !== -1 && line.slice(0, separator).trim().toLowerCase() === "x-agent-shim-session" && line.slice(separator + 1).trim() !== "") {
      return line.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** The proxy to ask: an explicit `HEADROOM_PROXY_URL` names one run on its own and wins, otherwise the socket agent-shim's supervisor serves (already authenticated by the caller), otherwise none. */
export function headroomTargetOf(env: Readonly<Record<string, string | undefined>>, supervisedSocketPath: string | undefined): HeadroomTarget | undefined {
  const url = env.HEADROOM_PROXY_URL?.trim();
  if (url !== undefined && url !== "") {
    return { kind: "http", baseUrl: url.replace(/\/+$/, "") };
  }
  return supervisedSocketPath === undefined ? undefined : { kind: "socket", socketPath: supervisedSocketPath };
}

/**
 * Looks up one session's savings. Undefined whenever there is nothing to show: the proxy is unreachable or slow, does not know the session (one not routed through it), or answers something that is not a savings row. A statusline degrades by dropping the segment, so none of those is an error worth stopping the line for.
 */
export async function fetchHeadroomSessionStats(get: HeadroomGet, target: HeadroomTarget, sessionId: string): Promise<HeadroomStats | undefined> {
  let response;
  try {
    response = await get(target, `/stats/sessions/${encodeURIComponent(sessionId)}`, HEADROOM_TIMEOUT_MS);
  } catch {
    return undefined;
  }
  if (response.status !== HTTP_OK) {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(response.text);
  } catch {
    return undefined;
  }
  const row = SessionRowSchema.safeParse(body);
  if (!row.success) {
    return undefined;
  }
  const stats = { tokensSaved: row.data.tokens_saved, savingsPercent: row.data.savings_percent, savingsUsd: row.data.compression_savings_usd };
  return stats.tokensSaved === undefined && stats.savingsPercent === undefined && stats.savingsUsd === undefined ? undefined : stats;
}


/** The real transport: an http request over the unix socket for a supervised daemon, a plain fetch for a proxy named by URL. */
export const realHeadroomGet: HeadroomGet = async (target, requestPath, timeoutMs) => {
  if (target.kind === "http") {
    const response = await fetch(`${target.baseUrl}${requestPath}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, text: await response.text() };
  }
  return await new Promise((resolve, reject) => {
    const request = http.request({ socketPath: target.socketPath, path: requestPath, method: "GET", headers: { accept: "application/json", host: "localhost" }, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("headroom lookup timed out"));
    });
    request.on("error", reject);
    request.end();
  });
};

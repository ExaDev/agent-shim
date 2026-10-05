import type { CodexLogin } from "../config/schema";
import type { CodexAuthStore, CodexCredentials } from "./auth";
import { HTTP_STATUS } from "./http";
import type { CodexUpstreamPorts } from "./upstream";
import type { UpstreamFetch, UpstreamRequestInit, UpstreamResponse } from "./upstreamPort";

/**
 * Test doubles for the codex route's ports: canned upstream responses, a recording fetch, and a fixed-token auth store. Every token here is a made-up placeholder of no real format.
 */

/** Encodes events in the SSE wire format the backend uses, one chunk per event. */
function sseChunks(events: readonly unknown[]): Uint8Array[] {
  const encoder = new TextEncoder();
  return events.map((event) => encoder.encode(`event: message\ndata: ${JSON.stringify(event)}\n\n`));
}

async function* iterate(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

/** The first status past the 2xx range, where a Fetch API response stops being `ok`. */
const SUCCESS_STATUS_CEILING = 300;

/** A canned upstream response. */
export function fakeResponse(
  options: Readonly<{ status?: number; headers?: Readonly<Record<string, string>>; events?: readonly unknown[]; chunks?: readonly Uint8Array[]; text?: string }>,
): UpstreamResponse {
  const status = options.status ?? HTTP_STATUS.ok;
  const headers = new Map(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const chunks = options.chunks ?? (options.events === undefined ? undefined : sseChunks(options.events));
  return {
    status,
    ok: status >= HTTP_STATUS.ok && status < SUCCESS_STATUS_CEILING,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: chunks === undefined ? null : iterate(chunks),
    text: async () => await Promise.resolve(options.text ?? ""),
    json: async () => {
      const value: unknown = JSON.parse(options.text ?? "null");
      return await Promise.resolve(value);
    },
  };
}

/** The same upstream ports for every login, for tests that do not tell the logins apart. */
export function sameUpstreamForEveryLogin(upstream: CodexUpstreamPorts): Record<CodexLogin, CodexUpstreamPorts> {
  return { "codex-cli": upstream, "chatgpt-sign-in": upstream };
}

/** One recorded upstream call. */
export interface RecordedCall {
  readonly url: string;
  readonly init: UpstreamRequestInit;
}

/** A fetch that answers from `respond`, and every call it recorded. */
export function recordingFetch(respond: (call: RecordedCall, index: number) => UpstreamResponse | Promise<UpstreamResponse>): { readonly fetch: UpstreamFetch; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch = async (url: string, init: UpstreamRequestInit): Promise<UpstreamResponse> => {
    const call = { url, init };
    calls.push(call);
    return await respond(call, calls.length - 1);
  };
  return { fetch, calls };
}

/** A made-up access token. */
export const FAKE_ACCESS_TOKEN = "fake-access-token-one";
/** A made-up refreshed access token. */
export const FAKE_REFRESHED_ACCESS_TOKEN = "fake-access-token-two";

/** An auth store that hands out `FAKE_ACCESS_TOKEN` and, on refresh, `FAKE_REFRESHED_ACCESS_TOKEN`, recording what it was asked to refresh. */
export function fakeAuth(): CodexAuthStore & { readonly refreshed: string[] } {
  const refreshed: string[] = [];
  const credentials = (accessToken: string): CodexCredentials => ({ accessToken, accountId: "fake-account" });
  return {
    refreshed,
    current: async () => await Promise.resolve(credentials(FAKE_ACCESS_TOKEN)),
    refresh: async (rejected) => {
      refreshed.push(rejected);
      return await Promise.resolve(credentials(FAKE_REFRESHED_ACCESS_TOKEN));
    },
  };
}

/** Timers that never fire on their own; `fire` runs every pending callback, the way the headers deadline elapsing would. */
export function manualTimers(): { readonly after: (ms: number, callback: () => void) => () => void; readonly fire: () => void; readonly pending: () => number } {
  const callbacks = new Set<() => void>();
  return {
    after: (_ms, callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    fire: () => {
      const due = [...callbacks];
      callbacks.clear();
      for (const callback of due) {
        callback();
      }
    },
    pending: () => callbacks.size,
  };
}

/** Collects a route body, whole or streamed, into one string. */
export async function collectBody(body: string | AsyncIterable<string>): Promise<string> {
  if (typeof body === "string") {
    return body;
  }
  let text = "";
  for await (const chunk of body) {
    text += chunk;
  }
  return text;
}

/** Parses an Anthropic SSE stream into its events' names and data. */
export function parseAnthropicSse(text: string): { readonly event: string; readonly data: unknown }[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim() !== "")
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "";
      const data: unknown = JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "null");
      return { event, data };
    });
}

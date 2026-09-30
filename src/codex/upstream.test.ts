import { describe, expect, it } from "vitest";

import { parseSse } from "./events";
import { CODEX_RESPONSES_URL, callCodex, fetchUntilHeaders, sessionIdFor } from "./upstream";
import { fakeAuth, fakeResponse, manualTimers, recordingFetch } from "./testing";
import { HTTP_STATUS } from "./http";
import type { UpstreamRequestInit, UpstreamResponse } from "./upstreamPort";
import { resolveCodexConfig, translateRequest } from "./translate";

const INIT = { method: "POST", headers: {}, body: "{}" } satisfies Omit<UpstreamRequestInit, "signal">;
const SPLIT_INSIDE_CHARACTER = 12;

/** A fetch whose calls hang until their signal aborts, the way a request on a dead keep-alive socket does. */
function hangingUntilAborted(): (signal: AbortSignal) => Promise<UpstreamResponse> {
  return async (signal) =>
    await new Promise<UpstreamResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
}

describe("fetchUntilHeaders", () => {
  it("retries exactly once on a fresh attempt when the headers deadline fires", async () => {
    const timers = manualTimers();
    const hang = hangingUntilAborted();
    const fetch = recordingFetch(async (call, index) => (index === 0 ? await hang(call.init.signal) : fakeResponse({ events: [] })));
    const pending = fetchUntilHeaders(fetch.fetch, timers, "https://backend.example", { ...INIT, signal: new AbortController().signal });
    await Promise.resolve();
    timers.fire();
    const response = await pending;
    expect(response.status).toBe(HTTP_STATUS.ok);
    expect(fetch.calls).toHaveLength(2);
    expect(timers.pending()).toBe(0);
  });

  it("gives up after the one retry", async () => {
    const timers = manualTimers();
    const hang = hangingUntilAborted();
    const fetch = recordingFetch(async (call) => await hang(call.init.signal));
    const pending = fetchUntilHeaders(fetch.fetch, timers, "https://backend.example", { ...INIT, signal: new AbortController().signal });
    await Promise.resolve();
    timers.fire();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    timers.fire();
    await expect(pending).rejects.toThrow("aborted");
    expect(fetch.calls).toHaveLength(2);
  });

  it("does not retry when the caller aborted", async () => {
    const timers = manualTimers();
    const caller = new AbortController();
    const hang = hangingUntilAborted();
    const fetch = recordingFetch(async (call) => await hang(call.init.signal));
    const pending = fetchUntilHeaders(fetch.fetch, timers, "https://backend.example", { ...INIT, signal: caller.signal });
    await Promise.resolve();
    caller.abort();
    await expect(pending).rejects.toThrow();
    expect(fetch.calls).toHaveLength(1);
  });

  it("does not start at all for an already aborted caller", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetch = recordingFetch(() => fakeResponse({}));
    await expect(fetchUntilHeaders(fetch.fetch, manualTimers(), "https://backend.example", { ...INIT, signal: caller.signal })).rejects.toThrow();
    expect(fetch.calls).toEqual([]);
  });
});

describe("sessionIdFor", () => {
  it("is stable per user id, distinct between user ids, and UUID-shaped", () => {
    const a = sessionIdFor("user_1_session_a", () => "unused");
    expect(sessionIdFor("user_1_session_a", () => "unused")).toBe(a);
    expect(sessionIdFor("user_1_session_b", () => "unused")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  });

  it("falls back to a fresh id when there is no user id", () => {
    expect(sessionIdFor(undefined, () => "fresh")).toBe("fresh");
    expect(sessionIdFor("", () => "fresh")).toBe("fresh");
  });
});

describe("callCodex", () => {
  it("posts the translated request to the Codex endpoint", async () => {
    const fetch = recordingFetch(() => fakeResponse({ events: [] }));
    const { request } = translateRequest({ messages: [] }, resolveCodexConfig(undefined));
    await callCodex({ fetch: fetch.fetch, auth: fakeAuth(), timers: manualTimers(), randomId: () => "r" }, request, "sess", new AbortController().signal);
    expect(fetch.calls[0]?.url).toBe(CODEX_RESPONSES_URL);
    expect(fetch.calls[0]?.init.headers.session_id).toBe("sess");
    expect(JSON.parse(fetch.calls[0]?.init.body ?? "null")).toEqual(request);
  });
});

describe("parseSse", () => {
  async function* chunks(parts: readonly string[]): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder();
    for (const part of parts) {
      await Promise.resolve();
      yield encoder.encode(part);
    }
  }

  async function collect(parts: readonly string[]): Promise<unknown[]> {
    const events: unknown[] = [];
    for await (const event of parseSse(chunks(parts))) {
      events.push(event);
    }
    return events;
  }

  it("parses events split across chunk boundaries, CRLF line endings and multi-line data", async () => {
    expect(await collect(['event: a\r\ndata: {"n":', "1}\r\n\r\ndata: {", '\ndata: "n":2}\n\n'])).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("splits a multi-byte character across chunks without corrupting it", async () => {
    const encoded = new TextEncoder().encode(`data: {"t":"é"}\n\n`);
    async function* bytes(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      // Byte 12 falls inside the two-byte "é".
      yield encoded.slice(0, SPLIT_INSIDE_CHARACTER);
      yield encoded.slice(SPLIT_INSIDE_CHARACTER);
    }
    const events: unknown[] = [];
    for await (const event of parseSse(bytes())) {
      events.push(event);
    }
    expect(events).toEqual([{ t: "é" }]);
  });

  it("skips an event that is not JSON and keeps a well-formed unterminated tail", async () => {
    expect(await collect(["data: {bad\n\n", 'data: {"ok":true}\n\n', 'data: {"tail":1}'])).toEqual([{ ok: true }, { tail: 1 }]);
  });
});

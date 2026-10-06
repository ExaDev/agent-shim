import http from "node:http";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { RC_CLIENT_PATH, RC_CLIENT_PAGE_HTML, RC_CLIENT_PAGE_SCRIPT, createRcClientPage } from "./rcClientPage";
import { RC_ORPC_PATH_PREFIX, createRcApiNodeHandler } from "./rcApi";
import { createRcSessionTracker, RC_IDLE_EXPIRY_MS } from "./rcSessions";
import type { RcEventWriteResult } from "./rcWrites";
import { createFrontDoorServer } from "./server";

/** The token the mounted page accepts, standing in for the per-generation value the real door writes owner-only. */
const CONTROL_TOKEN = "unit-control-token";
/** The sequence numbers the recording write fakes answer with, so the assertions name what the page renders. */
const SEND_SEQUENCE_NUM = 41;
const ANSWER_SEQUENCE_NUM = 42;
/** The sketch cap and input length the bounded-sketch assertion uses. */
const SKETCH_CAP = 10;
const SKETCH_LONG_CHARS = 50;

/** A write the tests never expect to reach the real dial: the page's interrupt and steering calls resolve through it. */
const unexercised = async (): Promise<RcEventWriteResult> => await Promise.resolve({ ok: false, message: "this test drives no Remote Control write" });

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
}

/**
 * The shipped page script as a typed object. The object handed to `vm.createContext` is the context's own global backing, so the script's top-level declarations land on it as properties: the placeholder methods below are overwritten by the real ones when the script runs, and if the script ever stops defining one, calling it fails with the placeholder's own message instead of a silent pass. No `document` is provided, so the script's boot guard skips and nothing but the definitions runs.
 */
interface PageScript {
  /** The page's protocol call: one procedure, one input, resolving the output or rejecting with the door's message. */
  rpc: (path: string, input: Readonly<Record<string, unknown>> | undefined) => Promise<unknown>;
  /** The page's SSE parser over the buffered text of one stream read. */
  parseSseFrames: (buffer: string) => { readonly frames: readonly SseFrame[]; readonly rest: string };
  /** The page's dropped-events arithmetic over one source-tagged event. */
  sequenceGap: (tracker: Readonly<Record<string, number>>, event: Readonly<DoorEventLike>) => number;
  /** The page's headline rendering of one Remote Control stream event. */
  rcLine: (event: Readonly<{ session: string; envelope: Readonly<{ event_type: string; payload: unknown }> }>) => string;
  /** The page's bounded JSON sketch. */
  sketch: (value: unknown, cap: number) => string;
  /** The control token the page's calls present; the script's own `var token`, settable from the outside. */
  token: string;
}



/** Fails naming the definition the script was expected to provide, so a missing one is loud rather than a silent pass. */
function notDefined(name: string): never {
  throw new Error(`the page script did not define ${name}`);
}

/** Evaluates the shipped page script (the exact text the door serves, not a copy) and returns the very object its declarations landed on, placeholders already replaced. The object is annotated with the record intersection so `vm.createContext` takes it while the test reads it typed. */
function pageScript(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>, token: string, origin: string): PageScript {
  const sandbox: PageScript & Record<string, unknown> = {
    fetch: fetchImpl,
    window: { location: { origin, search: "" } },
    rpc: () => notDefined("rpc"),
    parseSseFrames: () => notDefined("parseSseFrames"),
    sequenceGap: () => notDefined("sequenceGap"),
    rcLine: () => notDefined("rcLine"),
    sketch: () => notDefined("sketch"),
    token: "",
  };
  vm.runInContext(RC_CLIENT_PAGE_SCRIPT, vm.createContext(sandbox));
  sandbox.token = token;
  return sandbox;
}

/** One SSE frame exactly as the door's event iterator writes it: the sequence as the id, the event wrapped in the protocol's json envelope. */
function doorFrame(sequence: number, source: string, payload: string): string {
  return `event: message\nid: ${String(sequence)}\ndata: {"json":{"source":"${source}","sequence":${String(sequence)},"payload":${payload}}}\n\n`;
}

/** The rc payload of a frame the door's own publishes produced, as its data field holds it. */
const RC_FRAME_PAYLOAD = '{"session":"cse_page","envelope":{"event_type":"assistant","sequence_num":9,"source":"worker"}}';

/** The error string the page gate's JSON refusal carries, narrowed by hand the way the control routes' own tests narrow theirs. */
function refusalMessageOf(body: unknown): string | undefined {
  return typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : undefined;
}

/** The error a page call rejects with, narrowed by the shape the page's own rpc() throws. */
function isPageError(value: unknown): value is { message: string; status: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("message" in value) || !("status" in value)) {
    return false;
  }
  return typeof value.message === "string" && typeof value.status === "number";
}

/** Runs the call expecting it to be refused, failing when it resolves instead. */
async function refusalOf(call: () => Promise<unknown>): Promise<{ message: string; status: number }> {
  try {
    await call();
  } catch (error: unknown) {
    if (isPageError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the page's call to be refused");
}

describe("the door's web client page behind the token gate", () => {
  let port: number;
  let close: (() => Promise<void>) | undefined;
  const served: string[] = [];

  // The real dispatch shape the door serves: the page's pre-pipeline surface on the listener, so the prefix matching, the gate and the served bytes all run as they do on a serving door (over plain HTTP here; the TLS path is the e2e suite's). The pipeline answers everything itself, so a request outside the page's prefix is observed rather than hung.
  beforeAll(async () => {
    const page = createRcClientPage(CONTROL_TOKEN);
    const server = createFrontDoorServer(
      async (request) => {
        request.response.writeHead(HTTP_STATUS.notFound, { "Content-Type": "text/plain" });
        request.response.end("no pipeline in this test");
        await Promise.resolve();
      },
      () => undefined,
      undefined,
      undefined,
      [{ ...page, handle: async (request, response) => { served.push(`${request.method ?? "?"} ${request.url ?? ""}`); return await page.handle(request, response); } }],
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected a bound TCP server");
    }
    port = address.port;
    close = async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    };
  });

  afterAll(async () => {
    await close?.();
  });

  it("refuses an unauthenticated fetch and one with the wrong token", async () => {
    const bare = await fetch(`http://127.0.0.1:${String(port)}${RC_CLIENT_PATH}`);
    expect(bare.status).toBe(HTTP_STATUS.unauthorized);
    const refusal: unknown = await bare.json();
    expect(refusalMessageOf(refusal)).toEqual(expect.stringContaining("control token"));

    const wrong = await fetch(`http://127.0.0.1:${String(port)}${RC_CLIENT_PATH}`, { headers: { authorization: "Bearer not-this-generation" } });
    expect(wrong.status).toBe(HTTP_STATUS.unauthorized);
  });

  it("serves the page to a Bearer credential and to the token query parameter, byte-identical to the shipped constant", async () => {
    const byHeader = await fetch(`http://127.0.0.1:${String(port)}${RC_CLIENT_PATH}`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    expect(byHeader.status).toBe(HTTP_STATUS.ok);
    expect(byHeader.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(byHeader.headers.get("cache-control")).toBe("no-store");
    expect(await byHeader.text()).toBe(RC_CLIENT_PAGE_HTML);

    const byQuery = await fetch(`http://127.0.0.1:${String(port)}${RC_CLIENT_PATH}?token=${encodeURIComponent(CONTROL_TOKEN)}`);
    expect(byQuery.status).toBe(HTTP_STATUS.ok);
    const page = await byQuery.text();
    expect(page).toBe(RC_CLIENT_PAGE_HTML);

    // The token rode the query and was never echoed, and the page carries no external resource of any kind, so nothing beyond the door's own origin is ever requested.
    expect(page).not.toContain(CONTROL_TOKEN);
    expect(page).not.toMatch(/src=|href=/);
  });

  it("answers HEAD with the page's headers and no body, refuses other methods, and 404s deeper paths", async () => {
    const head = await fetch(`http://127.0.0.1:${String(port)}${RC_CLIENT_PATH}`, { method: "HEAD", headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    expect(head.status).toBe(HTTP_STATUS.ok);
    expect(await head.text()).toBe("");

    const posted = await fetch(`http://127.0.0.1:${String(port)}${RC_CLIENT_PATH}`, { method: "POST", headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    expect(posted.status).toBe(HTTP_STATUS.methodNotAllowed);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");

    const deeper = await fetch(`http://127.0.0.1:${String(port)}${RC_CLIENT_PATH}/elsewhere`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    expect(deeper.status).toBe(HTTP_STATUS.notFound);

    // The trailing-slash spelling of the page serves the same page, so a pasted URL with it works unchanged.
    const slashed = await fetch(`http://127.0.0.1:${String(port)}${RC_CLIENT_PATH}/`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    expect(slashed.status).toBe(HTTP_STATUS.ok);
  });

  it("leaves paths outside its prefix to the listener, so the mount displaces nothing", async () => {
    served.length = 0;
    const outside = await fetch(`http://127.0.0.1:${String(port)}${RC_ORPC_PATH_PREFIX}/rc/list`, { method: "POST", headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ json: {} }) });
    expect(outside.status).toBe(HTTP_STATUS.notFound);
    expect(served).toEqual([]);
  });
});

describe("the page's script against the door's protocol", () => {
  let port: number;
  let close: (() => Promise<void>) | undefined;
  const writes: { readonly path: string; readonly body: string }[] = [];

  // The Remote Control router mounted the way the door mounts it, with the writes recorded so the page's own rpc() calls are observable end to end through the real node handler.
  beforeAll(async () => {
    const tracker = createRcSessionTracker({ now: () => Date.now(), idleMs: RC_IDLE_EXPIRY_MS });
    const api = createRcApiNodeHandler({
      expectedToken: CONTROL_TOKEN,
      list: tracker.list,
      statusOf: (sessionId?: string) => tracker.statusOf(sessionId),
      pendingOf: (sessionId?: string) => tracker.pendingOf(sessionId),
      inject: async (session, text) => {
        writes.push({ path: "inject", body: `${session}:${text}` });
        return await Promise.resolve({ ok: true, sequenceNums: [SEND_SEQUENCE_NUM] });
      },
      answer: async (session, request) => {
        writes.push({ path: "answer", body: `${session}:${request}` });
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
      fanout: { publish: () => undefined, subscribe: () => () => undefined },
    });
    const server = http.createServer((request, response) => {
      void api.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(undefined);
      });
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected a bound TCP server");
    }
    port = address.port;
    close = async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
        server.closeAllConnections();
      });
    };
  });

  afterAll(async () => {
    await close?.();
  });

  it("calls the door's procedures with the page's own rpc(), the shipped protocol shape", async () => {
    const page = pageScript(fetch, CONTROL_TOKEN, `http://127.0.0.1:${String(port)}`);

    expect(await page.rpc("rc/list", {})).toEqual({ sessions: [] });
    expect(await page.rpc("rc/status", {})).toEqual({ statuses: [] });
    expect(await page.rpc("rc/pending", {})).toEqual({ pending: [] });

    expect(await page.rpc("rc/send", { session: "cse_page", text: "run the tests" })).toEqual({ session: "cse_page", sequenceNums: [SEND_SEQUENCE_NUM] });
    expect(writes.at(-1)).toEqual({ path: "inject", body: "cse_page:run the tests" });

    expect(await page.rpc("rc/answer", { session: "cse_page", request: "req_page", approve: true })).toEqual({ session: "cse_page", request: "req_page", sequenceNums: [ANSWER_SEQUENCE_NUM] });
    expect(writes.at(-1)).toEqual({ path: "answer", body: "cse_page:req_page" });

    // The door's own refusals surface as the page surfaces them: the message, and the status the 401 path keys on.
    const notFound = await refusalOf(async () => {
      await page.rpc("rc/status", { session: "cse_missing" });
    });
    expect(notFound.status).toBe(HTTP_STATUS.notFound);
    expect(notFound.message).toContain("cse_missing");

    const unauthorized = await refusalOf(async () => {
      await pageScript(fetch, "not-this-generation", `http://127.0.0.1:${String(port)}`).rpc("rc/list", {});
    });
    expect(unauthorized.status).toBe(HTTP_STATUS.unauthorized);
    expect(unauthorized.message).toContain("control token");
  });

  it("parses the door's SSE frames, including the keepalive comment and a frame split across chunks", () => {
    const page = pageScript(fetch, CONTROL_TOKEN, "http://127.0.0.1:1");

    // The door's stream opens with a comment-only keepalive frame, which carries no data and must be dropped.
    expect(page.parseSseFrames(": \n\n")).toEqual({ frames: [], rest: "" });

    /** The backbone sequence of the frame the parser assertion reads back. */
    const FRAME_SEQUENCE = 3;

    const real = doorFrame(FRAME_SEQUENCE, "rc", RC_FRAME_PAYLOAD);
    expect(page.parseSseFrames(real)).toEqual({ frames: [{ event: "message", id: String(FRAME_SEQUENCE), data: `{"json":{"source":"rc","sequence":3,"payload":${RC_FRAME_PAYLOAD}}}` }], rest: "" });

    // A frame split mid-data by the transport leaves the partial in the rest, and the completed frame parses once its terminator arrives.
    const cut = real.indexOf("\"sequence_num\"");
    const first = page.parseSseFrames(real.slice(0, cut));
    expect(first.frames).toEqual([]);
    expect(first.rest).toBe(real.slice(0, cut));
    expect(page.parseSseFrames(first.rest + real.slice(cut)).frames[0]?.id).toBe(String(FRAME_SEQUENCE));

    // Two frames in one chunk parse as two, in order.
    expect(page.parseSseFrames(real + real).frames).toHaveLength(2);
  });

  it("surfaces dropped events by the per-source sequence and ignores numbers the door re-sends", () => {
    const page = pageScript(fetch, CONTROL_TOKEN, "http://127.0.0.1:1");
    /** The high-water the gap assertion jumps from; the jump to it reports the two events in between as dropped. */
    const HIGH_WATER = 5;

    const tracker: Record<string, number> = {};
    expect(page.sequenceGap(tracker, { source: "rc", sequence: 1 })).toBe(0);
    expect(page.sequenceGap(tracker, { source: "rc", sequence: 2 })).toBe(0);
    expect(page.sequenceGap(tracker, { source: "rc", sequence: HIGH_WATER })).toBe(2);
    // A re-sent number after a reconnect is a duplicate, not a step back, and never reports a negative gap.
    expect(page.sequenceGap(tracker, { source: "rc", sequence: HIGH_WATER })).toBe(0);
    expect(page.sequenceGap(tracker, { source: "rc", sequence: 2 })).toBe(0);
    expect(tracker.rc).toBe(HIGH_WATER);
    // Sources count independently, so a second source's first event is a beginning, not a gap.
    expect(page.sequenceGap(tracker, { source: "launch", sequence: 1 })).toBe(0);
  });

  it("renders assistant prose when the payload carries text blocks and a bounded sketch otherwise", () => {
    const page = pageScript(fetch, CONTROL_TOKEN, "http://127.0.0.1:1");

    const prose = page.rcLine({ session: "cse_00000000-0000-4000-8000-000000000000", envelope: { event_type: "assistant", payload: { content: [{ type: "text", text: "the tests pass" }, { type: "tool_use", id: "t" }, { type: "text", text: "again" }] } } });
    expect(prose).toContain("assistant");
    expect(prose).toContain("the tests pass again");
    expect(prose).toContain("cse_0000..0000");

    const bare = page.rcLine({ session: "cse_page", envelope: { event_type: "control_request", payload: { request_id: "req_page" } } });
    expect(bare).toContain("control_request");
    expect(bare).toContain("req_page");

    const empty = page.rcLine({ session: "cse_page", envelope: { event_type: "presence", payload: undefined } });
    expect(empty.endsWith("presence")).toBe(true);

    expect(page.sketch({ long: "x".repeat(SKETCH_LONG_CHARS) }, SKETCH_CAP)).toBe('{"long":"x...');
  });
});

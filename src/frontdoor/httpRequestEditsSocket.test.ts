import http from "node:http";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { admitLaunchToken, followsLaunchFlag } from "../test-helpers";
import { serveRouted } from "./pipeline";
import { editingHttpRequest } from "./httpRequestEdits";
import { bodyTooLargeMessage } from "./messagesBodyLimit";
import type * as scans from "./requestScan";
import { AUTH_HEADER, type FrontDoorRoute } from "./route";
import { createFrontDoorServer, listenFrontDoor } from "./server";

const TOKEN = "launch-token-for-tests";
/** The cap these tests run the door under, and the chunk the upload is written in: the upload is many chunks past the cap. */
const CAP_BYTES = 4096;
const CHUNK_BYTES = 65_536;
/** The upload is far past the socket buffers on both sides (each some hundreds of kibibytes), so a door that stops reading it either resets the client or stalls it. */
const CHUNKS_PAST_CAP = 512;

/** Every replay stream a head scan handed the route in this test: on the auto path the route reads that stream, not the connection's own. */
const replays: Readable[] = [];
vi.mock("./requestScan", async (importOriginal) => {
  const actual = await importOriginal<typeof scans>();
  return {
    ...actual,
    scanRequestHead: vi.fn(async (...args: Parameters<typeof scans.scanRequestHead>) => {
      const scan = await actual.scanRequestHead(...args);
      replays.push(scan.replayed.body);
      return scan;
    }),
  };
});

const servers: http.Server[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  replays.length = 0;
  await Promise.all(closers.splice(0).map(async (close) => { await close(); }));
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }));
});

/** Whether the request stream the route was handed, or the replay of it a head scan made, had been destroyed at the moment the route began its answer: a route that destroys the connection's own stream before it answers has no answer to give, whatever the client managed to read. (Once the answer is finished the server itself ends a refused connection, so the state afterwards says nothing about the route.) */
interface StreamState {
  readonly destroyedAtAnswer: boolean;
  /** Whether a scan's replay stream (which only the route's own code could destroy: the server ends the connection's stream itself once the answer is done) had been destroyed when the route returned. */
  readonly replayDestroyedAtReturn: boolean;
}

/** A door whose only route is the editing wrapper over a stand-in for the provider's route: the pipeline hands the wrapper the connection's own request stream, exactly as a request that reaches it unscanned would, so what the wrapper does to that stream is what the test sees. */
async function door(serverTools: "drop" | undefined, upstream: { readonly requests: () => void; readonly bytes?: (count: number) => void }, onAnswer: (state: StreamState) => void): Promise<string> {
  const stand: FrontDoorRoute = {
    name: "http:spark",
    headroomEligible: true,
    headroomUpstream: undefined,
    serve: async (served, response) => {
      upstream.requests();
      // The provider's own answer: it reads what it is sent, counts it and answers 200 when the body has ended.
      served.body.on("data", (chunk: Buffer) => {
        upstream.bytes?.(chunk.length);
      });
      await new Promise<void>((resolve) => {
        served.body.once("end", resolve);
        served.body.resume();
      });
      response.start(HTTP_STATUS.ok, { "Content-Type": "application/json" });
      await response.write("{}");
      response.end();
    },
  };
  const route = editingHttpRequest(stand, {
    provider: "spark",
    definition: { baseUrl: "http://127.0.0.1:1", ...(serverTools === undefined ? {} : { serverTools }) },
    served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
    credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
    droppedLogged: new Set<string>(),
    droppedLoggedLimit: 1,
    log: () => undefined,
    bodyLimitBytes: CAP_BYTES,
  });
  const observing: FrontDoorRoute = {
    ...route,
    serve: async (served, response) => {
      let atAnswer = false;
      await route.serve(served, {
        ...response,
        start: (status, headers) => {
          atAnswer = [served.body, ...replays].some((stream) => stream.destroyed);
          response.start(status, headers);
        },
      });
      onAnswer({ destroyedAtAnswer: atAnswer, replayDestroyedAtReturn: replays.some((stream) => stream.destroyed) });
    },
  };
  const server = createFrontDoorServer(
    async (pipelineRequest) => {
      await serveRouted(pipelineRequest, { resolveRoute: async () => await Promise.resolve({ ok: true, route: observing }), canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [], admit: admitLaunchToken(TOKEN), now: () => 0, log: () => undefined });
    },
    () => undefined,
  );
  const handle = await listenFrontDoor(server);
  closers.push(handle.close);
  return `http://127.0.0.1:${String(handle.port)}`;
}

interface Outcome {
  readonly status: number | undefined;
  readonly body: string;
  readonly reset: boolean;
}

/** Uploads a body of many chunks to the door over a real socket, as a client does, and reports what the client saw: the answer's status and body, whether the connection was reset before an answer arrived. */
async function upload(url: string, options: { readonly declareLength: boolean; readonly head: string }): Promise<Outcome> {
  const total = options.head.length + CHUNK_BYTES * CHUNKS_PAST_CAP;
  const request = http.request(`${url}/providers/spark/v1/messages`, { method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: TOKEN, ...(options.declareLength ? { "content-length": String(total) } : { "transfer-encoding": "chunked" }) } });
  let status: number | undefined;
  let body = "";
  let finished = false;
  const outcome = new Promise<Outcome>((resolve) => {
    const finish = (reset: boolean): void => {
      if (!finished) {
        finished = true;
        request.destroy();
        resolve({ status, body, reset: reset && status === undefined });
      }
    };
    request.on("response", (response) => {
      status = response.statusCode;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        finish(false);
      });
      response.on("error", () => {
        finish(true);
      });
    });
    request.on("error", () => {
      // After the answer has arrived the door closing the connection is expected; before it, it is the reset under test.
      finish(true);
    });
  });
  request.write(options.head);
  const chunk = " ".repeat(CHUNK_BYTES);
  let written = 0;
  const pump = (): void => {
    while (written < CHUNKS_PAST_CAP && !finished) {
      written += 1;
      if (!request.write(chunk)) {
        request.once("drain", pump);
        return;
      }
    }
    request.end();
  };
  pump();
  return await outcome;
}

describe("a Messages body past the cap the door reads whole", () => {
  it.each([
    ["chunked, with serverTools drop", "drop" as const, false, '{"model":"claude-sonnet-5-5","pad":"'],
    ["declared past the cap, with serverTools drop", "drop" as const, true, '{"model":"claude-sonnet-5-5","pad":"'],
    ["chunked, naming the model auto", undefined, false, '{"model":"auto","pad":"'],
    ["declared past the cap, naming the model auto", undefined, true, '{"model":"auto","pad":"'],
  ])("is answered 413 to the client, never reset, and the upload does not hang: %s", async (_label, serverTools, declareLength, head) => {
    let reached = 0;
    const observed: StreamState[] = [];
    const url = await door(serverTools, { requests: () => { reached += 1; } }, (state) => {
      observed.push(state);
    });
    const outcome = await upload(url, { declareLength, head });
    expect(outcome.reset).toBe(false);
    expect(outcome.status).toBe(HTTP_STATUS.payloadTooLarge);
    expect(outcome.body).toContain(JSON.stringify(bodyTooLargeMessage(CAP_BYTES, "spark")).slice(1, -1));
    expect(reached).toBe(0);
    // The route did not destroy the connection's own stream before answering.
    await vi.waitFor(() => {
      expect(observed).toHaveLength(1);
    });
    expect(observed[0]).toEqual({ destroyedAtAnswer: false, replayDestroyedAtReturn: false });
  });
});

describe("a Messages body past the cap whose head shows a model other than auto", () => {
  it.each([["chunked", false], ["declared past the cap", true]])("is forwarded without reading its remainder, byte for byte, never refused and never held whole: %s", async (_label, declareLength) => {
    let received = 0;
    const observed: StreamState[] = [];
    const url = await door(undefined, { requests: () => undefined, bytes: (count) => { received += count; } }, (state) => {
      observed.push(state);
    });
    const outcome = await upload(url, { declareLength, head: '{"model":"other-model","pad":"' });
    expect(outcome.reset).toBe(false);
    expect(outcome.status).toBe(HTTP_STATUS.ok);
    // The provider received every byte the client sent: the wrapper neither answered 413 nor stopped reading, and the whole-body cap (which a read of the body would have hit at once) never applied.
    expect(received).toBe('{"model":"other-model","pad":"'.length + CHUNK_BYTES * CHUNKS_PAST_CAP);
  });
});

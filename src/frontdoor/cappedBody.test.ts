import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { abandonBody, readCappedBody } from "./cappedBody";
import { editingHttpRequest } from "./httpRequestEdits";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";

const CAP = 64;
const CHUNK = 32;
const CHUNKS = 20;

/** A body of `CHUNKS` chunks that records how many it has handed out. */
function counted(): { readonly body: Readable; readonly handedOut: () => number } {
  let handed = 0;
  const body = new Readable({
    read() {
      if (handed >= CHUNKS) {
        this.push(null);
        return;
      }
      handed += 1;
      this.push(Buffer.alloc(CHUNK, "x"));
    },
  });
  return { body, handedOut: () => handed };
}

async function ended(body: Readable): Promise<void> {
  await new Promise<void>((resolve) => {
    if (body.readableEnded) {
      resolve();
      return;
    }
    body.once("end", resolve);
  });
}

describe("reading a request body under a cap", () => {
  it("reads a body within the cap whole", async () => {
    const read = await readCappedBody(Readable.from([Buffer.from("abc"), Buffer.from("def")]), CAP);
    expect(read.kind === "read" && read.bytes.toString()).toBe("abcdef");
  });

  it("accepts a body of exactly the cap and refuses one a byte over it", async () => {
    const exact = await readCappedBody(Readable.from([Buffer.alloc(CAP, "x")]), CAP);
    expect(exact.kind === "read" && exact.bytes.length).toBe(CAP);
    expect((await readCappedBody(Readable.from([Buffer.alloc(CAP, "x"), Buffer.from("y")]), CAP)).kind).toBe("too-large");
  });

  it("throws on a chunk that is not a Buffer, which is a defect of whoever built the stream", async () => {
    await expect(readCappedBody(Readable.from(["not a buffer"]), CAP)).rejects.toThrow("request body chunk was not a Buffer");
  });

  it("reports a body past the cap without destroying the stream, and abandoning it lets the rest flow away to its end", async () => {
    const { body, handedOut } = counted();
    expect((await readCappedBody(body, CAP)).kind).toBe("too-large");
    // Not destroyed: a stream still open is neither ended nor closed, which a destroyed one would be.
    expect(body.destroyed).toBe(false);
    abandonBody(body);
    await ended(body);
    expect(handedOut()).toBe(CHUNKS);
    expect(body.readableEnded).toBe(true);
  });
});

function recording(): { readonly response: RoutedResponse; readonly status: () => number | undefined; readonly headers: () => Readonly<Record<string, string>> } {
  let status: number | undefined;
  let headers: Readonly<Record<string, string>> = {};
  return {
    response: {
      headersSent: false,
      start: (code, sent) => {
        status = code;
        headers = sent;
      },
      flush: () => undefined,
      write: async () => {
        await Promise.resolve();
      },
      end: () => undefined,
      destroy: () => undefined,
    },
    status: () => status,
    headers: () => headers,
  };
}

function served(serverTools: "drop" | undefined): FrontDoorRoute {
  const inner: FrontDoorRoute = { name: "http:spark", headroomEligible: true, headroomUpstream: undefined, serve: async () => { await Promise.resolve(); } };
  return editingHttpRequest(inner, {
    provider: "spark",
    definition: { baseUrl: "http://127.0.0.1:1", ...(serverTools === undefined ? {} : { serverTools }) },
    served: undefined,
    credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
    droppedLogged: new Set<string>(),
    droppedLoggedLimit: 1,
    log: () => undefined,
    bodyLimitBytes: CAP,
  });
}

function requestOf(body: Readable, headers: Readonly<Record<string, string>> = {}): RoutedRequest {
  return { method: "POST", url: "/v1/messages", headers, body, signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined } };
}

describe("a Messages body refused as too large", () => {
  it.each([
    ["chunked, with serverTools drop", "drop" as const, "{\"model\":\"m\",\"pad\":\"", {}],
    ["chunked, naming the model auto", undefined, "{\"model\":\"auto\",\"pad\":\"", {}],
    ["declared past the cap, with serverTools drop", "drop" as const, "{\"model\":\"m\",\"pad\":\"", { "content-length": String(CAP * CHUNKS) }],
    ["declared past the cap, naming the model auto", undefined, "{\"model\":\"auto\",\"pad\":\"", { "content-length": String(CAP * CHUNKS) }],
  ])("gets a 413, and its stream is neither destroyed nor left undrained: %s", async (_label, serverTools, head, headers) => {
    const source = counted();
    const lead = Readable.from([Buffer.from(head)]);
    const body = Readable.from((async function* () {
      for await (const chunk of lead) {
        yield chunk as Buffer;
      }
      for await (const chunk of source.body) {
        yield chunk as Buffer;
      }
    })());
    const answered = recording();
    await served(serverTools).serve(requestOf(body, headers), answered.response);
    expect(answered.status()).toBe(HTTP_STATUS.payloadTooLarge);
    await ended(body);
    // Drained to its natural end: a destroyed stream never ends, so its remaining chunks would not have been handed out.
    expect(body.readableEnded).toBe(true);
    expect(source.handedOut()).toBe(CHUNKS);
  });
});

import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SIZES_BYTES, bodyOf, copiesDuring } from "./copyCounting";
import { editingHttpRequest } from "./httpRequestEdits";
import { MESSAGES_BODY_LIMIT_BYTES } from "./messagesBodyLimit";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";

const silent: RoutedResponse = { headersSent: false, start: () => undefined, flush: () => undefined, write: async () => { await Promise.resolve(); }, end: () => undefined, destroy: () => undefined };

/** The chunks the wrapper hands the route it wraps: left as they are, since joining or decoding them here would be a copy of the body the wrapper did not make. */
async function serveWithDrop(chunks: readonly Buffer[]): Promise<readonly Buffer[]> {
  const received: Buffer[] = [];
  const inner: FrontDoorRoute = {
    name: "http:spark",
    headroomEligible: true,
    headroomUpstream: undefined,
    serve: async (served) => {
      for await (const chunk of served.body) {
        if (Buffer.isBuffer(chunk)) received.push(chunk);
      }
    },
  };
  const route = editingHttpRequest(inner, {
    provider: "spark",
    definition: { baseUrl: "http://127.0.0.1:1", serverTools: "drop" },
    served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
    credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
    droppedLogged: new Set<string>(),
    droppedLoggedLimit: 1,
    log: () => undefined,
    bodyLimitBytes: MESSAGES_BODY_LIMIT_BYTES,
  });
  const request: RoutedRequest = { method: "POST", url: "/v1/messages", headers: {}, body: Readable.from(chunks), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined } };
  await route.serve(request, silent);
  return received;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A request that names a model and has tools to drop is the same cost as one that names `auto`: the read of the body and its one-byte-per-character view, and the edited body streamed as the slices of them, at every size. */
describe("the copies of a body the editing wrapper makes for a named model with serverTools drop", () => {
  it("are the read and the view and nothing for the removal, at every body size, and the body that reaches the route has the server tool gone", async () => {
    for (const size of SIZES_BYTES) {
      const chunks = bodyOf(size, "named-model");
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      let forwarded: readonly Buffer[] = [];
      const counts = await copiesDuring(total, async () => {
        forwarded = await serveWithDrop(chunks);
      });
      expect(counts).toEqual({ concat: 1, decode: 1, from: 0 });
      expect(Buffer.concat(forwarded).toString("latin1")).toBe(Buffer.concat(chunks).toString("latin1").replace('{"type":"web_search_20250305","name":"web_search"},', ""));
    }
  });
});

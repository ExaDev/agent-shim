import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { SIZES_BYTES, bodyOf, copiesDuring } from "./copyCounting";
import { editingHttpRequest } from "./httpRequestEdits";
import { withModel, withModelInHead } from "./mainLoopRoute";
import { MESSAGES_BODY_LIMIT_BYTES } from "./messagesBodyLimit";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";

const silent: RoutedResponse = { headersSent: false, start: () => undefined, flush: () => undefined, write: async () => { await Promise.resolve(); }, end: () => undefined, destroy: () => undefined };
const END_TO_END_TIMEOUT_MS = 60_000;

/** The route the wrapper serves with, which reads the whole of what it is handed, and the request the test sends it. */
async function serveWith(chunks: readonly Buffer[]): Promise<void> {
  const inner: FrontDoorRoute = {
    name: "http:spark",
    headroomEligible: true,
    headroomUpstream: undefined,
    serve: async (served) => {
      for await (const chunk of served.body) {
        expect(Buffer.isBuffer(chunk)).toBe(true);
      }
    },
  };
  const route = editingHttpRequest(inner, {
    provider: "spark",
    definition: { baseUrl: "http://127.0.0.1:1" },
    served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
    credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
    log: () => undefined,
    bodyLimitBytes: MESSAGES_BODY_LIMIT_BYTES,
  });
  const request: RoutedRequest = { method: "POST", url: "/v1/messages", headers: {}, body: Readable.from(chunks), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined } };
  await route.serve(request, silent);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The copies of a body the wrapper makes however large it is: the read joins its chunks once, and its view one byte per character, which every walk of it is in, is decoded once. Editing never adds a copy: the edited body is streamed as slices of the one read. */
const WRAPPER_COPIES = { concat: 1, decode: 1, from: 0 };

/** What a body costs the editing wrapper is the number of times it is copied, which does not depend on its size: counted at two sizes, never timed. */
describe("the copies of a body the editing wrapper makes", () => {
  it("is the same at every body size: the read of it and its one-byte-per-character view, and no copy for an edit", async () => {
    const counted = [];
    for (const size of SIZES_BYTES) {
      const chunks = bodyOf(size);
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      counted.push(await copiesDuring(total, async () => {
        await serveWith(chunks);
      }));
    }
    expect(counted).toEqual(SIZES_BYTES.map(() => WRAPPER_COPIES));
  });
});

/** The whole door, resolver and wrapper, over a request that names `auto` and over one that passes a qualified model name through: the model `auto` costs the one read and the one view the wrapper makes, whatever the body size. */
describe("the copies of a body a request for spark/auto costs the door beyond one for a named model", () => {
  it("are those of the wrapper, at every body size", async () => {
    const { startWorld, send } = await import("./mainLoopRouteTestWorld");
    const { mainLoopRoutesOfLiveSessions } = await import("../test-helpers");
    const world = await startWorld(mainLoopRoutesOfLiveSessions());
    world.setProvider("spark", { displayName: "spark", baseUrl: `http://127.0.0.1:${String(world.upstreamPort)}`, credential: { sources: [{ literal: "t" }] }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "spark-main" } });
    const copiesOf = async (model: string, size: number): Promise<Awaited<ReturnType<typeof copiesDuring>>> => {
      const rawBody = `{"model":${JSON.stringify(model)},"max_tokens":16,"stream":false,"messages":[{"role":"user","content":"${"x".repeat(size)}"}]}`;
      return await copiesDuring(rawBody.length, async () => {
        expect((await send(world, { model, requestClass: "main", rawBody })).status).toBe(HTTP_STATUS.ok);
      });
    };
    try {
      for (const size of SIZES_BYTES) {
        const named = await copiesOf("spark/spark-x", size);
        const auto = await copiesOf("spark/auto", size);
        expect({ concat: auto.concat - named.concat, decode: auto.decode - named.decode, from: auto.from - named.from }).toEqual(WRAPPER_COPIES);
      }
    } finally {
      await world.close();
    }
  }, END_TO_END_TIMEOUT_MS);
});

/** The rewrite of a model field in a body the resolver's whole-body scan read: streamed as three slices of the bytes it holds, so the rewrite costs no copy of the body whatever its size. */
describe("the copies of a body the resolver's rewrite of a model name makes", () => {
  it("are none, at every body size, and the rewritten body is the original with the one field changed", async () => {
    for (const size of SIZES_BYTES) {
      const bytes = Buffer.concat(bodyOf(size));
      const request: RoutedRequest = { method: "POST", url: "/v1/messages", headers: {}, body: Readable.from([bytes]), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined } };
      const seen: Buffer[] = [];
      const counted = await copiesDuring(bytes.length, async () => {
        for await (const chunk of withModel(request, bytes, "auto", "served").body) {
          if (Buffer.isBuffer(chunk)) seen.push(chunk);
        }
      });
      expect(counted).toEqual({ concat: 0, decode: 1, from: 0 });
      expect(Buffer.concat(seen).toString("latin1")).toBe(bytes.toString("latin1").replace('"model":"auto"', '"model":"served"'));
    }
  });
});

/**
 * The rewrite of a model field in the head of a body (the head the resolver's scan read, the rest streaming on): a head that does not spell the name is passed on as it came, and one that does is joined once from its slices. Counted at two sizes, with the head as long as the body.
 */
describe("the copies of a body the rewrite of a model name in its head makes", () => {
  const rewriteCopies = async (size: number, from: string): Promise<{ readonly counts: Awaited<ReturnType<typeof copiesDuring>>; readonly text: string }> => {
    // The head arrives as one chunk, as the head of a request does (it is bounded by the scan's cap): the rewrite is then the only thing that copies it.
    const bytes = Buffer.concat(bodyOf(size));
    const request: RoutedRequest = { method: "POST", url: "/v1/messages", headers: {}, body: Readable.from([bytes]), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: undefined, headroom: false, projectId: undefined } };
    const seen: Buffer[] = [];
    const counts = await copiesDuring(bytes.length, async () => {
      for await (const chunk of withModelInHead(request, bytes.length, from, "served").body) {
        if (Buffer.isBuffer(chunk)) seen.push(chunk);
      }
    });
    return { counts, text: Buffer.concat(seen).toString("latin1") };
  };

  it("is the same at every size, and a head that spells the name costs one join more than one that does not, which is passed on as it came", async () => {
    const unchanged: Awaited<ReturnType<typeof copiesDuring>>[] = [];
    const changed: Awaited<ReturnType<typeof copiesDuring>>[] = [];
    for (const size of SIZES_BYTES) {
      const kept = await rewriteCopies(size, "another-name");
      const rewritten = await rewriteCopies(size, "auto");
      expect(kept.text).toBe(Buffer.concat(bodyOf(size)).toString("latin1"));
      expect(rewritten.text).toBe(Buffer.concat(bodyOf(size)).toString("latin1").replace('"model":"auto"', '"model":"served"'));
      unchanged.push(kept.counts);
      changed.push(rewritten.counts);
    }
    expect(unchanged.every((counts) => counts.concat === unchanged[0]?.concat && counts.decode === 1 && counts.from === 0)).toBe(true);
    expect(changed.every((counts, at) => counts.concat === (unchanged[at]?.concat ?? 0) + 1 && counts.decode === 1 && counts.from === 0)).toBe(true);
  });
});

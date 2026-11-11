import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { editingHttpRequest } from "./httpRequestEdits";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";

const LIMIT = 64;
const JSON_HEADERS = { "Content-Type": "application/json" };

function request(body: string, headers: RoutedRequest["headers"]): RoutedRequest {
  return { method: "POST", url: "/v1/messages", headers, body: Readable.from([Buffer.from(body)]), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: "spark", headroom: false, projectId: undefined } };
}

/** What a wrapped route's own answer carried, or what it handed the inner route: the headers and the bytes of the request it forwarded. */
interface Outcome {
  readonly forwarded: { readonly headers: RoutedRequest["headers"]; readonly body: string } | undefined;
  readonly status: number | undefined;
  readonly answerHeaders: Readonly<Record<string, string>> | undefined;
}

async function through(body: string, headers: RoutedRequest["headers"], serverTools: "drop" | undefined): Promise<Outcome> {
  let forwarded: Outcome["forwarded"];
  let status: number | undefined;
  let answerHeaders: Readonly<Record<string, string>> | undefined;
  const inner: FrontDoorRoute = {
    name: "http:spark",
    headroomEligible: true,
    headroomUpstream: undefined,
    serve: async (served) => {
      const chunks: Buffer[] = [];
      for await (const chunk of served.body) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      forwarded = { headers: served.headers, body: Buffer.concat(chunks).toString("utf8") };
    },
  };
  const route = editingHttpRequest(inner, {
    provider: "spark",
    definition: { baseUrl: "http://127.0.0.1:1", ...(serverTools === undefined ? {} : { serverTools }) },
    served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
    credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
    droppedLogged: new Set<string>(),
    droppedLoggedLimit: 1,
    log: () => undefined,
    bodyLimitBytes: LIMIT,
  });
  const response: RoutedResponse = {
    headersSent: false,
    start: (code, sent) => {
      status = code;
      answerHeaders = sent;
    },
    flush: () => undefined,
    write: async () => {
      await Promise.resolve();
    },
    end: () => undefined,
    destroy: () => undefined,
  };
  await route.serve(request(body, headers), response);
  return { forwarded, status, answerHeaders };
}

const framed = (body: string): RoutedRequest["headers"] => ({ "content-length": String(Buffer.byteLength(body)) });

describe("the framing of a request the wrapper forwards", () => {
  it("keeps the declared length of a request it did not change", async () => {
    const body = '{"max_tokens":1}';
    const outcome = await through(body, framed(body), undefined);
    expect(outcome.forwarded?.body).toBe(body);
    expect(outcome.forwarded?.headers["content-length"]).toBe(String(body.length));
  });

  it("drops the declared length of a request whose model it rewrote, since the body changed length", async () => {
    const body = '{"model":"auto"}';
    const outcome = await through(body, framed(body), undefined);
    expect(outcome.forwarded?.body).toBe('{"model":"served"}');
    expect(outcome.forwarded?.headers).not.toHaveProperty("content-length");
  });

  it("keeps the declared length under drop when no tool is removed, and drops it when one is", async () => {
    const kept = '{"model":"m","tools":[{"name":"t","input_schema":{}}]}';
    const unchanged = await through(kept, framed(kept), "drop");
    expect(unchanged.forwarded?.body).toBe(kept);
    expect(unchanged.forwarded?.headers["content-length"]).toBe(String(kept.length));
    const dropping = '{"model":"m","tools":[{"type":"web_search_20250305"}]}';
    const edited = await through(dropping, framed(dropping), "drop");
    expect(edited.forwarded?.body).toBe('{"model":"m"}');
    expect(edited.forwarded?.headers).not.toHaveProperty("content-length");
  });
});

describe("the wrapper's own refusals", () => {
  it.each([
    ["a body past the limit", `{"model":"auto","pad":"${"x".repeat(LIMIT)}"}`, HTTP_STATUS.payloadTooLarge],
    ["a body that names auto twice", '{"model":"auto","model":"auto"}', HTTP_STATUS.badRequest],
  ])("answers %s as JSON", async (_label, body, status) => {
    const outcome = await through(body, {}, undefined);
    expect(outcome.status).toBe(status);
    expect(outcome.answerHeaders).toEqual(JSON_HEADERS);
    expect(outcome.forwarded).toBeUndefined();
  });
});

import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { HELD_ANSWER_LIMIT_BYTES, editingHttpRequest } from "./httpRequestEdits";
import { MAX_LOGGED_TEXT_CHARS, quotedForLog } from "./loggedText";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";

const KIB = 1024;
/** Past the 64 KiB bound on an error answer held back to read what it says. */
const PAST_HELD_BOUND_KIB = 80;
const PAST_THE_HELD_BOUND_BYTES = PAST_HELD_BOUND_KIB * KIB;

const LIMIT = 64;


function request(body: string, extra: { readonly headers?: RoutedRequest["headers"]; readonly session?: string; readonly stream?: Readable } = {}): RoutedRequest {
  return { method: "POST", url: "/v1/messages", headers: extra.headers ?? {}, body: extra.stream ?? Readable.from([Buffer.from(body)]), signal: new AbortController().signal, session: { identity: undefined, sessionId: extra.session ?? "s", provider: "spark", headroom: false, projectId: undefined } };
}

function recordingResponse(): { readonly response: RoutedResponse; readonly status: () => number | undefined; readonly text: () => string } {
  let status: number | undefined;
  const chunks: Buffer[] = [];
  const response: RoutedResponse = {
    headersSent: false,
    start: (code) => {
      status = code;
    },
    flush: () => undefined,
    write: async (chunk) => {
      chunks.push(Buffer.from(chunk));
      await Promise.resolve();
    },
    end: () => undefined,
    destroy: () => undefined,
  };
  return { response, status: () => status, text: () => Buffer.concat(chunks).toString("utf8") };
}

function wrapped(withServedModel = true): { readonly route: FrontDoorRoute; readonly served: () => number } {
  let served = 0;
  const inner: FrontDoorRoute = {
    name: "http:spark",
    headroomEligible: true,
    headroomUpstream: undefined,
    serve: async () => {
      served += 1;
      await Promise.resolve();
    },
  };
  const route = editingHttpRequest(inner, {
    provider: "spark",
    definition: { baseUrl: "http://127.0.0.1:1" },
    served: withServedModel ? { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) } : undefined,
    credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
    log: () => undefined,
    bodyLimitBytes: LIMIT,
  });
  return { route, served: () => served };
}

describe("a body read whole to be edited", () => {
  it("is refused with a 413 past the limit, and never forwarded", async () => {
    const { route, served } = wrapped();
    const recorded = recordingResponse();
    await route.serve(request(`{"model":"auto","pad":"${"x".repeat(LIMIT)}"}`), recorded.response);
    expect(recorded.status()).toBe(HTTP_STATUS.payloadTooLarge);
    expect(recorded.text()).toContain(String(LIMIT));
    expect(served()).toBe(0);
  });

  it("is forwarded within the limit", async () => {
    const { route, served } = wrapped();
    await route.serve(request('{"model":"auto"}'), recordingResponse().response);
    expect(served()).toBe(1);
  });

  it("is refused with a 413 from a declared Content-Length over the limit, though what arrived is within it", async () => {
    const { route, served } = wrapped();
    const recorded = recordingResponse();
    await route.serve(request('{"model":"auto"}', { headers: { "content-length": String(LIMIT + 1) } }), recorded.response);
    expect(recorded.status()).toBe(HTTP_STATUS.payloadTooLarge);
    expect(served()).toBe(0);
  });
});

describe("a body with the model auto named twice at its top level", () => {
  it("is refused with a 400 naming the problem and never forwarded", async () => {
    const { route, served } = wrapped();
    const recorded = recordingResponse();
    await route.serve(request('{"model":"auto","model":"other"}'), recorded.response);
    expect(recorded.status()).toBe(HTTP_STATUS.badRequest);
    expect(recorded.text()).toContain("more than one top-level model");
    expect(served()).toBe(0);
  });
});

describe("a body that names the model more than once", () => {
  it("is refused with a 400 when its first field names auto, and forwarded as it came when its first field names another model, whatever follows", async () => {
    const refused = wrapped();
    const recorded = recordingResponse();
    await refused.route.serve(request('{"model":"auto","pad":1,"model":"x"}'), recorded.response);
    expect(recorded.status()).toBe(HTTP_STATUS.badRequest);
    expect(refused.served()).toBe(0);
    for (const body of ['{"model":"x","pad":1,"model":"auto"}', '{"model":"x","model":"y"}']) {
      const forwarded = wrapped();
      await forwarded.route.serve(request(body), recordingResponse().response);
      expect(forwarded.served()).toBe(1);
    }
  });
});

describe("which model field of a body that names the model more than once the door goes by", () => {
  it.each([
    ["its first two fields both name auto", '{"model":"auto","model":"auto"}', true],
    ["its first field names auto and a later one names auto again after another model", '{"model":"auto","model":"x","model":"auto"}', true],
    ["a later field names auto after another model", '{"model":"x","model":"auto"}', false],
    ["two later fields name auto after another model", '{"model":"x","model":"auto","model":"auto"}', false],
  ])("is decided by the first field, under every setting: %s", async (_label, body, refused) => {
    const { route, served } = wrapped();
    const recorded = recordingResponse();
    await route.serve(request(body), recorded.response);
    expect(recorded.status() === HTTP_STATUS.badRequest).toBe(refused);
    expect(recorded.text().includes("more than one top-level model")).toBe(refused);
    expect(served()).toBe(refused ? 0 : 1);
  });
});

describe("a declared length of exactly the limit", () => {
  it("is accepted, as a body of exactly the limit is, and one byte over is refused", async () => {
    const exact = `{"model":"auto","pad":"${"x".repeat(LIMIT - '{"model":"auto","pad":""}'.length)}"}`;
    expect(exact).toHaveLength(LIMIT);
    for (const serverTools of [undefined] as const) {
      const accepted = wrapped(serverTools);
      const recorded = recordingResponse();
      await accepted.route.serve(request(exact, { headers: { "content-length": String(LIMIT) } }), recorded.response);
      expect(recorded.status(), String(serverTools)).not.toBe(HTTP_STATUS.payloadTooLarge);
      const refused = wrapped(serverTools);
      const refusal = recordingResponse();
      await refused.route.serve(request(exact, { headers: { "content-length": String(LIMIT + 1) } }), refusal.response);
      expect(refusal.status()).toBe(HTTP_STATUS.payloadTooLarge);
      expect(refused.served()).toBe(0);
    }
  });
});

describe("an answer that says the model is unknown and arrives in several writes", () => {
  it("is read whole, so the list is refreshed and the request served again under the model it now lists", async () => {
    const answered = JSON.stringify({ error: { type: "not_found_error", message: "The model `served` does not exist" } });
    // The word `model` ends the first write and the phrase that says it is missing opens the last, so neither alone says the model is unknown, and neither is JSON.
    const firstCut = answered.indexOf("model") + "model".length;
    const lastCut = answered.indexOf("does not exist");
    const pieces = [answered.slice(0, firstCut), answered.slice(firstCut, lastCut), answered.slice(lastCut)];
    expect(pieces.every((piece) => piece.length > 0)).toBe(true);
    const sent: string[] = [];
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (served, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of served.body) {
          chunks.push(Buffer.from(chunk as Buffer));
        }
        const model = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model;
        sent.push(model);
        if (model === "served") {
          response.start(HTTP_STATUS.notFound, {});
          for (const piece of pieces) {
            await response.write(Buffer.from(piece));
          }
        } else {
          response.start(HTTP_STATUS.ok, {});
          await response.write(Buffer.from("{}"));
        }
        response.end();
      },
    };
    let lookups = 0;
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: true, model: (lookups += 1) === 1 ? "served" : "newer" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const recorded = recordingResponse();
    await route.serve(request('{"model":"auto"}'), recorded.response);
    expect(sent).toEqual(["served", "newer"]);
    expect(recorded.status()).toBe(HTTP_STATUS.ok);
  });
});

describe("an unknown-model answer when the refreshed list names the same model", () => {
  it("is the answer the client gets, with no second request to the server", async () => {
    const answered = JSON.stringify({ error: { message: "The model `served` does not exist" } });
    const sent: string[] = [];
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (served, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of served.body) {
          chunks.push(Buffer.from(chunk as Buffer));
        }
        sent.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model);
        response.start(HTTP_STATUS.notFound, {});
        await response.write(Buffer.from(answered));
        response.end();
      },
    };
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const recorded = recordingResponse();
    await route.serve(request('{"model":"auto"}'), recorded.response);
    expect(sent).toEqual(["served"]);
    expect(recorded.status()).toBe(HTTP_STATUS.notFound);
    expect(recorded.text()).toBe(answered);
  });
});

describe("an unknown-model answer at the bound on a held one", () => {
  /** The models the wrapper sent when the server's answer to the first was a model-missing 404 of exactly `bytes` bytes. */
  async function sentForAnswerOf(bytes: number): Promise<readonly string[]> {
    const frame = (pad: string): string => JSON.stringify({ error: { message: "The model `served` does not exist", pad } });
    const answered = frame("x".repeat(bytes - frame("").length));
    expect(Buffer.byteLength(answered)).toBe(bytes);
    const sent: string[] = [];
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (served, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of served.body) {
          chunks.push(Buffer.from(chunk as Buffer));
        }
        const model = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model;
        sent.push(model);
        response.start(model === "served" ? HTTP_STATUS.notFound : HTTP_STATUS.ok, {});
        await response.write(Buffer.from(model === "served" ? answered : "{}"));
        response.end();
      },
    };
    let lookups = 0;
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: true, model: (lookups += 1) === 1 ? "served" : "newer" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    await route.serve(request('{"model":"auto"}'), recordingResponse().response);
    return sent;
  }

  it("is read and retried at exactly the bound, and passed through unread one byte past it", async () => {
    expect(await sentForAnswerOf(HELD_ANSWER_LIMIT_BYTES)).toEqual(["served", "newer"]);
    expect(await sentForAnswerOf(HELD_ANSWER_LIMIT_BYTES + 1)).toEqual(["served"]);
  });
});

describe("an unknown-model answer that is encoded", () => {
  /** The wrapper over a route that answers a 404 saying the model does not exist, with `headers`, and the models it was sent. */
  async function sentWith(headers: Readonly<Record<string, string>>): Promise<{ readonly sent: readonly string[]; readonly status: number | undefined }> {
    const answered = JSON.stringify({ error: { message: "The model `served` does not exist" } });
    const sent: string[] = [];
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (served, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of served.body) {
          chunks.push(Buffer.from(chunk as Buffer));
        }
        const model = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model;
        sent.push(model);
        response.start(model === "served" ? HTTP_STATUS.notFound : HTTP_STATUS.ok, model === "served" ? headers : {});
        await response.write(Buffer.from(answered));
        response.end();
      },
    };
    let lookups = 0;
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: true, model: (lookups += 1) === 1 ? "served" : "newer" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const recorded = recordingResponse();
    await route.serve(request('{"model":"auto"}'), recorded.response);
    return { sent, status: recorded.status() };
  }

  it.each([["gzip"], ["br"], ["Gzip"], [" deflate "]])("is passed through as it is, with no retry, when its Content-Encoding is %j", async (encoding) => {
    const outcome = await sentWith({ "Content-Encoding": encoding });
    expect(outcome.sent).toEqual(["served"]);
    expect(outcome.status).toBe(HTTP_STATUS.notFound);
  });

  it.each([[{}], [{ "content-encoding": "identity" }], [{ "Content-Encoding": "Identity" }], [{ "content-encoding": "" }]])("is read and retried when it is not encoded: %j", async (headers) => {
    const outcome = await sentWith(headers);
    expect(outcome.sent).toEqual(["served", "newer"]);
    expect(outcome.status).toBe(HTTP_STATUS.ok);
  });
});

describe("an unknown-model answer when the list cannot be read again", () => {
  it("is the answer the client gets, with no second request to the server", async () => {
    const answered = JSON.stringify({ error: { message: "The model `served` does not exist" } });
    const sent: string[] = [];
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (served, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of served.body) {
          chunks.push(Buffer.from(chunk as Buffer));
        }
        sent.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model);
        response.start(HTTP_STATUS.notFound, {});
        await response.write(Buffer.from(answered));
        response.end();
      },
    };
    let lookups = 0;
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve((lookups += 1) === 1 ? ({ ok: true, model: "served" } as const) : ({ ok: false, status: HTTP_STATUS.badGateway, message: "the list is down" } as const)) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const recorded = recordingResponse();
    await route.serve(request('{"model":"auto"}'), recorded.response);
    expect(sent).toEqual(["served"]);
    expect(recorded.status()).toBe(HTTP_STATUS.notFound);
    expect(recorded.text()).toBe(answered);
  });
});

describe("an unknown-model answer when the refreshed list names the same model", () => {
  it("is the answer the client gets, with no second request to the server", async () => {
    const answered = JSON.stringify({ error: { message: "The model `served` does not exist" } });
    const sent: string[] = [];
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (served, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of served.body) {
          chunks.push(Buffer.from(chunk as Buffer));
        }
        sent.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model);
        response.start(HTTP_STATUS.notFound, {});
        await response.write(Buffer.from(answered));
        response.end();
      },
    };
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const recorded = recordingResponse();
    await route.serve(request('{"model":"auto"}'), recorded.response);
    expect(sent).toEqual(["served"]);
    expect(recorded.status()).toBe(HTTP_STATUS.notFound);
    expect(recorded.text()).toBe(answered);
  });
});

describe("the log line of a retry under another model", () => {
  it("quotes and cuts the two model ids the provider supplied, so neither can start a line or fill one", async () => {
    const hostile = `old\nfront door: forged line ${"x".repeat(MAX_LOGGED_TEXT_CHARS * 2)}`;
    const answered = JSON.stringify({ error: { message: "The model does not exist" } });
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (served, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of served.body) {
          chunks.push(Buffer.from(chunk as Buffer));
        }
        const model = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model;
        response.start(model === hostile ? HTTP_STATUS.notFound : HTTP_STATUS.ok, {});
        await response.write(Buffer.from(model === hostile ? answered : "{}"));
        response.end();
      },
    };
    let lookups = 0;
    const lines: string[] = [];
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: true, model: (lookups += 1) === 1 ? hostile : `new\nforged ${hostile}` } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: (line) => {
        lines.push(line);
      },
      bodyLimitBytes: LIMIT * LIMIT,
    });
    await route.serve(request('{"model":"auto"}'), recordingResponse().response);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).toContain(quotedForLog(hostile));
    expect(lines[0]).not.toContain(hostile);
  });
});

describe("an error answer larger than the bound on a held one", () => {
  it("reaches the client while the upstream is still sending, and whole", async () => {
    const TAIL = "tail";
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (_request, response) => {
        response.start(HTTP_STATUS.badRequest, {});
        response.flush();
        await response.write(Buffer.alloc(PAST_THE_HELD_BOUND_BYTES, "x"));
        await gate;
        await response.write(Buffer.from(TAIL));
        response.end();
      },
    };
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const recorded = recordingResponse();
    const serving = route.serve(request('{"model":"auto"}'), recorded.response);
    await vi.waitFor(() => {
      expect(recorded.text().length).toBe(PAST_THE_HELD_BOUND_BYTES);
    });
    expect(recorded.status()).toBe(HTTP_STATUS.badRequest);
    open();
    await serving;
    expect(recorded.text().length).toBe(PAST_THE_HELD_BOUND_BYTES + TAIL.length);
  });
});

describe("a body whose first model field names auto and that has a second model key of any value", () => {
  it.each(["null", "7", '""', "true", '{"id":"x"}', '["x"]'])("is refused with a 400 when the second is %s", async (value) => {
    const { route, served } = wrapped();
    const recorded = recordingResponse();
    await route.serve(request(`{"model":"auto","model":${value}}`), recorded.response);
    expect(recorded.status()).toBe(HTTP_STATUS.badRequest);
    expect(recorded.text()).toContain("more than one top-level model");
    expect(served()).toBe(0);
  });
});

describe("the model auto is the decoded value", () => {
  it("takes a spelling with escapes as auto", async () => {
    const { route, served } = wrapped(false);
    const recorded = recordingResponse();
    await route.serve(request('{"model":"\\u0061uto"}'), recorded.response);
    expect(recorded.status()).toBe(HTTP_STATUS.badRequest);
    expect(recorded.text()).toContain("needs the provider's model list");
    expect(served()).toBe(0);
  });
});

describe("a request that does not name the model auto", () => {
  it("is served before the rest of its body has arrived, so the body is never read whole", async () => {
    const { route, served } = wrapped();
    let release: () => void = () => undefined;
    const rest = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* body(): AsyncGenerator<Buffer> {
      yield Buffer.from('{"model":"m","messages":[');
      await rest;
      yield Buffer.from("]}");
    }
    const recorded = recordingResponse();
    const serving = route.serve(request("", { stream: Readable.from(body()) }), recorded.response);
    await vi.waitFor(() => {
      expect(served()).toBe(1);
    });
    release();
    await serving;
  });
});

describe("a route that changes its answer after a held error", () => {
  /** What reached the real response, in order: every start with its status, and every body write. */
  function events(): { readonly response: RoutedResponse; readonly seen: string[] } {
    const seen: string[] = [];
    const response: RoutedResponse = {
      headersSent: false,
      start: (status) => {
        seen.push(`start ${String(status)}`);
      },
      flush: () => undefined,
      write: async (chunk) => {
        seen.push(`write ${Buffer.from(chunk).toString("utf8")}`);
        await Promise.resolve();
      },
      end: () => {
        seen.push("end");
      },
      destroy: () => undefined,
    };
    return { response, seen };
  }

  it.each([
    ["the upstream body failed after a partial error text", ["partial 400 text"]],
    ["the connection failed after the error head", []],
  ])("answers with the later start alone when %s", async (_label, partial) => {
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (_request, response) => {
        response.start(HTTP_STATUS.badRequest, {});
        for (const text of partial) {
          await response.write(Buffer.from(text));
        }
        response.start(HTTP_STATUS.badGateway, {});
        await response.write(Buffer.from("bad gateway"));
        response.end();
      },
    };
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const { response, seen } = events();
    await route.serve(request('{"model":"auto"}'), response);
    expect(seen).toEqual(["start 502", "write bad gateway", "end"]);
  });
});

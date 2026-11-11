import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { editingHttpRequest } from "./httpRequestEdits";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";

const LIMIT = 4096;

function request(body: string): RoutedRequest {
  return { method: "POST", url: "/v1/messages", headers: {}, body: Readable.from([Buffer.from(body)]), signal: new AbortController().signal, session: { identity: undefined, sessionId: "s", provider: "spark", headroom: false, projectId: undefined } };
}

function recordingResponse(): { readonly response: RoutedResponse; readonly status: () => number | undefined } {
  let status: number | undefined;
  const response: RoutedResponse = {
    headersSent: false,
    start: (code) => {
      status = code;
    },
    flush: () => undefined,
    write: async () => {
      await Promise.resolve();
    },
    end: () => undefined,
    destroy: () => undefined,
  };
  return { response, status: () => status };
}

describe("only a 400 or a 404 is taken for an unknown-model answer", () => {
  it.each([HTTP_STATUS.internalServerError, HTTP_STATUS.ok, HTTP_STATUS.badGateway])("a %i whose message says the model does not exist is passed through, with no refresh and no second request", async (status) => {
    const sent: string[] = [];
    let lookups = 0;
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
        response.start(status, {});
        await response.write(Buffer.from(JSON.stringify({ error: { message: "The model `served` does not exist" } })));
        response.end();
      },
    };
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      droppedLogged: new Set<string>(),
      droppedLoggedLimit: 1,
      served: { resolve: async () => await Promise.resolve({ ok: true, model: (lookups += 1) === 1 ? "served" : "newer" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const recorded = recordingResponse();
    await route.serve(request('{"model":"auto"}'), recorded.response);
    expect(sent).toEqual(["served"]);
    expect(lookups).toBe(1);
    expect(recorded.status()).toBe(status);
  });
});

describe("the model the wrapper reports it sent", () => {
  /** The wrapper over a route that answers `status` saying the model `served` does not exist, whose list names `served` and then `newer`, and the models it reported. */
  function reporting(): { readonly route: FrontDoorRoute; readonly reported: string[] } {
    const reported: string[] = [];
    let lookups = 0;
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
        response.start(model === "served" ? HTTP_STATUS.notFound : HTTP_STATUS.ok, {});
        await response.write(Buffer.from(JSON.stringify({ error: { message: "The model `served` does not exist" } })));
        response.end();
      },
    };
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      droppedLogged: new Set<string>(),
      droppedLoggedLimit: 1,
      served: { resolve: async () => await Promise.resolve({ ok: true, model: (lookups += 1) === 1 ? "served" : "newer" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      log: () => undefined,
      bodyLimitBytes: LIMIT,
      servedModelSent: (model) => {
        reported.push(model);
      },
    });
    return { route, reported };
  }

  it("is the model the list names, and then the one a refreshed list names for the retry", async () => {
    const { route, reported } = reporting();
    await route.serve(request('{"model":"auto"}'), recordingResponse().response);
    expect(reported).toEqual(["served", "newer"]);
  });

  it("is never told for a request that names another model than auto", async () => {
    const { route, reported } = reporting();
    await route.serve(request('{"model":"chosen"}'), recordingResponse().response);
    expect(reported).toEqual([]);
  });
});

describe("the model choice the route reports through the wrapper", () => {
  it("reaches the client's response when it can take one, and the wrapper offers none when it cannot", async () => {
    const choices: unknown[] = [];
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (served, response) => {
        served.body.resume();
        response.noteModelChoice?.({ requested: "fast", providers: ["spark"] });
        await Promise.resolve();
      },
    };
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: undefined,
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      droppedLogged: new Set<string>(),
      droppedLoggedLimit: 1,
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const taking = { ...recordingResponse().response, noteModelChoice: (choice: unknown) => { choices.push(choice); } };
    await route.serve(request('{"model":"chosen"}'), taking);
    expect(choices).toEqual([{ requested: "fast", providers: ["spark"] }]);
    // A response with no such method gets none: the wrapper's own does not invent one.
    await route.serve(request('{"model":"chosen"}'), recordingResponse().response);
    expect(choices).toHaveLength(1);
  });

  it("reaches the client's response from a route serving a request whose model auto the wrapper rewrote, through the response that holds back a model-missing answer", async () => {
    const choices: unknown[] = [];
    const inner: FrontDoorRoute = {
      name: "http:spark",
      headroomEligible: true,
      headroomUpstream: undefined,
      serve: async (served, response) => {
        served.body.resume();
        response.noteModelChoice?.({ requested: "fast", providers: ["spark"] });
        await Promise.resolve();
      },
    };
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: true, model: "served" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      droppedLogged: new Set<string>(),
      droppedLoggedLimit: 1,
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const taking = { ...recordingResponse().response, noteModelChoice: (choice: unknown) => { choices.push(choice); } };
    await route.serve(request('{"model":"auto"}'), taking);
    expect(choices).toEqual([{ requested: "fast", providers: ["spark"] }]);
    await route.serve(request('{"model":"auto"}'), recordingResponse().response);
    expect(choices).toHaveLength(1);
  });
});

describe("the retry after an unknown-model answer asks for a refreshed list", () => {
  it("resolves again with `refresh: true`, and serves the retry under what that read names, never under the cached model", async () => {
    const sent: string[] = [];
    const asked: (boolean | undefined)[] = [];
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
        response.start(model === "cached" ? HTTP_STATUS.notFound : HTTP_STATUS.ok, {});
        await response.write(Buffer.from(JSON.stringify({ error: { message: "The model `cached` does not exist" } })));
        response.end();
      },
    };
    const reported: string[] = [];
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      // The cached list names `cached`; only a refreshed read names `fresh`.
      served: { resolve: async (_source, options) => { asked.push(options?.refresh); return await Promise.resolve({ ok: true, model: options?.refresh === true ? "fresh" : "cached" } as const); } },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      droppedLogged: new Set<string>(),
      droppedLoggedLimit: 1,
      log: () => undefined,
      bodyLimitBytes: LIMIT,
      servedModelSent: (model) => {
        reported.push(model);
      },
    });
    await route.serve(request('{"model":"auto"}'), recordingResponse().response);
    expect(asked).toEqual([undefined, true]);
    expect(sent).toEqual(["cached", "fresh"]);
    expect(reported).toEqual(["cached", "fresh"]);
  });
});

describe("a request for the model auto when the list cannot be read", () => {
  it("is answered once with the lookup's own failure, and the route never serves it", async () => {
    const starts: number[] = [];
    let served = 0;
    const inner: FrontDoorRoute = { name: "http:spark", headroomEligible: true, headroomUpstream: undefined, serve: async () => { served += 1; await Promise.resolve(); } };
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: false, status: HTTP_STATUS.badGateway, message: "the list is down" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      droppedLogged: new Set<string>(),
      droppedLoggedLimit: 1,
      log: () => undefined,
      bodyLimitBytes: LIMIT,
    });
    const response: RoutedResponse = { ...recordingResponse().response, start: (status) => { starts.push(status); } };
    await route.serve(request('{"model":"auto"}'), response);
    expect(starts).toEqual([HTTP_STATUS.badGateway]);
    expect(served).toBe(0);
  });
});

describe("an unknown-model answer when the refreshed list names the same model", () => {
  it("is the answer the client gets, with one upstream call and one report", async () => {
    const sent: string[] = [];
    const reported: string[] = [];
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
        await response.write(Buffer.from(JSON.stringify({ error: { message: "The model `same` does not exist" } })));
        response.end();
      },
    };
    const route = editingHttpRequest(inner, {
      provider: "spark",
      definition: { baseUrl: "http://127.0.0.1:1" },
      served: { resolve: async () => await Promise.resolve({ ok: true, model: "same" } as const) },
      credential: async () => await Promise.resolve({ ok: false, message: "unused" } as const),
      droppedLogged: new Set<string>(),
      droppedLoggedLimit: 1,
      log: () => undefined,
      bodyLimitBytes: LIMIT,
      servedModelSent: (model) => {
        reported.push(model);
      },
    });
    const recorded = recordingResponse();
    await route.serve(request('{"model":"auto"}'), recorded.response);
    expect(sent).toEqual(["same"]);
    expect(reported).toEqual(["same"]);
    expect(recorded.status()).toBe(HTTP_STATUS.notFound);
  });
});

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { admitEverything } from "../test-helpers";
import { createRoutedResponse, serveRouted, type PipelineDeps, type PipelineRequest, type ResponseBodyObserver, type ResponseObserver, type RouteResolution, type RoutedResponseEvent } from "./pipeline";
import { HEADROOM_FLAG_HEADER, IDENTITY_HEADER, SESSION_HEADER, type FrontDoorRoute, type RoutedRequest, type RoutedResponse } from "./route";

/**
 * A stand-in ServerResponse with the only behaviour `createRoutedResponse` reads: writeHead, write returning false on demand, drain and close events, and destruction. A new one per use keeps each test's socket semantics independent.
 */
class FakeServerResponse extends EventEmitter {
  writtenHead: { status: number; headers: Record<string, string> } | undefined;
  chunks: string[] = [];
  ended = false;
  destroyed = false;
  private readonly backpressure: boolean;

  constructor(backpressure = false) {
    super();
    this.backpressure = backpressure;
  }

  get writableEnded(): boolean {
    return this.ended;
  }

  writeHead(status: number, headers: Readonly<Record<string, string>>): void {
    this.writtenHead = { status, headers };
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.backpressure;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/** An arbitrary instant the injected clock reports. */
const RECEIVED_AT = 1_700_000_000_000;

/** A stand-in IncomingMessage: the pipeline only passes it through to the route. */
function fakeBody(): IncomingMessage {
  return new EventEmitter() as unknown as IncomingMessage;
}

function pipelineRequest(headers: Record<string, string | string[]> = {}): { readonly request: PipelineRequest; readonly response: FakeServerResponse } {
  const response = new FakeServerResponse();
  return {
    request: { method: "POST", url: "/providers/codex/v1/messages", headers, body: fakeBody(), signal: new AbortController().signal, response: response as unknown as PipelineRequest["response"] },
    response,
  };
}

/** A route that records what it was handed and writes a fixed response. */
function recordingRoute(overrides: Partial<FrontDoorRoute> = {}): FrontDoorRoute & { readonly seen: RoutedRequest[] } {
  const seen: RoutedRequest[] = [];
  return {
    seen,
    name: "test",
    headroomEligible: true,
    headroomUpstream: undefined,
    serve: async (request, response) => {
      seen.push(request);
      response.start(HTTP_STATUS.ok, { "Content-Type": "text/plain" });
      await response.write("body");
      response.end();
    },
    ...overrides,
  };
}

function deps(resolution: RouteResolution, observers: readonly ResponseObserver[] = []): { readonly deps: PipelineDeps; readonly logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    deps: {
      resolveRoute: async () => await Promise.resolve(resolution),
      responseObservers: observers,
      admit: admitEverything,
      now: () => 0,
      log: (line) => {
        logs.push(line);
      },
    },
  };
}

describe("createRoutedResponse", () => {
  it("applies backpressure: a write that the socket refuses waits for its drain", async () => {
    const response = new FakeServerResponse(true);
    const routed = createRoutedResponse(response as unknown as PipelineRequest["response"], { deps: deps({ ok: true, route: recordingRoute() }).deps, session: { identity: "work", sessionId: "s", provider: undefined, headroom: false, projectId: undefined }, route: "test", request: { method: "POST", path: "/v1/messages", receivedAt: 0 } });
    routed.start(HTTP_STATUS.ok, {});
    let resolved = false;
    const write = routed.write("chunk").then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    response.emit("drain");
    await write;
    expect(resolved).toBe(true);
    expect(response.chunks).toEqual(["chunk"]);
  });

  it("settles a backpressured write when the client goes away, so a route is never left waiting on a dead socket", async () => {
    const response = new FakeServerResponse(true);
    const routed = createRoutedResponse(response as unknown as PipelineRequest["response"], { deps: deps({ ok: true, route: recordingRoute() }).deps, session: { identity: "work", sessionId: "s", provider: undefined, headroom: false, projectId: undefined }, route: "test", request: { method: "POST", path: "/v1/messages", receivedAt: 0 } });
    routed.start(HTTP_STATUS.ok, {});
    let resolved = false;
    const write = routed.write("chunk").then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    response.emit("close");
    await write;
    expect(resolved).toBe(true);
  });
});

describe("serveRouted", () => {
  it("identifies the session, strips the internal headers, and hands the route what may leave the machine", async () => {
    const route = recordingRoute();
    const { request } = pipelineRequest({ [IDENTITY_HEADER]: "work", [SESSION_HEADER]: "session-9", [HEADROOM_FLAG_HEADER]: "1", authorization: "Bearer tok" });
    await serveRouted(request, deps({ ok: true, route }).deps);
    expect(route.seen[0]?.session).toEqual({ identity: "work", sessionId: "session-9", headroom: true });
    expect(route.seen[0]?.headers).toEqual({ authorization: "Bearer tok" });
  });

  it("runs every response observer, in order, at the response head and before the body", async () => {
    const events: string[] = [];
    const observeTyped = (event: RoutedResponseEvent): undefined => {
      events.push(`first:${event.route}:${String(event.status)}:${String(event.session.identity)}`);
      return undefined;
    };
    const observers: ResponseObserver[] = [
      observeTyped,
      (event) => {
        events.push(`second:${String(event.headers["Content-Type"])}`);
        return undefined;
      },
    ];
    const { request, response } = pipelineRequest({ [IDENTITY_HEADER]: "work" });
    await serveRouted(request, deps({ ok: true, route: recordingRoute() }, observers).deps);
    expect(events).toEqual(["first:test:200:work", "second:text/plain"]);
    expect(response.writtenHead?.status).toBe(HTTP_STATUS.ok);
  });

  it("refuses an unauthorized request before any route or resolution, as an Anthropic-shaped 401 the observers still see", async () => {
    const statuses: number[] = [];
    const { request, response } = pipelineRequest();
    await serveRouted(
      request,
      {
        resolveRoute: async () => await Promise.resolve({ ok: true, route: recordingRoute() }),
        responseObservers: [(event) => { statuses.push(event.status); return undefined; }],
        admit: () => ({ ok: false, message: "agent-shim front door: this request carries no capability from a live agent-shim launch" }),
        now: () => 0,
        log: () => undefined,
      },
    );
    expect(response.writtenHead?.status).toBe(HTTP_STATUS.unauthorized);
    expect(response.chunks[0]).toContain("authentication_error");
    expect(statuses).toEqual([HTTP_STATUS.unauthorized]);
  });

  it("answers an unrouted target as an Anthropic-shaped error the observers still see", async () => {
    const statuses: number[] = [];
    const { request, response } = pipelineRequest();
    await serveRouted(request, deps({ ok: false, status: HTTP_STATUS.notFound, message: "no such endpoint" }, [(event) => {
      statuses.push(event.status);
      return undefined;
    }]).deps);
    expect(response.writtenHead?.status).toBe(HTTP_STATUS.notFound);
    expect(response.chunks[0]).toContain("not_found_error");
    expect(response.chunks[0]).toContain("no such endpoint");
    expect(statuses).toEqual([HTTP_STATUS.notFound]);
  });

  it("drops a throwing observer and still serves the response, logging the failure", async () => {
    const logs: string[] = [];
    const { request, response } = pipelineRequest();
    await serveRouted(
      request,
      {
        resolveRoute: async () => await Promise.resolve({ ok: true, route: recordingRoute() }),
        responseObservers: [
          (): undefined => {
            throw new Error("observer bug");
          },
        ],
        admit: admitEverything,
        now: () => 0,
        log: (line) => {
          logs.push(line);
        },
      },
    );
    expect(response.ended).toBe(true);
    expect(response.chunks).toEqual(["body"]);
    expect(logs[0]).toContain("observer bug");
  });

  it("answers a route that fails before its head as an Anthropic-shaped 500", async () => {
    const failing: FrontDoorRoute = {
      name: "failing",
      headroomEligible: false,
      headroomUpstream: undefined,
      serve: async () => {
        await Promise.resolve();
        throw new Error("route exploded");
      },
    };
    const { request, response } = pipelineRequest();
    const { deps: d, logs } = deps({ ok: true, route: failing });
    await serveRouted(request, d);
    expect(response.writtenHead?.status).toBe(HTTP_STATUS.internalServerError);
    expect(response.chunks[0]).toContain("api_error");
    expect(logs[0]).toContain("failing");
  });

  it("destroys the response when a route fails after its head, since no status can be sent any more", async () => {
    let routedResponse: RoutedResponse | undefined;
    const failing: FrontDoorRoute = {
      name: "failing",
      headroomEligible: false,
      headroomUpstream: undefined,
      serve: async (_request, response) => {
        routedResponse = response;
        response.start(HTTP_STATUS.ok, {});
        await Promise.resolve();
        throw new Error("mid-stream failure");
      },
    };
    const { request, response } = pipelineRequest();
    await serveRouted(request, deps({ ok: true, route: failing }).deps);
    expect(routedResponse?.headersSent).toBe(true);
    expect(response.destroyed).toBe(true);
  });

  it("hands each observer the request's method, query-less path and arrival time from the injected clock", async () => {
    const events: RoutedResponseEvent[] = [];
    const { request } = pipelineRequest();
    const withQuery: PipelineRequest = { ...request, url: "/providers/codex/v1/messages?beta=true" };
    const { deps: d } = deps({ ok: true, route: recordingRoute() }, [(event) => {
      events.push(event);
      return undefined;
    }]);
    await serveRouted(withQuery, { ...d, now: () => RECEIVED_AT });
    expect(events.map((event) => [event.method, event.path, event.receivedAt])).toEqual([["POST", "/providers/codex/v1/messages", RECEIVED_AT]]);
  });
});

/** A body observer that records what it saw, in order. */
function recordingBodyObserver(): ResponseBodyObserver & { readonly seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    chunk: (chunk) => {
      seen.push(`chunk:${Buffer.from(chunk).toString("utf8")}`);
    },
    end: (outcome) => {
      seen.push(`end:${outcome}`);
    },
  };
}

function routedWith(response: FakeServerResponse, observers: readonly ResponseObserver[]): { readonly routed: RoutedResponse; readonly logs: string[] } {
  const { deps: d, logs } = deps({ ok: true, route: recordingRoute() }, observers);
  const routed = createRoutedResponse(response as unknown as PipelineRequest["response"], {
    deps: d,
    session: { identity: "work", sessionId: "s", provider: undefined, headroom: false, projectId: undefined },
    route: "test",
    request: { method: "POST", path: "/v1/messages", receivedAt: 0 },
  });
  return { routed, logs };
}

describe("response body observers", () => {
  it("see each chunk only after the socket has it, then the completed end, exactly once", async () => {
    const response = new FakeServerResponse();
    const body = recordingBodyObserver();
    const order: string[] = [];
    const original = response.write.bind(response);
    response.write = (chunk: string): boolean => {
      order.push(`socket:${chunk}`);
      return original(chunk);
    };
    const { routed } = routedWith(response, [() => ({
      chunk: (chunk) => {
        order.push(`observer:${Buffer.from(chunk).toString("utf8")}`);
        body.chunk(chunk);
      },
      end: body.end,
    })]);
    routed.start(HTTP_STATUS.ok, {});
    await routed.write("one");
    await routed.write("two");
    routed.end();
    response.emit("close");
    expect(order).toEqual(["socket:one", "observer:one", "socket:two", "observer:two"]);
    expect(body.seen).toEqual(["chunk:one", "chunk:two", "end:completed"]);
  });

  it("are told the body was aborted when the route destroys the response", async () => {
    const response = new FakeServerResponse();
    const body = recordingBodyObserver();
    const { routed } = routedWith(response, [() => body]);
    routed.start(HTTP_STATUS.ok, {});
    await routed.write("partial");
    routed.destroy();
    expect(body.seen).toEqual(["chunk:partial", "end:aborted"]);
  });

  it("are told the body was aborted when the client goes away and the route never ends it", async () => {
    const response = new FakeServerResponse();
    const body = recordingBodyObserver();
    const { routed } = routedWith(response, [() => body]);
    routed.start(HTTP_STATUS.ok, {});
    await routed.write("partial");
    response.emit("close");
    expect(body.seen).toEqual(["chunk:partial", "end:aborted"]);
  });

  it("drop a throwing body observer for the rest of the response while the others and the client carry on", async () => {
    const response = new FakeServerResponse();
    const healthy = recordingBodyObserver();
    let calls = 0;
    const { routed, logs } = routedWith(response, [
      () => ({
        chunk: () => {
          calls += 1;
          throw new Error("scanner bug");
        },
        end: () => {
          calls += 1;
        },
      }),
      () => healthy,
    ]);
    routed.start(HTTP_STATUS.ok, {});
    await routed.write("one");
    await routed.write("two");
    routed.end();
    expect(calls).toBe(1);
    expect(response.chunks).toEqual(["one", "two"]);
    expect(healthy.seen).toEqual(["chunk:one", "chunk:two", "end:completed"]);
    expect(logs.join("\n")).toContain("scanner bug");
  });
});

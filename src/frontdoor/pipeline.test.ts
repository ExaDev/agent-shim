import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { admitEverything, followsLaunchFlag } from "../test-helpers";
import { rcObservingResolver } from "./commands";
import { createCredentialCustody } from "./custody";
import { NO_ROUTING_SETTING } from "../headroom/routingSetting";
import { createHeadroomDecision } from "./headroomDecision";
import { RC_IDLE_EXPIRY_MS, createRcSessionTracker } from "./rcSessions";
import { createRoutedResponse, serveRouted, type PipelineDeps, type PipelineRequest, type ResponseBodyObserver, type ResponseObserver, type RouteResolution, type RoutedResponseEvent } from "./pipeline";
import { HEADROOM_FLAG_HEADER, IDENTITY_HEADER, PROVIDER_HEADER, SESSION_HEADER, type FrontDoorRoute, type RoutedRequest, type RoutedResponse  } from "./route";

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

/** One longer than the longest client session id the usage record accepts. */
const LONG_CLIENT_ID_LENGTH = 129;

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

function deps(resolution: RouteResolution, observers: readonly ResponseObserver[] = [], extra: Partial<PipelineDeps> = {}): { readonly deps: PipelineDeps; readonly logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    deps: {
      resolveRoute: async () => await Promise.resolve(resolution),
      canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: observers, ...extra,
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
    const routed = createRoutedResponse(response as unknown as PipelineRequest["response"], { deps: deps({ ok: true, route: recordingRoute() }).deps, servedPath: "/v1/messages", session: { identity: "work", sessionId: "s", provider: undefined, headroom: false, projectId: undefined }, route: "test", request: { method: "POST", path: "/v1/messages", receivedAt: 0, viaHeadroom: false, thread: { lineage: undefined }, modelChoice: { value: undefined }, requestedModel: { value: undefined }, clientSessionId: undefined } });
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
    const routed = createRoutedResponse(response as unknown as PipelineRequest["response"], { deps: deps({ ok: true, route: recordingRoute() }).deps, servedPath: "/v1/messages", session: { identity: "work", sessionId: "s", provider: undefined, headroom: false, projectId: undefined }, route: "test", request: { method: "POST", path: "/v1/messages", receivedAt: 0, viaHeadroom: false, thread: { lineage: undefined }, modelChoice: { value: undefined }, requestedModel: { value: undefined }, clientSessionId: undefined } });
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

  it("routes a session launched under a renamed provider's old name, on its header and on a provider-scoped path, as the provider it became", async () => {
    const seen: RoutedRequest[] = [];
    const rename = (name: string): string => (name === "z" ? "zai" : name);
    const { deps: pipeline } = deps({ ok: true, route: recordingRoute() }, [], {
      canonicalProvider: rename,
      resolveRoute: async (routed) => {
        seen.push(routed);
        return await Promise.resolve({ ok: true, route: recordingRoute() });
      },
    });
    const { request } = pipelineRequest({ [PROVIDER_HEADER]: "z" });
    await serveRouted({ ...request, url: "/providers/z/v1/messages?beta=true" }, pipeline);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.session.provider).toBe("zai");
    expect(seen[0]?.url).toBe("/providers/zai/v1/messages?beta=true");
  });

  it("leaves a request that names no provider, or a current one, untouched", async () => {
    const seen: RoutedRequest[] = [];
    const { deps: pipeline } = deps({ ok: true, route: recordingRoute() }, [], {
      canonicalProvider: (name) => (name === "z" ? "zai" : name),
      resolveRoute: async (routed) => {
        seen.push(routed);
        return await Promise.resolve({ ok: true, route: recordingRoute() });
      },
    });
    const { request } = pipelineRequest();
    await serveRouted({ ...request, url: "/v1/messages" }, pipeline);
    const current = pipelineRequest({ [PROVIDER_HEADER]: "zai" });
    await serveRouted({ ...current.request, url: "/providers/zai/v1/messages" }, pipeline);
    expect(seen.map((routed) => [routed.session.provider, routed.url])).toEqual([
      [undefined, "/v1/messages"],
      ["zai", "/providers/zai/v1/messages"],
    ]);
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

  describe("viaHeadroom on the observed event", () => {
    /** Serves one request with the given session flag, route eligibility and headroom wiring, and returns what the response observer saw. */
    async function observedViaHeadroom(options: { readonly flagged: boolean; readonly eligible: boolean; readonly wired: boolean }): Promise<boolean[]> {
      const seen: boolean[] = [];
      const { request } = pipelineRequest(options.flagged ? { [HEADROOM_FLAG_HEADER]: "1" } : {});
      const { deps: base } = deps({ ok: true, route: recordingRoute({ headroomEligible: options.eligible }) }, [
        (event) => {
          seen.push(event.viaHeadroom);
          return undefined;
        },
      ]);
      // A daemon between restarts: the hop answers 502 itself, so deciding to hop needs no live daemon.
      const headroom = { headroomSocket: () => undefined, hopSecret: "secret", custody: createCredentialCustody(() => "id"), log: () => undefined };
      await serveRouted(request, options.wired ? { ...base, headroom } : base);
      return seen;
    }

    it("keeps a session's routing across requests while its cache is warm, though a later request's flag differs", async () => {
      const seen: boolean[] = [];
      const decision = createHeadroomDecision(() => NO_ROUTING_SETTING);
      const { deps: base } = deps({ ok: true, route: recordingRoute() }, [
        (event) => {
          seen.push(event.viaHeadroom);
          return undefined;
        },
      ]);
      const headroom = { headroomSocket: () => undefined, hopSecret: "secret", custody: createCredentialCustody(() => "id"), log: () => undefined };
      const serve = async (flagged: boolean): Promise<void> => {
        const { request } = pipelineRequest({ [SESSION_HEADER]: "s1", ...(flagged ? { [HEADROOM_FLAG_HEADER]: "1" } : {}) });
        // The probe needs a live daemon socket, which this pipeline test has none of: the daemon is stood in for as always ready.
        await serveRouted(request, { ...base, headroom, headroomDecision: { decide: async (id, wanted, now) => await decision.decide(id, wanted, now, async () => await Promise.resolve(true)), observe: decision.observe } });
      };
      await serve(true);
      decision.observe({ sessionId: "s1", startedAtMs: 0, endedAtMs: 0, viaHeadroom: true, lineage: undefined, cache: { readTokens: 1000, writtenTokens: 0, uncachedTokens: 0 } });
      await serve(false);
      expect(seen).toEqual([true, true]);
    });

    it("is true when the session asked for headroom, the route admits it and a daemon is wired", async () => {
      expect(await observedViaHeadroom({ flagged: true, eligible: true, wired: true })).toEqual([true]);
    });

    it("is false when the session did not ask for headroom", async () => {
      expect(await observedViaHeadroom({ flagged: false, eligible: true, wired: true })).toEqual([false]);
    });

    it("is false when the route does not admit headroom", async () => {
      expect(await observedViaHeadroom({ flagged: true, eligible: false, wired: true })).toEqual([false]);
    });

    it("is false when no daemon is wired, though the session asked for one", async () => {
      expect(await observedViaHeadroom({ flagged: true, eligible: true, wired: false })).toEqual([false]);
    });
  });

  it("refuses an unauthorized request before any route or resolution, as an Anthropic-shaped 401 the observers still see", async () => {
    const statuses: number[] = [];
    const { request, response } = pipelineRequest();
    await serveRouted(
      request,
      {
        resolveRoute: async () => await Promise.resolve({ ok: true, route: recordingRoute() }),
        canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [(event) => { statuses.push(event.status); return undefined; }],
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
        canonicalProvider: (name) => name, headroomDecision: followsLaunchFlag, responseObservers: [
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

describe("the client's conversation id", () => {
  it("reaches the observers from Claude Code's own header, which is not the launch's session id", async () => {
    const events: RoutedResponseEvent[] = [];
    const { request } = pipelineRequest();
    const { deps: d } = deps({ ok: true, route: recordingRoute() }, [(event) => {
      events.push(event);
      return undefined;
    }]);
    await serveRouted({ ...request, headers: { ...request.headers, "x-claude-code-session-id": "conversation-1" } }, d);
    await serveRouted({ ...request, headers: { ...request.headers, "x-claude-code-session-id": "conversation-2" } }, d);
    expect(events.map((event) => event.clientSessionId)).toEqual(["conversation-1", "conversation-2"]);
  });

  it("is undefined when the client sent no such header, sent it twice, or sent something that is not a single id", async () => {
    const events: RoutedResponseEvent[] = [];
    const { request } = pipelineRequest();
    const { deps: d } = deps({ ok: true, route: recordingRoute() }, [(event) => {
      events.push(event);
      return undefined;
    }]);
    await serveRouted(request, d);
    for (const value of [["a", "b"], "a, b", "../x", "x".repeat(LONG_CLIENT_ID_LENGTH)]) {
      await serveRouted({ ...request, headers: { ...request.headers, "x-claude-code-session-id": value } }, d);
    }
    expect(events.map((event) => event.clientSessionId)).toEqual([undefined, undefined, undefined, undefined, undefined]);
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
    request: { method: "POST", path: "/v1/messages", receivedAt: 0, viaHeadroom: false, thread: { lineage: undefined }, modelChoice: { value: undefined }, requestedModel: { value: undefined }, clientSessionId: undefined },
    servedPath: "/v1/messages",
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

describe("a model choice reaching the response observers", () => {
  it("carries the resolution's choice on the event the observers see at the head", async () => {
    const choices: (RoutedResponseEvent["modelChoice"])[] = [];
    const { request, response } = pipelineRequest();
    await serveRouted(request, deps({ ok: true, route: recordingRoute(), modelChoice: { requested: "auto", providers: ["z", "antigravity"] } }, [(event) => {
      choices.push(event.modelChoice);
      return undefined;
    }]).deps);
    expect(response.writtenHead?.status).toBe(HTTP_STATUS.ok);
    expect(choices).toEqual([{ requested: "auto", providers: ["z", "antigravity"] }]);
  });

  it("carries a choice the route notes before its head, as the tier translator does", async () => {
    const choices: (RoutedResponseEvent["modelChoice"])[] = [];
    const notingRoute: FrontDoorRoute = {
      name: "noting",
      headroomEligible: false,
      headroomUpstream: undefined,
      serve: async (_request, response) => {
        response.noteModelChoice?.({ requested: "sonnet", providers: ["antigravity"] });
        response.start(HTTP_STATUS.ok, {});
        await Promise.resolve();
        response.end();
      },
    };
    const { request, response } = pipelineRequest();
    await serveRouted(request, deps({ ok: true, route: notingRoute }, [(event) => {
      choices.push(event.modelChoice);
      return undefined;
    }]).deps);
    expect(response.writtenHead?.status).toBe(HTTP_STATUS.ok);
    expect(choices).toEqual([{ requested: "sonnet", providers: ["antigravity"] }]);
  });
});

describe("a session that wants headroom, served through the Remote Control observing resolver", () => {
  const SESSION = "cse_00000000-0000-4000-8000-000000000001";
  // A daemon that is not serving: a request that takes the hop is answered 502 by the hop itself and never reaches the route, which is what tells the two paths apart.
  const headroom = { headroomSocket: () => undefined, hopSecret: "secret", custody: createCredentialCustody(() => "id"), log: () => undefined };

  async function serveFlagged(url: string): Promise<{ readonly status: number | undefined; readonly routeServed: number; readonly tracked: readonly string[] }> {
    const tracker = createRcSessionTracker({ now: () => 0, idleMs: RC_IDLE_EXPIRY_MS });
    const route = recordingRoute();
    const { deps: base } = deps({ ok: true, route });
    const resolveRoute = rcObservingResolver(async () => await Promise.resolve({ ok: true as const, route }), tracker);
    const { request, response } = pipelineRequest({ [HEADROOM_FLAG_HEADER]: "1" });
    await serveRouted({ ...request, url }, { ...base, resolveRoute, headroom });
    tracker.close();
    return { status: response.writtenHead?.status, routeServed: route.seen.length, tracked: tracker.list().map((session) => session.id) };
  }

  it("serves a worker call from the route, where the tracker observes it, instead of the hop that bypasses it", async () => {
    expect(await serveFlagged(`/v1/code/sessions/${SESSION}/worker/heartbeat`)).toEqual({ status: HTTP_STATUS.ok, routeServed: 1, tracked: [SESSION] });
  });

  it("still sends a model request over the hop", async () => {
    expect(await serveFlagged("/v1/messages")).toEqual({ status: HTTP_STATUS.badGateway, routeServed: 0, tracked: [] });
  });
});

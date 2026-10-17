import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import type { RoutedRequest, RoutedResponse } from "./route";
import { createAntigravityRouteMount } from "./antigravityMount";
import { resolveAntigravityConfig, type ResolvedAntigravityConfig } from "../antigravity/translate";

const DEFAULT_CONFIG: ResolvedAntigravityConfig = resolveAntigravityConfig({
  mode: "cloud",
  cloud: {},
  local: {},
});

function createMockResponse(): {
  response: RoutedResponse;
  getStatus: () => number | undefined;
  getHeaders: () => Record<string, string> | undefined;
  getChunks: () => string[];
  isEnded: () => boolean;
} {
  let status: number | undefined;
  let headers: Record<string, string> | undefined;
  const chunks: string[] = [];
  let ended = false;
  let headersSent = false;

  const response: RoutedResponse = {
    get headersSent() {
      return headersSent;
    },
    start: (s, h) => {
      status = s;
      headers = h;
      headersSent = true;
    },
    flush: () => undefined,
    write: async (chunk) => {
      await Promise.resolve();
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    },
    end: () => {
      ended = true;
    },
    destroy: () => undefined,
  };

  return {
    response,
    getStatus: () => status,
    getHeaders: () => headers,
    getChunks: () => chunks,
    isEnded: () => ended,
  };
}

describe("createAntigravityRouteMount", () => {
  it("creates a route with proper metadata", () => {
    const mount = createAntigravityRouteMount(
      {
        loadProvider: () => ({ ok: false, status: 404, message: "not found" }),
      },
      "http://127.0.0.1:4100",
      "my-ag",
    );

    expect(mount.name).toBe("antigravity:my-ag");
    expect(mount.headroomEligible).toBe(true);
    expect(mount.headroomUpstream).toBe("http://127.0.0.1:4100");
  });

  it("serves a translated request end-to-end", async () => {
    const geminiSse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Greetings!"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
    ].join("");

    const mockFetch: typeof fetch = async () => {
      return await Promise.resolve(
        new Response(geminiSse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    };

    const mount = createAntigravityRouteMount(
      {
        loadProvider: () => ({
          ok: true,
          config: DEFAULT_CONFIG,
          token: "dummy-key",
          credentialTarget: "apiKey",
        }),
        fetchFn: mockFetch,
      },
      "http://127.0.0.1:4100",
      "my-ag",
    );

    const mockRes = createMockResponse();
    const reqBody = JSON.stringify({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hi" }],
    });

    const request: RoutedRequest = {
      method: "POST",
      url: "/providers/my-ag/v1/messages",
      headers: {},
      body: Readable.from([Buffer.from(reqBody)]),
      signal: new AbortController().signal,
      session: {
        identity: undefined,
        sessionId: undefined,
        provider: undefined,
        headroom: false, routeByName: false,
        projectId: undefined,
      },
    };

    await mount.serve(request, mockRes.response);

    expect(mockRes.getStatus()).toBe(HTTP_STATUS.ok);
    expect(mockRes.getHeaders()?.["Content-Type"]).toBe("text/event-stream");
    expect(mockRes.isEnded()).toBe(true);

    const output = mockRes.getChunks().join("");
    expect(output).toContain("Greetings!");
    expect(output).toContain("event: message_stop");
  });

  it("returns 400 when body chunk is not a Buffer", async () => {
    const mount = createAntigravityRouteMount(
      {
        loadProvider: () => ({ ok: false, status: 404, message: "not found" }),
      },
      "http://127.0.0.1:4100",
      "my-ag",
    );

    const mockRes = createMockResponse();
    const request: RoutedRequest = {
      method: "POST",
      url: "/providers/my-ag/v1/messages",
      headers: {},
      body: Readable.from(["not a buffer string"]),
      signal: new AbortController().signal,
      session: {
        identity: undefined,
        sessionId: undefined,
        provider: undefined,
        headroom: false, routeByName: false,
        projectId: undefined,
      },
    };

    await mount.serve(request, mockRes.response);

    expect(mockRes.getStatus()).toBe(HTTP_STATUS.badRequest);
    expect(mockRes.isEnded()).toBe(true);
    expect(mockRes.getChunks().join("")).toContain("request body chunk was not a Buffer");
  });
});

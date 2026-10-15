import { describe, expect, it } from "vitest";

import {
  buildCloudHeaders,
  buildCloudRequestBody,
  buildCloudUrl,
  callCloudAntigravity,
  CCPA_DEFAULT_PROJECT_ID,
  CCPA_ENDPOINT,
  CCPA_USER_AGENT,
} from "./cloudUpstream";
import { resolveAntigravityConfig } from "./translate";

describe("buildCloudUrl", () => {
  it("builds CCPA URL by default", () => {
    const config = resolveAntigravityConfig(undefined);
    expect(buildCloudUrl(config, "claude-sonnet-5-5-high")).toBe(
      `${CCPA_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
    );
  });

  it("builds Vertex AI URL when projectId and location are present", () => {
    const config = resolveAntigravityConfig({
      cloud: { projectId: "my-project", location: "us-central1" },
    });
    expect(buildCloudUrl(config, "gemini-2.5-pro")).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
  });

  it("uses custom non-CCPA endpoint when configured", () => {
    const config = resolveAntigravityConfig({
      cloud: { endpoint: "https://my-proxy.internal" },
    });
    expect(buildCloudUrl(config, "gemini-2.5-pro")).toBe(
      "https://my-proxy.internal/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
  });

  it("uses CCPA route when custom endpoint is a Cloud Code endpoint", () => {
    const config = resolveAntigravityConfig({
      cloud: { endpoint: "https://cloudcode-pa.googleapis.com" },
    });
    expect(buildCloudUrl(config, "claude-opus-5-5-high")).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
  });
});

describe("buildCloudHeaders", () => {
  it("builds apiKey header", () => {
    const headers = buildCloudHeaders("my-key", "apiKey", "https://generativelanguage.googleapis.com");
    expect(headers).toEqual({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "x-goog-api-key": "my-key",
    });
  });

  it("builds bearer authorization and user agent header for CCPA by default", () => {
    const headers = buildCloudHeaders("my-bearer-token", "bearer");
    expect(headers).toEqual({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: "Bearer my-bearer-token",
      "User-Agent": CCPA_USER_AGENT,
    });
  });
});

describe("buildCloudRequestBody", () => {
  it("wraps request with CCPA metadata by default", () => {
    const config = resolveAntigravityConfig(undefined);
    const bodyStr = buildCloudRequestBody({
      config,
      model: "claude-sonnet-5-5-high",
      request: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      token: "fake-token",
      signal: new AbortController().signal,
    });
    const parsed = JSON.parse(bodyStr) as {
      project: string;
      requestId: string;
      request: { contents: unknown[] };
      model: string;
      userAgent: string;
    };
    expect(parsed.project).toBe(CCPA_DEFAULT_PROJECT_ID);
    expect(parsed.model).toBe("claude-sonnet-5-5-high");
    expect(parsed.userAgent).toBe("antigravity");
    expect(parsed.requestId).toMatch(/^agent\/[a-f0-9-]+\/\d+\/1$/);
    expect(parsed.request.contents).toHaveLength(1);
  });

  it("keeps raw request body for non-CCPA endpoints", () => {
    const config = resolveAntigravityConfig({ cloud: { endpoint: "https://generativelanguage.googleapis.com" } });
    const req = { contents: [{ role: "user" as const, parts: [{ text: "Hello" }] }] };
    const bodyStr = buildCloudRequestBody({
      config,
      model: "gemini-2.5-pro",
      request: req,
      token: "fake-token",
      signal: new AbortController().signal,
    });
    expect(JSON.parse(bodyStr)).toEqual(req);
  });
});

describe("callCloudAntigravity", () => {
  it("streams and unwraps CCPA response chunks", async () => {
    const config = resolveAntigravityConfig(undefined);
    const ssePayload =
      'data: {"response": {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}}\n\n' +
      'data: {"response": {"candidates":[{"content":{"parts":[{"text":" there"}]},"finishReason":"STOP"}]}}\n\n';

    const mockFetch: typeof fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ssePayload));
          controller.close();
        },
      });
      return await Promise.resolve(new Response(stream, { status: 200 }));
    };

    const chunks = [];
    for await (const chunk of callCloudAntigravity(
      {
        config,
        model: "claude-sonnet-5-5-high",
        request: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
        token: "fake-token",
        signal: new AbortController().signal,
      },
      mockFetch,
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({ text: "Hi" });
    expect(chunks[1]?.candidates?.[0]?.finishReason).toBe("STOP");
  });

  it("throws on non-200 responses", async () => {
    const config = resolveAntigravityConfig(undefined);
    const mockFetch: typeof fetch = async () => await Promise.resolve(new Response("Unauthorized", { status: 401 }));

    await expect(async () => {
      const iter = callCloudAntigravity(
        {
          config,
          model: "claude-sonnet-5-5-high",
          request: { contents: [] },
          token: "fake-token",
          signal: new AbortController().signal,
        },
        mockFetch,
      );
      await iter[Symbol.asyncIterator]().next();
    }).rejects.toThrow(/Google Antigravity API error \(401\)/);
  });
});

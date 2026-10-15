import { describe, expect, it } from "vitest";

import { buildCloudHeaders, buildCloudUrl, callCloudAntigravity } from "./cloudUpstream";
import { resolveAntigravityConfig } from "./translate";

describe("buildCloudUrl", () => {
  it("builds Gemini API URL by default", () => {
    const config = resolveAntigravityConfig(undefined);
    expect(buildCloudUrl(config, "gemini-2.5-pro")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
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

  it("uses custom endpoint when configured", () => {
    const config = resolveAntigravityConfig({
      cloud: { endpoint: "https://my-proxy.internal" },
    });
    expect(buildCloudUrl(config, "gemini-2.5-pro")).toBe(
      "https://my-proxy.internal/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
  });
});

describe("buildCloudHeaders", () => {
  it("builds apiKey header", () => {
    const headers = buildCloudHeaders("my-key", "apiKey");
    expect(headers).toEqual({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "x-goog-api-key": "my-key",
    });
  });

  it("builds bearer authorization header by default", () => {
    const headers = buildCloudHeaders("my-bearer-token", "bearer");
    expect(headers).toEqual({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: "Bearer my-bearer-token",
    });
  });
});

describe("callCloudAntigravity", () => {
  it("streams and parses SSE data chunks", async () => {
    const config = resolveAntigravityConfig(undefined);
    const ssePayload =
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":" there"}]},"finishReason":"STOP"}]}\n\n';

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
        model: "gemini-2.5-pro",
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
          model: "gemini-2.5-pro",
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

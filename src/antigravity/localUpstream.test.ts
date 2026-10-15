import { describe, expect, it } from "vitest";

import { callLocalAntigravity, type AcpConnection } from "./localUpstream";
import { resolveAntigravityConfig } from "./translate";

describe("callLocalAntigravity", () => {
  it("communicates with an ACP server and yields parsed chunks", async () => {
    const sentMessages: unknown[] = [];
    const config = resolveAntigravityConfig({
      mode: "local",
      local: { command: ["fake-acp"] },
    });

    async function* fakeLines() {
      await Promise.resolve();
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "1.0" } });
      yield JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { delta: { text: "Hello from ACP" } },
      });
      yield JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          delta: { toolCall: { id: "c1", name: "bash_cmd", arguments: '{"cmd":"date"}' } },
          finishReason: "STOP",
        },
      });
    }

    const mockConnector = (): AcpConnection => ({
      send: (msg) => {
        sentMessages.push(msg);
      },
      lines: fakeLines(),
      close: () => undefined,
    });

    const chunks = [];
    for await (const chunk of callLocalAntigravity({
      config,
      model: "gemini-2.5-pro",
      request: { contents: [] },
      signal: new AbortController().signal,
      connector: mockConnector,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({ text: "Hello from ACP" });
    expect(chunks[1]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
      functionCall: { name: "bash_cmd", args: { cmd: "date" } },
    });
    expect(chunks[1]?.candidates?.[0]?.finishReason).toBe("STOP");

    expect(sentMessages).toHaveLength(2);
    expect((sentMessages[0] as { method: string }).method).toBe("initialize");
    expect((sentMessages[1] as { method: string }).method).toBe("session/prompt");
  });
});

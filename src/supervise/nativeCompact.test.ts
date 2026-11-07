import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compactInSession, nativeCompactionReady, RESULT_POLL_MS } from "./nativeCompact";
import { stageNativeCompactionPlugin } from "./nativeCompactionPlugin";

describe("the live compaction request", () => {
  it("waits for its own result and removes the request afterwards", async () => {
    const plugin = stageNativeCompactionPlugin();
    try {
      expect(nativeCompactionReady(plugin)).toBe(false);
      writeFileSync(plugin.ready, "{}");
      writeFileSync(plugin.result, JSON.stringify({ id: "old", tokensBefore: 999 }));
      const pending = compactInSession(plugin, "conversation", new AbortController().signal);
      const request: unknown = JSON.parse(readFileSync(plugin.request, "utf8"));
      if (typeof request !== "object" || request === null || !("id" in request) || typeof request.id !== "string") throw new Error("request missing id");
      writeFileSync(plugin.result, JSON.stringify({ id: request.id, kind: "compacted", tokensBefore: 100, tokensAfter: 20 }));
      await expect(pending).resolves.toEqual({ kind: "compacted", beforeTokens: 100, afterTokens: 20 });
      expect(readFileSync(plugin.request, "utf8")).toBe("{}");
    } finally {
      plugin.release();
    }
  });

  it("holds the request while the plugin reports an in-flight compaction", async () => {
    const plugin = stageNativeCompactionPlugin();
    try {
      writeFileSync(plugin.ready, "{}");
      const controller = new AbortController();
      const pending = compactInSession(plugin, "conversation", controller.signal);
      const request: unknown = JSON.parse(readFileSync(plugin.request, "utf8"));
      if (typeof request !== "object" || request === null || !("id" in request) || typeof request.id !== "string") throw new Error("request missing id");
      writeFileSync(plugin.result, JSON.stringify({ id: request.id, kind: "running" }));
      await new Promise((resolve) => { setTimeout(resolve, RESULT_POLL_MS + RESULT_POLL_MS); });
      expect(existsSync(plugin.request)).toBe(true);
      writeFileSync(plugin.result, JSON.stringify({ id: request.id, kind: "compacted" }));
      await expect(pending).resolves.toEqual({ kind: "compacted" });
    } finally {
      plugin.release();
    }
  });

  it("fails closed if the plugin did not load and cancels a wait when the child exits", async () => {
    const plugin = stageNativeCompactionPlugin();
    try {
      await expect(compactInSession(plugin, "conversation", new AbortController().signal)).rejects.toThrow("did not load");
      writeFileSync(plugin.ready, "{}");
      const controller = new AbortController();
      const pending = compactInSession(plugin, "conversation", controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(readFileSync(plugin.request, "utf8")).toBe("{}");
    } finally {
      plugin.release();
    }
  });
});

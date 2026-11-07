import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { stageNativeCompactionPlugin, withNativeCompactionPlugin } from "./nativeCompactionPlugin";

describe("the native compaction plugin", () => {
  it("preserves existing plugin options and positional arguments", () => {
    expect(withNativeCompactionPlugin(["--plugin-dir", "/user", "--", "prompt"], "/shim")).toEqual(["--plugin-dir", "/user", "--plugin-dir", "/shim", "--", "prompt"]);
  });
  it("recovers a running request from the post-compaction event after a reload", async () => {
    const plugin = stageNativeCompactionPlugin();
    try {
      const module: unknown = await import(pathToFileURL(path.join(plugin.directory, "hooks", "register.js")).href);
      if (typeof module !== "object" || module === null || !("register" in module) || typeof module.register !== "function") throw new Error("plugin did not export register");
      let postCompact: unknown;
      Reflect.apply(module.register, undefined, [(event: string, handler: unknown) => { if (event === "classic.PostCompact") postCompact = handler; }]);
      if (typeof postCompact !== "function") throw new Error("plugin did not register PostCompact");
      let deferred: unknown;
      const write = vi.fn();
      const host = {
        clock: { after: (_ms: number, callback: unknown) => { deferred = callback; } },
        fs: { read: () => JSON.stringify({ id: "request-1", kind: "running" }), write },
      };
      await Reflect.apply(postCompact, undefined, [host, {}, () => "finished"]);
      if (typeof deferred !== "function") throw new Error("plugin did not schedule recovery");
      await Reflect.apply(deferred, undefined, []);
      expect(write).toHaveBeenCalledWith(plugin.result, JSON.stringify({ id: "request-1", kind: "compacted" }));
    } finally {
      plugin.release();
    }
  });

  it("compacts the requested conversation once and reports only the outcome", async () => {
    const plugin = stageNativeCompactionPlugin();
    try {
      const module: unknown = await import(pathToFileURL(path.join(plugin.directory, "hooks", "register.js")).href);
      if (typeof module !== "object" || module === null || !("register" in module) || typeof module.register !== "function") {
        throw new Error("plugin did not export register");
      }
      let start: unknown;
      Reflect.apply(module.register, undefined, [(event: string, handler: unknown) => { if (event === "session.start") start = handler; }]);
      if (typeof start !== "function") throw new Error("plugin did not register session.start");
      let tick: unknown;
      let request = JSON.stringify({ id: "request-1", conversationId: "conversation-1" });
      const write = vi.fn();
      const compact = vi.fn(() => ({ tokensBefore: 100, tokensAfter: 20, messages: ["private"] }));
      const host = {
        clock: { every: (_ms: number, callback: unknown) => { tick = callback; } },
        fs: { read: (file: string) => file === plugin.request ? request : undefined, write },
        session: { id: () => "conversation-1", compact },
      };
      await Reflect.apply(start, undefined, [host, {}, () => "started"]);
      expect(write).toHaveBeenCalledWith(plugin.ready, JSON.stringify({ ready: true }));
      write.mockClear();
      if (typeof tick !== "function") throw new Error("plugin did not schedule its request reader");
      await Reflect.apply(tick, undefined, []);
      await Reflect.apply(tick, undefined, []);
      expect(compact).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith(plugin.result, JSON.stringify({ id: "request-1", kind: "running" }));
      expect(write).toHaveBeenCalledWith(plugin.result, JSON.stringify({ id: "request-1", kind: "compacted", tokensBefore: 100, tokensAfter: 20 }));
      request = JSON.stringify({ id: "request-2", conversationId: "other" });
      await Reflect.apply(tick, undefined, []);
      expect(compact).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenLastCalledWith(plugin.result, expect.stringContaining("the conversation changed before compaction"));
      expect(JSON.parse(readFileSync(path.join(plugin.directory, "hooks", "hooks.json"), "utf8"))).toEqual({ modules: ["./register.js"] });
    } finally {
      plugin.release();
    }
  });
});

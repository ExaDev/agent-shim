import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { stageSessionControlPlugin, withSessionControlPlugin, type SessionControlPlugin } from "./sessionControlPlugin";

/** The plugin's hook for one event, read from the module the stager wrote. */
async function hookOf(plugin: SessionControlPlugin, name: string): Promise<(...args: readonly unknown[]) => unknown> {
  const module: unknown = await import(pathToFileURL(path.join(plugin.directory, "hooks", "register.js")).href);
  if (typeof module !== "object" || module === null || !("register" in module) || typeof module.register !== "function") throw new Error("plugin did not export register");
  let hook: unknown;
  Reflect.apply(module.register, undefined, [(event: string, handler: unknown) => { if (event === name) hook = handler; }]);
  if (typeof hook !== "function") throw new Error(`plugin did not register ${name}`);
  const found = hook;
  return (...args): unknown => {
    const returned: unknown = Reflect.apply(found, undefined, args);
    return returned;
  };
}

/** An in-memory stand-in for the plugin API's files: a map of path to text, listed by directory. */
function memoryFs(files: Map<string, string>) {
  return {
    read: (file: string) => files.get(file),
    write: vi.fn((file: string, text: string) => {
      files.set(file, text);
    }),
    list: (directory: string) => [...files.keys()].filter((file) => path.dirname(file) === directory).map((file) => ({ name: path.basename(file) })),
  };
}

/** The plugin clock's instant in these cases, and an expiry still ahead of it. */
const NOW = 5_000;
const LIVE = NOW + 1;

describe("the in-process control plugin", () => {
  it("preserves existing plugin options and positional arguments", () => {
    expect(withSessionControlPlugin(["--plugin-dir", "/user", "--", "prompt"], "/shim")).toEqual(["--plugin-dir", "/user", "--plugin-dir", "/shim", "--", "prompt"]);
  });

  it("completes a running compaction from the post-compaction event after a reload, and leaves other results alone", async () => {
    const plugin = stageSessionControlPlugin();
    try {
      const postCompact = await hookOf(plugin, "classic.PostCompact");
      const files = new Map([
        [path.join(plugin.results, "a.json"), JSON.stringify({ id: "a", kind: "running", op: "compact" })],
        [path.join(plugin.results, "b.json"), JSON.stringify({ id: "b", kind: "running", op: "goal" })],
      ]);
      let deferred: unknown;
      const fs = memoryFs(files);
      await postCompact({ clock: { after: (_ms: number, callback: unknown) => { deferred = callback; } }, fs }, {}, () => "finished");
      if (typeof deferred !== "function") throw new Error("plugin did not schedule recovery");
      await Reflect.apply(deferred, undefined, []);
      expect(fs.write).toHaveBeenCalledTimes(1);
      expect(files.get(path.join(plugin.results, "a.json"))).toBe(JSON.stringify({ id: "a", kind: "compacted" }));
    } finally {
      plugin.release();
    }
  });

  it("reports its version, runs each request once in name order, refuses an expired one, compacts and runs a goal command, and refuses what it does not perform", async () => {
    const plugin = stageSessionControlPlugin();
    try {
      const start = await hookOf(plugin, "session.start");
      const files = new Map([
        [path.join(plugin.requests, "1.json"), JSON.stringify({ id: "1", op: "compact", conversationId: "conversation-1", instructions: "keep it", expiresAt: LIVE })],
        [path.join(plugin.requests, "2.json"), JSON.stringify({ id: "2", op: "goal", conversationId: "conversation-1", args: "tests pass", expiresAt: LIVE })],
        [path.join(plugin.requests, "3.json"), JSON.stringify({ id: "3", op: "goal", conversationId: "conversation-1", args: "", expiresAt: LIVE })],
        [path.join(plugin.requests, "4.json"), JSON.stringify({ id: "4", op: "compact", conversationId: "other", expiresAt: LIVE })],
        [path.join(plugin.requests, "6.json"), JSON.stringify({ id: "6", op: "goal", conversationId: "conversation-1", args: "late", expiresAt: NOW })],
        [path.join(plugin.requests, ".5.json"), "partial"],
      ]);
      const fs = memoryFs(files);
      const compact = vi.fn(() => ({ tokensBefore: 100, tokensAfter: 20, messages: ["private"] }));
      const run = vi.fn(() => ({ context: ["the directive"] }));
      let tick: unknown;
      await start({ clock: { every: (_ms: number, callback: unknown) => { tick = callback; }, now: () => NOW }, fs, session: { id: () => "conversation-1", compact, version: () => ({ version: "2.1.319" }) }, command: { run } }, {}, () => "started");
      expect(files.get(plugin.ready)).toBe(JSON.stringify({ ready: true, version: "2.1.319" }));
      if (typeof tick !== "function") throw new Error("plugin did not schedule its request reader");
      // One tick per request the fixture holds, plus one that finds nothing left to run.
      const requestCount = [...files.keys()].filter((file) => path.dirname(file) === plugin.requests).length;
      for (let turn = 0; turn <= requestCount; turn += 1) {
        await Reflect.apply(tick, undefined, []);
      }
      expect(compact).toHaveBeenCalledTimes(1);
      expect(compact).toHaveBeenCalledWith({ instructions: "keep it" });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith({ command: "goal", args: "tests pass" });
      expect(files.get(path.join(plugin.results, "1.json"))).toBe(JSON.stringify({ id: "1", kind: "compacted", tokensBefore: 100, tokensAfter: 20 }));
      expect(files.get(path.join(plugin.results, "2.json"))).toBe(JSON.stringify({ id: "2", kind: "ran" }));
      expect(files.get(path.join(plugin.results, "3.json"))).toContain("no operation this plugin performs");
      expect(files.get(path.join(plugin.results, "4.json"))).toContain("the conversation changed before the request ran");
      expect(files.has(path.join(plugin.results, ".5.json"))).toBe(false);
      // A request whose expiry has come is refused, never run, as one a crashed caller left behind is.
      expect(files.get(path.join(plugin.results, "6.json"))).toContain("the request expired");
      expect(JSON.parse(readFileSync(path.join(plugin.directory, "hooks", "hooks.json"), "utf8"))).toEqual({ modules: ["./register.js"] });
    } finally {
      plugin.release();
    }
  });
});

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { compactInSession, RESULT_POLL_MS, runGoalInSession, sessionControlReady, sessionControlVersion } from "./sessionControl";
import { stageSessionControlPlugin, type SessionControlPlugin } from "./sessionControlPlugin";

/** The one request a caller has written, read back as the plugin would read it. */
async function pendingRequest(plugin: SessionControlPlugin): Promise<Record<string, unknown>> {
  for (;;) {
    const names = readdirSync(plugin.requests).filter((name) => !name.startsWith("."));
    const name = names[0];
    if (name !== undefined) {
      const value: unknown = JSON.parse(readFileSync(path.join(plugin.requests, name), "utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request is not an object");
      return { ...value };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, RESULT_POLL_MS);
    });
  }
}

function answer(plugin: SessionControlPlugin, id: unknown, value: Record<string, unknown>): void {
  if (typeof id !== "string") throw new Error("request missing id");
  writeFileSync(path.join(plugin.results, `${id}.json`), JSON.stringify({ id, ...value }));
}

describe("the in-process control requests", () => {
  it("compacts through its own request file, waiting out a running result and removing both files afterwards", async () => {
    const plugin = stageSessionControlPlugin();
    try {
      expect(sessionControlReady(plugin)).toBe(false);
      writeFileSync(plugin.ready, JSON.stringify({ ready: true, version: "2.1.319" }));
      expect(sessionControlVersion(plugin)).toBe("2.1.319");
      const pending = compactInSession(plugin, "conversation", new AbortController().signal, "keep the plan");
      const request = await pendingRequest(plugin);
      expect(request).toMatchObject({ op: "compact", conversationId: "conversation", instructions: "keep the plan" });
      answer(plugin, request.id, { kind: "running", op: "compact" });
      await new Promise((resolve) => {
        setTimeout(resolve, RESULT_POLL_MS + RESULT_POLL_MS);
      });
      answer(plugin, request.id, { kind: "compacted", tokensBefore: 100, tokensAfter: 20 });
      await expect(pending).resolves.toEqual({ kind: "compacted", beforeTokens: 100, afterTokens: 20 });
      expect(readdirSync(plugin.requests)).toEqual([]);
      expect(readdirSync(plugin.results)).toEqual([]);
    } finally {
      plugin.release();
    }
  });

  it("keeps concurrent requests apart, each answered by its own result", async () => {
    const plugin = stageSessionControlPlugin();
    try {
      writeFileSync(plugin.ready, "{}");
      const goal = runGoalInSession(plugin, "conversation", "tests pass", new AbortController().signal);
      const goalRequest = await pendingRequest(plugin);
      const compact = compactInSession(plugin, "conversation", new AbortController().signal);
      let compactRequest: Record<string, unknown> | undefined;
      while (compactRequest === undefined) {
        const names = readdirSync(plugin.requests).filter((name) => !name.startsWith(".") && name !== `${String(goalRequest.id)}.json`);
        const name = names[0];
        if (name !== undefined) {
          const value: unknown = JSON.parse(readFileSync(path.join(plugin.requests, name), "utf8"));
          if (typeof value === "object" && value !== null && !Array.isArray(value)) compactRequest = { ...value };
        } else {
          await new Promise((resolve) => {
            setTimeout(resolve, RESULT_POLL_MS);
          });
        }
      }
      answer(plugin, compactRequest.id, { kind: "unchanged", skip: "Not enough messages to compact." });
      answer(plugin, goalRequest.id, { kind: "ran" });
      await expect(compact).resolves.toEqual({ kind: "unchanged", reason: "Not enough messages to compact." });
      await expect(goal).resolves.toEqual({});
      expect(goalRequest).toMatchObject({ op: "goal", args: "tests pass" });
    } finally {
      plugin.release();
    }
  });

  it("refuses a bare goal command, fails closed when the plugin did not load, carries a plugin error and cancels a wait on abort", async () => {
    const plugin = stageSessionControlPlugin();
    try {
      await expect(compactInSession(plugin, "conversation", new AbortController().signal)).rejects.toThrow("did not load");
      writeFileSync(plugin.ready, "{}");
      await expect(runGoalInSession(plugin, "conversation", "  ", new AbortController().signal)).rejects.toThrow("bare /goal");
      const failing = runGoalInSession(plugin, "conversation", "clear", new AbortController().signal);
      answer(plugin, (await pendingRequest(plugin)).id, { error: "the conversation changed before the request ran" });
      await expect(failing).rejects.toThrow("the conversation changed");
      const controller = new AbortController();
      const pending = compactInSession(plugin, "conversation", controller.signal);
      await pendingRequest(plugin);
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(readdirSync(plugin.requests)).toEqual([]);
      expect(existsSync(plugin.ready)).toBe(true);
    } finally {
      plugin.release();
    }
  });
});

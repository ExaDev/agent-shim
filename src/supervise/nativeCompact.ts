import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import type { NativeCompactionPlugin } from "./nativeCompactionPlugin";
import type { CompactionResult } from "./realCompact";

/** How often the supervisor reads a result from the in-process plugin, which runs on its own event loop. */
export const RESULT_POLL_MS = 250;

/** Whether this launch's plugin has acknowledged that Claude loaded it. */
export function nativeCompactionReady(plugin: Readonly<NativeCompactionPlugin>): boolean {
  return existsSync(plugin.ready);
}

/** Asks the live Claude process to compact its current conversation. Aborting stops the wait after that child has exited. */
export async function compactInSession(plugin: Readonly<NativeCompactionPlugin>, conversationId: string, signal: AbortSignal): Promise<CompactionResult> {
  if (!nativeCompactionReady(plugin)) throw new Error("the in-process compaction plugin did not load");
  signal.throwIfAborted();
  const id = randomUUID();
  const temporary = `${plugin.request}.${id}`;
  writeFileSync(temporary, JSON.stringify({ id, conversationId }), { mode: 0o600 });
  renameSync(temporary, plugin.request);
  try {
    while (!signal.aborted) {
      signal.throwIfAborted();
      if (existsSync(plugin.result)) {
        let value: unknown;
        try {
          value = JSON.parse(readFileSync(plugin.result, "utf8"));
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (typeof value === "object" && value !== null && "id" in value && value.id === id) {
          if ("error" in value && typeof value.error === "string") throw new Error(value.error);
          if ("kind" in value && value.kind === "unchanged" && "skip" in value && typeof value.skip === "string") return { kind: "unchanged", reason: value.skip };
          if ("kind" in value && value.kind === "running") {
            await sleep(RESULT_POLL_MS, undefined, { signal });
            continue;
          }
          if (!("kind" in value) || value.kind !== "compacted") throw new Error("the compaction plugin returned an invalid result");
          const beforeTokens = "tokensBefore" in value && typeof value.tokensBefore === "number" ? value.tokensBefore : undefined;
          const afterTokens = "tokensAfter" in value && typeof value.tokensAfter === "number" ? value.tokensAfter : undefined;
          return { kind: "compacted", ...(beforeTokens === undefined ? {} : { beforeTokens }), ...(afterTokens === undefined ? {} : { afterTokens }) };
        }
      }
      await sleep(RESULT_POLL_MS, undefined, { signal });
    }
    signal.throwIfAborted();
    throw new Error("compaction wait ended unexpectedly");
  } finally {
    writeFileSync(plugin.request, "{}", { mode: 0o600 });
  }
}

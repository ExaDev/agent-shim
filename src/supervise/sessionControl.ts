import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { CompactionResult } from "./realCompact";
import type { SessionControlPlugin } from "./sessionControlPlugin";

/** How often a caller reads a result from the in-process plugin, which runs on its own event loop. */
export const RESULT_POLL_MS = 250;

/** The paths a caller of the plugin uses: the plugin's own layout, without the stager's release. */
type PluginPaths = Pick<SessionControlPlugin, "ready" | "requests" | "results">;

/** Whether this launch's plugin has acknowledged that Claude loaded it. */
export function sessionControlReady(plugin: Readonly<PluginPaths>): boolean {
  return existsSync(plugin.ready);
}

/** The Claude Code version the plugin reported when it loaded (from `$.session.version()`), or undefined when it has not loaded or wrote none. */
export function sessionControlVersion(plugin: Readonly<PluginPaths>): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(plugin.ready, "utf8"));
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && "version" in value && typeof value.version === "string" ? value.version : undefined;
}

/**
 * Sends one request to the plugin and waits for its outcome: writes `requests/<id>.json` atomically with the instant it stops being runnable, polls `results/<id>.json` until it holds something other than `running`, and removes both files whatever happens, so no request is left for the plugin to run later. A request a crash leaves behind is refused by the plugin once its expiry passes. A plugin error is thrown as an `Error` carrying its message. Aborting stops the wait.
 */
/** How one request is sent: the caller's signal, and how long the request stays runnable, after which the plugin refuses it rather than run it for a caller long gone. */
export interface SessionControlRequestOptions {
  readonly signal: AbortSignal;
  readonly expiresInMs: number;
  /** The clock the expiry is reckoned from: `Date.now` in production. */
  readonly now?: () => number;
}

/** The width an epoch-millisecond instant is padded to in a request's name: the digits `Number.MAX_SAFE_INTEGER` has, so every instant a clock can give sorts as a fixed-width string. */
const REQUEST_INSTANT_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

/** A request's id: the instant it was made, zero-padded so names sort by it, then a random part that keeps two made in the same millisecond apart. The plugin runs requests in name order, so the oldest runs first, whichever process (the supervisor or the door) made it. */
function requestIdOf(nowMs: number): string {
  return `${String(nowMs).padStart(REQUEST_INSTANT_DIGITS, "0")}-${randomUUID()}`;
}

/**
 * Removes every result whose request is gone: one the plugin wrote after its caller had given up and removed the request (an abort, or a wait that passed while the plugin was mid-run), which nothing else would ever read. A caller removes its request before its result, so a result with no request belongs to no live caller.
 */
function removeOrphanResults(plugin: Readonly<PluginPaths>): void {
  const requests = new Set(readdirSync(plugin.requests));
  for (const name of readdirSync(plugin.results)) {
    if (!requests.has(name)) {
      rmSync(path.join(plugin.results, name), { force: true });
    }
  }
}

async function requestInSession(plugin: Readonly<PluginPaths>, body: Readonly<Record<string, unknown>>, options: SessionControlRequestOptions): Promise<Readonly<Record<string, unknown>>> {
  const { signal } = options;
  const nowMs = (options.now ?? Date.now)();
  if (!sessionControlReady(plugin)) throw new Error("the in-process control plugin did not load");
  signal.throwIfAborted();
  removeOrphanResults(plugin);
  const id = requestIdOf(nowMs);
  const request = path.join(plugin.requests, `${id}.json`);
  const result = path.join(plugin.results, `${id}.json`);
  const temporary = path.join(plugin.requests, `.${id}.json`);
  writeFileSync(temporary, JSON.stringify({ ...body, id, expiresAt: nowMs + options.expiresInMs }), { mode: 0o600 });
  renameSync(temporary, request);
  try {
    for (;;) {
      signal.throwIfAborted();
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(result, "utf8"));
      } catch (error) {
        // Absent until the plugin reaches the request, and briefly unparsable while it is written.
        if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value) && "id" in value && value.id === id) {
        const outcome: Record<string, unknown> = { ...value };
        if (typeof outcome.error === "string") throw new Error(outcome.error);
        if (outcome.kind !== "running") return outcome;
      }
      await sleep(RESULT_POLL_MS, undefined, { signal });
    }
  } finally {
    rmSync(request, { force: true });
    rmSync(result, { force: true });
  }
}

/** Asks the live Claude process to compact its current conversation, with the summary instructions when given. Aborting stops the wait; the request expires after `options.expiresInMs`. */
export async function compactInSession(plugin: Readonly<PluginPaths>, conversationId: string, options: SessionControlRequestOptions, instructions?: string): Promise<CompactionResult> {
  const value = await requestInSession(plugin, { op: "compact", conversationId, ...(instructions === undefined ? {} : { instructions }) }, options);
  if (value.kind === "unchanged" && typeof value.skip === "string") return { kind: "unchanged", reason: value.skip };
  if (value.kind !== "compacted") throw new Error("the control plugin returned an invalid compaction result");
  const beforeTokens = typeof value.tokensBefore === "number" ? value.tokensBefore : undefined;
  const afterTokens = typeof value.tokensAfter === "number" ? value.tokensAfter : undefined;
  return { kind: "compacted", ...(beforeTokens === undefined ? {} : { beforeTokens }), ...(afterTokens === undefined ? {} : { afterTokens }) };
}

/** Asks the live Claude process to run `/goal <args>` as if the person typed it; `args` is a condition or a clear word, never empty (a bare `/goal` opens an interactive panel). Resolves once the command has run, with the text it printed when the plugin API returned one; the goal's effect is read from the transcript. */
export async function runGoalInSession(plugin: Readonly<PluginPaths>, conversationId: string, args: string, options: SessionControlRequestOptions): Promise<{ readonly text?: string }> {
  if (args.trim() === "") throw new Error("a goal command run in process needs an argument: a bare /goal opens an interactive panel");
  const value = await requestInSession(plugin, { op: "goal", conversationId, args }, options);
  if (value.kind !== "ran") throw new Error("the control plugin returned an invalid goal result");
  return typeof value.text === "string" ? { text: value.text } : {};
}

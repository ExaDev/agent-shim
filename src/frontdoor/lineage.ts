import { createHash } from "node:crypto";

/**
 * Where a messages request sits in its conversation thread, as hashes of its own history.
 *
 * `ownKey` identifies the request's whole history; `parentKey` identifies the history one turn earlier (everything but the newest assistant and user message), which is exactly what the thread's previous request carried. A response can therefore be matched with the response that preceded it in its own thread even when a subagent or a fork is answering in between under the same launch session id.
 */
export interface Lineage {
  readonly ownKey: string;
  /** Absent for a request with too few messages to have a previous turn. */
  readonly parentKey: string | undefined;
}

/** The marker Claude Code moves from request to request to say where the cache breakpoint is. It changes nothing about the content, so it is left out of every hash: otherwise a thread's history would hash differently each turn. */
const CACHE_MARKER_KEY = "cache_control";

/** How many of the newest messages separate a request's history from the previous request's: the assistant reply and the user message that followed it. */
const MESSAGES_PER_TURN = 2;

function stable(value: unknown): string {
  return JSON.stringify(value, (key: string, inner: unknown) => (key === CACHE_MARKER_KEY ? undefined : inner));
}

/** The lineage of a messages request body, or undefined when it is not a messages request body (not JSON, or without a messages array). */
export function lineageOf(body: Buffer): Lineage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("messages" in parsed) || !Array.isArray(parsed.messages)) {
    return undefined;
  }
  const messages: unknown[] = parsed.messages;
  const hash = createHash("sha256");
  // What precedes the messages and so belongs to every one of them: a subagent's system prompt and tools are what tell it apart from the thread that spawned it.
  hash.update(stable({ model: "model" in parsed ? parsed.model : undefined, system: "system" in parsed ? parsed.system : undefined, tools: "tools" in parsed ? parsed.tools : undefined }));
  const parentLength = messages.length - MESSAGES_PER_TURN;
  let parentKey: string | undefined;
  for (const [index, message] of messages.entries()) {
    if (index === parentLength && parentLength > 0) {
      parentKey = hash.copy().digest("hex");
    }
    hash.update(stable(message));
  }
  return { ownKey: hash.digest("hex"), parentKey };
}

import { open, stat } from "node:fs/promises";

import { goalAfterLine, type TranscriptGoal } from "./sessionGoal";

/**
 * What the front door reads out of a supervised session's transcript, kept up to date by reading only what was appended since the last read: the transcript is append-only JSON Lines, and a live one grows every turn, so reading the whole file each time would put a read the size of the conversation on the door's event loop for every goal or compaction verb.
 *
 * Two facts are kept: the bridge session id the latest `bridge-session` row names, which joins a Remote Control session to its supervised launch, and the goal the `goal_status` rows leave active (`sessionGoal.ts`). A file that shrank since the last read (a transcript rewritten in place) is read again from the start.
 */

/** The facts the transcript states as of its last read. */
interface TranscriptFacts {
  readonly bridgeSessionId: string | undefined;
  readonly goal: TranscriptGoal | null;
}

/** How a follower reads a file: its size, and the bytes from an offset to the end. In production both are asynchronous file reads; tests read an in-memory file. */
export interface TranscriptReadPort {
  /** The file's size in bytes, or undefined when it does not exist. */
  readonly sizeOf: (path: string) => Promise<number | undefined>;
  /** The bytes from `start` (inclusive) to `end` (exclusive). */
  readonly readRange: (path: string, start: number, end: number) => Promise<Buffer>;
}

/** The line break JSON Lines separates rows with, as a byte. */
const NEWLINE = 0x0a;

/** The bridge session id one transcript line states, when it is a `bridge-session` row; only whole rows of that type count, since the same key and value inside a tool call's input or result is text a model could have written, never the CLI's own record. Claude Code writes the row (`{"type":"bridge-session","sessionId":<local>,"bridgeSessionId":<cse_ id>,...}`) each time the bridge's sequence cursor advances, and a fresh one after a reconnect. */
function bridgeSessionIdOfLine(line: string): string | undefined {
  if (!line.includes('"bridge-session"')) {
    return undefined;
  }
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  return typeof row === "object" && row !== null && "type" in row && row.type === "bridge-session" && "bridgeSessionId" in row && typeof row.bridgeSessionId === "string" ? row.bridgeSessionId : undefined;
}

/** One followed file: how many bytes have been read, the bytes of a last line still being written, and the facts the complete lines stated. */
interface Followed {
  readonly size: number;
  readonly carry: Buffer;
  readonly facts: TranscriptFacts;
}

/** The facts after one complete line. */
function factsAfterLine(facts: TranscriptFacts, line: string): TranscriptFacts {
  return { bridgeSessionId: bridgeSessionIdOfLine(line) ?? facts.bridgeSessionId, goal: goalAfterLine(facts.goal, line) };
}

/** The facts of an empty transcript. */
const NO_FACTS: TranscriptFacts = { bridgeSessionId: undefined, goal: null };

/** A transcript follower: `factsOf` reads a transcript's appended bytes since the last call for the same path and returns its facts, or undefined when the file does not exist. */
export interface TranscriptFollower {
  readonly factsOf: (path: string) => Promise<TranscriptFacts | undefined>;
}

/** Creates a follower over `port`. One per door process; it holds one small record per transcript it has read. */
export function createTranscriptFollower(port: TranscriptReadPort): TranscriptFollower {
  const followed = new Map<string, Followed>();
  return {
    factsOf: async (path) => {
      const size = await port.sizeOf(path);
      if (size === undefined) {
        followed.delete(path);
        return undefined;
      }
      const known = followed.get(path);
      const from = known === undefined || size < known.size ? { size: 0, carry: Buffer.alloc(0), facts: NO_FACTS } : known;
      if (size === from.size) {
        return from.facts;
      }
      const bytes = Buffer.concat([from.carry, await port.readRange(path, from.size, size)]);
      // Only complete lines are read; the bytes after the last line break are a row still being written, kept for the next read so a multi-byte character or a row is never split.
      const lastBreak = bytes.lastIndexOf(NEWLINE);
      const complete = lastBreak === -1 ? Buffer.alloc(0) : bytes.subarray(0, lastBreak);
      const carry = lastBreak === -1 ? bytes : Buffer.from(bytes.subarray(lastBreak + 1));
      const facts = complete.length === 0 ? from.facts : complete.toString("utf8").split("\n").reduce(factsAfterLine, from.facts);
      followed.set(path, { size, carry, facts });
      return facts;
    },
  };
}

/** The real read port: asynchronous size and range reads, so the door's event loop never blocks on a transcript. */
export const realTranscriptReadPort: TranscriptReadPort = {
  sizeOf: async (path) => {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
  readRange: async (path, start, end) => {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

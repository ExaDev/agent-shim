import { createHash, type Hash } from "node:crypto";

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

/** The marker Claude Code moves from request to request to say where the cache breakpoint is. It changes nothing about the content, so its member is left out of every hash: otherwise a thread's history would hash differently each turn. */
const CACHE_MARKER_KEY = '"cache_control"';

/** The top-level members that tell a thread from another with the same messages: a subagent's system prompt and tools, and the model. Other members (limits, streaming flags, metadata) say nothing about the thread and may differ between requests of one. */
const THREAD_MEMBER_KEYS: ReadonlySet<string> = new Set(['"model"', '"system"', '"tools"']);

const MESSAGES_KEY = '"messages"';

/** The depth the messages array's own brackets sit at: the root object is depth one, and the array is its value. */
const MESSAGES_ARRAY_DEPTH = 2;

/** How many of the newest messages separate a request's history from the previous request's: the assistant reply and the user message that followed it. */
const MESSAGES_PER_TURN = 2;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;
const SEPARATOR = Buffer.from([0]);

const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function isWhitespace(byte: number): boolean {
  return byte === SPACE || byte === TAB || byte === LINE_FEED || byte === CARRIAGE_RETURN;
}

const STRING = 1;
const OPEN = 2;
const CLOSE = 3;
const COLON_TOKEN = 4;
const COMMA_TOKEN = 5;
const SCALAR = 6;
const END = 0;

/** Where the token `nextToken` last returned begins and ends. Module state rather than an object per token: a body can hold millions of tokens and the walk must not allocate for each. */
let tokenStart = 0;
let tokenEnd = 0;

/** Reads the next token at or after `from` and returns its kind (END at the end of the text), leaving its bounds in `tokenStart` and `tokenEnd`. */
function nextToken(body: Buffer, from: number): number {
  let index = from;
  while (index < body.length && isWhitespace(body[index] ?? 0)) {
    index += 1;
  }
  if (index >= body.length) {
    return END;
  }
  tokenStart = index;
  const byte = body[index] ?? 0;
  if (byte === QUOTE) {
    let end = index + 1;
    while (end < body.length && body[end] !== QUOTE) {
      end += body[end] === BACKSLASH ? 2 : 1;
    }
    tokenEnd = Math.min(end + 1, body.length);
    return STRING;
  }
  tokenEnd = index + 1;
  if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
    return OPEN;
  }
  if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
    return CLOSE;
  }
  if (byte === COLON) {
    return COLON_TOKEN;
  }
  if (byte === COMMA) {
    return COMMA_TOKEN;
  }
  while (tokenEnd < body.length) {
    const next = body[tokenEnd] ?? 0;
    if (isWhitespace(next) || next === COMMA || next === CLOSE_BRACE || next === CLOSE_BRACKET || next === COLON) {
      break;
    }
    tokenEnd += 1;
  }
  return SCALAR;
}

/** What one walk over a body found. */
interface Walk {
  readonly sawMessages: boolean;
  readonly elements: number;
  readonly threadDigest: string;
  readonly messagesDigest: string;
  /** The messages hash as it stood after `parentAfter` elements, when that many were given and the walk got there. */
  readonly parentDigest: string | undefined;
}

/**
 * Walks the body token by token. With `hashing` off it only counts the messages array's elements; with it on it also hashes the thread members and the messages, snapshotting the messages hash once, after `parentAfter` elements. Never builds objects, so the work is linear in the body and the memory constant.
 */
function walk(body: Buffer, hashing: boolean, parentAfter: number | undefined): Walk {
  const thread: Hash = createHash("sha256");
  const messages: Hash = createHash("sha256");
  let parentDigest: string | undefined;
  let elements = 0;
  let depth = 0;
  // The top-level key whose value is being read, and whether that value is the messages array.
  let topKey: string | undefined;
  let inMessages = false;
  let sawMessages = false;
  // True when the next string at an object level is a key: just after `{` or `,`.
  const expectKey: boolean[] = [];
  let skipUntilDepth: number | undefined;
  let skipNextValue = false;

  const elementEnded = (): void => {
    elements += 1;
    if (hashing && parentAfter !== undefined && elements === parentAfter) {
      parentDigest = messages.copy().digest("hex");
    }
  };

  let cursor = 0;
  for (;;) {
    const kind = nextToken(body, cursor);
    if (kind === END) {
      break;
    }
    const start = tokenStart;
    const end = tokenEnd;
    cursor = end;

    if (skipUntilDepth !== undefined) {
      if (kind === OPEN) {
        depth += 1;
      } else if (kind === CLOSE) {
        depth -= 1;
        if (depth === skipUntilDepth) {
          skipUntilDepth = undefined;
        }
      }
      continue;
    }
    if (kind === COMMA_TOKEN) {
      if (depth >= 1) {
        expectKey[depth - 1] = true;
      }
      continue;
    }
    if (kind === COLON_TOKEN) {
      if (depth >= 1) {
        expectKey[depth - 1] = false;
      }
      if (skipNextValue) {
        // The cache marker's value follows: a container is skipped to its end, a scalar is the next token alone.
        skipNextValue = false;
        const valueKind = nextToken(body, cursor);
        if (valueKind !== END) {
          cursor = tokenEnd;
          if (valueKind === OPEN) {
            skipUntilDepth = depth;
            depth += 1;
          }
        }
      }
      continue;
    }
    const isKey = kind === STRING && depth >= 1 && expectKey[depth - 1] === true;
    // Only a key's text is ever needed, so only a key is turned into a string.
    const text = isKey ? body.toString("latin1", start, end) : undefined;
    if (isKey && text === CACHE_MARKER_KEY) {
      skipNextValue = true;
      continue;
    }
    if (depth === 1 && isKey) {
      topKey = text;
    }
    // The bracket that closes the messages array belongs to no message: a request's history must hash the same whether or not more messages follow it, or the previous request's key would never equal a later request's parent key.
    const closesMessages = kind === CLOSE && inMessages && depth === MESSAGES_ARRAY_DEPTH;
    if (hashing && !closesMessages && !(depth === 1 && isKey && !THREAD_MEMBER_KEYS.has(text ?? ""))) {
      const target: Hash | undefined = inMessages ? messages : depth >= 1 && topKey !== undefined && THREAD_MEMBER_KEYS.has(topKey) ? thread : undefined;
      if (target !== undefined) {
        target.update(body.subarray(start, end));
        target.update(SEPARATOR);
      }
    }

    if (kind === OPEN) {
      const startsMessages = depth === 1 && topKey === MESSAGES_KEY && body[start] === OPEN_BRACKET && !sawMessages;
      depth += 1;
      expectKey.push(body[start] === OPEN_BRACE);
      if (startsMessages) {
        inMessages = true;
        sawMessages = true;
      }
    } else if (kind === CLOSE) {
      expectKey.pop();
      depth -= 1;
      if (inMessages && depth === 1) {
        inMessages = false;
      } else if (inMessages && depth === 2) {
        elementEnded();
      }
    } else if (inMessages && depth === 2 && kind === SCALAR) {
      elementEnded();
    }
    if (depth < 0) {
      break;
    }
  }
  return { sawMessages, elements, threadDigest: thread.digest("hex"), messagesDigest: messages.digest("hex"), parentDigest };
}

/**
 * The lineage of a messages request body, or undefined when it is not one (no top-level `messages` array).
 *
 * The body is walked token by token and hashed as it goes, never parsed into objects, so the work is linear in its size and the memory constant however many messages or nested values it holds: the door reads these bodies from clients it does not otherwise vet. Commas are left out of the hashed stream and the cache marker's member is skipped, which makes the key a function of the content alone. Two walks, because the parent key needs the messages hash as it stood two elements before the end, which is only known once the end has been counted.
 */
export function lineageOf(body: Buffer): Lineage | undefined {
  const counted = walk(body, false, undefined);
  if (!counted.sawMessages) {
    return undefined;
  }
  const parentAfter = counted.elements > MESSAGES_PER_TURN ? counted.elements - MESSAGES_PER_TURN : undefined;
  const hashed = walk(body, true, parentAfter);
  const combine = (messagesDigest: string): string => createHash("sha256").update(hashed.threadDigest).update(messagesDigest).digest("hex");
  return { ownKey: combine(hashed.messagesDigest), parentKey: hashed.parentDigest === undefined ? undefined : combine(hashed.parentDigest) };
}

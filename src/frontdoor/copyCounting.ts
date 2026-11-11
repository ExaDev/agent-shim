import { vi } from "vitest";

/** Counts of the copies of a request body a piece of the door makes, at two body sizes: what a body costs the door is how many times it is copied, which does not depend on its size, so it is counted and never timed. */

const KIB = 1024;
const BASE_KIB = 256;
const SCALE = 4;
const CHUNK_KIB = 64;
/** Two body sizes whose ratio is large enough that a copy per byte shows and a copy per request does not. */
const BASE_BYTES = BASE_KIB * KIB;
export const SIZES_BYTES: readonly number[] = [BASE_BYTES, SCALE * BASE_BYTES];
/** A copy of at least this share of the body counts as a copy of the body: the model name, the tool spans and the framing around them are never that large. */
const COPY_SHARE = 0.9;
/** The size of the chunks a body arrives in. */
const CHUNK_BYTES = CHUNK_KIB * KIB;

/** The body, in chunks the way a socket delivers it, of a Messages request that names `model` and holds `bytes` of message text. */
export function bodyOf(bytes: number, model = "auto"): readonly Buffer[] {
  const text = Buffer.from(`{"model":${JSON.stringify(model)},"max_tokens":16,"tools":[{"type":"web_search_20250305","name":"web_search"},{"name":"edit","input_schema":{}}],"messages":[{"role":"user","content":"${"x".repeat(bytes)}"}]}`);
  const chunks: Buffer[] = [];
  for (let at = 0; at < text.length; at += CHUNK_BYTES) chunks.push(text.subarray(at, at + CHUNK_BYTES));
  return chunks;
}

/**
 * How many times each of the calls that copy a buffer made a copy as large as the body while `run` ran: `Buffer.concat` joining chunks or slices, `Buffer#toString` decoding it to a string, `Buffer.from` making one from a string or another buffer.
 */
export async function copiesDuring(bodyBytes: number, run: () => Promise<void>): Promise<{ readonly concat: number; readonly decode: number; readonly from: number }> {
  const floor = Math.floor(bodyBytes * COPY_SHARE);
  const counts = { concat: 0, decode: 0, from: 0 };
  const concat = Buffer.concat.bind(Buffer);
  vi.spyOn(Buffer, "concat").mockImplementation((list, length) => {
    const joined = concat(list, length);
    if (joined.length >= floor) counts.concat += 1;
    return joined;
  });
  // `Buffer#toString` is replaced on the prototype itself (a spy cannot be typed over it), and put back below.
  const proto = Reflect.getPrototypeOf(Buffer.alloc(0));
  if (proto === null) throw new Error("a buffer has a prototype");
  const decode: unknown = Reflect.get(proto, "toString");
  if (typeof decode !== "function") throw new TypeError("Buffer#toString is a function");
  Reflect.set(proto, "toString", function counted(this: Buffer, ...args: readonly unknown[]): unknown {
    if (this.length >= floor) counts.decode += 1;
    const text: unknown = Reflect.apply(decode, this, args);
    return text;
  });
  const from = Buffer.from.bind(Buffer);
  vi.spyOn(Buffer, "from").mockImplementation((...args: Parameters<typeof Buffer.from>) => {
    const made = from(...args);
    if (made.length >= floor) counts.from += 1;
    return made;
  });
  try {
    await run();
  } finally {
    Reflect.set(proto, "toString", decode);
    vi.restoreAllMocks();
  }
  return counts;
}

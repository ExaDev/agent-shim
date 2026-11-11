import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoutedRequest } from "./route";
import * as topLevelModelWalk from "./topLevelModel";
import { REQUEST_SCAN_CAP_BYTES, scanRequestHead } from "./requestScan";

function requestOver(body: Readable): RoutedRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: {},
    body,
    signal: new AbortController().signal,
    session: { identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined },
  };
}

/** Lets the stream machinery deliver the error and close events queued by a destroy. */
async function drainTicks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** What a client abort does to a server request body: an `aborted` error with code ECONNRESET. */
class AbortedError extends Error {
  readonly code = "ECONNRESET";

  constructor() {
    super("aborted");
  }
}

function abortError(): Error {
  return new AbortedError();
}

describe("scanRequestHead when the client aborts the body", () => {
  const uncaught: Error[] = [];
  const record = (error: Error): void => {
    uncaught.push(error);
  };
  process.on("uncaughtException", record);
  afterEach(() => {
    uncaught.length = 0;
  });

  it("does not raise an unhandled error after the head decided the route", async () => {
    const body = new PassThrough();
    const scan = await (async () => {
      const pending = scanRequestHead(requestOver(body));
      body.write(Buffer.from('{"model":"claude-test","max_tokens":1,'));
      return await pending;
    })();
    expect(scan.model).toBe("claude-test");
    body.destroy(abortError());
    await drainTicks();
    expect(uncaught).toEqual([]);
  });

  it("settles with what it read, and raises nothing, when the body aborts before the model field", async () => {
    const body = new PassThrough();
    const pending = scanRequestHead(requestOver(body));
    body.write(Buffer.from('{"max_tokens":1,'));
    body.destroy(abortError());
    const scan = await pending;
    await drainTicks();
    expect(scan.model).toBeUndefined();
    expect(uncaught).toEqual([]);
  });

  it("still reports the abort to a consumer reading the replay", async () => {
    const body = new PassThrough();
    const pending = scanRequestHead(requestOver(body));
    body.write(Buffer.from('{"model":"claude-test",'));
    const replayed = (await pending).replayed;
    body.destroy(abortError());
    await expect(replayed.body.toArray()).rejects.toThrow("aborted");
    expect(uncaught).toEqual([]);
  });
});

describe("scanRequestHead over a body that was already read to its end", () => {
  it("fails at once instead of waiting for an end that already fired", async () => {
    const body = new PassThrough();
    const request = requestOver(body);
    body.end(JSON.stringify({ model: "m", messages: [] }));
    const scanned = await scanRequestHead(request);
    scanned.replayed.body.resume();
    await drainTicks();
    expect(body.readableEnded).toBe(true);
    await expect(scanRequestHead(request)).rejects.toThrow("already read to its end");
  });
});

describe("scanRequestHead over a model name written with an escaped quote", () => {
  it("reads the whole JSON string, escapes included, instead of stopping at the escaped quote", async () => {
    const body = new PassThrough();
    body.end('{"model":"a\\"b","messages":[]}');
    const scanned = await scanRequestHead(requestOver(body));
    expect(scanned.model).toBe('a"b');
  });
});

describe("scanRequestHead over a body whose characters span chunks", () => {
  it("decodes a multi-byte character split across a chunk boundary whole, so a rewrite from the text keeps the body", async () => {
    const body = JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "naïve 漢字 🙂" }] });
    const bytes = Buffer.from(body, "utf8");
    // Every split point, so each multi-byte character is cut somewhere inside it by one of them.
    for (let split = 1; split < bytes.length; split += 1) {
      const source = new PassThrough();
      const scanning = scanRequestHead(requestOver(source), true);
      source.write(bytes.subarray(0, split));
      source.end(bytes.subarray(split));
      const scan = await scanning;
      expect(scan.text, `split at byte ${String(split)}`).toBe(body);
    }
  });
});

/** The size of a body that continues after its head is decided, and how many chunks it arrives in. */
const CONTINUED_PAD = 4096;
const CONTINUED_CHUNKS = 5;

describe("scanRequestHead over a body that continues after its head is decided", () => {
  it.each([[false], [true]])("replays every byte once, in order, however many chunks follow the one that decided it (whole body: %s)", async (whole) => {
    const body = `{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"${"x".repeat(CONTINUED_PAD)}"}]}`;
    const bytes = Buffer.from(body, "utf8");
    const chunks = Array.from({ length: CONTINUED_CHUNKS }, (_unused, at) => bytes.subarray(Math.floor((at * bytes.length) / CONTINUED_CHUNKS), Math.floor(((at + 1) * bytes.length) / CONTINUED_CHUNKS)));
    const scan = await scanRequestHead(requestOver(Readable.from(chunks)), whole);
    const replayed: Buffer[] = [];
    for await (const chunk of scan.replayed.body) {
      replayed.push(Buffer.from(chunk as Buffer));
    }
    expect(Buffer.concat(replayed).toString("utf8")).toBe(body);
  });

  it("settles once when the body reports an error or closes after it ended, so the head is written into the replay once and the error stays the caller's", async () => {
    const source = new PassThrough();
    const scanning = scanRequestHead(requestOver(source));
    source.write(Buffer.from('{"max_tokens":16'));
    source.end();
    const scan = await scanning;
    const replayed: Buffer[] = [];
    for await (const chunk of scan.replayed.body) {
      replayed.push(Buffer.from(chunk as Buffer));
    }
    source.on("error", () => undefined);
    source.emit("error", new Error("reset after the end"));
    source.emit("close");
    expect(Buffer.concat(replayed).toString("utf8")).toBe('{"max_tokens":16');
  });

  it("settles with what it read when the body is destroyed without a cause, and ends the replay so that a consumer of it finishes", async () => {
    const source = new PassThrough();
    const scanning = scanRequestHead(requestOver(source));
    source.write(Buffer.from('{"max_tokens":16'));
    source.destroy();
    // The close event is queued by the destroy: a few turns of the event loop are all it needs, so a scan or a replay still pending after them never finishes.
    const TURNS = 10;
    const turns = async (): Promise<"pending"> => {
      for (let turn = 0; turn < TURNS; turn += 1) await drainTicks();
      return "pending";
    };
    const scan = await Promise.race([scanning, turns()]);
    expect(scan).not.toBe("pending");
    if (scan === "pending") return;
    const replayed: Buffer[] = [];
    const consumed = (async (): Promise<"finished"> => {
      for await (const chunk of scan.replayed.body) replayed.push(Buffer.from(chunk as Buffer));
      return "finished";
    })();
    expect(await Promise.race([consumed, turns()])).toBe("finished");
    expect(Buffer.concat(replayed).toString("utf8")).toBe('{"max_tokens":16');
  });
});

describe("scanRequestHead over a whole body that passes the limit while it is read", () => {
  const LIMIT_BYTES = 64;
  const CHUNK_BYTES = 40;

  it("passes the chunks that follow the one that crossed the limit on through the replay, so the rest of the upload drains", async () => {
    const chunk = (fill: string): Buffer => Buffer.alloc(CHUNK_BYTES, fill);
    const scan = await scanRequestHead(requestOver(Readable.from([chunk("a"), chunk("b"), chunk("c"), chunk("d")])), true, undefined, LIMIT_BYTES);
    expect(scan.tooLarge).toBe(true);
    const drained: Buffer[] = [];
    for await (const piece of scan.replayed.body) {
      drained.push(Buffer.from(piece as Buffer));
    }
    expect(Buffer.concat(drained).toString("utf8")).toBe(`${"c".repeat(CHUNK_BYTES)}${"d".repeat(CHUNK_BYTES)}`);
  });
});

describe("scanRequestHead over a whole body whose declared length is past the limit", () => {
  /** The limit the scan is given and the declared length past it: the body that follows is shorter than both, as a client that declared more than it sends. */
  const LIMIT_BYTES = 64;
  const DECLARED_BYTES = LIMIT_BYTES + 1;
  /** Where the sent body is cut into two chunks. */
  const FIRST_CHUNK_CHARS = 5;

  it("answers too large before reading, and still passes what arrives on through the replay to be drained", async () => {
    const sent = '{"model":"m","pad":"short"}';
    const request = { ...requestOver(Readable.from([Buffer.from(sent.slice(0, FIRST_CHUNK_CHARS)), Buffer.from(sent.slice(FIRST_CHUNK_CHARS))])), headers: { "content-length": String(DECLARED_BYTES) } };
    const scan = await scanRequestHead(request, true, undefined, LIMIT_BYTES);
    expect(scan.tooLarge).toBe(true);
    const drained: Buffer[] = [];
    for await (const chunk of scan.replayed.body) {
      drained.push(Buffer.from(chunk as Buffer));
    }
    expect(Buffer.concat(drained).toString("utf8")).toBe(sent);
  });
});

/** Gaps, margins and chunk sizes of the chunking test, in bytes. */
const NEAR_GAP = 100;
const MARGIN = 64;
const DOUBLED_FIELD_SLACK = 32;
vi.mock("./topLevelModel", async (importOriginal) => {
  const actual = await importOriginal<typeof topLevelModelWalk>();
  return { ...actual, topLevelModel: vi.fn(actual.topLevelModel) };
});

/** The chunks that follow the first in the per-chunk work test, and the most walks for the model a scan may make: one on the first chunk, which has it. */
const FEW_CHUNKS = 5;
const MANY_CHUNKS = 500;
const MODEL_WALKS_PER_SCAN = 2;
const A_PAGE = 4096;
const A_THOUSAND = 1000;
const FEW_BYTES = 7;
const CHUNK_SIZES = [A_PAGE, A_THOUSAND, FEW_BYTES] as const;
const SMALL_GAP = 10;
const MAX_TOKENS_VALUE = 1024;

describe("the doubled model field check does not depend on how the body is chunked", () => {
  /** A body whose second top-level model field sits `gap` bytes after the first. */
  const bodyWithGap = (gap: number): string => `{"model":"a","pad":"${"x".repeat(gap)}","model":"b"}`;

  async function severalFor(body: string, chunkBytes: number): Promise<boolean | undefined> {
    const buffer = Buffer.from(body);
    const chunks = Array.from({ length: Math.ceil(buffer.length / chunkBytes) }, (_unused, index) => buffer.subarray(index * chunkBytes, (index + 1) * chunkBytes));
    const scan = await scanRequestHead(requestOver(Readable.from(chunks)), false, REQUEST_SCAN_CAP_BYTES);
    return scan.hasSeveralModelFields();
  }

  it.each([
    ["near", NEAR_GAP],
    ["just inside the inspected bytes", REQUEST_SCAN_CAP_BYTES - MARGIN],
    ["past the inspected bytes", REQUEST_SCAN_CAP_BYTES + MARGIN],
  ])("gives one decision for a second field %s, whatever the chunk size", async (_label, gap) => {
    const body = bodyWithGap(gap);
    const decisions = await Promise.all([body.length, REQUEST_SCAN_CAP_BYTES, ...CHUNK_SIZES].map(async (chunk) => await severalFor(body, chunk)));
    expect(new Set(decisions).size).toBe(1);
    expect(decisions[0] === true).toBe(gap < REQUEST_SCAN_CAP_BYTES - DOUBLED_FIELD_SLACK);
  });

  it("says nothing about doubled fields to a scan that was not asked to inspect", async () => {
    const scan = await scanRequestHead(requestOver(Readable.from([Buffer.from(bodyWithGap(SMALL_GAP))])));
    expect(scan.hasSeveralModelFields()).toBe(false);
  });
});

describe("the work a head scan does per chunk", () => {
  /** The calls of the top-level model walk a scan of `chunks` one-byte-wider chunks makes: the body names its model in its first chunk and then runs on. */
  async function walksFor(chunkCount: number): Promise<number> {
    vi.mocked(topLevelModelWalk.topLevelModel).mockClear();
    const first = Buffer.from('{"model":"m","messages":[');
    const rest = Array.from({ length: chunkCount }, () => Buffer.from('{"role":"user","content":"x"},'));
    await scanRequestHead(requestOver(Readable.from([first, ...rest, Buffer.from("{}]}")])), false, REQUEST_SCAN_CAP_BYTES);
    return vi.mocked(topLevelModelWalk.topLevelModel).mock.calls.length;
  }

  it("walks for the model until it is found and never again, however many chunks follow", async () => {
    const few = await walksFor(FEW_CHUNKS);
    const many = await walksFor(MANY_CHUNKS);
    expect(many).toBe(few);
    expect(many).toBeLessThanOrEqual(MODEL_WALKS_PER_SCAN);
  });
});

/** Where a model field sits in a body, in bytes from its start: well inside the cap, just inside it, and past it. */
const AUTO_NAME_LENGTH = 4;
/** How many bytes before the cap a `max_tokens` number begins, so the cap falls inside it. */
const CUT_BEFORE_CAP = 40;
const NEAR_START = 100;
const JUST_INSIDE_CAP = 65_000;
const PAST_CAP = 70_000;
const MODEL_POSITIONS = [NEAR_START, JUST_INSIDE_CAP, PAST_CAP] as const;
const FRAMINGS = [A_PAGE, A_THOUSAND, NEAR_START] as const;

/** A body of `padBytes` of padding, then the model field, then a `max_tokens` of `1024`. */
const bodyWithModelAt = (padBytes: number): string => `{"pad":"${"x".repeat(padBytes)}","model":"auto","max_tokens":1024}`;

async function scanFramed(body: string, chunkBytes: number): Promise<Awaited<ReturnType<typeof scanRequestHead>>> {
  const buffer = Buffer.from(body);
  const chunks = Array.from({ length: Math.ceil(buffer.length / chunkBytes) }, (_unused, index) => buffer.subarray(index * chunkBytes, (index + 1) * chunkBytes));
  return await scanRequestHead(requestOver(Readable.from(chunks)));
}

describe("the model a head scan finds does not depend on how the body is framed", () => {
  it.each(MODEL_POSITIONS)("gives one answer for a model field %s bytes in, whole or in chunks of any size", async (position) => {
    const body = bodyWithModelAt(position);
    const answers = await Promise.all([body.length, ...FRAMINGS].map(async (chunk) => (await scanFramed(body, chunk)).model));
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe(position + 'pad":"'.length + AUTO_NAME_LENGTH < REQUEST_SCAN_CAP_BYTES ? "auto" : undefined);
  });
});

describe("max_tokens is read only when the number is complete and is an integer", () => {
  const scanOf = async (text: string): Promise<number | undefined> => (await scanRequestHead(requestOver(Readable.from([Buffer.from(text)])))).maxTokens;

  it("is not taken from a head cut mid-number, whichever chunk the cut falls in", async () => {
    const scan = await scanRequestHead(requestOver(Readable.from([Buffer.from('{"model":"m","max_tokens":1'), Buffer.from('024,"messages":[]}')])));
    expect(scan.maxTokens).toBeUndefined();
  });

  it.each([
    ["a comma", '{"model":"m","max_tokens":1024,"messages":[]}', MAX_TOKENS_VALUE],
    ["a closing brace", '{"model":"m","max_tokens":1024}', MAX_TOKENS_VALUE],
    ["whitespace", '{"model":"m","max_tokens":1024 }', MAX_TOKENS_VALUE],
    ["a decimal point", '{"model":"m","max_tokens":16.5,"messages":[]}', undefined],
    ["an exponent", '{"model":"m","max_tokens":1.0e3,"messages":[]}', undefined],
    ["a plain exponent", '{"model":"m","max_tokens":1e3,"messages":[]}', undefined],
  ])("follows its number by %s", async (_label, text, expected) => {
    expect(await scanOf(text)).toBe(expected);
  });

  it("is a textual match anywhere in the text read: one inside a nested object decides", async () => {
    expect(await scanOf('{"model":"m","x":{"max_tokens":1024}}')).toBe(MAX_TOKENS_VALUE);
  });

  it("is not taken from a number the scan cap cuts", async () => {
    const cut = await scanRequestHead(requestOver(Readable.from([Buffer.from(`{"model":"m","pad":"${"x".repeat(REQUEST_SCAN_CAP_BYTES - CUT_BEFORE_CAP)}","max_tokens":1`), Buffer.from("024}")])));
    expect(cut.maxTokens).toBeUndefined();
  });
});

describe("a whole-body scan against its limit", () => {
  const LIMIT_BYTES = 256;
  const bodyOf = (bytes: number): Buffer => Buffer.from(`{"model":"m","pad":"${"x".repeat(bytes - '{"model":"m","pad":""}'.length)}"}`);

  it.each([["streamed in two chunks", false], ["declared by its Content-Length", true]])("accepts a body of exactly the limit and refuses one a byte over it, %s", async (_label, declared) => {
    const scanOver = async (body: Buffer): Promise<boolean | undefined> => {
      const half = Math.floor(body.length / 2);
      const request = { ...requestOver(Readable.from([body.subarray(0, half), body.subarray(half)])), headers: declared ? { "content-length": String(body.length) } : {} };
      return (await scanRequestHead(request, true, undefined, LIMIT_BYTES)).tooLarge;
    };
    expect(await scanOver(bodyOf(LIMIT_BYTES))).not.toBe(true);
    expect(await scanOver(bodyOf(LIMIT_BYTES + 1))).toBe(true);
  });
});

describe("tools and images are textual matches", () => {
  const facts = async (text: string): Promise<{ readonly toolsPresent?: boolean; readonly hasImage?: boolean }> => await scanRequestHead(requestOver(Readable.from([Buffer.from(text)])), true);

  it("counts a nested object that spells the tools array, not the same words inside a string value", async () => {
    expect((await facts('{"model":"m","messages":[{"content":{"tools":[{"a":1}]}}]}')).toolsPresent).toBe(true);
    expect((await facts('{"model":"m","messages":[{"content":"\\"tools\\":[{ in text"}]}')).toolsPresent).toBe(false);
  });
});

describe("the cap on the text a head scan looks in is exact", () => {
  const TAIL_BYTES = 100;
  /** A body whose `model` value closes at byte `closesAt` (counted from 1), padded past the cap so the scan is cut at it. */
  const modelClosingAt = (closesAt: number): string => {
    const lead = '{"pad":"';
    const field = '","model":"auto"';
    return `${lead}${"x".repeat(closesAt - lead.length - field.length)}${field}${"y".repeat(REQUEST_SCAN_CAP_BYTES + TAIL_BYTES)}`;
  };

  it("finds a model whose value closes on the last byte of the cap, and none whose value closes one byte after", async () => {
    expect((await scanRequestHead(requestOver(Readable.from([Buffer.from(modelClosingAt(REQUEST_SCAN_CAP_BYTES))])))).model).toBe("auto");
    expect((await scanRequestHead(requestOver(Readable.from([Buffer.from(modelClosingAt(REQUEST_SCAN_CAP_BYTES + 1))])))).model).toBeUndefined();
  });

  /** A body whose second top-level model key has its colon at byte `closesAt` (counted from 1): the walk counts a key once its colon is in the text, whatever follows it. */
  const secondClosingAt = (closesAt: number): string => {
    const lead = '{"model":"a","pad":"';
    const key = '","model":';
    return `${lead}${"x".repeat(closesAt - lead.length - key.length)}${key}"b","z":"${"y".repeat(TAIL_BYTES)}"}`;
  };

  it("sees a second model key whose colon is the last inspected byte, and none whose colon is one byte after", async () => {
    const severalAt = async (closesAt: number): Promise<boolean> => (await scanRequestHead(requestOver(Readable.from([Buffer.from(secondClosingAt(closesAt))])), false, REQUEST_SCAN_CAP_BYTES)).hasSeveralModelFields();
    expect(await severalAt(REQUEST_SCAN_CAP_BYTES)).toBe(true);
    expect(await severalAt(REQUEST_SCAN_CAP_BYTES + 1)).toBe(false);
  });
});

describe("the body length a whole-body scan reads from the headers", () => {
  it.each(["Content-Length", "content-length", "CONTENT-LENGTH"])("is read whatever the case of the header's name (%s), and a length past the limit is refused before the body is read", async (name) => {
    const limit = 10;
    const scan = await scanRequestHead({ ...requestOver(Readable.from([Buffer.from("{}")])), headers: { [name]: String(limit + 1) } }, true, undefined, limit);
    expect(scan.tooLarge).toBe(true);
  });
});

describe("a head scan that has read exactly the cap", () => {
  it("settles without waiting for more of a body that names no model", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* chunks(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(REQUEST_SCAN_CAP_BYTES, "x");
      await gate;
      yield Buffer.from("never needed");
    }
    const scan = await scanRequestHead(requestOver(Readable.from(chunks())));
    expect(scan.headBytes).toBe(REQUEST_SCAN_CAP_BYTES);
    expect(scan.model).toBeUndefined();
    release();
  });
});

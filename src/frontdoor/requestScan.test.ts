import { PassThrough, type Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { RoutedRequest } from "./route";
import { scanRequestHead } from "./requestScan";

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
    if (replayed === undefined) {
      throw new Error("expected a replayed request");
    }
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
    scanned.replayed?.body.resume();
    await drainTicks();
    expect(body.readableEnded).toBe(true);
    await expect(scanRequestHead(request)).rejects.toThrow("already read to its end");
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

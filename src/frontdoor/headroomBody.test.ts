import { once } from "node:events";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { MAX_BODY_BYTES, collectBody } from "./headroomHop";

const CHUNK_BYTES = 1_048_576;

/** A stream of `size` bytes in mebibyte chunks, counting how many chunks were actually pulled from it. */
function stream(size: number): { readonly body: Readable; readonly pulled: () => number } {
  let sent = 0;
  let pulled = 0;
  const body = new Readable({
    read() {
      if (sent >= size) {
        this.push(null);
        return;
      }
      const length = Math.min(CHUNK_BYTES, size - sent);
      sent += length;
      pulled += 1;
      this.push(Buffer.alloc(length, "a"));
    },
  });
  return { body, pulled: () => pulled };
}

describe("collectBody", () => {
  it("returns the whole body when it is within the limit", async () => {
    const collected = await collectBody(stream(CHUNK_BYTES * 2).body);
    expect(collected.kind).toBe("body");
    expect(collected.kind === "body" ? collected.body.length : 0).toBe(CHUNK_BYTES * 2);
  });

  it("answers too-large as soon as the limit is passed, and reads the rest of the upload without keeping it", async () => {
    const source = stream(MAX_BODY_BYTES + CHUNK_BYTES * 2);
    const collected = await collectBody(source.body);
    expect(collected.kind).toBe("too-large");
    // The remainder is still drained, so the client can finish its upload and receive the answer.
    if (!source.body.readableEnded) {
      await once(source.body, "end");
    }
    expect(source.body.readableEnded).toBe(true);
  });

  it("reports a stream that errors as failed", async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error("client went away"));
      },
    });
    expect((await collectBody(failing)).kind).toBe("failed");
  });
});

import type { Readable } from "node:stream";

/** What reading a request body under a byte cap found. */
export type CappedBody = { readonly kind: "read"; readonly bytes: Buffer } | { readonly kind: "too-large" };

/**
 * Collects a request body as the bytes it arrived in, or reports `too-large` once it passes `limitBytes`; a chunk that is not a Buffer is a defect of whoever built the stream and throws `TypeError`. This function never destroys the body: it is the connection's own request stream (or a replay of it) and destroying it resets the socket, so a client uploading past the cap would see a reset where the refusal belongs. Reading stops where it is and the caller answers, then calls `abandonBody`. The answer is not followed by the connection's close: a server that closes a socket its client is still writing to resets it, and the client may then lose the answer along with the connection.
 */
export async function readCappedBody(body: Readable, limitBytes: number): Promise<CappedBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  // Leaving the loop early must not destroy the stream, which is the iterator's default.
  for await (const chunk of body.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("request body chunk was not a Buffer");
    }
    total += chunk.length;
    if (total > limitBytes) {
      return { kind: "too-large" };
    }
    chunks.push(chunk);
  }
  return { kind: "read", bytes: Buffer.concat(chunks) };
}

/** Lets the rest of a body the door has stopped reading flow away unread, once the refusal is on its way: the client finishes (or its connection closes after the refusal) instead of stalling on a stream nobody drains. */
export function abandonBody(body: Readable): void {
  body.resume();
}

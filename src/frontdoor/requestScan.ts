import { PassThrough } from "node:stream";

import type { RoutedRequest } from "./route";

/**
 * How much of a request's body the routing scan reads: enough to cover the head of any real Messages request through its top-level `model` field and the first turns of `messages`, and no more, because a routed request must replay everything it read and the whole body is the conversation itself, images included. The `model` field is top-level, so it appears before `messages` in every body Claude Code sends; a request whose head reaches this cap without one is not routed (its facts are indeterminate), never guessed at.
 *
 * Not a fresh number: the Messages body's own field order puts `model` within the first kilobyte of every request Claude Code sends, and the scan deliberately keeps reading past it only to notice image blocks in the first turns. 64 KiB is two orders of magnitude beyond the field's own position while staying far below a conversation's real size, so the scan's memory cost is a bounded sliver of the request, not a copy of it.
 */
/** One kibibyte, the unit the scan cap is stated in. */
const BYTES_PER_KIB = 1024;

/** The scan cap in kibibytes, the number the derivation in the comment below reasons in. */
const SCAN_KIB = 64;

const REQUEST_SCAN_CAP_BYTES = SCAN_KIB * BYTES_PER_KIB;

/** Everything the scan found in the head it read, beside the request whose body is now the replay: the model field when the head reached it, image-block presence when it saw content blocks at all. */
export interface RequestScan {
  /** True when the scan read the whole body rather than its head, which is what makes `hasImage` a fact about the whole conversation rather than its opening turns. */
  readonly whole?: boolean;
  /** The whole body's text, present only in whole-body mode, so a route that rewrites the model field does it from the one copy already read rather than a second. */
  readonly text?: string;
  readonly model?: string;
  readonly hasImage?: boolean;
  /** True when the request carries a non-empty `tools` array. */
  readonly toolsPresent?: boolean;
  /** True when the request enables extended thinking (`thinking` of type enabled). */
  readonly thinking?: boolean;
  /** The request's `max_tokens`, when the scanned text reached it. */
  readonly maxTokens?: number;
  /** True when the request targets the count_tokens endpoint, which the path (not the body) states. */
  readonly isCountTokens?: boolean;
  /** The request as the chosen route should receive it: the scanned head replayed in front of the unread remainder. `undefined` when nothing was read, in which case the original request is the honest handover. */
  readonly replayed?: RoutedRequest;
}

/**
 * Reads the head of a request's body for the facts a route condition needs, and hands back a request whose body replays exactly what was read. The stream contract on `RoutedRequest.body` ("a route either pipes it onward untouched or reads it whole, never both") is why the scan never reads without teeing: whatever it consumes is re-emitted in front of the unread remainder, so the route sees one unbroken body.
 *
 * The mechanism is persistent `data`/`end` listeners with pause and resume, not an async iterator: an iterator broken out of mid-flight detaches its listeners, and a stream that ends while nobody is listening leaves a later `next()` waiting for an `end` that already fired. Persistent listeners cannot miss it, and pausing the source the moment the head is decided is what keeps the scan bounded while the remainder streams straight through to the replay under real backpressure.
 *
 * Nothing here parses the body: the model field is found as the first `"model": "..."` pair of the head's text, and an image block as the first `"type": "image"` inside it, which is exactly how the fields appear in the JSON Claude Code serialises. A head with neither (or a body the cap could not cover) reports the fact as absent, which the condition evaluator carries as indeterminate.
 */
export async function scanRequestHead(request: RoutedRequest, wholeBody = false): Promise<RequestScan> {
  const body = request.body;
  const head: Buffer[] = [];
  let seen = 0;
  let text = "";
  let decided = false;
  let ended = false;
  let error: Error | undefined;
  const replay = new PassThrough();
  const modelIn = (): string | undefined => /"model"\s*:\s*"([^"]+)"/.exec(text)?.[1];

  const settled = new Promise<RequestScan>((resolve) => {
    const settle = (): void => {
      const model = modelIn();
      const hasImage = /"type"\s*:\s*"image"/.test(text);
      for (const chunk of head) {
        replay.write(chunk);
      }
      const maxTokens = /"max_tokens"\s*:\s*([0-9]+)/.exec(text)?.[1];
      resolve({
        ...(model === undefined ? {} : { model }),
        hasImage,
        toolsPresent: /"tools"\s*:\s*\[\s*\{/.test(text),
        thinking: /"thinking"\s*:\s*\{\s*"type"\s*:\s*"enabled"/.test(text),
        ...(maxTokens === undefined ? {} : { maxTokens: Number(maxTokens) }),
        isCountTokens: request.url.includes("/v1/messages/count_tokens"),
        ...(wholeBody ? { whole: true, text } : {}),
        replayed: { ...request, body: replay },
      });
    };
    body.on("data", (chunk: Buffer) => {
      if (decided) {
        // The remainder streams straight through under backpressure: a full replay pauses the source until the consumer drains it.
        if (!replay.write(chunk)) {
          body.pause();
          replay.once("drain", () => {
            body.resume();
          });
        }
        return;
      }
      head.push(chunk);
      seen += chunk.length;
      text += chunk.toString("utf8");
      if (!wholeBody && (modelIn() !== undefined || seen >= REQUEST_SCAN_CAP_BYTES)) {
        decided = true;
        body.pause();
        // Let the scan's caller resume the source when it is ready to consume the replay, so the remainder never buffers unread.
        replay.once("resume", () => {
          body.resume();
        });
        settle();
      }
    });
    body.on("end", () => {
      ended = true;
      // A body that ends before the scan found the model field settles with whatever it read: the facts are what they are, and the replay must end for the route to finish.
      if (!decided) {
        decided = true;
        settle();
      }
      replay.end();
    });
    body.on("error", (cause: Error) => {
      error = cause;
      replay.destroy(cause);
    });
    // A body that ends before any data arrived settles with nothing read.
    body.on("close", () => {
      if (!decided && !ended && error === undefined) {
        decided = true;
        settle();
      }
    });
  });
  return await settled;
}

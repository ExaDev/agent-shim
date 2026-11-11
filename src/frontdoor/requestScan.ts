import { declaredLength } from "./contentLength";
import { hasSeveralTopLevelModels, topLevelModel, type TopLevelModel } from "./topLevelModel";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

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

/** The scan cap in bytes. A rewrite from the head asks the scan to inspect this many bytes for a second top-level model field (`inspectBytes`): the scan keeps reading until it has them (or the body ends), however the body is framed into chunks, and looks at no more than that many (the whole body when it ends sooner), so the same bytes give the same decision whatever the chunking; a second field after them is not seen. */
export const REQUEST_SCAN_CAP_BYTES = SCAN_KIB * BYTES_PER_KIB;


/** Everything the scan found in the head it read, beside the request whose body is now the replay: the model field when the head reached it, image-block presence when it saw content blocks at all. */
export interface RequestScan {
  /** True when the scan read the whole body rather than its head, which is what makes `hasImage` a fact about the whole conversation rather than its opening turns. */
  readonly whole?: boolean;
  /** The whole body's text, present only in whole-body mode, so a route that rewrites the model field does it from the one copy already read rather than a second. */
  readonly text?: string;
  /** The name the request's top-level `model` field spells, its escapes decoded (`spark/auto` for the source `spark\/auto`): what every decision about the model is made on, at every site, so the same body is decided the same way whatever its spelling. A rewrite replaces the field's span and never reads the source spelling. The scan walks the utf8-decoded text, so it keeps no offsets: a rewrite locates the field in the body's bytes itself. */
  readonly model?: string;
  /**
   * Whether the text the scan inspected names its model in more than one top-level field: a rewrite of the first of them is then not known to change what a server reads, so a site that rewrites refuses. A whole-body scan inspects the whole body; a head scan inspects the first `inspectBytes` bytes (all of the body when it ends sooner) when it was given them (`REQUEST_SCAN_CAP_BYTES`), and says false otherwise. Walked on the first call and not before, so a request that rewrites nothing never pays for it.
   */
  readonly hasSeveralModelFields: () => boolean;
  /** The bytes a whole-body scan read, for a rewrite by span: joined from the chunks when first asked for, so a request that rewrites nothing never holds a second copy. */
  readonly bytes?: () => Buffer;
  /** True when a whole-body scan stopped because the body passed the limit it was given (or declared a length past it): nothing was kept, `replayed` is the stream still to drain, and the caller answers 413 and abandons it. */
  readonly tooLarge?: true;
  /** How many bytes of the body the scan read before it settled: the length of the head `text` decodes and the replay emits first, so a rewrite confined to the head (the model field is always in it) can leave every later byte untouched. */
  readonly headBytes: number;
  /** True when the text read matches an image block (`"type": "image"`): a textual match anywhere in the text (the whole body for a whole-body scan, else the head), not a read of the request's field. */
  readonly hasImage?: boolean;
  /** True when the text read matches `"tools": [{`: a textual match anywhere in the text, not a read of the request's field (a nested object that spells it counts; text inside a string value, whose quotes are escaped, does not). */
  readonly toolsPresent?: boolean;
  /** True when the text read matches `"thinking": {"type": "enabled"`: a textual match anywhere in the text, not a read of the request's field. */
  readonly thinking?: boolean;
  /** The integer the text read matches after `"max_tokens":`, when a JSON delimiter follows it or the body has ended: a textual match anywhere in the text, not a read of the request's field. */
  readonly maxTokens?: number;
  /** True when the request targets the count_tokens endpoint, which the path (not the body) states. */
  readonly isCountTokens?: boolean;
  /** The request as the chosen route should receive it: the scanned head replayed in front of the unread remainder. Always present on what `scanRequestHead` returns (see `ScannedRequest`); absent only on a stand-in for a body already read to its end, in which case the original request is the honest handover. */
  readonly replayed?: RoutedRequest;
}

/** What `scanRequestHead` hands back: a scan that always carries the request to route on, since a body it was given has a replay to read from even when it held no byte. A `RequestScan` without one is only the stand-in for a body that was read to its end before any scan could start. */
export type ScannedRequest = RequestScan & { readonly replayed: RoutedRequest };

/**
 * Reads the head of a request's body for the facts a route condition needs, and hands back a request whose body replays exactly what was read. The stream contract on `RoutedRequest.body` ("a route either pipes it onward untouched or reads it whole, never both") is why the scan never reads without teeing: whatever it consumes is re-emitted in front of the unread remainder, so the route sees one unbroken body.
 *
 * The mechanism is persistent `data`/`end` listeners, not an async iterator: an iterator broken out of mid-flight detaches its listeners, and a stream that ends while nobody is listening leaves a later `next()` waiting for an `end` that already fired. Persistent listeners cannot miss it, and pausing the source the moment the head is decided is what keeps the scan bounded while the remainder streams straight through to the replay under real backpressure.
 *
 * Nothing here parses the body: the model field is found as the `"model"` key of the top-level object in the head's text (`topLevelModel`: a walk over strings and brace depth, so a `model` nested in `messages` never counts), and an image block as the first `"type": "image"` inside it, which is exactly how the fields appear in the JSON Claude Code serialises. A head with neither (or a body the cap could not cover) reports the fact as absent, which the condition evaluator carries as indeterminate.
 */
export async function scanRequestHead(request: RoutedRequest, wholeBody = false, inspectBytes?: number, wholeBodyLimitBytes?: number): Promise<ScannedRequest> {
  const body = request.body;
  // The listeners below wait for events: on a body that has already ended the `end` has fired and will not again, so the scan would wait for ever. A body read to its end is a request a caller already consumed, which is that caller's defect, so it fails here instead of stalling the request.
  if (body.readableEnded) {
    throw new Error("the request body was already read to its end, so its head cannot be scanned again");
  }
  const head: Buffer[] = [];
  let seen = 0;
  let text = "";
  // A multi-byte character can be split across two chunks; the decoder holds the leading bytes until the rest arrive, where decoding each chunk alone would turn both halves into replacement characters and a rewrite from `text` would corrupt the body.
  const decoder = new StringDecoder("utf8");
  let decided = false;
  let ended = false;
  let error: Error | undefined;
  const replay = new PassThrough();
  // Destroying the replay with the body's failure emits `error` on it, and a stream with no `error` listener turns that into an uncaught exception that ends the process. A client aborting its upload fails the body whether or not the route has attached to the replay yet, so the scan owns a listener; a consumer reading the replay still receives the same error through the stream itself.
  replay.on("error", () => undefined);
  // The first top-level model field never changes once the text has it, so it is walked for only until it is found.
  let found: TopLevelModel | undefined;
  // The model is looked for in the first `REQUEST_SCAN_CAP_BYTES` bytes of a head scan, however the body is framed into chunks, so the same bytes give the same answer; a whole-body scan looks in all of the body.
  let cappedText: string | undefined;
  const modelSearchText = (): string => (wholeBody || seen <= REQUEST_SCAN_CAP_BYTES ? text : (cappedText ??= Buffer.concat(head).subarray(0, REQUEST_SCAN_CAP_BYTES).toString("utf8")));
  const modelIn = (): TopLevelModel | undefined => {
    found ??= topLevelModel(modelSearchText());
    return found;
  };
  let tooLarge = false;

  const settled = new Promise<ScannedRequest>((resolve) => {
    // Settling happens once, however many events ask for it: a second call would write the head into the replay again.
    let settledOnce = false;
    const settle = (): void => {
      if (settledOnce) {
        return;
      }
      settledOnce = true;
      if (tooLarge) {
        resolve({ headBytes: seen, tooLarge: true, hasSeveralModelFields: () => false, replayed: { ...request, body: replay } });
        return;
      }
      modelIn();
      // The bytes the doubled-field check looks at: all of a whole body, else the first `inspectBytes` bytes of the head, or all of it when the body ends sooner (the decision to settle waited for them), whatever the chunks were. Read only when a rewrite asks.
      let several: boolean | undefined;
      const hasSeveralModelFields = (): boolean => {
        several ??= wholeBody ? hasSeveralTopLevelModels(text) : inspectBytes !== undefined && hasSeveralTopLevelModels(Buffer.concat(head).subarray(0, inspectBytes).toString("utf8"));
        return several;
      };
      const hasImage = /"type"\s*:\s*"image"/.test(text);
      for (const chunk of head) {
        replay.write(chunk);
      }
      // A number cut off by the end of the text read may be the front of a longer one (`1` of `1024`), and one followed by `.` or `e` is a different number (`16.5`, `1.0e3`), so it counts only when a JSON delimiter (a comma, a closing brace or bracket, or whitespace) follows it or the body has ended.
      const maxTokensMatch = /"max_tokens"\s*:\s*([0-9]+)([^0-9]?)/.exec(text);
      const maxTokens = maxTokensMatch !== null && (maxTokensMatch[2] === "" ? ended : /[,}\]\s]/.test(maxTokensMatch[2] ?? "")) ? maxTokensMatch[1] : undefined;
      resolve({
        ...(found === undefined ? {} : { model: found.decoded }),
        headBytes: seen,
        hasSeveralModelFields,
        hasImage,
        toolsPresent: /"tools"\s*:\s*\[\s*\{/.test(text),
        thinking: /"thinking"\s*:\s*\{\s*"type"\s*:\s*"enabled"/.test(text),
        ...(maxTokens === undefined ? {} : { maxTokens: Number(maxTokens) }),
        isCountTokens: request.url.includes("/v1/messages/count_tokens"),
        ...(wholeBody ? { whole: true, text, bytes: () => Buffer.concat(head) } : {}),
        replayed: { ...request, body: replay },
      });
    };
    body.on("data", (chunk: Buffer) => {
      if (decided) {
        // The remainder streams straight through under the replay's own backpressure: a full replay pauses the source until the consumer drains it, whatever style the consumer reads in (a pipe switches the replay to flowing; a for-await reads it in paused mode), so the replay never buffers more than its high-water mark ahead of the consumer.
        if (!replay.write(chunk)) {
          body.pause();
          replay.once("drain", () => {
            body.resume();
          });
        }
        return;
      }
      seen += chunk.length;
      if (wholeBody && wholeBodyLimitBytes !== undefined && seen > wholeBodyLimitBytes) {
        // Nothing is kept: the head read so far is dropped and the rest drains through the replay, so the body is never held past the limit.
        head.length = 0;
        text = "";
        tooLarge = true;
        decided = true;
        settle();
        return;
      }
      head.push(chunk);
      text += decoder.write(chunk);
      if (!wholeBody && ((modelIn() !== undefined && seen >= (inspectBytes ?? 0)) || seen >= REQUEST_SCAN_CAP_BYTES)) {
        decided = true;
        settle();
      }
    });
    body.on("end", () => {
      ended = true;
      text += decoder.end();
      // A body that ends before the scan found the model field settles with whatever it read: the facts are what they are, and the replay must end for the route to finish.
      settle();
      replay.end();
    });
    body.on("error", (cause: Error) => {
      error = cause;
      // A body that fails before the head is decided (the client aborting mid-upload) settles with what it read, so the caller's await ends and the route sees the failure on the replay it is handed.
      settle();
      replay.destroy(cause);
    });
    // A body that closes with neither an end nor an error (destroyed with no cause) settles with what it read, and ends the replay: a consumer that reads it must finish, not wait for an end that will not come.
    body.on("close", () => {
      if (!ended && error === undefined) {
        settle();
        replay.end();
      }
    });
    // A declared length past the limit is answered before this scan reads any of the body, so the upload is not drawn for nothing; what arrives still drains through the replay.
    if (wholeBody && wholeBodyLimitBytes !== undefined && declaredLength(request.headers) > wholeBodyLimitBytes) {
      tooLarge = true;
      decided = true;
      settle();
    }
  });
  return await settled;
}

import { Readable } from "node:stream";

import { HTTP_STATUS } from "../codex/http";
import type { HttpProvider } from "../config/schema";
import type { CredentialResolution } from "../credential";
import type { FrontDoorRoute, RoutedRequest, RoutedResponse } from "./route";
import { scanRequestHead } from "./requestScan";
import { type ServedModels } from "./servedModel";
import { AUTO_MODEL } from "../models/reservedModelNames";
import { errorBody } from "./pipeline";
import { bodyTooLargeMessage, isMessagesRequest } from "./messagesBodyLimit";
import { abandonBody, readCappedBody } from "./cappedBody";
import { editedSegments } from "./serverToolSplice";
import { modelFieldsOf, walkTopLevelMembers } from "./topLevelMembers";
import { quotedForLog } from "./loggedText";
import { topLevelModel } from "./topLevelModel";

/** A request body that parsed as a JSON object. */
type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The request carrying the body the `segments` make up, replacing the one the scan or the read consumed; the segments are streamed as they are, so no copy of the body is made to join them. A body that changed length drops the stale framing header, so the forward re-frames it. */
function carrying(request: RoutedRequest, segments: readonly Buffer[], changed: boolean): RoutedRequest {
  const headers = changed ? Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "content-length")) : request.headers;
  return { ...request, headers, body: Readable.from(segments) };
}

/** Writes an Anthropic-shaped error, the shape the pipeline answers its own refusals with. */
async function refuse(response: RoutedResponse, status: number, message: string, headers: Readonly<Record<string, string>> = { "Content-Type": "application/json" }): Promise<void> {
  response.start(status, headers);
  await response.write(errorBody(status, message));
  response.end();
}

/** The words of an error body that say what went wrong: its `error.message`, or its `message` or `detail`, else the text itself. The error `type` is never read, since `invalid_request_error` is the type of every 400 whatever its cause. */
function errorMessageOf(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isJsonObject(parsed)) {
      const inner = isJsonObject(parsed.error) ? parsed.error.message : undefined;
      for (const candidate of [inner, parsed.message, parsed.detail]) {
        if (typeof candidate === "string") {
          return candidate;
        }
      }
    }
  } catch {
    // Not JSON: the text is the message.
  }
  return body;
}

/** The phrasings of a server that does not have the model it was asked for ("The model `x` does not exist", "model not found", "unknown model"). A message that only mentions a model (a context limit, a parameter the model rejects) matches none of them. */
const MODEL_MISSING = /\bmodel\b[^\n]{0,120}\b(?:does not exist|not found|is not supported|is not available)\b|\b(?:unknown|no such) model\b|\bmodel not found\b/i;

/** Whether an answer's headers say its body is encoded (`Content-Encoding` other than `identity`): the text of such a body is not the message it carries, so it cannot be matched. */
function isEncoded(headers: Readonly<Record<string, string>>): boolean {
  return Object.entries(headers).some(([name, value]) => name.toLowerCase() === "content-encoding" && value.trim().toLowerCase() !== "identity" && value.trim() !== "");
}

/** Whether an upstream answer's body says the model it was asked for is not one the server has: its message uses a model-missing phrasing. Only a 400 or a 404 is held to be asked (`holdingModelRefusals`), so the status is decided there and nowhere else. */
function isUnknownModelError(body: string): boolean {
  return MODEL_MISSING.test(errorMessageOf(body));
}

/** The most bytes of an error answer held to read what it says. A model-missing message is a sentence or a small JSON object, so the bound only has to exceed any such message; an answer past it is not one and is streamed instead of held. */
const KIB = 1024;
const HELD_ANSWER_KIB = 64;
export const HELD_ANSWER_LIMIT_BYTES = HELD_ANSWER_KIB * KIB;

/** An upstream answer held back from the client until it is known whether it says the model is unknown. */
interface HeldAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly chunks: Buffer[];
}

/**
 * A response whose 400 and 404 answers are held back, whole, instead of written: every other answer (a stream above all) goes to `real` as it arrives. An error body is small, and what it says decides whether the request is served again. `release` writes a held answer to `real` after all.
 */
function holdingModelRefusals(real: RoutedResponse): { readonly response: RoutedResponse; readonly held: () => HeldAnswer | undefined; readonly release: () => Promise<void> } {
  let held: HeldAnswer | undefined;
  let heldBytes = 0;
  // Writes the held answer to `real` and stops holding: what follows streams through.
  const spill = async (): Promise<void> => {
    const answer = held;
    held = undefined;
    if (answer === undefined) {
      return;
    }
    real.start(answer.status, answer.headers);
    real.flush();
    for (const chunk of answer.chunks) {
      await real.write(chunk);
    }
  };
  const response: RoutedResponse = {
    get headersSent() {
      return held === undefined ? real.headersSent : false;
    },
    start: (status, headers) => {
      if (status === HTTP_STATUS.badRequest || status === HTTP_STATUS.notFound) {
        held = { status, headers, chunks: [] };
        heldBytes = 0;
        return;
      }
      // A start after a held one is the route changing its answer (the pass-through's own 502 once the upstream body failed): the held answer is discarded, so what follows goes to the real response and not into the held one.
      held = undefined;
      heldBytes = 0;
      real.start(status, headers);
    },
    flush: () => {
      if (held === undefined) {
        real.flush();
      }
    },
    write: async (chunk) => {
      if (held === undefined) {
        await real.write(chunk);
        return;
      }
      held.chunks.push(Buffer.from(chunk));
      heldBytes += chunk.length;
      // An answer past the bound is taken not to be a model-missing message, so it is not held: what was held is written and the rest streams.
      if (heldBytes > HELD_ANSWER_LIMIT_BYTES) {
        await spill();
      }
    },
    end: () => {
      if (held === undefined) {
        real.end();
      }
    },
    destroy: () => {
      real.destroy();
    },
    ...(real.noteModelChoice === undefined ? {} : { noteModelChoice: real.noteModelChoice }),
  };
  return {
    response,
    held: () => held,
    release: async () => {
      if (held === undefined) {
        return;
      }
      await spill();
      real.end();
    },
  };
}

/** What the edits of one `http` provider's route need. */
export interface HttpRequestEditDeps {
  readonly provider: string;
  readonly definition: Pick<HttpProvider, "baseUrl" | "catalogue">;
  /** The served-model lookup, absent when the embedding offers no way to read a provider's model list: `auto` is then refused, naming that. */
  readonly served: ServedModels | undefined;
  readonly credential: () => Promise<CredentialResolution>;
  readonly log: (message: string) => void;
  /** Told each model the wrapper sends for the request when it chose it (the model `auto` becomes the one the server serves, and a retry after an unknown-model answer sends the one the list names now), so the route context records what was sent, not what was first read. */
  readonly servedModelSent?: (model: string) => void;
  /** The most bytes of a body read whole to edit it; see `MESSAGES_BODY_LIMIT_BYTES`. */
  readonly bodyLimitBytes: number;
}

/**
 * Wraps an `http` provider's route with the edit a request to it may need before it is forwarded: with the model `auto`, the model is rewritten to the one the provider's server serves; an answer saying that model is unknown refreshes the list once and serves the request once more under the model it now lists, logging both. A request that needs no edit goes to the route byte for byte as it arrived, and an edit changes only the span it replaces.
 */
export function editingHttpRequest(route: FrontDoorRoute, deps: Readonly<HttpRequestEditDeps>): FrontDoorRoute {
  return {
    name: route.name,
    headroomEligible: route.headroomEligible,
    headroomUpstream: route.headroomUpstream,
    serve: async (request, response) => {
      // Only a Messages request has a model to follow; any other request to the provider (a model list, a batch) passes unread.
      if (!isMessagesRequest(request.method, new URL(request.url, "http://127.0.0.1").pathname)) {
        await route.serve(request, response);
        return;
      }
      // The head says whether the request names a model other than `auto`, in which case it is forwarded without reading the rest of it, whatever it holds. A head that found no model field at all leaves it open, since the resolver in front of this route decides on the whole body: such a request is read whole, under the same cap, so both decide on the same data.
      const head = await scanRequestHead(request, false);
      if (head.model !== undefined && head.model !== AUTO_MODEL) {
        await route.serve(head.replayed, response);
        return;
      }
      const working = head.replayed;
      const tooLarge = bodyTooLargeMessage(deps.bodyLimitBytes, deps.provider);
      // A declared length over the limit is refused before the rest of the body is read (the head scan above has read up to its own cap), so the upload is not drawn for nothing; a body that does not declare one is counted as it arrives.
      const declared = Number(working.headers["content-length"]);
      if (declared > deps.bodyLimitBytes) {
        await refuse(response, HTTP_STATUS.payloadTooLarge, tooLarge);
        abandonBody(working.body);
        return;
      }
      const read = await readCappedBody(working.body, deps.bodyLimitBytes);
      if (read.kind === "too-large") {
        await refuse(response, HTTP_STATUS.payloadTooLarge, tooLarge);
        abandonBody(working.body);
        return;
      }
      const buffer = read.bytes;
      // The body's bytes viewed one character each, the view every offset of the walks below is in: the body is never decoded, so bytes that are not UTF-8 reach the server as they came.
      const text = buffer.toString("latin1");
      // Whether the request names `auto` is read by the same lenient walk the scan used: a body that names `auto` but is no well-formed JSON object (the strict walk below cannot see its model) is refused, never forwarded with the literal name.
      const namesAuto = topLevelModel(text)?.decoded === AUTO_MODEL;
      // The one structural walk over the whole body: every decision below (the model fields and the span the model is replaced at) is read from its result, so the body is walked once however many edits it needs.
      const members = walkTopLevelMembers(text);
      const modelFields = members === undefined ? [] : modelFieldsOf(text, members);
      const names = modelFields.map((field) => field.decoded);
      // The door rewrites the first model field when it names `auto`. Which of two fields a server reads differs between parsers (the last usually wins), so a body whose first field names `auto` and that has another top-level `model` key, whatever its value, cannot be rewritten to mean one thing: it is refused rather than guessed at. A body whose first field names another model is not rewritten, whatever a later field says, and is forwarded as it came.
      if (names[0] === AUTO_MODEL && members?.filter((member) => member.key === "model").length !== 1) {
        await refuse(response, HTTP_STATUS.badRequest, `provider "${deps.provider}": the request has more than one top-level model field and one is "${AUTO_MODEL}", so which model it names is ambiguous`);
        return;
      }
      const source = { name: deps.provider, provider: deps.definition, credential: deps.credential };
      const model = modelFields[0];
      if (model?.decoded !== AUTO_MODEL) {
        // A body that names `auto` where the strict walk finds no replaceable model is no well-formed JSON object, so the name cannot be replaced and the request is refused; one that does not name `auto` goes on as it came.
        if (!namesAuto) {
          await route.serve(carrying(working, [buffer], false), response);
          return;
        }
        await refuse(response, HTTP_STATUS.badRequest, `provider "${deps.provider}": the request names the model "${AUTO_MODEL}" but its body is not a JSON object whose top-level model can be replaced`);
        return;
      }
      if (deps.served === undefined) {
        await refuse(response, HTTP_STATUS.badRequest, `provider "${deps.provider}": the model "${AUTO_MODEL}" needs the provider's model list, which this front door cannot read`);
        return;
      }
      const served = await deps.served.resolve(source);
      if (!served.ok) {
        await refuse(response, served.status, served.message);
        return;
      }
      deps.servedModelSent?.(served.model);
      const attempt = async (modelName: string): Promise<{ readonly release: () => Promise<void>; readonly refused: boolean }> => {
        const holding = holdingModelRefusals(response);
        const edited = editedSegments(buffer, [{ start: model.start, end: model.end, replacement: Buffer.from(JSON.stringify(modelName), "utf8") }]);
        await route.serve(carrying(working, edited, true), holding.response);
        const answer = holding.held();
        const answerText = answer === undefined ? undefined : Buffer.concat(answer.chunks).toString("utf8");
        return { release: holding.release, refused: answer !== undefined && answerText !== undefined && !isEncoded(answer.headers) && isUnknownModelError(answerText) };
      };
      const first = await attempt(served.model);
      if (!first.refused) {
        await first.release();
        return;
      }
      const refreshed = await deps.served.resolve(source, { refresh: true });
      if (!refreshed.ok || refreshed.model === served.model) {
        // Nothing newer to try: the server's own answer is the honest one.
        await first.release();
        return;
      }
      deps.log(`provider ${deps.provider} answered ${quotedForLog(served.model)} as an unknown model; its server now serves ${quotedForLog(refreshed.model)}, serving the request again under it`);
      deps.servedModelSent?.(refreshed.model);
      const second = await attempt(refreshed.model);
      await second.release();
    },
  };
}

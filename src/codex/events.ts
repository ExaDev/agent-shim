import { z } from "zod";

/**
 * The Codex Responses API stream events the relay acts on, validated as they arrive. Loose objects throughout: the backend adds fields freely, and an event type the relay does not know (reasoning summaries, content part lifecycle) is simply not relayed.
 */

/** Token usage as the Responses API reports it: `input_tokens` is the whole prompt, with the cached part broken out in `input_tokens_details`. */
export const ResponsesUsageSchema = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  input_tokens_details: z
    .looseObject({ cached_tokens: z.number().optional(), cache_write_tokens: z.number().optional() })
    .nullish(),
});
export type ResponsesUsage = z.infer<typeof ResponsesUsageSchema>;

const ResponseCreatedSchema = z.looseObject({
  type: z.literal("response.created"),
  response: z.looseObject({ id: z.string().optional() }).optional(),
});

const OutputItemAddedSchema = z.looseObject({
  type: z.literal("response.output_item.added"),
  output_index: z.number(),
  item: z.looseObject({
    type: z.string(),
    id: z.string().optional(),
    call_id: z.string().optional(),
    name: z.string().optional(),
  }),
});

const OutputTextDeltaSchema = z.looseObject({
  type: z.literal("response.output_text.delta"),
  output_index: z.number(),
  delta: z.string(),
});

const FunctionArgumentsDeltaSchema = z.looseObject({
  type: z.literal("response.function_call_arguments.delta"),
  output_index: z.number(),
  delta: z.string(),
});

const OutputItemDoneSchema = z.looseObject({
  type: z.literal("response.output_item.done"),
  output_index: z.number(),
});

const ResponseCompletedSchema = z.looseObject({
  type: z.literal("response.completed"),
  response: z
    .looseObject({ id: z.string().optional(), status: z.string().optional(), usage: ResponsesUsageSchema.nullish() })
    .optional(),
});

const ResponseFailedSchema = z.looseObject({
  type: z.literal("response.failed"),
  response: z.looseObject({ error: z.looseObject({ message: z.string().optional() }).nullish() }).optional(),
});

const StreamErrorSchema = z.looseObject({ type: z.literal("error"), message: z.string().optional() });

export const CodexEventSchema = z.union([
  ResponseCreatedSchema,
  OutputItemAddedSchema,
  OutputTextDeltaSchema,
  FunctionArgumentsDeltaSchema,
  OutputItemDoneSchema,
  ResponseCompletedSchema,
  ResponseFailedSchema,
  StreamErrorSchema,
]);
export type CodexEvent = z.infer<typeof CodexEventSchema>;

/** The error envelope the backend answers a refused request with; a quota refusal carries its reset timing. */
export const CodexErrorEnvelopeSchema = z.looseObject({
  error: z.looseObject({
    message: z.string().optional(),
    resets_at: z.number().optional(),
    resets_in_seconds: z.number().optional(),
  }),
});
export type CodexErrorDetail = z.infer<typeof CodexErrorEnvelopeSchema>["error"];

/**
 * Parses a server-sent-events body into the JSON value of each event's `data`, tolerating multi-line data, CRLF line endings and chunk boundaries anywhere. An event whose data is not JSON (never fully formed, or a truncated tail) is skipped.
 */
export async function* parseSse(body: Readonly<AsyncIterable<Uint8Array>>): AsyncGenerator {
  const decoder = new TextDecoder();
  let buffer = "";
  let data = "";
  const parsed = function* (raw: string): Generator {
    try {
      yield JSON.parse(raw);
    } catch {
      // An event that never finished forming carries nothing to relay.
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (data !== "") {
          yield* parsed(data);
        }
        data = "";
      } else if (line.startsWith("data:")) {
        data += line.slice("data:".length).trimStart();
      }
      newline = buffer.indexOf("\n");
    }
  }
  if (data !== "") {
    yield* parsed(data);
  }
}

/** Parses the backend's stream into validated events, skipping any event whose type the relay does not act on. */
export async function* codexEvents(body: Readonly<AsyncIterable<Uint8Array>>): AsyncGenerator<CodexEvent> {
  for await (const raw of parseSse(body)) {
    const event = CodexEventSchema.safeParse(raw);
    if (event.success) {
      yield event.data;
    }
  }
}

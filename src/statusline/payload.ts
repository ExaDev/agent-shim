import { z } from "zod";

import type { StatuslinePayloadView } from "./elements/context";

/** A number the client sent; anything else, including `null`, reads as absent. */
const number = z.number().optional().catch(undefined);
const text = z.string().optional().catch(undefined);

/**
 * The part of the client's statusline payload (the JSON Claude Code writes to standard input) the built-in statusline reads. Every field is optional and a field of the wrong type reads as absent, so one malformed field neither discards the others nor fails the render; fields the statusline does not read pass through unread. Elements read what they need from here and add their field when they first need one.
 */
const ClientPayloadSchema = z
  .looseObject({
    session_id: text,
    transcript_path: text,
    cwd: text,
    /** The Claude Code release the session runs. */
    version: text,
    /** The reasoning effort: a level name, or an object carrying one in `level` (Claude Code 2.1.115 and later). */
    effort: z.union([z.string(), z.looseObject({ level: text })]).optional().catch(undefined),
    workspace: z
      .looseObject({
        current_dir: text,
        project_dir: text,
        added_dirs: z.array(z.string()).optional().catch(undefined),
        git_worktree: text,
      })
      .optional()
      .catch(undefined),
    model: z.looseObject({ id: text, display_name: text }).optional().catch(undefined),
    context_window: z
      .looseObject({
        context_window_size: number,
        total_input_tokens: number,
        total_output_tokens: number,
        used_percentage: number,
        remaining_percentage: number,
        current_usage: z.looseObject({ input_tokens: number, output_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number }).optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    prompt_cache: z.looseObject({ hit_ratio: number }).optional().catch(undefined),
    cost: z
      .looseObject({ total_cost_usd: number, total_duration_ms: number, total_api_duration_ms: number, total_lines_added: number, total_lines_removed: number })
      .optional()
      .catch(undefined),
    rate_limits: z
      .looseObject({
        five_hour: z.looseObject({ used_percentage: number, resets_at: number }).optional().catch(undefined),
        seven_day: z.looseObject({ used_percentage: number, resets_at: number }).optional().catch(undefined),
        model_scoped: z
          .array(z.looseObject({ display_name: text, utilization: number, resets_at: text }))
          .optional()
          .catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .catch({});

export type ClientPayload = z.infer<typeof ClientPayloadSchema>;

/** Reads the client's payload into the fields the statusline uses; anything that is not a JSON object reads as an empty payload. */
export function parseClientPayload(raw: unknown): ClientPayload {
  return ClientPayloadSchema.parse(raw);
}

/** The payload fields the context row and the model segment draw, as the renderer takes them. */
export function viewOf(payload: ClientPayload): StatuslinePayloadView {
  return {
    modelDisplayName: payload.model?.display_name,
    contextUsedPercentage: payload.context_window?.used_percentage,
    contextTotalTokens: payload.context_window?.total_input_tokens,
    contextWindowTokens: payload.context_window?.context_window_size,
    cacheHitRatio: payload.prompt_cache?.hit_ratio,
    cacheReadTokens: payload.context_window?.current_usage?.cache_read_input_tokens,
    freshInputTokens: payload.context_window?.current_usage?.input_tokens,
  };
}

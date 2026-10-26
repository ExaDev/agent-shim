import { z } from "zod";

import type { StatuslinePayloadView } from "./elements/context";
import { FULL_PERCENT } from "./style";

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
        added_dirs: z
          .array(z.unknown())
          .transform((dirs) => dirs.filter((dir): dir is string => typeof dir === "string"))
          .optional()
          .catch(undefined),
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
          .array(z.looseObject({ display_name: text, utilization: number, resets_at: text }).optional().catch(undefined))
          .transform((windows) => windows.filter((window) => window !== undefined))
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

/** A token count or percentage read as absent when it is negative, since neither can be: a negative count would draw as a negative share of the window and a negative percentage as an empty bar with a negative figure. */
function nonNegative(value: number | undefined): number | undefined {
  return value !== undefined && value < 0 ? undefined : value;
}

/** A reported percentage of the window as drawn: read as absent when negative and held at the whole window when above it, since claude-hud draws neither beyond 0 to 100. */
function reportedPercent(value: number | undefined): number | undefined {
  const kept = nonNegative(value);
  return kept === undefined ? undefined : Math.min(kept, FULL_PERCENT);
}

/** `value` without its surrounding white space, or undefined when nothing is left. */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The payload fields the context row and the model segment draw, as the renderer takes them. The model's name is the client's display name, else its model id, each trimmed and read as absent when blank: claude-hud's `getModelName` falls back the same way but also rewrites an enterprise or Bedrock id into a readable name and ends in the word `Unknown`, where this ends in undefined. */
export function viewOf(payload: ClientPayload): StatuslinePayloadView {
  return {
    clientModelName: nonBlank(payload.model?.display_name) ?? nonBlank(payload.model?.id),
    contextUsedPercentage: reportedPercent(payload.context_window?.used_percentage),
    contextTotalTokens: nonNegative(payload.context_window?.total_input_tokens),
    contextWindowTokens: payload.context_window?.context_window_size,
    cacheHitRatio: payload.prompt_cache?.hit_ratio,
    cacheReadTokens: payload.context_window?.current_usage?.cache_read_input_tokens,
    freshInputTokens: payload.context_window?.current_usage?.input_tokens,
  };
}

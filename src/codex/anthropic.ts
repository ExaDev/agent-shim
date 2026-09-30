import { z } from "zod";

/**
 * The parts of an Anthropic Messages API request the codex translator reads. Every object is loose: Claude Code (and headroom in front of it) send fields this translator has no use for (`cache_control`, `thinking`, `temperature`, beta fields), and rejecting a request over a field the backend would never see would break every new Claude Code release. What the translator does read is validated exactly.
 */

/** A text block. */
const TextBlockSchema = z.looseObject({ type: z.literal("text"), text: z.string() });

/** An image carried inline as base64. */
const Base64ImageSourceSchema = z.looseObject({ type: z.literal("base64"), media_type: z.string().min(1), data: z.string() });

/** An image referenced by URL. */
const UrlImageSourceSchema = z.looseObject({ type: z.literal("url"), url: z.string().min(1) });

const ImageBlockSchema = z.looseObject({
  type: z.literal("image"),
  source: z.union([Base64ImageSourceSchema, UrlImageSourceSchema]),
});

const ToolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

/** The blocks a tool result's content may hold. Only text survives translation; anything else is replaced by a marker, since the backend's function output is a plain string. */
const ToolResultContentBlockSchema = z.union([TextBlockSchema, z.looseObject({ type: z.string() })]);

const ToolResultBlockSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(ToolResultContentBlockSchema)]).optional(),
});

/**
 * Any other block (`thinking`, `redacted_thinking`, server tool blocks, and whatever a later API version adds). Accepted so the request validates, and dropped in translation: the backend keeps its reasoning server-side and does not accept replayed reasoning items.
 */
const OtherBlockSchema = z.looseObject({ type: z.string() });

export const ContentBlockSchema = z.union([TextBlockSchema, ImageBlockSchema, ToolUseBlockSchema, ToolResultBlockSchema, OtherBlockSchema]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/** One conversation turn. `system` is not an Anthropic API role, but Claude Code sends mid-conversation system turns (agent listings, token counts), so it is accepted here and folded into a user turn in translation. */
const MessageSchema = z.looseObject({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});
export type AnthropicMessage = z.infer<typeof MessageSchema>;

const ToolSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
});
export type AnthropicTool = z.infer<typeof ToolSchema>;

const ToolChoiceSchema = z.union([
  z.looseObject({ type: z.enum(["auto", "none", "any"]) }),
  z.looseObject({ type: z.literal("tool"), name: z.string().min(1) }),
]);
export type AnthropicToolChoice = z.infer<typeof ToolChoiceSchema>;

/** The top-level system prompt: a plain string, or a list of blocks of which only text blocks carry prompt text. */
const SystemSchema = z.union([z.string(), z.array(z.union([TextBlockSchema, OtherBlockSchema]))]);

export const MessagesRequestSchema = z.looseObject({
  model: z.string().optional(),
  system: SystemSchema.optional(),
  messages: z.array(MessageSchema),
  tools: z.array(ToolSchema).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  stream: z.boolean().optional(),
  /** `user_id` is stable for one Claude Code session and differs between sessions, which is what makes it the right key for both the backend's prompt cache and its session header. */
  metadata: z.looseObject({ user_id: z.string().optional() }).optional(),
  /** Claude Code's effort setting. Any string is accepted; the translator honours only the levels the backend understands. */
  output_config: z.looseObject({ effort: z.string().optional() }).optional(),
});
export type MessagesRequest = z.infer<typeof MessagesRequestSchema>;

/** The `/v1/messages/count_tokens` request: the same conversation fields, none of which are required to estimate a count. */
export const CountTokensRequestSchema = z.looseObject({
  system: z.unknown().optional(),
  messages: z.unknown().optional(),
  tools: z.unknown().optional(),
});

/** Narrows a content block to a text block. */
export function isTextBlock(block: { readonly type: string }): block is z.infer<typeof TextBlockSchema> {
  return TextBlockSchema.safeParse(block).success;
}

/** Narrows a content block to an image block. */
export function isImageBlock(block: { readonly type: string }): block is z.infer<typeof ImageBlockSchema> {
  return ImageBlockSchema.safeParse(block).success;
}

/** Narrows a content block to a tool_use block. */
export function isToolUseBlock(block: { readonly type: string }): block is z.infer<typeof ToolUseBlockSchema> {
  return ToolUseBlockSchema.safeParse(block).success;
}

/** Narrows a content block to a tool_result block. */
export function isToolResultBlock(block: { readonly type: string }): block is z.infer<typeof ToolResultBlockSchema> {
  return ToolResultBlockSchema.safeParse(block).success;
}

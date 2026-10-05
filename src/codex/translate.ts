import { createHash } from "node:crypto";

import {
  CODEX_DEFAULT_EFFORT,
  CODEX_DEFAULT_LOGIN,
  CODEX_DEFAULT_MODEL,
  CODEX_DEFAULT_TIER_MODELS,
  CODEX_TIERS,
  type CodexEffort,
  type CodexLogin,
  type CodexProviderConfig,
  type CodexTier,
} from "../config/schema";
import {
  isImageBlock,
  isTextBlock,
  isToolResultBlock,
  isToolUseBlock,
  type AnthropicMessage,
  type AnthropicTool,
  type AnthropicToolChoice,
  type ContentBlock,
  type MessagesRequest,
} from "./anthropic";

/** A codex provider's translation settings with every default applied. */
export interface ResolvedCodexConfig {
  readonly defaultModel: string;
  readonly models: Readonly<Record<CodexTier, string>>;
  readonly effort: CodexEffort;
  readonly login: CodexLogin;
}

/** Applies the shipped defaults to a provider's optional `codex` block. */
export function resolveCodexConfig(config: CodexProviderConfig | undefined): ResolvedCodexConfig {
  const overrides = config?.models;
  return {
    defaultModel: config?.defaultModel ?? CODEX_DEFAULT_MODEL,
    models: {
      fable: overrides?.fable ?? CODEX_DEFAULT_TIER_MODELS.fable,
      opus: overrides?.opus ?? CODEX_DEFAULT_TIER_MODELS.opus,
      sonnet: overrides?.sonnet ?? CODEX_DEFAULT_TIER_MODELS.sonnet,
      haiku: overrides?.haiku ?? CODEX_DEFAULT_TIER_MODELS.haiku,
    },
    effort: config?.effort ?? CODEX_DEFAULT_EFFORT,
    login: config?.login ?? CODEX_DEFAULT_LOGIN,
  };
}

/** One part of a Responses API message item. */
type InputContentPart =
  | { readonly type: "input_text"; readonly text: string }
  | { readonly type: "output_text"; readonly text: string }
  | { readonly type: "input_image"; readonly image_url: string };

/** One Responses API input item. */
type InputItem =
  | { readonly type: "message"; readonly role: "user" | "assistant"; readonly content: readonly InputContentPart[] }
  | { readonly type: "function_call"; readonly call_id: string; readonly name: string; readonly arguments: string }
  | { readonly type: "function_call_output"; readonly call_id: string; readonly output: string };

/** One function tool offered to the backend. */
interface FunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: false;
}

type ResponsesToolChoice = "auto" | "none" | "required" | { readonly type: "function"; readonly name: string };

/** The Codex Responses API request the translator produces. */
export interface ResponsesRequest {
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly InputItem[];
  /** Always true: the relay aggregates the stream itself when the client asked for a single JSON response. */
  readonly stream: true;
  readonly store: false;
  readonly text: { readonly verbosity: "medium" };
  readonly reasoning?: { readonly effort: Exclude<CodexEffort, "none">; readonly summary: "auto" };
  readonly prompt_cache_key?: string;
  readonly tools?: readonly FunctionTool[];
  readonly tool_choice?: ResponsesToolChoice;
}

/** A translated request plus the reverse tool-name mapping the response relay needs to restore the names Claude Code dispatches on. */
export interface TranslatedRequest {
  readonly request: ResponsesRequest;
  /** Shortened tool name to the original, for every name that had to be shortened. */
  readonly toolNames: ReadonlyMap<string, string>;
}

/**
 * Maps a requested Claude model onto a codex model. A request that already names a codex model (every model the backend serves is `gpt-*`) passes through untouched, so Claude Code's own model settings (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`) can name one explicitly. Otherwise the first tier in `CODEX_TIERS` order whose name appears in the requested model (case-insensitive) decides, and `defaultModel` covers everything else.
 */
export function mapModel(requested: string, config: ResolvedCodexConfig): string {
  if (requested.startsWith("gpt-")) {
    return requested;
  }
  const lower = requested.toLowerCase();
  const tier = CODEX_TIERS.find((candidate) => lower.includes(candidate));
  return tier === undefined ? config.defaultModel : config.models[tier];
}

/** The efforts a request's own `output_config.effort` may select; anything else (including `max`, which the backend has no equivalent for) falls back to the provider's configured effort. */
const REQUESTABLE_EFFORTS: readonly string[] = ["low", "medium", "high"] satisfies readonly CodexEffort[];

function isRequestableEffort(value: string): value is Exclude<CodexEffort, "none"> {
  return REQUESTABLE_EFFORTS.includes(value);
}

/** The reasoning effort for one request: Claude Code's own effort setting when the backend accepts it, else the provider's configured default. */
export function mapEffort(request: MessagesRequest, config: ResolvedCodexConfig): CodexEffort {
  const requested = request.output_config?.effort;
  return requested !== undefined && isRequestableEffort(requested) ? requested : config.effort;
}

/** Claude Code prefixes its system prompt with a billing telemetry line the codex backend has no use for. */
const BILLING_HEADER_LINE = /^x-anthropic-billing-header:[^\n]*\n/;

/** The top-level system prompt as the Responses API's `instructions`: every text block joined by newlines, minus Claude Code's billing line. */
function systemToInstructions(system: MessagesRequest["system"]): string {
  if (system === undefined) {
    return "";
  }
  const texts = typeof system === "string" ? [system] : system.filter(isTextBlock).map((block) => block.text);
  return texts.join("\n").replace(BILLING_HEADER_LINE, "");
}

/** The backend rejects tool names longer than this, which Claude Code's MCP tool names regularly exceed. */
export const CODEX_TOOL_NAME_LIMIT = 64;

/** Hex characters of the name hash kept in a shortened tool name: enough that two long names sharing a prefix do not collide in practice. */
const TOOL_NAME_HASH_CHARS = 8;

/**
 * A tool name the backend accepts: unchanged when within `CODEX_TOOL_NAME_LIMIT`, otherwise a prefix plus a hash of the whole name, so a replayed history shortens identically every turn. Every shortened name is recorded in `names` so the relay can hand Claude Code back the original.
 */
export function shortToolName(name: string, names: Map<string, string>): string {
  if (name.length <= CODEX_TOOL_NAME_LIMIT) {
    return name;
  }
  const hash = createHash("sha256").update(name).digest("hex").slice(0, TOOL_NAME_HASH_CHARS);
  const shortened = `${name.slice(0, CODEX_TOOL_NAME_LIMIT - TOOL_NAME_HASH_CHARS - 1)}_${hash}`;
  names.set(shortened, name);
  return shortened;
}

/** What replaces a non-text part of a tool result, since a function output is a plain string. */
export const NON_TEXT_TOOL_RESULT = "[non-text tool result omitted]";

function flattenToolResult(content: Extract<ContentBlock, { type: "tool_result" }>["content"]): string {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content.map((block) => (isTextBlock(block) ? block.text : NON_TEXT_TOOL_RESULT)).join("\n");
}

/** Wraps a folded system turn's text in the reminder convention Claude Code already uses for context it embeds in user turns itself. */
export function systemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

/** The blocks of one turn, with a string content read as one text block and a system turn's text wrapped as a reminder. */
function turnBlocks(message: AnthropicMessage): readonly ContentBlock[] {
  const blocks: readonly ContentBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (message.role !== "system") {
    return blocks;
  }
  return blocks.map((block) => (isTextBlock(block) ? { ...block, text: systemReminder(block.text) } : block));
}

/**
 * Anthropic messages as Responses API input items. Consecutive text and image parts of the same role batch into one message item; `tool_use` and `tool_result` become `function_call` and `function_call_output` items linked by call id. Mid-conversation system turns fold into user turns, because the backend accepts only user and assistant input. Every other block type is dropped, and so is whitespace-only text.
 */
function messagesToInput(messages: readonly AnthropicMessage[], names: Map<string, string>): InputItem[] {
  const input: InputItem[] = [];
  let pending: { role: "user" | "assistant"; parts: InputContentPart[] } | undefined;
  const flush = (): void => {
    if (pending !== undefined && pending.parts.length > 0) {
      input.push({ type: "message", role: pending.role, content: pending.parts });
    }
    pending = undefined;
  };
  const partsFor = (role: "user" | "assistant"): InputContentPart[] => {
    if (pending?.role !== role) {
      flush();
      pending = { role, parts: [] };
    }
    return pending.parts;
  };

  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    for (const block of turnBlocks(message)) {
      if (isTextBlock(block)) {
        if (block.text.trim() === "") {
          continue;
        }
        partsFor(role).push(role === "assistant" ? { type: "output_text", text: block.text } : { type: "input_text", text: block.text });
      } else if (isImageBlock(block)) {
        const { source } = block;
        partsFor(role).push({
          type: "input_image",
          image_url: source.type === "base64" ? `data:${source.media_type};base64,${source.data}` : source.url,
        });
      } else if (isToolUseBlock(block)) {
        flush();
        input.push({
          type: "function_call",
          call_id: block.id,
          name: shortToolName(block.name, names),
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (isToolResultBlock(block)) {
        flush();
        input.push({ type: "function_call_output", call_id: block.tool_use_id, output: flattenToolResult(block.content) });
      }
    }
  }
  flush();
  return input;
}

/** The parameters schema offered for a tool that declares none (a server tool, say): an object with no properties. */
const EMPTY_PARAMETERS: Readonly<Record<string, unknown>> = { type: "object", properties: {} };

function mapTools(tools: readonly AnthropicTool[] | undefined, names: Map<string, string>): FunctionTool[] | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    name: shortToolName(tool.name, names),
    description: tool.description ?? "",
    parameters: tool.input_schema ?? EMPTY_PARAMETERS,
    strict: false,
  }));
}

function mapToolChoice(choice: AnthropicToolChoice | undefined, names: Map<string, string>): ResponsesToolChoice | undefined {
  if (choice === undefined) {
    return undefined;
  }
  switch (choice.type) {
    case "auto":
    case "none":
      return choice.type;
    case "any":
      return "required";
    case "tool":
      return { type: "function", name: shortToolName(choice.name, names) };
    default:
      return choice satisfies never;
  }
}

/**
 * Translates one Anthropic Messages request into a Codex Responses request. Pure: no I/O, no clock, no randomness.
 *
 * `prompt_cache_key` comes from `metadata.user_id`, which is stable per Claude Code session: without a key the backend assigns a random one per request and its prompt cache never hits.
 */
export function translateRequest(body: MessagesRequest, config: ResolvedCodexConfig): TranslatedRequest {
  const names = new Map<string, string>();
  const effort = mapEffort(body, config);
  const tools = mapTools(body.tools, names);
  const toolChoice = mapToolChoice(body.tool_choice, names);
  const userId = body.metadata?.user_id;
  const request: ResponsesRequest = {
    model: mapModel(body.model ?? "", config),
    instructions: systemToInstructions(body.system),
    input: messagesToInput(body.messages, names),
    stream: true,
    store: false,
    text: { verbosity: "medium" },
    ...(effort === "none" ? {} : { reasoning: { effort, summary: "auto" } }),
    ...(userId === undefined ? {} : { prompt_cache_key: userId }),
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
  return { request, toolNames: names };
}

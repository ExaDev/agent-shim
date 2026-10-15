import { createHash } from "node:crypto";

import {
  ANTIGRAVITY_DEFAULT_EFFORT,
  ANTIGRAVITY_DEFAULT_MODE,
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_DEFAULT_TIER_MODELS,
  ANTIGRAVITY_EFFORTS,
  ANTIGRAVITY_TIERS,
  type AntigravityEffort,
  type AntigravityMode,
  type AntigravityProviderConfig,
  type AntigravityTier,
} from "../config/schema";
import {
  isImageBlock,
  isTextBlock,
  isToolResultBlock,
  isToolUseBlock,
  type AnthropicMessage,
  type AnthropicTool,
  type ContentBlock,
  type MessagesRequest,
} from "../codex/anthropic";
import type {
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiGenerateContentRequest,
  GeminiPart,
  GeminiSystemInstruction,
  GeminiTool,
} from "./geminiSchema";

/** An Antigravity provider's resolved settings. */
export interface ResolvedAntigravityConfig {
  readonly mode: AntigravityMode;
  readonly defaultModel: string;
  readonly models: Readonly<Record<AntigravityTier, string>>;
  readonly effort: AntigravityEffort;
  readonly cloud: {
    readonly endpoint?: string;
    readonly projectId?: string;
    readonly location?: string;
  };
  readonly local: {
    readonly command?: readonly string[];
    readonly socketPath?: string;
  };
}

/** Applies shipped defaults to a provider's `antigravity` configuration block. */
export function resolveAntigravityConfig(config: AntigravityProviderConfig | undefined): ResolvedAntigravityConfig {
  const overrides = config?.models;
  return {
    mode: config?.mode ?? ANTIGRAVITY_DEFAULT_MODE,
    defaultModel: config?.defaultModel ?? ANTIGRAVITY_DEFAULT_MODEL,
    models: {
      fable: overrides?.fable ?? ANTIGRAVITY_DEFAULT_TIER_MODELS.fable,
      opus: overrides?.opus ?? ANTIGRAVITY_DEFAULT_TIER_MODELS.opus,
      sonnet: overrides?.sonnet ?? ANTIGRAVITY_DEFAULT_TIER_MODELS.sonnet,
      haiku: overrides?.haiku ?? ANTIGRAVITY_DEFAULT_TIER_MODELS.haiku,
    },
    effort: config?.effort ?? ANTIGRAVITY_DEFAULT_EFFORT,
    cloud: {
      endpoint: config?.cloud?.endpoint,
      projectId: config?.cloud?.projectId,
      location: config?.cloud?.location,
    },
    local: {
      command: config?.local?.command,
      socketPath: config?.local?.socketPath,
    },
  };
}

/**
 * Maps a requested Claude model name onto an Antigravity/Gemini model name.
 * If the requested model already names a gemini model (e.g. `gemini-...`), it passes through untouched.
 */
export function mapModel(requested: string, config: ResolvedAntigravityConfig): string {
  if (requested.startsWith("gemini-") || requested.startsWith("antigravity-")) {
    return requested;
  }
  const lower = requested.toLowerCase();
  const tier = ANTIGRAVITY_TIERS.find((candidate) => lower.includes(candidate));
  return tier === undefined ? config.defaultModel : config.models[tier];
}

/** Token budgets for each effort level in Gemini's thinking configuration. */
const EFFORT_TO_BUDGET: Readonly<Record<AntigravityEffort, number>> = {
  none: 0,
  low: 1024,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};

/** Determines the thinking budget for a request. */
export function mapEffort(request: MessagesRequest, config: ResolvedAntigravityConfig): number | undefined {
  const requested = request.output_config?.effort;
  const level: AntigravityEffort = ANTIGRAVITY_EFFORTS.find((effort) => effort === requested) ?? config.effort;
  const budget = EFFORT_TO_BUDGET[level];
  return budget > 0 ? budget : undefined;
}

/** Claude Code prefixes system prompts with billing telemetry line to strip. */
const BILLING_HEADER_LINE = /^x-anthropic-billing-header:[^\n]*\n/;

/** Converts the top-level Anthropic system prompt to a Gemini systemInstruction. */
export function systemToInstruction(system: MessagesRequest["system"]): GeminiSystemInstruction | undefined {
  if (system === undefined) {
    return undefined;
  }
  const texts = typeof system === "string" ? [system] : system.filter(isTextBlock).map((b) => b.text);
  const combined = texts.join("\n").replace(BILLING_HEADER_LINE, "").trim();
  return combined.length > 0 ? { parts: [{ text: combined }] } : undefined;
}

const ANTIGRAVITY_TOOL_NAME_LIMIT = 64;
const TOOL_NAME_HASH_CHARS = 8;

/**
 * Normalizes tool names for Gemini (must match `^[a-zA-Z_][a-zA-Z0-9_]*$`).
 * Replaces hyphens and other disallowed characters with underscores, shortening and hashing if necessary.
 */
export function shortToolName(name: string, names: Map<string, string>): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (sanitized === name && name.length <= ANTIGRAVITY_TOOL_NAME_LIMIT) {
    return name;
  }
  let result: string;
  if (sanitized.length <= ANTIGRAVITY_TOOL_NAME_LIMIT) {
    result = sanitized;
  } else {
    const hash = createHash("sha256").update(name).digest("hex").slice(0, TOOL_NAME_HASH_CHARS);
    const prefix = sanitized.slice(0, ANTIGRAVITY_TOOL_NAME_LIMIT - TOOL_NAME_HASH_CHARS - 1);
    result = `${prefix}_${hash}`;
  }
  names.set(result, name);
  return result;
}

const NON_TEXT_TOOL_RESULT = "[non-text tool result omitted]";

function flattenToolResult(content: Extract<ContentBlock, { type: "tool_result" }>["content"]): string {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content.map((block) => (isTextBlock(block) ? block.text : NON_TEXT_TOOL_RESULT)).join("\n");
}

function systemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

function turnBlocks(message: AnthropicMessage): readonly ContentBlock[] {
  const blocks: readonly ContentBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (message.role !== "system") {
    return blocks;
  }
  return blocks.map((block) => (isTextBlock(block) ? { ...block, text: systemReminder(block.text) } : block));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Translates Anthropic messages into strictly alternating Gemini contents.
 * Coalesces consecutive turns with the same role and formats tool calls/results.
 */
function messagesToGeminiContents(
  messages: readonly AnthropicMessage[],
  names: Map<string, string>,
  toolIdToName: Map<string, string>,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  let pendingRole: "user" | "model" | undefined;
  let pendingParts: GeminiPart[] = [];

  const flush = (): void => {
    if (pendingRole !== undefined && pendingParts.length > 0) {
      contents.push({ role: pendingRole, parts: pendingParts });
    }
    pendingRole = undefined;
    pendingParts = [];
  };

  const ensureRole = (role: "user" | "model"): GeminiPart[] => {
    if (pendingRole !== role) {
      flush();
      pendingRole = role;
    }
    return pendingParts;
  };

  for (const message of messages) {
    const defaultRole = message.role === "assistant" ? "model" : "user";
    for (const block of turnBlocks(message)) {
      if (isTextBlock(block)) {
        if (block.text.trim() === "") {
          continue;
        }
        ensureRole(defaultRole).push({ text: block.text });
      } else if (isImageBlock(block)) {
        const { source } = block;
        if (source.type === "base64") {
          ensureRole("user").push({
            inlineData: {
              mimeType: source.media_type,
              data: source.data,
            },
          });
        }
      } else if (isToolUseBlock(block)) {
        const sanitizedName = shortToolName(block.name, names);
        toolIdToName.set(block.id, sanitizedName);
        ensureRole("model").push({
          functionCall: {
            name: sanitizedName,
            args: isRecord(block.input) ? block.input : {},
          },
        });
      } else if (isToolResultBlock(block)) {
        const toolName = toolIdToName.get(block.tool_use_id) ?? "unknown_tool";
        ensureRole("user").push({
          functionResponse: {
            name: toolName,
            response: { output: flattenToolResult(block.content) },
          },
        });
      }
    }
  }

  flush();
  return contents;
}

const EMPTY_SCHEMA: Readonly<Record<string, unknown>> = { type: "object", properties: {} };

function mapTools(tools: readonly AnthropicTool[] | undefined, names: Map<string, string>): GeminiTool[] | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined;
  }
  const declarations: GeminiFunctionDeclaration[] = tools.map((tool) => ({
    name: shortToolName(tool.name, names),
    description: tool.description,
    parameters: tool.input_schema ?? EMPTY_SCHEMA,
  }));
  return [{ functionDeclarations: declarations }];
}

export interface TranslatedAntigravityRequest {
  readonly model: string;
  readonly request: GeminiGenerateContentRequest;
  readonly toolNames: ReadonlyMap<string, string>;
}

/** Translates an Anthropic MessagesRequest into a Gemini GenerateContentRequest. */
export function translateRequest(request: MessagesRequest, config: ResolvedAntigravityConfig): TranslatedAntigravityRequest {
  const toolNames = new Map<string, string>();
  const toolIdToName = new Map<string, string>();
  const model = mapModel(request.model ?? "", config);
  const thinkingBudget = mapEffort(request, config);
  const systemInstruction = systemToInstruction(request.system);
  const contents = messagesToGeminiContents(request.messages, toolNames, toolIdToName);
  const tools = mapTools(request.tools, toolNames);

  const req: GeminiGenerateContentRequest = {
    contents,
    ...(systemInstruction === undefined ? {} : { systemInstruction }),
    ...(tools === undefined ? {} : { tools }),
    ...(thinkingBudget !== undefined ? { generationConfig: { thinkingConfig: { thinkingBudget } } } : {}),
  };

  return {
    model,
    request: req,
    toolNames,
  };
}

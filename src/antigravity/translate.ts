import { createHash } from "node:crypto";

import { toolCallSignatureOf } from "./signatures";

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

/** The context-window marker Claude Code parses out of a model name (`glm-5.3[1m]` sizes its window at 1M instead of assuming 200k for a name it does not know). The backend names carry no such marker, so it is stripped before the name is mapped or passed through. */
const CONTEXT_MARKER_1M = "[1m]";

/**
 * Maps a requested Claude model name onto a Gemini model name. A name that already targets the backend directly (a `gemini-...` or `antigravity-...` model) passes through untouched; every other name is mapped onto its tier's model. A trailing `[1m]` context marker is stripped first: it tells Claude Code the window size and never reaches the backend.
 */
export function mapModel(requested: string, config: ResolvedAntigravityConfig): string {
  const stripped = requested.toLowerCase().endsWith(CONTEXT_MARKER_1M) ? requested.slice(0, -CONTEXT_MARKER_1M.length) : requested;
  if (stripped.startsWith("gemini-") || stripped.startsWith("antigravity-")) {
    return stripped;
  }
  const lower = stripped.toLowerCase();
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
        const signature = toolCallSignatureOf(block.id);
        ensureRole("model").push({
          functionCall: {
            name: sanitizedName,
            args: isRecord(block.input) ? block.input : {},
          },
          // The relay remembered the signature the backend attached to this exact call; echoing it back is what the backend requires of a repeated function call.
          ...(signature === undefined ? {} : { thoughtSignature: signature }),
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

/**
 * The JSON Schema keys the Cloud Code endpoint's function declarations accept. Every other key is rejected field by field, so each has a named translation below rather than being silently dropped: `$schema` is metadata with no Gemini meaning, `additionalProperties: false` is Gemini's default shape (a schema's properties are all there are), and the two keys with no native Gemini form (`additionalProperties` as a value schema, `propertyNames`) carry their information in the node's description instead, the one channel Gemini leaves open.
 */
const GEMINI_SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "anyOf", "items", "properties", "required", "minimum", "maximum", "minItems", "maxItems"]);

/** Names a JSON Schema value schema in one clause, for the keys with no Gemini form that must be described in prose instead: `string`, `a list of string`, `an object`. */
function describeSchemaValue(node: unknown): string {
  if (!isRecord(node)) {
    return "any value";
  }
  const type = node.type;
  const name = typeof type === "string" ? type : Array.isArray(type) && typeof type[0] === "string" ? type[0] : "value";
  if (name === "array") {
    return `a list of ${describeSchemaValue(node.items)}`;
  }
  return name === "object" ? "an object" : `a ${name}`;
}

/**
 * Converts one JSON Schema node to the subset the Cloud Code endpoint accepts, recursively. A type array names its non-null member with the node marked nullable (a bare `type: "null"` node keeps no type at all); `properties`, `items` and `anyOf` are converted in place; the keys with no Gemini form are folded into the description verbatim.
 */
function toGeminiSchema(node: unknown): unknown {
  if (!isRecord(node)) {
    return node;
  }
  const out: Record<string, unknown> = {};
  const notes: string[] = [];
  let nullable = false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" && Array.isArray(value)) {
      const named = value.filter((entry) => entry !== "null");
      if (named.length > 0 && typeof named[0] === "string") {
        out.type = named[0];
      }
      nullable = value.includes("null");
      continue;
    }
    if (!GEMINI_SCHEMA_KEYS.has(key)) {
      if (key === "additionalProperties" && value !== false) {
        notes.push(`Each value is ${describeSchemaValue(value)}.`);
      } else if (key === "propertyNames" && isRecord(value) && typeof value.pattern === "string") {
        notes.push(`Keys match ${value.pattern}.`);
      }
      continue;
    }
    out[key] = value;
  }
  if (out.type === "null") {
    delete out.type;
  }
  if (nullable && out.type !== undefined) {
    out.nullable = true;
  }
  if (notes.length > 0) {
    const description = typeof out.description === "string" ? out.description : "";
    out.description = `${description}${description === "" ? "" : " "}${notes.join(" ")}`;
  }
  if ("properties" in out && isRecord(out.properties)) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([name, child]) => [name, toGeminiSchema(child)]));
  }
  if ("items" in out) {
    out.items = toGeminiSchema(out.items);
  } else if (out.type === "array") {
    // JSON Schema allows an array with no items (any element); Gemini requires the field, and an empty schema is its permissive form.
    out.items = {};
  }
  if (Array.isArray(out.anyOf)) {
    out.anyOf = out.anyOf.map(toGeminiSchema);
  }
  return out;
}

function mapTools(tools: readonly AnthropicTool[] | undefined, names: Map<string, string>): GeminiTool[] | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined;
  }
  const declarations: GeminiFunctionDeclaration[] = tools.map((tool) => {
    const converted = tool.input_schema === undefined ? undefined : toGeminiSchema(tool.input_schema);
    return {
      name: shortToolName(tool.name, names),
      description: tool.description,
      parameters: isRecord(converted) ? converted : EMPTY_SCHEMA,
    };
  });
  return [{ functionDeclarations: declarations }];
}

export interface TranslatedAntigravityRequest {
  readonly model: string;
  readonly request: GeminiGenerateContentRequest;
  readonly toolNames: ReadonlyMap<string, string>;
}

/** The effort levels a suffixed backend model ID can name; xhigh and max have no ID of their own and ride the high variant's ID with their larger thinking budget. */
const EFFORT_SUFFIXES = new Set(["low", "medium", "high"]);

/** The suffix a request's effort level names on a model ID: the level itself when the backend spells one, the high variant for the levels above it, and low for none (the backend has no effort-free variant). */
function effortSuffixOf(level: AntigravityEffort): "low" | "medium" | "high" {
  if (level === "medium") {
    return "medium";
  }
  return level === "none" || level === "low" ? "low" : "high";
}

/** Strips one trailing effort suffix from a model name, returning the base the suffix was stripped from; undefined when the name already carries none. */
function splitEffortSuffix(model: string): { base: string; suffix: string } | undefined {
  const index = model.lastIndexOf("-");
  if (index === -1) {
    return undefined;
  }
  const suffix = model.slice(index + 1);
  return EFFORT_SUFFIXES.has(suffix) ? { base: model.slice(0, index), suffix } : undefined;
}

/**
 * Completes a bare model name with the request's effort suffix when the backend serves that family under effort-qualified IDs only. Which families those are is read from the configuration's own model table (its tiers and default), never hardcoded: a requested name that already names its effort, or whose base the table does not hold, passes through unchanged, so both the suffixed spelling and a family the backend serves bare keep working.
 */
function completeEffortSuffix(model: string, request: MessagesRequest, config: ResolvedAntigravityConfig): string {
  if (splitEffortSuffix(model) !== undefined) {
    return model;
  }
  const configured = [config.defaultModel, ...Object.values(config.models)];
  const effort = request.output_config?.effort;
  const level = ANTIGRAVITY_EFFORTS.find((candidate) => candidate === effort) ?? config.effort;
  const suffixed = `${model}-${effortSuffixOf(level)}`;
  return configured.some((entry) => entry === suffixed || splitEffortSuffix(entry)?.base === model) ? suffixed : model;
}

/** Translates an Anthropic MessagesRequest into a Gemini GenerateContentRequest. */
export function translateRequest(request: MessagesRequest, config: ResolvedAntigravityConfig): TranslatedAntigravityRequest {
  const toolNames = new Map<string, string>();
  const toolIdToName = new Map<string, string>();
  const model = completeEffortSuffix(mapModel(request.model ?? "", config), request, config);
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

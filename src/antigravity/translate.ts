import { createHash } from "node:crypto";

import { withoutContextMarker as stripContextMarker } from "../models/identity";
import { selectMember, type SelectionCandidate } from "../selection/engine";

/** Seconds per hour, to hand the engine a reset time in its own unit. */
const SECONDS_PER_HOUR = 3600;

/** The pressure a candidate whose quota the map does not measure competes at. */
const NEUTRAL_PRESSURE = 1;

import { antigravityQuotaExhaustion, antigravityQuotaPressure, type AntigravityQuotaMap } from "./quota";
import { toolCallSignatureOf, UNVERIFIED_THOUGHT_SIGNATURE } from "./signatures";

import {
  ANTIGRAVITY_DEFAULT_EFFORT,
  ANTIGRAVITY_DEFAULT_MODE,
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_DEFAULT_TIER_MODELS,
  ANTIGRAVITY_EFFORTS,
  CLAUDE_TIERS,
  type AntigravityEffort,
  type AntigravityMode,
  type AntigravityProviderConfig,
  type ClaudeTier,
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
  /** Each tier's candidate models in preference order; a request is routed to the first whose quota is not spent. */
  readonly models: Readonly<Record<ClaudeTier, readonly string[]>>;
  /** The aliases: the lower-cased requested name each key matches in full, and its candidate models in preference order. The configured ones, and `auto` unless one is configured under that name. */
  readonly aliases: ReadonlyMap<string, readonly string[]>;
  /** Whether a request whose tier has no quota left is served from the tiers below it. */
  readonly degradeDownTiers: boolean;
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

/**
 * The name of the virtual model that goes to whichever backend model has quota: every tier's candidates, strongest tier first, each once, so a request is served by the first of them that is unspent and otherwise by the one whose allowance is worth the most. It is an alias like any configured one, so `/model auto` and `--model auto` select it, and a configured alias of the same name replaces it.
 */
export const AUTO_ALIAS = "auto";

/** A configured target as its ordered candidate list. */
function candidatesOf(target: string | readonly string[]): readonly string[] {
  return typeof target === "string" ? [target] : target;
}

function isAntigravityTier(key: string): key is ClaudeTier {
  return CLAUDE_TIERS.some((tier) => tier === key);
}

/** Applies shipped defaults to a provider's `antigravity` configuration block. */
export function resolveAntigravityConfig(config: AntigravityProviderConfig | undefined): ResolvedAntigravityConfig {
  const overrides = config?.models ?? {};
  const aliases = new Map<string, readonly string[]>();
  for (const [key, target] of Object.entries(overrides)) {
    if (!isAntigravityTier(key)) {
      aliases.set(key.toLowerCase(), candidatesOf(target));
    }
  }
  const tierModel = (tier: ClaudeTier): readonly string[] => {
    const target = overrides[tier];
    return target === undefined ? ANTIGRAVITY_DEFAULT_TIER_MODELS[tier] : candidatesOf(target);
  };
  if (!aliases.has(AUTO_ALIAS)) {
    aliases.set(AUTO_ALIAS, [...new Set(CLAUDE_TIERS.flatMap(tierModel))]);
  }
  return {
    mode: config?.mode ?? ANTIGRAVITY_DEFAULT_MODE,
    defaultModel: config?.defaultModel ?? ANTIGRAVITY_DEFAULT_MODEL,
    models: { fable: tierModel("fable"), opus: tierModel("opus"), sonnet: tierModel("sonnet"), haiku: tierModel("haiku") },
    aliases,
    degradeDownTiers: config?.degradeDownTiers ?? false,
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

/** Backend model families whose every name is the backend's own: Gemini and its Antigravity builds, and the open GPT-OSS models Antigravity serves. */
const BACKEND_FAMILY_PREFIXES = ["gemini-", "antigravity-", "gpt-oss-"] as const;

/** The Claude models the backend serves carry a trailing effort or thinking variant (`claude-sonnet-5-5-high`, `claude-opus-4-6-thinking`), which the names Claude Code itself sends (`claude-sonnet-5-5`) never do; that suffix is what tells a backend Claude model from a Claude Code tier name. */
const BACKEND_CLAUDE_NAME = /^claude-.+-(?:low|medium|high|thinking)$/;

/** True when a requested name already is one of the backend's own model names. */
function isBackendModelName(name: string): boolean {
  return BACKEND_FAMILY_PREFIXES.some((prefix) => name.startsWith(prefix)) || BACKEND_CLAUDE_NAME.test(name);
}

/**
 * Maps a requested model name onto its backend candidates, in order: a configured alias that matches the whole name; a name that already is a backend model (Gemini, Antigravity or GPT-OSS family, or a Claude name with an effort or thinking suffix) passes through untouched, which is what lets `/model` select first and third party backend models directly; otherwise the name's tier (fable, opus, sonnet or haiku, by substring) selects that tier's candidates, and a name matching no tier maps to the default. A trailing `[1m]` context marker is stripped first: it tells Claude Code the window size and never reaches the backend.
 */
export function mapModel(requested: string, config: ResolvedAntigravityConfig): readonly string[] {
  return resolveName(requested, config).candidates;
}

/** A requested name resolved to its candidates, and the tier it selected when it selected one. */
function resolveName(requested: string, config: ResolvedAntigravityConfig): { readonly candidates: readonly string[]; readonly tier: ClaudeTier | undefined } {
  const stripped = stripContextMarker(requested);
  const lower = stripped.toLowerCase();
  const alias = config.aliases.get(lower);
  if (alias !== undefined) {
    return { candidates: alias, tier: undefined };
  }
  if (isBackendModelName(stripped)) {
    return { candidates: [stripped], tier: undefined };
  }
  const tier = CLAUDE_TIERS.find((candidate) => lower.includes(candidate));
  return tier === undefined ? { candidates: [config.defaultModel], tier: undefined } : { candidates: config.models[tier], tier };
}

/**
 * The candidate lists a request is served from, best first: the name's own, and, when the configuration degrades down tiers and the name selected a tier, each lower tier's after it (`CLAUDE_TIERS` runs from the highest tier to the lowest). A later list is used only when every candidate of the lists before it has no quota left.
 */
function candidateStages(requested: string, config: ResolvedAntigravityConfig): readonly (readonly string[])[] {
  const { candidates, tier } = resolveName(requested, config);
  if (!config.degradeDownTiers || tier === undefined) {
    return [candidates];
  }
  return CLAUDE_TIERS.slice(CLAUDE_TIERS.indexOf(tier)).map((name) => config.models[name]);
}

/** The live quota a request is routed by: the account's bucket map and the instant it is read at. */
export interface AntigravityRouting {
  readonly quota: AntigravityQuotaMap | undefined;
  readonly nowMs: number;
  /** The candidate this session was last routed to for this name, when it was routed before. A session keeps it while it is unspent: a switch re-sends the whole conversation uncached, so moving back to a preferred model the moment its window lifts costs more than it saves. */
  readonly previous?: string;
}

/**
 * Chooses among a name's candidates by available quota, on the selection engine's `ordered` mode: the model the session is already on while it is unspent, otherwise the first candidate in preference order, and when the preferred one is spent, the fallback whose allowance is worth the most, with every candidate spent, the one whose binding window lifts soonest.
 */
function chooseCandidate(candidates: readonly string[], routing: AntigravityRouting | undefined): string {
  const first = candidates[0];
  if (first === undefined) {
    throw new Error("A model target holds at least one candidate");
  }
  if (routing === undefined || candidates.length === 1) {
    return first;
  }
  const exhaustionOf = (model: string): { readonly resetSec: number } | undefined => antigravityQuotaExhaustion(routing.quota, model, routing.nowMs);
  const evaluated = candidates.map((model, index): { readonly candidate: SelectionCandidate; readonly capabilities: { vision: true; tools: true; thinking: true } } => {
    const exhaustion = exhaustionOf(model);
    return {
      candidate: {
        ref: model,
        order: index,
        available: exhaustion === undefined,
        // A quota the map does not measure competes at the neutral pressure the old in-place ranking gave it, not as an unknown that always loses.
        pressure: antigravityQuotaPressure(routing.quota, model) ?? NEUTRAL_PRESSURE,
        hoursToReset: exhaustion === undefined ? undefined : exhaustion.resetSec / SECONDS_PER_HOUR,
        feasible: true,
        isCurrent: routing.previous === model,
      },
      capabilities: { vision: true, tools: true, thinking: true },
    };
  });
  return selectMember("ordered", evaluated).ref ?? first;
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
          // The relay remembered the signature the backend attached to this exact call; echoing it back is what the backend requires of a repeated function call. A call with none remembered (made before a door restart, evicted from the bounded store, or produced by another model in a resumed session) gets the backend's documented bypass, since history is resent whole on every request and a single unsigned call would otherwise fail the whole conversation for good.
          thoughtSignature: signature ?? UNVERIFIED_THOUGHT_SIGNATURE,
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

/** The schema of a tool that declares none: an object that takes no properties. */
const EMPTY_SCHEMA: Readonly<Record<string, unknown>> = { type: "object", properties: {} };

function mapTools(tools: readonly AnthropicTool[] | undefined, names: Map<string, string>): GeminiTool[] | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined;
  }
  // The tool's own JSON Schema goes through as `parametersJsonSchema`, untouched. The Gemini `parameters` form is an OpenAPI subset that every backend model family does not read the same way: the Claude models reject a schema it has been narrowed to (any `anyOf` property fails their draft 2020-12 validation), while every family accepts the full JSON Schema in this field.
  const declarations: GeminiFunctionDeclaration[] = tools.map((tool) => ({
    name: shortToolName(tool.name, names),
    description: tool.description,
    parametersJsonSchema: tool.input_schema ?? EMPTY_SCHEMA,
  }));
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
  const configured = [config.defaultModel, ...Object.values(config.models).flat(), ...[...config.aliases.values()].flat()];
  const effort = request.output_config?.effort;
  const level = ANTIGRAVITY_EFFORTS.find((candidate) => candidate === effort) ?? config.effort;
  const suffixed = `${model}-${effortSuffixOf(level)}`;
  return configured.some((entry) => entry === suffixed || splitEffortSuffix(entry)?.base === model) ? suffixed : model;
}

/**
 * Chooses a model across the stages of `candidateStages`: the first stage with a candidate that has quota serves the request, and when every stage is spent the first stage's soonest-lifting candidate does, so the quota limit a person sees is that of the tier they asked for.
 */
function chooseAcrossStages(stages: readonly (readonly string[])[], routing: AntigravityRouting | undefined): string {
  const own = stages[0];
  if (own === undefined) {
    throw new Error("A request resolves to at least one candidate list");
  }
  if (routing === undefined) {
    return chooseCandidate(own, undefined);
  }
  for (const [index, stage] of stages.entries()) {
    const picked = chooseCandidate(stage, index === 0 ? routing : { quota: routing.quota, nowMs: routing.nowMs });
    if (antigravityQuotaExhaustion(routing.quota, picked, routing.nowMs) === undefined) {
      return picked;
    }
  }
  return chooseCandidate(own, routing);
}

/** Translates an Anthropic MessagesRequest into a Gemini GenerateContentRequest. */
export function translateRequest(request: MessagesRequest, config: ResolvedAntigravityConfig, routing?: AntigravityRouting): TranslatedAntigravityRequest {
  const toolNames = new Map<string, string>();
  const toolIdToName = new Map<string, string>();
  const model = chooseAcrossStages(
    candidateStages(request.model ?? "", config).map((stage) => stage.map((candidate) => completeEffortSuffix(candidate, request, config))),
    routing,
  );
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

/**
 * Google Gemini REST API request and response shapes used by the Antigravity provider.
 */

interface GeminiTextPart {
  readonly text: string;
  /** Marks the part as one of the model's thought parts, which a stateless client must echo back unchanged with its signature. */
  readonly thought?: boolean;
  /** The backend's thought signature for this part; generateContent attaches it to any part and requires it echoed back on the next turn. */
  readonly thoughtSignature?: string;
}

interface GeminiInlineDataPart {
  readonly inlineData: {
    readonly mimeType: string;
    readonly data: string;
  };
}

interface GeminiFunctionCallPart {
  readonly functionCall: {
    /** The id of the call, which the backend carries onto the tool call of a Claude model it serves and which that model's API requires; the matching response names the same id. */
    readonly id: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
  };
  /** The thought signature the backend attaches to a thinking model's function call, which it requires to be echoed back with the call on the next turn. */
  readonly thoughtSignature?: string;
}

interface GeminiFunctionResponsePart {
  readonly functionResponse: {
    /** The id of the call this answers. */
    readonly id: string;
    readonly name: string;
    readonly response: Readonly<Record<string, unknown>>;
  };
}

interface GeminiThoughtPart {
  readonly thought: string;
}

export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | GeminiThoughtPart;

export interface GeminiContent {
  readonly role: "user" | "model";
  readonly parts: readonly GeminiPart[];
}

export interface GeminiSystemInstruction {
  readonly parts: readonly GeminiTextPart[];
}

export interface GeminiFunctionDeclaration {
  readonly name: string;
  readonly description?: string;
  /** The tool's input schema as JSON Schema, accepted whole by every backend model family. */
  readonly parametersJsonSchema?: Readonly<Record<string, unknown>>;
}

export interface GeminiTool {
  readonly functionDeclarations: readonly GeminiFunctionDeclaration[];
}

interface GeminiThinkingConfig {
  readonly thinkingBudget?: number;
}

interface GeminiGenerationConfig {
  readonly thinkingConfig?: GeminiThinkingConfig;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface GeminiGenerateContentRequest {
  readonly contents: readonly GeminiContent[];
  readonly systemInstruction?: GeminiSystemInstruction;
  readonly tools?: readonly GeminiTool[];
  readonly generationConfig?: GeminiGenerationConfig;
}

export interface GeminiCandidate {
  readonly content?: {
    readonly role?: string;
    readonly parts?: readonly (GeminiPart | { text?: string; thought?: string; functionCall?: { name: string; args: Record<string, unknown> }; thoughtSignature?: string })[];
  };
  readonly finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER";
}

interface GeminiUsageMetadata {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
  /** The part of the prompt Gemini's implicit cache served, included in promptTokenCount. */
  readonly cachedContentTokenCount?: number;
}

export interface GeminiGenerateContentResponseChunk {
  readonly candidates?: readonly GeminiCandidate[];
  readonly usageMetadata?: GeminiUsageMetadata;
}

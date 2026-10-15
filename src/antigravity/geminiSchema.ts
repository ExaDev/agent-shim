/**
 * Google Gemini REST API request and response shapes used by the Antigravity provider.
 */

export interface GeminiTextPart {
  readonly text: string;
}

export interface GeminiInlineDataPart {
  readonly inlineData: {
    readonly mimeType: string;
    readonly data: string;
  };
}

export interface GeminiFunctionCallPart {
  readonly functionCall: {
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
  };
}

export interface GeminiFunctionResponsePart {
  readonly functionResponse: {
    readonly name: string;
    readonly response: Readonly<Record<string, unknown>>;
  };
}

export interface GeminiThoughtPart {
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
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface GeminiTool {
  readonly functionDeclarations: readonly GeminiFunctionDeclaration[];
}

export interface GeminiThinkingConfig {
  readonly thinkingBudget?: number;
}

export interface GeminiGenerationConfig {
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
    readonly parts?: readonly (GeminiPart | { text?: string; thought?: string; functionCall?: { name: string; args: Record<string, unknown> } })[];
  };
  readonly finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER";
}

export interface GeminiUsageMetadata {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
}

export interface GeminiGenerateContentResponseChunk {
  readonly candidates?: readonly GeminiCandidate[];
  readonly usageMetadata?: GeminiUsageMetadata;
}

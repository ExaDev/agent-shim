import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_DEFAULT_EFFORT,
  ANTIGRAVITY_DEFAULT_MODE,
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_DEFAULT_TIER_MODELS,
} from "../config/schema";
import { MessagesRequestSchema, type MessagesRequest } from "../codex/anthropic";
import {
  mapEffort,
  mapModel,
  resolveAntigravityConfig,
  shortToolName,
  systemToInstruction,
  translateRequest,
} from "./translate";

const defaults = resolveAntigravityConfig(undefined);
const BUDGET_LOW = 1024;
const BUDGET_MEDIUM = 4096;
const BUDGET_HIGH = 8192;
const MAX_TOOL_NAME_LEN = 64;
const THREE_CONTENTS = 3;

function request(body: unknown): MessagesRequest {
  return MessagesRequestSchema.parse(body);
}

describe("resolveAntigravityConfig", () => {
  it("applies the shipped defaults", () => {
    expect(defaults).toEqual({
      mode: ANTIGRAVITY_DEFAULT_MODE,
      defaultModel: ANTIGRAVITY_DEFAULT_MODEL,
      models: ANTIGRAVITY_DEFAULT_TIER_MODELS,
      effort: ANTIGRAVITY_DEFAULT_EFFORT,
      cloud: { endpoint: undefined, projectId: undefined, location: undefined },
      local: { command: undefined, socketPath: undefined },
    });
    expect(ANTIGRAVITY_DEFAULT_MODE).toBe("cloud");
    expect(ANTIGRAVITY_DEFAULT_MODEL).toBe("gemini-3.8-flash-high");
    expect(ANTIGRAVITY_DEFAULT_TIER_MODELS.sonnet).toBe("gemini-3.8-flash-medium");
  });

  it("overrides mode, model tiers, and cloud settings", () => {
    const config = resolveAntigravityConfig({
      mode: "cloud",
      models: { sonnet: "gemini-custom" },
      cloud: { endpoint: "https://custom.endpoint.com", projectId: "p-123", location: "us-central1" },
    });
    expect(config.models.sonnet).toBe("gemini-custom");
    expect(config.cloud.projectId).toBe("p-123");
    expect(config.cloud.endpoint).toBe("https://custom.endpoint.com");
  });

  it("overrides local settings", () => {
    const config = resolveAntigravityConfig({
      mode: "local",
      local: { command: ["my-acp", "--server"], socketPath: "/tmp/acp.sock" },
    });
    expect(config.mode).toBe("local");
    expect(config.local.command).toEqual(["my-acp", "--server"]);
    expect(config.local.socketPath).toBe("/tmp/acp.sock");
  });
});

describe("mapModel", () => {
  it.each([
    ["claude-fable-5", "gemini-3.8-flash-high"],
    ["claude-opus-4-7", "gemini-3.8-flash-high"],
    ["claude-sonnet-4-5-20250929", "gemini-3.8-flash-medium"],
    ["claude-haiku-4-5", "gemini-3.8-flash-low"],
    ["something-else", "gemini-3.8-flash-high"],
  ])("maps %s to %s by tier", (requested, expected) => {
    expect(mapModel(requested, defaults)).toBe(expected);
  });

  it("passes gemini model names through untouched", () => {
    expect(mapModel("gemini-3.8-flash", defaults)).toBe("gemini-3.8-flash");
    expect(mapModel("antigravity-custom", defaults)).toBe("antigravity-custom");
  });

  it("maps claude names with effort suffixes by tier", () => {
    expect(mapModel("claude-sonnet-5-5-high", defaults)).toBe("gemini-3.8-flash-medium");
    expect(mapModel("claude-opus-5-5-high", defaults)).toBe("gemini-3.8-flash-high");
  });
});

describe("mapEffort", () => {
  it("maps efforts to token budgets", () => {
    expect(mapEffort(request({ messages: [], output_config: { effort: "low" } }), defaults)).toBe(BUDGET_LOW);
    expect(mapEffort(request({ messages: [], output_config: { effort: "medium" } }), defaults)).toBe(BUDGET_MEDIUM);
    expect(mapEffort(request({ messages: [], output_config: { effort: "high" } }), defaults)).toBe(BUDGET_HIGH);
    expect(mapEffort(request({ messages: [], output_config: { effort: "none" } }), defaults)).toBeUndefined();
  });
});

describe("shortToolName", () => {
  it("normalizes disallowed characters", () => {
    const names = new Map<string, string>();
    const sanitized = shortToolName("bash-runner", names);
    expect(sanitized).toBe("bash_runner");
    expect(names.get("bash_runner")).toBe("bash-runner");
  });

  it("shortens names exceeding 64 chars", () => {
    const names = new Map<string, string>();
    const longName = "very_long_tool_name_that_exceeds_sixty_four_characters_limit_and_needs_hashing";
    const shortened = shortToolName(longName, names);
    expect(shortened.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LEN);
    expect(names.get(shortened)).toBe(longName);
  });
});

describe("systemToInstruction", () => {
  it("strips billing lines and joins text parts", () => {
    const result = systemToInstruction([
      { type: "text", text: "x-anthropic-billing-header: test\nYou are an assistant." },
      { type: "text", text: "Be helpful." },
    ]);
    expect(result).toEqual({ parts: [{ text: "You are an assistant.\nBe helpful." }] });
  });
});

describe("translateRequest", () => {
  it("translates a conversation with text, tool_use, and tool_result", () => {
    const req = request({
      model: "claude-sonnet-4-5",
      system: "System prompt",
      messages: [
        { role: "user", content: "Run bash" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running command" },
            { type: "tool_use", id: "call_1", name: "bash-exec", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "file1.txt\nfile2.txt" }],
        },
      ],
      tools: [
        {
          name: "bash-exec",
          description: "Runs a bash command",
          input_schema: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
      output_config: { effort: "medium" },
    });

    const translated = translateRequest(req, defaults);
    expect(translated.model).toBe("gemini-3.8-flash-medium");
    expect(translated.request.systemInstruction?.parts[0]?.text).toBe("System prompt");
    expect(translated.request.generationConfig?.thinkingConfig?.thinkingBudget).toBe(BUDGET_MEDIUM);
    expect(translated.toolNames.get("bash_exec")).toBe("bash-exec");

    // Check alternating contents
    const contents = translated.request.contents;
    expect(contents).toHaveLength(THREE_CONTENTS);
    expect(contents[0]?.role).toBe("user");
    expect(contents[0]?.parts).toEqual([{ text: "Run bash" }]);

    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts[0]).toEqual({ text: "Running command" });
    expect(contents[1]?.parts[1]).toEqual({
      functionCall: { name: "bash_exec", args: { cmd: "ls" } },
    });

    expect(contents[2]?.role).toBe("user");
    expect(contents[2]?.parts[0]).toEqual({
      functionResponse: { name: "bash_exec", response: { output: "file1.txt\nfile2.txt" } },
    });
  });

  it("folds mid-conversation system turns into system reminders for user turns", () => {
    const req = request({
      messages: [
        { role: "user", content: "Hello" },
        { role: "system", content: "Active agents: none" },
      ],
    });
    const translated = translateRequest(req, defaults);
    expect(translated.request.contents).toHaveLength(1);
    expect(translated.request.contents[0]?.parts[1]).toEqual({
      text: "<system-reminder>\nActive agents: none\n</system-reminder>",
    });
  });

  it("translates inline base64 images", () => {
    const req = request({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } },
          ],
        },
      ],
    });
    const translated = translateRequest(req, defaults);
    expect(translated.request.contents[0]?.parts).toEqual([
      { text: "Look at this" },
      { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } },
    ]);
  });
});

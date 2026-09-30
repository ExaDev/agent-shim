import { describe, expect, it } from "vitest";

import { CODEX_DEFAULT_EFFORT, CODEX_DEFAULT_MODEL, CODEX_DEFAULT_TIER_MODELS } from "../config/schema";
import { MessagesRequestSchema, type MessagesRequest } from "./anthropic";
import {
  CODEX_TOOL_NAME_LIMIT,
  mapEffort,
  mapModel,
  NON_TEXT_TOOL_RESULT,
  resolveCodexConfig,
  shortToolName,
  systemReminder,
  translateRequest,
} from "./translate";

const defaults = resolveCodexConfig(undefined);

function request(body: unknown): MessagesRequest {
  return MessagesRequestSchema.parse(body);
}

describe("resolveCodexConfig", () => {
  it("applies the shipped mapping, matching the script it replaces", () => {
    expect(defaults).toEqual({ defaultModel: CODEX_DEFAULT_MODEL, models: CODEX_DEFAULT_TIER_MODELS, effort: CODEX_DEFAULT_EFFORT });
    expect(CODEX_DEFAULT_TIER_MODELS).toEqual({ fable: "gpt-5.6-sol", opus: "gpt-5.6-sol", sonnet: "gpt-5.6-terra", haiku: "gpt-5.6-luna" });
    expect(CODEX_DEFAULT_MODEL).toBe("gpt-5.6-sol");
    expect(CODEX_DEFAULT_EFFORT).toBe("low");
  });

  it("overrides only the tiers a provider names", () => {
    const config = resolveCodexConfig({ models: { sonnet: "gpt-custom" }, effort: "high", defaultModel: "gpt-default" });
    expect(config.models).toEqual({ ...CODEX_DEFAULT_TIER_MODELS, sonnet: "gpt-custom" });
    expect(config.effort).toBe("high");
    expect(config.defaultModel).toBe("gpt-default");
  });
});

describe("mapModel", () => {
  it.each([
    ["claude-fable-5", "gpt-5.6-sol"],
    ["claude-opus-4-7", "gpt-5.6-sol"],
    ["claude-sonnet-4-5-20250929", "gpt-5.6-terra"],
    ["claude-haiku-4-5", "gpt-5.6-luna"],
    ["Claude-HAIKU-latest", "gpt-5.6-luna"],
    ["something-else", "gpt-5.6-sol"],
    ["", "gpt-5.6-sol"],
  ])("maps %s to %s by tier", (requested, expected) => {
    expect(mapModel(requested, defaults)).toBe(expected);
  });

  it("passes a codex model name through untouched", () => {
    expect(mapModel("gpt-5.6-terra", resolveCodexConfig({ models: { sonnet: "gpt-other" } }))).toBe("gpt-5.6-terra");
  });

  it("matches tiers in order, so a name mentioning two tiers takes the first", () => {
    expect(mapModel("fable-opus-hybrid", resolveCodexConfig({ models: { fable: "gpt-f", opus: "gpt-o" } }))).toBe("gpt-f");
  });

  it("uses the configured default for a model that names no tier", () => {
    expect(mapModel("mystery", resolveCodexConfig({ defaultModel: "gpt-default" }))).toBe("gpt-default");
  });
});

describe("mapEffort", () => {
  it.each(["low", "medium", "high"])("honours a requested %s effort", (effort) => {
    expect(mapEffort(request({ messages: [], output_config: { effort } }), defaults)).toBe(effort);
  });

  it("falls back to the configured effort for a level the backend does not accept", () => {
    expect(mapEffort(request({ messages: [], output_config: { effort: "max" } }), resolveCodexConfig({ effort: "medium" }))).toBe("medium");
    expect(mapEffort(request({ messages: [] }), defaults)).toBe("low");
  });

  it("omits the reasoning block entirely for effort none", () => {
    const { request: translated } = translateRequest(request({ messages: [] }), resolveCodexConfig({ effort: "none" }));
    expect(translated.reasoning).toBeUndefined();
    const { request: withEffort } = translateRequest(request({ messages: [] }), defaults);
    expect(withEffort.reasoning).toEqual({ effort: "low", summary: "auto" });
  });
});

describe("translateRequest", () => {
  it("translates a plain text conversation", () => {
    const { request: translated } = translateRequest(
      request({
        model: "claude-sonnet-4-5",
        system: "You are helpful.",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
          { role: "user", content: [{ type: "text", text: "How are you?" }] },
        ],
        stream: true,
      }),
      defaults,
    );
    expect(translated).toEqual({
      model: "gpt-5.6-terra",
      instructions: "You are helpful.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi there" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "How are you?" }] },
      ],
      stream: true,
      store: false,
      text: { verbosity: "medium" },
      reasoning: { effort: "low", summary: "auto" },
    });
  });

  it("always streams upstream, even when the client asked for a single response", () => {
    expect(translateRequest(request({ messages: [], stream: false }), defaults).request.stream).toBe(true);
  });

  it("joins system text blocks and strips Claude Code's billing line", () => {
    const { request: translated } = translateRequest(
      request({
        messages: [],
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2.1\nFirst" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "text", text: "Second", cache_control: { type: "ephemeral" } },
        ],
      }),
      defaults,
    );
    expect(translated.instructions).toBe("First\nSecond");
  });

  it("folds mid-conversation system turns into user turns wrapped as reminders", () => {
    const { request: translated } = translateRequest(
      request({
        messages: [
          { role: "user", content: "Start" },
          { role: "system", content: "Agent listing" },
          { role: "assistant", content: "Done" },
        ],
      }),
      defaults,
    );
    expect(translated.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Start" },
          { type: "input_text", text: systemReminder("Agent listing") },
        ],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
    ]);
    expect(systemReminder("x")).toBe("<system-reminder>\nx\n</system-reminder>");
  });

  it("translates tool calls and tool results, linked by call id", () => {
    const { request: translated } = translateRequest(
      request({
        messages: [
          { role: "user", content: "List files" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm", signature: "sig" },
              { type: "text", text: "Checking" },
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "a.txt" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }] },
              { type: "tool_result", tool_use_id: "toolu_2", content: "plain" },
              { type: "tool_result", tool_use_id: "toolu_3" },
              { type: "text", text: "Continue" },
            ],
          },
        ],
        tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }, { name: "web_search" }],
        tool_choice: { type: "any" },
      }),
      defaults,
    );
    expect(translated.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "List files" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking" }] },
      { type: "function_call", call_id: "toolu_1", name: "Bash", arguments: JSON.stringify({ command: "ls" }) },
      { type: "function_call_output", call_id: "toolu_1", output: `a.txt\n${NON_TEXT_TOOL_RESULT}` },
      { type: "function_call_output", call_id: "toolu_2", output: "plain" },
      { type: "function_call_output", call_id: "toolu_3", output: "" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
    ]);
    expect(translated.tools).toEqual([
      { type: "function", name: "Bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } }, strict: false },
      { type: "function", name: "web_search", description: "", parameters: { type: "object", properties: {} }, strict: false },
    ]);
    expect(translated.tool_choice).toBe("required");
  });

  it.each([
    [{ type: "auto" }, "auto"],
    [{ type: "none" }, "none"],
    [{ type: "tool", name: "Bash" }, { type: "function", name: "Bash" }],
  ])("maps tool_choice %j", (choice, expected) => {
    expect(translateRequest(request({ messages: [], tool_choice: choice }), defaults).request.tool_choice).toEqual(expected);
  });

  it("translates images, base64 and URL, into input_image parts batched with the turn's text", () => {
    const { request: translated } = translateRequest(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
              { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
            ],
          },
        ],
      }),
      defaults,
    );
    expect(translated.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Look" },
          { type: "input_image", image_url: "data:image/png;base64,QUJD" },
          { type: "input_image", image_url: "https://example.com/a.png" },
        ],
      },
    ]);
  });

  it("drops whitespace-only text and never emits an empty message item", () => {
    const { request: translated } = translateRequest(request({ messages: [{ role: "user", content: "   " }, { role: "assistant", content: [] }] }), defaults);
    expect(translated.input).toEqual([]);
  });

  it("uses metadata.user_id as the prompt cache key, and sets none without it", () => {
    expect(translateRequest(request({ messages: [], metadata: { user_id: "user_abc_session_1" } }), defaults).request.prompt_cache_key).toBe("user_abc_session_1");
    expect(translateRequest(request({ messages: [] }), defaults).request.prompt_cache_key).toBeUndefined();
  });

  it("shortens long tool names identically in the tool list, the history and tool_choice, and records the originals", () => {
    const longName = `mcp__${"a".repeat(CODEX_TOOL_NAME_LIMIT)}__tool`;
    const { request: translated, toolNames } = translateRequest(
      request({
        messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: longName, input: {} }] }],
        tools: [{ name: longName, input_schema: { type: "object" } }],
        tool_choice: { type: "tool", name: longName },
      }),
      defaults,
    );
    const short = translated.tools?.[0]?.name;
    expect(short).toBeDefined();
    expect(short?.length).toBe(CODEX_TOOL_NAME_LIMIT);
    expect(translated.input[0]).toMatchObject({ type: "function_call", name: short });
    expect(translated.tool_choice).toEqual({ type: "function", name: short });
    expect(short === undefined ? undefined : toolNames.get(short)).toBe(longName);
  });

  it("leaves a name within the limit untouched and unrecorded", () => {
    const names = new Map<string, string>();
    const name = "a".repeat(CODEX_TOOL_NAME_LIMIT);
    expect(shortToolName(name, names)).toBe(name);
    expect(names.size).toBe(0);
    const longer = `${name}b`;
    expect(shortToolName(longer, names)).not.toBe(shortToolName(`${name}c`, names));
  });
});

describe("MessagesRequestSchema", () => {
  it("accepts fields the translator ignores and rejects a request with no messages", () => {
    expect(MessagesRequestSchema.safeParse({ messages: [], temperature: 1, thinking: { type: "enabled" } }).success).toBe(true);
    expect(MessagesRequestSchema.safeParse({ model: "claude" }).success).toBe(false);
    expect(MessagesRequestSchema.safeParse({ messages: [{ role: "tool", content: "x" }] }).success).toBe(false);
  });
});

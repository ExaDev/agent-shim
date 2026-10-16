import { describe, expect, it } from "vitest";

import type { AntigravityQuotaMap } from "./quota";
import { rememberToolCallSignature, UNVERIFIED_THOUGHT_SIGNATURE } from "./signatures";

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
const BUDGET_XHIGH = 16384;
const BUDGET_MAX = 32768;
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
      models: Object.fromEntries(Object.entries(ANTIGRAVITY_DEFAULT_TIER_MODELS).map(([tier, model]) => [tier, [model]])),
      aliases: new Map(),
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
    expect(config.models.sonnet).toEqual(["gemini-custom"]);
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
    expect(mapModel(requested, defaults)).toEqual([expected]);
  });

  it("passes gemini model names through untouched", () => {
    expect(mapModel("gemini-3.8-flash", defaults)).toEqual(["gemini-3.8-flash"]);
    expect(mapModel("antigravity-custom", defaults)).toEqual(["antigravity-custom"]);
  });

  it("strips a trailing 1m context marker before mapping, so the marker sizes Claude Code's window and never reaches the backend", () => {
    expect(mapModel("gemini-3.8-flash-high[1m]", defaults)).toEqual(["gemini-3.8-flash-high"]);
    expect(mapModel("claude-sonnet-5-5[1m]", defaults)).toEqual(["gemini-3.8-flash-medium"]);
    expect(mapModel("claude-fable-5[1m]", defaults)).toEqual(["gemini-3.8-flash-high"]);
  });

  it("completes a marked bare family member as if unmarked", () => {
    const translated = translateRequest(request({ model: "gemini-3.8-flash[1m]", output_config: { effort: "high" }, messages: [{ role: "user", content: "Hi" }] }), defaults);
    expect(translated.model).toBe("gemini-3.8-flash-high");
  });

  it("maps the claude names Claude Code sends by tier", () => {
    expect(mapModel("claude-sonnet-5-5", defaults)).toEqual(["gemini-3.8-flash-medium"]);
    expect(mapModel("claude-opus-5-5[1m]", defaults)).toEqual(["gemini-3.8-flash-high"]);
  });

  it("passes a backend Claude, thinking or GPT-OSS model name through, so /model can select it", () => {
    expect(mapModel("claude-sonnet-5-5-high", defaults)).toEqual(["claude-sonnet-5-5-high"]);
    expect(mapModel("claude-opus-4-6-thinking[1m]", defaults)).toEqual(["claude-opus-4-6-thinking"]);
    expect(mapModel("gpt-oss-120b-medium", defaults)).toEqual(["gpt-oss-120b-medium"]);
    expect(mapModel("gemini-4-argon-medium", defaults)).toEqual(["gemini-4-argon-medium"]);
  });

  describe("routing by available quota", () => {
    const NOW = 1_000_000;
    const SOON = 300;
    const LATER = 900;
    const SHORT = 60;
    const routed = resolveAntigravityConfig({ models: { opus: ["gemini-3.8-pro-high", "claude-opus-5-5-high", "gemini-3.8-flash-high"], any: ["gemini-3.8-flash-low", "gpt-oss-120b-medium"] } });
    const spent = (resetInSeconds: number) => ({ remaining_fraction: 0, reset_in_seconds: resetInSeconds });
    const route = (model: string, quota: AntigravityQuotaMap): string =>
      translateRequest(request({ model, messages: [{ role: "user", content: "Hi" }] }), routed, { quota, nowMs: NOW }).model;

    it("takes the first candidate whose windows are not spent", () => {
      expect(route("claude-opus-5-5", { "gemini-5h": { remaining_fraction: 0.5, reset_in_seconds: 60 } })).toContain("gemini-3.8-pro");
      expect(route("claude-opus-5-5", { "gemini-5h": spent(LATER), "3p-5h": { remaining_fraction: 0.9, reset_in_seconds: 60 } })).toBe("claude-opus-5-5-high");
    });

    it("skips a candidate whose weekly window is spent even when its five-hour window is free", () => {
      expect(route("claude-opus-5-5", { "gemini-5h": { remaining_fraction: 1, reset_in_seconds: 60 }, "gemini-weekly": spent(LATER) })).toBe("claude-opus-5-5-high");
    });

    it("routes to the candidate whose binding window lifts soonest when every one is spent", () => {
      expect(route("claude-opus-5-5", { "gemini-5h": spent(LATER), "3p-5h": spent(SOON) })).toBe("claude-opus-5-5-high");
    });

    it("treats an absent quota map as no known limit and takes the first candidate", () => {
      expect(route("claude-opus-5-5", {})).toContain("gemini-3.8-pro");
      expect(translateRequest(request({ model: "claude-opus-5-5", messages: [{ role: "user", content: "Hi" }] }), routed).model).toContain("gemini-3.8-pro");
    });

    it("keeps a session on the model it is on while that model is unspent, instead of returning to the preferred one", () => {
      const routeFrom = (previous: string, quota: AntigravityQuotaMap): string =>
        translateRequest(request({ model: "claude-opus-5-5", messages: [{ role: "user", content: "Hi" }] }), routed, { quota, nowMs: NOW, previous }).model;
      expect(routeFrom("claude-opus-5-5-high", {})).toBe("claude-opus-5-5-high");
      expect(routeFrom("claude-opus-5-5-high", { "3p-5h": spent(SOON) })).toContain("gemini-3.8-pro");
    });

    it("spends a fallback whose windows are already running before one that would start a new clock", () => {
      const spill = resolveAntigravityConfig({ models: { spill: ["gemini-3.8-flash-low", "claude-opus-5-5-high", "gemini-4-argon-medium"] } });
      const via = (quota: AntigravityQuotaMap): string => translateRequest(request({ model: "spill", messages: [{ role: "user", content: "Hi" }] }), spill, { quota, nowMs: NOW }).model;
      const fresh = { remaining_fraction: 1, reset_in_seconds: LATER };
      const running = { remaining_fraction: 0.74, reset_in_seconds: LATER };
      expect(via({ "gemini-5h": spent(SOON), "3p-5h": fresh, "3p-weekly": fresh, "gemini-argon-wtu-weekly": running })).toBe("gemini-4-argon-medium");
      expect(via({ "gemini-5h": spent(SOON), "3p-5h": fresh, "3p-weekly": fresh, "gemini-argon-wtu-weekly": fresh })).toBe("claude-opus-5-5-high");
    });

    it("keeps the preferred candidate while it is unspent, even when it would start a new clock", () => {
      const spill = resolveAntigravityConfig({ models: { spill: ["claude-opus-5-5-high", "gemini-4-argon-medium"] } });
      const fresh = { remaining_fraction: 1, reset_in_seconds: LATER };
      const quota = { "3p-5h": fresh, "3p-weekly": fresh, "gemini-argon-wtu-weekly": { remaining_fraction: 0.74, reset_in_seconds: LATER } };
      expect(translateRequest(request({ model: "spill", messages: [{ role: "user", content: "Hi" }] }), spill, { quota, nowMs: NOW }).model).toBe("claude-opus-5-5-high");
    });

    it("routes an alias's candidates the same way", () => {
      expect(route("any", { "gemini-5h": spent(SHORT) })).toBe("gpt-oss-120b-medium");
    });
  });

  describe("aliases", () => {
    const aliased = resolveAntigravityConfig({ models: { sonnet: "claude-sonnet-5-5-medium", Fast: "gemini-3.8-flash-low", oss: "gpt-oss-120b-medium" } });

    it("matches a configured alias against the whole name, ignoring case and a context marker", () => {
      expect(mapModel("fast", aliased)).toEqual(["gemini-3.8-flash-low"]);
      expect(mapModel("OSS[1m]", aliased)).toEqual(["gpt-oss-120b-medium"]);
    });

    it("does not match an alias inside a longer name", () => {
      expect(mapModel("fastest-thing", aliased)).toEqual([aliased.defaultModel]);
    });

    it("outranks the pass-through of backend names", () => {
      const redirected = resolveAntigravityConfig({ models: { "gemini-3.8-flash-high": "claude-opus-5-5-high" } });
      expect(mapModel("gemini-3.8-flash-high", redirected)).toEqual(["claude-opus-5-5-high"]);
    });

    it("keeps a tier key a tier override, matched by substring", () => {
      expect(mapModel("claude-sonnet-5-5", aliased)).toEqual(["claude-sonnet-5-5-medium"]);
    });

    it("completes an alias's bare family with the request's effort, as a tier model does", () => {
      const bare = resolveAntigravityConfig({ models: { pro: "gemini-3.8-pro-medium" } });
      expect(translateRequest(request({ model: "gemini-3.8-pro", output_config: { effort: "high" }, messages: [{ role: "user", content: "Hi" }] }), bare).model).toBe("gemini-3.8-pro-high");
    });
  });

  it("completes a bare family member with the request's effort suffix, and leaves every other spelling alone", () => {
    const translated = (effort: string | undefined, model: string): string =>
      translateRequest(request({ model, ...(effort === undefined ? {} : { output_config: { effort } }), messages: [{ role: "user", content: "Hi" }] }), defaults).model;
    expect(translated("medium", "gemini-3.8-flash")).toBe("gemini-3.8-flash-medium");
    expect(translated("xhigh", "gemini-3.8-flash")).toBe("gemini-3.8-flash-high");
    expect(translated("none", "gemini-3.8-flash")).toBe("gemini-3.8-flash-low");
    expect(translated(undefined, "gemini-3.8-flash")).toBe("gemini-3.8-flash-low");
    expect(translated("medium", "gemini-3.8-flash-high")).toBe("gemini-3.8-flash-high");
    expect(translated("medium", "gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("reads the effort-qualified families from the configuration's own model table", () => {
    const custom = resolveAntigravityConfig({ models: { fable: "gemini-2.5-pro", opus: "gemini-2.5-pro", sonnet: "gemini-2.5-flash", haiku: "gemini-2.5-flash" }, defaultModel: "gemini-2.5-pro" });
    const translated = translateRequest(request({ model: "gemini-3.8-flash", output_config: { effort: "high" }, messages: [{ role: "user", content: "Hi" }] }), custom);
    expect(translated.model).toBe("gemini-3.8-flash");
  });
});

describe("mapEffort", () => {
  it("maps efforts to token budgets", () => {
    expect(mapEffort(request({ messages: [], output_config: { effort: "low" } }), defaults)).toBe(BUDGET_LOW);
    expect(mapEffort(request({ messages: [], output_config: { effort: "medium" } }), defaults)).toBe(BUDGET_MEDIUM);
    expect(mapEffort(request({ messages: [], output_config: { effort: "high" } }), defaults)).toBe(BUDGET_HIGH);
    expect(mapEffort(request({ messages: [], output_config: { effort: "xhigh" } }), defaults)).toBe(BUDGET_XHIGH);
    expect(mapEffort(request({ messages: [], output_config: { effort: "max" } }), defaults)).toBe(BUDGET_MAX);
    expect(mapEffort(request({ messages: [], output_config: { effort: "none" } }), defaults)).toBeUndefined();
    expect(mapEffort(request({ messages: [], output_config: { effort: "not-a-level" } }), defaults)).toBe(BUDGET_LOW);
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
  it("sanitises tool input schemas to the keys the Cloud Code endpoint accepts", () => {
    const req = request({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Run bash" }],
      tools: [
        {
          name: "bash_exec",
          description: "Run a command",
          input_schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            propertyNames: { pattern: "^[a-z]+$" },
            properties: {
              command: { type: "string", description: "The command" },
              timeout: { type: ["number", "null"], minimum: 0 },
              env: { type: "object", additionalProperties: { type: "string" }, properties: {} },
            },
            required: ["command"],
          },
        },
      ],
    });
    const translated = translateRequest(req, defaults);
    expect(translated.request.tools?.[0]?.functionDeclarations[0]?.parameters).toEqual({
      type: "object",
      description: "Keys match ^[a-z]+$.",
      properties: {
        command: { type: "string", description: "The command" },
        timeout: { type: "number", minimum: 0, nullable: true },
        env: { type: "object", properties: {}, description: "Each value is a string." },
      },
      required: ["command"],
    });
  });

  it("echoes a remembered call signature back onto its function call part, and the backend's bypass value onto an unremembered one", () => {
    rememberToolCallSignature("call_signed", "sig-abc");
    const req = request({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "Run bash" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_signed", name: "bash-exec", input: { cmd: "ls" } },
            { type: "tool_use", id: "call_plain", name: "bash-exec", input: { cmd: "pwd" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_signed", content: "file1.txt" },
            { type: "tool_result", tool_use_id: "call_plain", content: "/tmp" },
          ],
        },
      ],
    });
    const translated = translateRequest(req, defaults);
    const modelTurn = translated.request.contents.find((content) => content.role === "model");
    expect(modelTurn?.parts).toEqual([
      { functionCall: { name: "bash_exec", args: { cmd: "ls" } }, thoughtSignature: "sig-abc" },
      { functionCall: { name: "bash_exec", args: { cmd: "pwd" } }, thoughtSignature: UNVERIFIED_THOUGHT_SIGNATURE },
    ]);
  });

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
      thoughtSignature: UNVERIFIED_THOUGHT_SIGNATURE,
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

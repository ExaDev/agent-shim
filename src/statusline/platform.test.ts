import { describe, expect, it } from "vitest";

import { hidesSubscriptionWindows, isBedrockModelId, modelPlatformOf } from "./platform";

describe("the platform label claude-hud draws beside the model", () => {
  it("is Bedrock when the client's Bedrock switch is on", () => {
    expect(modelPlatformOf({ CLAUDE_CODE_USE_BEDROCK: "1" }, "claude-opus-4-7")).toBe("Bedrock");
  });

  it("is Vertex when the client's Vertex switch is on", () => {
    expect(modelPlatformOf({ CLAUDE_CODE_USE_VERTEX: "1" }, "claude-opus-4-7")).toBe("Vertex");
  });

  it("takes the first that holds, in claude-hud's order: Bedrock, Vertex, MiniMax, Enterprise", () => {
    const minimax = { ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic" };
    expect(modelPlatformOf({ CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", ...minimax }, "opusplan")).toBe("Bedrock");
    expect(modelPlatformOf({ CLAUDE_CODE_USE_VERTEX: "1", ...minimax }, "opusplan")).toBe("Vertex");
    expect(modelPlatformOf(minimax, "opusplan")).toBe("MiniMax");
  });

  it("is MiniMax for either MiniMax endpoint as the base URL, compared by origin and path whatever trailing slashes or query it carries", () => {
    expect(modelPlatformOf({ ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic" }, undefined)).toBe("MiniMax");
    expect(modelPlatformOf({ ANTHROPIC_BASE_URL: "  https://api.minimaxi.com/anthropic//?x=1  " }, undefined)).toBe("MiniMax");
  });

  it("reads ANTHROPIC_API_BASE_URL only when ANTHROPIC_BASE_URL is unset or blank", () => {
    expect(modelPlatformOf({ ANTHROPIC_BASE_URL: " ", ANTHROPIC_API_BASE_URL: "https://api.minimax.io/anthropic" }, undefined)).toBe("MiniMax");
    expect(modelPlatformOf({ ANTHROPIC_BASE_URL: "http://127.0.0.1:4141", ANTHROPIC_API_BASE_URL: "https://api.minimax.io/anthropic" }, undefined)).toBeUndefined();
  });

  it("is no MiniMax endpoint for another host, another path or a base URL that is not a URL", () => {
    expect(modelPlatformOf({ ANTHROPIC_BASE_URL: "https://api.minimax.io/v1" }, undefined)).toBeUndefined();
    expect(modelPlatformOf({ ANTHROPIC_BASE_URL: "http://api.minimax.io/anthropic" }, undefined)).toBeUndefined();
    expect(modelPlatformOf({ ANTHROPIC_BASE_URL: "api.minimax.io/anthropic" }, undefined)).toBeUndefined();
  });

  it("is Enterprise for the model ids opusplan, sonnetplan and haikuplan, whatever their case", () => {
    expect(modelPlatformOf({}, "opusplan")).toBe("Enterprise");
    expect(modelPlatformOf({}, "SonnetPlan")).toBe("Enterprise");
    expect(modelPlatformOf({}, "haikuplan")).toBe("Enterprise");
  });

  it("is undefined when none holds: no switch on, no MiniMax base URL and any other model id", () => {
    expect(modelPlatformOf({}, "claude-opus-4-7")).toBeUndefined();
    expect(modelPlatformOf({}, undefined)).toBeUndefined();
    expect(modelPlatformOf({ CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "true" }, "opus")).toBeUndefined();
  });
});

describe("whether the subscription windows apply to a session", () => {
  it("does not apply to a Bedrock session, by the switch or by a Bedrock model id in any case", () => {
    expect(hidesSubscriptionWindows({ CLAUDE_CODE_USE_BEDROCK: "1" }, undefined)).toBe(true);
    expect(hidesSubscriptionWindows({}, "us.anthropic.claude-opus-4-5-v1:0")).toBe(true);
    expect(hidesSubscriptionWindows({}, "EU.Anthropic.Claude-Sonnet-4-5")).toBe(true);
  });

  it("applies to every other session, Vertex and an ordinary model id included", () => {
    expect(hidesSubscriptionWindows({ CLAUDE_CODE_USE_VERTEX: "1" }, "claude-opus-4-5")).toBe(false);
    expect(hidesSubscriptionWindows({}, undefined)).toBe(false);
    expect(hidesSubscriptionWindows({}, "claude-opus-4-5")).toBe(false);
  });
});

describe("whether a model id is a Bedrock one", () => {
  it("is one when it carries anthropic.claude- in any case, wherever it sits, and no other id or none is", () => {
    expect(isBedrockModelId("us.anthropic.claude-opus-4-5-v1:0")).toBe(true);
    expect(isBedrockModelId("Anthropic.Claude-Sonnet-4-5")).toBe(true);
    expect(isBedrockModelId("claude-opus-4-5")).toBe(false);
    expect(isBedrockModelId("anthropic.titan")).toBe(false);
    expect(isBedrockModelId(undefined)).toBe(false);
  });
});

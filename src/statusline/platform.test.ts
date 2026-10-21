import { describe, expect, it } from "vitest";

import { modelPlatformOf } from "./platform";

describe("the platform a session's model is served through", () => {
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

  it("is Enterprise for an enterprise planning model id, whatever its case", () => {
    expect(modelPlatformOf({}, "opusplan")).toBe("Enterprise");
    expect(modelPlatformOf({}, "SonnetPlan")).toBe("Enterprise");
    expect(modelPlatformOf({}, "haikuplan")).toBe("Enterprise");
  });

  it("is undefined for Anthropic's own API: no switch on, no MiniMax base URL and an ordinary model id", () => {
    expect(modelPlatformOf({}, "claude-opus-4-7")).toBeUndefined();
    expect(modelPlatformOf({}, undefined)).toBeUndefined();
    expect(modelPlatformOf({ CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "true" }, "opus")).toBeUndefined();
  });
});

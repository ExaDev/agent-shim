import { describe, expect, it } from "vitest";

import { parseClaudeModelId } from "./modelId";

describe("parseClaudeModelId", () => {
  it("reads a family-first ID, with or without a release date", () => {
    expect(parseClaudeModelId("claude-opus-4-7")).toEqual({ family: "opus", version: "4.7" });
    expect(parseClaudeModelId("claude-sonnet-4-20250514")).toEqual({ family: "sonnet", version: "4" });
    expect(parseClaudeModelId("claude-haiku-4-5-20251001")).toEqual({ family: "haiku", version: "4.5" });
  });

  it("reads a version-first ID", () => {
    expect(parseClaudeModelId("claude-3-5-sonnet-20241022")).toEqual({ family: "sonnet", version: "3.5" });
    expect(parseClaudeModelId("claude-3-opus")).toEqual({ family: "opus", version: "3" });
  });

  it("reads a bare family alias without a version, in any case", () => {
    expect(parseClaudeModelId("Opus")).toEqual({ family: "opus", version: undefined });
  });

  it("is undefined for an ID that is not a Claude one", () => {
    expect(parseClaudeModelId("glm-5.3")).toBeUndefined();
    expect(parseClaudeModelId("anthropic.claude-opus-4-7-v1:0")).toBeUndefined();
    expect(parseClaudeModelId("")).toBeUndefined();
  });
});

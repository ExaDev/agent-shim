import { describe, expect, it } from "vitest";

import { CLAUDE_TIERS } from "../config/schema";
import { claudeTierOf } from "./tiers";

describe("claudeTierOf", () => {
  it("selects the tier a model name names, case-insensitively", () => {
    expect(claudeTierOf("claude-haiku-5-5")).toBe("haiku");
    expect(claudeTierOf("CLAUDE-SONNET-5-5")).toBe("sonnet");
    expect(claudeTierOf("Claude-Opus-5-5")).toBe("opus");
    expect(claudeTierOf("claude-fable-5-1")).toBe("fable");
  });

  it("selects the tier of a name with a context-window suffix or a provider qualifier", () => {
    expect(claudeTierOf("claude-opus-5-5[1m]")).toBe("opus");
    expect(claudeTierOf("anthropic/claude-sonnet-5-5")).toBe("sonnet");
  });

  it("selects none for a name that names no tier", () => {
    expect(claudeTierOf("gpt-5")).toBeUndefined();
    expect(claudeTierOf("")).toBeUndefined();
  });

  it("takes the first tier in the shared order when a name holds more than one, fable before opus before sonnet before haiku", () => {
    expect(CLAUDE_TIERS).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(claudeTierOf("fable-opus")).toBe("fable");
    expect(claudeTierOf("opus-sonnet")).toBe("opus");
    expect(claudeTierOf("sonnet-haiku")).toBe("sonnet");
    expect(claudeTierOf("haiku-opus")).toBe("opus");
  });
});

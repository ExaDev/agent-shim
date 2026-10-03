import { describe, expect, it } from "vitest";
import { aliasLegacyEnv } from "./legacy";

describe("aliasLegacyEnv", () => {
  it("copies a legacy variable to its current name and reports it", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_USE_IDENTITY: "work", CLAUDE_USE_DEBUG: "1" };
    expect(aliasLegacyEnv(env)).toEqual(["CLAUDE_USE_DEBUG", "CLAUDE_USE_IDENTITY"]);
    expect(env.AGENT_SHIM_IDENTITY).toBe("work");
    expect(env.AGENT_SHIM_DEBUG).toBe("1");
  });

  it("lets a set current variable win, including an empty one", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_USE_IDENTITY: "old", AGENT_SHIM_IDENTITY: "new", CLAUDE_USE_HOME: "/old", AGENT_SHIM_HOME: "" };
    expect(aliasLegacyEnv(env)).toEqual([]);
    expect(env.AGENT_SHIM_IDENTITY).toBe("new");
    expect(env.AGENT_SHIM_HOME).toBe("");
  });

  it("leaves unrelated variables alone", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    expect(aliasLegacyEnv(env)).toEqual([]);
    expect(env).toEqual({ PATH: "/bin" });
  });
});

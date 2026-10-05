import { describe, expect, it } from "vitest";

import { InvalidClaudeVersionError, resolveClaudeVersion } from "./claudeVersion";

describe("resolveClaudeVersion", () => {
  it("is undefined when nothing pins a version", () => {
    expect(resolveClaudeVersion({ env: {} })).toBeUndefined();
  });

  it("takes the flag over the environment over the cascade", () => {
    const env = { AGENT_SHIM_CLAUDE_VERSION: "2.1.2" };
    expect(resolveClaudeVersion({ flag: "2.1.1", env, cascade: "2.1.3" })).toEqual({ version: "2.1.1", source: "flag" });
    expect(resolveClaudeVersion({ env, cascade: "2.1.3" })).toEqual({ version: "2.1.2", source: "environment" });
    expect(resolveClaudeVersion({ env: {}, cascade: "2.1.3" })).toEqual({ version: "2.1.3", source: "cascade" });
  });

  it("counts an empty environment variable as unset", () => {
    expect(resolveClaudeVersion({ env: { AGENT_SHIM_CLAUDE_VERSION: "" }, cascade: "2.1.3" })).toEqual({ version: "2.1.3", source: "cascade" });
  });

  it("refuses a flag or environment value that is not an exact dotted-numeric version, naming where it came from", () => {
    for (const bad of ["latest", "stable", "2.1.x", "^2.1.0", "v2.1.0", "2.1.220-beta"]) {
      expect(() => resolveClaudeVersion({ flag: bad, env: {} })).toThrow(InvalidClaudeVersionError);
      expect(() => resolveClaudeVersion({ env: { AGENT_SHIM_CLAUDE_VERSION: bad } })).toThrow(/AGENT_SHIM_CLAUDE_VERSION names Claude Code version/);
    }
    expect(() => resolveClaudeVersion({ flag: "latest", env: {} })).toThrow(/^--claude-version names/);
  });
});

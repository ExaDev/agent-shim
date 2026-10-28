import { describe, expect, it } from "vitest";

import { isClaudeSubcommand } from "./claudeSubcommand";

describe("isClaudeSubcommand", () => {
  it.each(["plugin", "plugins", "mcp", "auth", "setup-token", "doctor", "update", "upgrade", "stop", "kill", "agents", "rm"])("takes %s as a subcommand, with its own arguments after it", (name) => {
    expect(isClaudeSubcommand([name])).toBe(true);
    expect(isClaudeSubcommand([name, "install", "miro@claude-plugins-official"])).toBe(true);
  });

  it("takes arguments that start a session as none", () => {
    expect(isClaudeSubcommand([])).toBe(false);
    expect(isClaudeSubcommand(["--continue"])).toBe(false);
    expect(isClaudeSubcommand(["--model", "opus"])).toBe(false);
    expect(isClaudeSubcommand(["fix the plugin"])).toBe(false);
  });

  it("reads only the first token, as a name a flag or a prompt carries further on is not a subcommand", () => {
    expect(isClaudeSubcommand(["--verbose", "plugin", "list"])).toBe(false);
    expect(isClaudeSubcommand(["fix", "plugin"])).toBe(false);
    expect(isClaudeSubcommand(["--", "plugin"])).toBe(false);
  });

  it("matches a name exactly", () => {
    expect(isClaudeSubcommand(["Plugin"])).toBe(false);
    expect(isClaudeSubcommand(["plugin-list"])).toBe(false);
    expect(isClaudeSubcommand(["plug"])).toBe(false);
  });
});

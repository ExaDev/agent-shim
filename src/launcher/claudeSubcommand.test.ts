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

  it("reads past options that take no value", () => {
    expect(isClaudeSubcommand(["--verbose", "plugin", "list"])).toBe(true);
    expect(isClaudeSubcommand(["--verbose", "--chrome", "mcp", "list"])).toBe(true);
  });

  it("reads past an option and the one value it takes", () => {
    expect(isClaudeSubcommand(["--model", "opus", "plugin", "list"])).toBe(true);
    expect(isClaudeSubcommand(["--settings", "{}", "--model", "opus", "auth", "status"])).toBe(true);
    expect(isClaudeSubcommand(["-n", "work", "plugin", "list"])).toBe(true);
  });

  it("takes the value an option names with = from the same argument", () => {
    expect(isClaudeSubcommand(["--model=opus", "plugin", "list"])).toBe(true);
    expect(isClaudeSubcommand(["--debug=api", "plugin", "list"])).toBe(true);
  });

  it("gives an option with an optional value the next argument unless it starts with a hyphen, as claude reads it", () => {
    expect(isClaudeSubcommand(["--debug", "plugin", "list"])).toBe(false);
    expect(isClaudeSubcommand(["-r", "plugin"])).toBe(false);
    expect(isClaudeSubcommand(["--debug", "--verbose", "plugin", "list"])).toBe(true);
    expect(isClaudeSubcommand(["--resume", "-p", "plugin"])).toBe(true);
    expect(isClaudeSubcommand(["--worktree"])).toBe(false);
  });

  it("gives a variadic option every argument up to the next option, as claude reads it", () => {
    expect(isClaudeSubcommand(["--add-dir", "a", "b", "plugin", "list"])).toBe(false);
    expect(isClaudeSubcommand(["--allowedTools", "Bash", "--verbose", "plugin", "list"])).toBe(true);
    expect(isClaudeSubcommand(["--mcp-config", "one.json", "two.json"])).toBe(false);
  });

  it("takes an option this table does not list to have no value", () => {
    expect(isClaudeSubcommand(["--not-a-claude-option", "plugin", "list"])).toBe(true);
  });

  it("finds no subcommand after a prompt, a terminator or the end of the arguments", () => {
    expect(isClaudeSubcommand(["fix", "plugin"])).toBe(false);
    expect(isClaudeSubcommand(["--", "plugin"])).toBe(false);
    expect(isClaudeSubcommand(["--verbose", "--", "plugin"])).toBe(false);
    expect(isClaudeSubcommand(["--model"])).toBe(false);
    expect(isClaudeSubcommand(["--model", "opus"])).toBe(false);
  });

  it("matches a name exactly", () => {
    expect(isClaudeSubcommand(["Plugin"])).toBe(false);
    expect(isClaudeSubcommand(["plugin-list"])).toBe(false);
    expect(isClaudeSubcommand(["plug"])).toBe(false);
  });
});

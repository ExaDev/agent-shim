/** The subcommands `claude --help` lists, aliases included. They manage claude's own state (plugins, MCP servers, background sessions, authentication) and start no conversation, so the options a launch adds to a session are not options they take. */
const CLAUDE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "agents",
  "attach",
  "auth",
  "auto-mode",
  "doctor",
  "gateway",
  "import",
  "install",
  "kill",
  "logs",
  "mcp",
  "plugin",
  "plugins",
  "purge",
  "respawn",
  "rm",
  "setup-token",
  "stop",
  "ultrareview",
  "update",
  "upgrade",
]);

/**
 * Whether the arguments claude receives run one of its subcommands: their first token names one, as claude's own parser reads it. A subcommand starts no session, so the launch applies only the identity, the configuration directory and the credential to it, and adds none of the options a session takes (its tool flags, `CLAUDE_EXTRA_FLAGS`, `--settings`, a conversation id), which a subcommand rejects as unknown. A subcommand named after claude options (`claude --verbose plugin list`) is not recognised, since which options take a value is claude's to say.
 */
export function isClaudeSubcommand(passthrough: readonly string[]): boolean {
  const first = passthrough[0];
  return first !== undefined && CLAUDE_SUBCOMMANDS.has(first);
}

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

/** The options `claude --help` lists that take one value, which follows them as the next argument (`--model opus`). An option written with `=` carries its value in the same argument. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--agent",
  "--agents",
  "--append-system-prompt",
  "--autocompact",
  "--debug-file",
  "--effort",
  "--environment",
  "--fallback-model",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--model",
  "--name",
  "-n",
  "--output-format",
  "--permission-mode",
  "--permission-prompts",
  "--plugin-dir",
  "--plugin-url",
  "--remote-control-session-name-prefix",
  "--session-id",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--system-prompt-snapshot",
]);

/** The options `claude --help` lists that take any number of values (`--add-dir <directories...>`): they take every argument that follows until one that starts with a hyphen. */
const VARIADIC_OPTIONS: ReadonlySet<string> = new Set(["--add-dir", "--allowed-tools", "--allowedTools", "--betas", "--disallowed-tools", "--disallowedTools", "--file", "--mcp-config", "--tools"]);

/** The options `claude --help` lists with an optional value (`--resume [value]`): they take the next argument unless it starts with a hyphen. */
const OPTIONAL_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--cloud", "--debug", "-d", "--from-pr", "--prompt-suggestions", "--remote-control", "--resume", "-r", "--teleport", "--worktree", "-w"]);

/** Whether `token` is there and is not an option, so an option that takes a value can take it. */
function isOptionValue(token: string | undefined): boolean {
  return token !== undefined && !token.startsWith("-");
}

/**
 * Whether the arguments claude receives run one of its subcommands: the first argument that is not an option or an option's value names one, read as claude's own parser (commander) reads it. A subcommand starts no session, so the launch applies only the identity, the configuration directory and the credential to it, and adds none of the options a session takes (its tool flags, `CLAUDE_EXTRA_FLAGS`, `--settings`, a conversation id), which a subcommand rejects as unknown.
 *
 * Options before the subcommand are skipped with the values they take: one for the options in `VALUE_OPTIONS`, the arguments up to the next option for `VARIADIC_OPTIONS`, and the next argument unless it starts with a hyphen for `OPTIONAL_VALUE_OPTIONS`, so `claude --model opus plugin list` runs `plugin` while `claude --debug plugin list` gives `--debug` the filter `plugin`, as claude reads it. An option this table does not list is taken to have no value, so a newer claude's value option before a subcommand leaves the launch as it was for a session, and a `--` terminator ends the options with no subcommand.
 */
export function isClaudeSubcommand(passthrough: readonly string[]): boolean {
  let index = 0;
  while (index < passthrough.length) {
    const token = passthrough[index];
    if (token === undefined || token === "--") {
      return false;
    }
    if (!token.startsWith("-")) {
      return CLAUDE_SUBCOMMANDS.has(token);
    }
    index += 1;
    if (token.includes("=")) {
      continue;
    }
    if (VALUE_OPTIONS.has(token)) {
      index += 1;
    } else if (VARIADIC_OPTIONS.has(token)) {
      while (isOptionValue(passthrough[index])) {
        index += 1;
      }
    } else if (OPTIONAL_VALUE_OPTIONS.has(token) && isOptionValue(passthrough[index])) {
      index += 1;
    }
  }
  return false;
}

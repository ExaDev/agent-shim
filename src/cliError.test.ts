import { describe, expect, it } from "vitest";
import { CommanderError } from "commander";

import { CliError, EXIT_FAILURE, EXIT_USAGE, MissingInputError, PromptCancelledError, reportFatalError, UsageError } from "./cliError";
import { IdentityAlreadyExistsError, IdentityNotFoundError, InvalidIdentityNameError } from "./identityManager";
import { InvalidCategoryNameError, ProfileAlreadyExistsError, ProfileNotFoundError } from "./configProfiles";
import { DirectoryRuleAlreadyExistsError, DirectoryRuleMissingTargetError, DirectoryRuleNotFoundError } from "./directoryRules";
import { InvalidEnvBoolError } from "./cli/parsers";
import { ConflictingIdentityError } from "./launcher/argv";
import { ConfigureNeedsTerminalError, NoConfigProfileResolvedError, NoIdentityResolvedError } from "./configure";
import { UnsupportedShellError } from "./completion";
import { InvalidProviderNameError, ProviderAlreadyExistsError, ProviderNotFoundError } from "./providers";
import { ForeignClaudeEntryError, UnsupportedShimSourceError } from "./claudeShim";
import { ConfigValidationError } from "./config/load";
import { InvalidCliCategoryError, InvalidCliEntryKeyError } from "./launcher/cliOverride";
import { IdentityLockBusyError } from "./launcher/lock";
import { UnrootedProjectPathError } from "./resolve/projects";
import { EntryKeyError } from "./resolve/match";

// An arbitrary fake PID, used only as a fixture for IdentityLockBusyError below.
const FAKE_LOCK_HOLDER_PID = 42;

/**
 * Every custom error this CLI throws to represent an expected, user-facing failure must extend `CliError` -- that is what makes `main()` in `src/cli.ts` print it as a clean one-line message instead of a raw stack trace. This test exists specifically to catch a class silently reverting to `extends Error`, or a new one being added without extending `CliError` at all, neither of which `tsc`/`eslint` would ever flag.
 */
describe("every CLI-facing error class extends CliError", () => {
  it.each<[string, () => Error]>([
    ["IdentityNotFoundError", () => new IdentityNotFoundError("work")],
    ["IdentityAlreadyExistsError", () => new IdentityAlreadyExistsError("work")],
    ["InvalidIdentityNameError", () => new InvalidIdentityNameError("bad@name")],
    ["ProfileNotFoundError", () => new ProfileNotFoundError("client-acme")],
    ["ProfileAlreadyExistsError", () => new ProfileAlreadyExistsError("client-acme")],
    ["InvalidCategoryNameError", () => new InvalidCategoryNameError("secret")],
    ["DirectoryRuleNotFoundError", () => new DirectoryRuleNotFoundError("/some/path")],
    ["DirectoryRuleMissingTargetError", () => new DirectoryRuleMissingTargetError()],
    ["ForeignClaudeEntryError", () => new ForeignClaudeEntryError("/usr/local/bin/claude", "enable")],
    ["UnsupportedShimSourceError", () => new UnsupportedShimSourceError("/some/source")],
    ["ConfigValidationError", () => new ConfigValidationError("/some/config.json", [])],
    ["InvalidCliCategoryError", () => new InvalidCliCategoryError("secret")],
    ["InvalidCliEntryKeyError", () => new InvalidCliEntryKeyError("no-prefix")],
    ["IdentityLockBusyError", () => new IdentityLockBusyError("work", "/some/lock", FAKE_LOCK_HOLDER_PID)],
    ["UnrootedProjectPathError", () => new UnrootedProjectPathError("relative/path")],
    ["EntryKeyError", () => new EntryKeyError("bad-key", "bad", "malformed")],
    ["DirectoryRuleAlreadyExistsError", () => new DirectoryRuleAlreadyExistsError("/some/path")],
    ["InvalidEnvBoolError", () => new InvalidEnvBoolError("CLAUDE_USE_HEADROOM", "yes")],
    ["ConflictingIdentityError", () => new ConflictingIdentityError("work", "personal")],
    ["ConfigureNeedsTerminalError", () => new ConfigureNeedsTerminalError()],
    ["NoConfigProfileResolvedError", () => new NoConfigProfileResolvedError("work", "/some/dir")],
    ["NoIdentityResolvedError", () => new NoIdentityResolvedError("/some/dir")],
    ["UnsupportedShellError", () => new UnsupportedShellError("tcsh")],
    ["ProviderNotFoundError", () => new ProviderNotFoundError("z")],
    ["ProviderAlreadyExistsError", () => new ProviderAlreadyExistsError("z")],
    ["InvalidProviderNameError", () => new InvalidProviderNameError(".z")],
    ["UsageError", () => new UsageError("bad")],
    ["MissingInputError", () => new MissingInputError("--yes", "Confirmation")],
    ["PromptCancelledError", () => new PromptCancelledError()],
  ])("%s extends CliError", (_name, construct) => {
    expect(construct()).toBeInstanceOf(CliError);
  });
});

class ExampleCliError extends CliError {}

function capture(error: unknown, env: Readonly<Record<string, string | undefined>> = {}): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = reportFatalError(error, {
    writeErr: (line) => {
      lines.push(line);
    },
    env,
  });
  return { code, lines };
}

describe("reportFatalError", () => {
  it("prints an expected failure as claude-use: <message> and exits 1", () => {
    expect(capture(new ExampleCliError('No identity named "work".'))).toEqual({ code: EXIT_FAILURE, lines: ['claude-use: No identity named "work".'] });
  });

  it("exits 2 for a usage error, including missing input with no terminal", () => {
    expect(capture(new UsageError("bad flag")).code).toBe(EXIT_USAGE);
    const missing = capture(new MissingInputError("--yes", "Confirmation"));
    expect(missing.code).toBe(EXIT_USAGE);
    expect(missing.lines[0]).toContain("pass --yes");
  });

  it("prints an unexpected error by message alone, with no stack, by default", () => {
    const error = new Error("boom");
    expect(capture(error)).toEqual({ code: EXIT_FAILURE, lines: ["claude-use: boom"] });
  });

  it.each(["1", "true"])("adds the stack trace when CLAUDE_USE_DEBUG=%s", (value) => {
    const error = new Error("boom");
    expect(capture(error, { CLAUDE_USE_DEBUG: value }).lines).toEqual(["claude-use: boom", error.stack]);
  });

  it.each(["0", "false", "", "nonsense"])("keeps the stack hidden when CLAUDE_USE_DEBUG=%j", (value) => {
    expect(capture(new Error("boom"), { CLAUDE_USE_DEBUG: value }).lines).toEqual(["claude-use: boom"]);
  });

  it("prints a thrown non-Error value as text", () => {
    expect(capture("plain")).toEqual({ code: EXIT_FAILURE, lines: ["claude-use: plain"] });
  });

  it("maps a Commander error to its own zero for help and version, and to the usage status otherwise, printing nothing itself", () => {
    expect(capture(new CommanderError(0, "commander.helpDisplayed", "(outputHelp)"))).toEqual({ code: 0, lines: [] });
    expect(capture(new CommanderError(1, "commander.unknownCommand", "error: unknown command 'rules'"))).toEqual({ code: EXIT_USAGE, lines: [] });
  });
});

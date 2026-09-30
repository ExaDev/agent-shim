import { describe, expect, it } from "vitest";

import { CliError, reportFatalError } from "./cliError";
import { IdentityAlreadyExistsError, IdentityNotFoundError, InvalidIdentityNameError } from "./identityManager";
import { InvalidCategoryNameError, ProfileAlreadyExistsError, ProfileNotFoundError } from "./configProfiles";
import { DirectoryRuleMissingTargetError, DirectoryRuleNotFoundError } from "./directoryRules";
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
  ])("%s extends CliError", (_name, construct) => {
    expect(construct()).toBeInstanceOf(CliError);
  });
});

class ExampleCliError extends CliError {}

describe("reportFatalError", () => {
  it("prints an expected failure as its message alone and exits 1", () => {
    const lines: string[] = [];
    const code = reportFatalError(new ExampleCliError("No identity named \"work\"."), (line) => { lines.push(line); });
    expect(lines).toEqual(['No identity named "work".']);
    expect(code).toBe(1);
  });

  it("prints an unexpected error with its stack trace and exits 1", () => {
    const lines: string[] = [];
    const error = new Error("boom");
    const code = reportFatalError(error, (line) => { lines.push(line); });
    expect(lines).toEqual([error.stack]);
    expect(code).toBe(1);
  });

  it("prints a thrown non-Error value as text", () => {
    const lines: string[] = [];
    expect(reportFatalError("plain", (line) => { lines.push(line); })).toBe(1);
    expect(lines).toEqual(["plain"]);
  });
});

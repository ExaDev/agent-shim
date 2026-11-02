import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError, EXIT_FAILURE } from "./cliError";
import { reportFatalError } from "./cliReport";
import { runIdentityWizard, tryRunAtIdentityShortcut } from "./identityManager";
import { renameIdentity } from "./identityRename";
import { createWorld, type World } from "./identityRenameTestWorld";
import { IdentityAlreadyExistsError, InvalidIdentityNameError, addNewIdentity, identityExists } from "./identityStore";
import { createFakeKeychain, type FakeKeychain } from "./keychainTestWorld";
import { KeychainLoginError, type KeychainProbe } from "./keychainLogin";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { fakeCommandDeps, scriptedPrompts } from "./test-helpers";
import { claudeCodeKeychainService } from "./usage/signIn";

/** A made-up login, which no message or call of the check may carry. */
const LOGIN_BLOB = "a-made-up-login-blob";

describe("creating an identity while the Keychain still holds a login filed for its directory", () => {
  let root: string;
  let paths: LayoutPaths;
  let keychain: FakeKeychain;
  let darwin: KeychainProbe;
  let world: World;
  let out: string[];

  const service = (name: string): string => claudeCodeKeychainService(path.join(paths.identitiesDir, name));
  const deleteCommand = (name: string): string => `security delete-generic-password -s '${service(name)}' -a 'alex'`;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-add-keychain-test-"));
    paths = buildLayoutPaths(root);
    keychain = createFakeKeychain();
    darwin = { run: keychain.run, platform: "darwin" };
    world = createWorld();
    out = [];
    vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
      out.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** Runs `agent-shim` with `argv` against this state root and the fake Keychain, returning the exit status and what a failure printed. */
  async function run(argv: readonly string[]): Promise<number> {
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn(), identityRenamePorts: { ...world.ports(), run: keychain.run, platform: "darwin" } });
    try {
      await program.parseAsync([...argv], { from: "user" });
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    } catch (error) {
      return reportFatalError(error, {
        writeErr: (line) => {
          out.push(line);
        },
        env: {},
      });
    }
  }

  it("is refused by identity add, naming the entry and the exact command that deletes it, and creates nothing", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    expect(await run(["identity", "add", "work"])).toBe(EXIT_FAILURE);
    const printed = out.join("\n");
    expect(printed).toContain('Cannot create identity "work"');
    expect(printed).toContain(path.join(paths.identitiesDir, "work"));
    expect(printed).toContain(`service ${service("work")}`);
    expect(printed).toContain("account alex");
    expect(printed).toContain("would start signed in as that account");
    expect(printed).toContain(`\`${deleteCommand("work")}\``);
    expect(identityExists(paths, "work")).toBe(false);
    expect(fs.existsSync(path.join(paths.identitiesDir, "work"))).toBe(false);
  });

  it.each([
    ["a single quote", "o'brien", `'o'\\''brien'`],
    ["a command substitution", "$(touch evil)", "'$(touch evil)'"],
    ["backticks", "`id`", "'`id`'"],
    ["a semicolon and a space", "a; rm -rf x", "'a; rm -rf x'"],
    ["a plain name", "alex", "'alex'"],
  ])("prints the account in single quotes, so a shell takes it literally, for an account with %s", async (_case, account, quoted) => {
    keychain.seed(service("work"), account, LOGIN_BLOB);
    expect(await run(["identity", "add", "work"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain(`security delete-generic-password -s '${service("work")}' -a ${quoted}`);
  });

  it("prints the command without an account, rather than with a guessed one, when the item has no plain account name", async () => {
    keychain.seed(service("work"), "", LOGIN_BLOB);
    expect(await run(["identity", "add", "work"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain(`\`security delete-generic-password -s '${service("work")}'\``);
    expect(out.join("\n")).not.toContain(" -a ");
  });

  it("asks the Keychain for attributes only, never for the login, and the message carries none of it", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    await run(["identity", "add", "work"]);
    expect(keychain.calls).toEqual([{ command: "security", args: ["find-generic-password", "-s", service("work")] }]);
    expect(keychain.calls.some((call) => call.args.includes("-w") || call.args.includes("-g") || call.args[0] === "-i")).toBe(false);
    expect(out.join("\n")).not.toContain(LOGIN_BLOB);
  });

  it("is allowed once the entry is deleted, with the command the message gave", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    expect(await run(["identity", "add", "work"])).toBe(EXIT_FAILURE);
    keychain.items.delete(service("work"));
    out.length = 0;
    expect(await run(["identity", "add", "work"])).toBe(0);
    expect(identityExists(paths, "work")).toBe(true);
    expect(out).toContain('Created identity "work".');
  });

  it("is not refused for a login filed for a different directory, and asks only about its own", async () => {
    keychain.seed(service("other"), "alex", LOGIN_BLOB);
    expect(await run(["identity", "add", "work"])).toBe(0);
    expect(keychain.calls.map((call) => call.args[2])).toEqual([service("work")]);
  });

  it("asks nothing of the Keychain off macOS", () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    addNewIdentity(paths, "work", { run: keychain.run, platform: "linux" });
    expect(keychain.calls).toEqual([]);
    expect(identityExists(paths, "work")).toBe(true);
  });

  it("is a refusal of the name before it is a question to the Keychain: an identity that exists, which has a login of its own, and a name that is not valid", () => {
    addNewIdentity(paths, "work", { run: keychain.run, platform: "linux" });
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    expect(() => addNewIdentity(paths, "work", darwin)).toThrow(IdentityAlreadyExistsError);
    expect(() => addNewIdentity(paths, "@work", darwin)).toThrow(InvalidIdentityNameError);
    expect(keychain.calls).toEqual([]);
  });

  it("is a KeychainLoginError, which is an expected failure and not a stack trace", () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    const failure: unknown = (() => {
      try {
        addNewIdentity(paths, "work", darwin);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(KeychainLoginError);
    expect(failure).toBeInstanceOf(CliError);
  });

  it("is refused by the wizard that creates an identity for use, before anything is created", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    await expect(runIdentityWizard(scriptedPrompts(["create", "skip"]), paths, "work", darwin)).rejects.toThrow(KeychainLoginError);
    expect(identityExists(paths, "work")).toBe(false);
  });

  it("is refused by the @name shortcut that offers to create one", async () => {
    keychain.seed(service("work"), "alex", LOGIN_BLOB);
    await expect(tryRunAtIdentityShortcut(fakeCommandDeps(paths, { interactive: true, answers: ["create", "skip"] }), ["@work"], darwin)).rejects.toThrow(KeychainLoginError);
    expect(identityExists(paths, "work")).toBe(false);
  });

  describe("after a rename whose old Keychain item could not be deleted", () => {
    it("is the reason the rename's warning gives for deleting it, and identity add of the old name refuses until it is", async () => {
      const renamed = createWorld("darwin");
      try {
        const oldService = claudeCodeKeychainService(renamed.directory("work"));
        const stubborn = { run: (command: string, args: readonly string[], input?: string) => (args[0] === "delete-generic-password" ? { status: 1, stdout: "", stderr: "denied" } : renamed.keychain.run.run(command, args, input)) };
        const report = await renameIdentity(renamed.paths, "work", "client", renamed.ports({ run: stubborn }));
        const warning = report.warnings.find((entry) => entry.includes(oldService));
        expect(warning).toContain("could not be deleted");
        expect(warning).not.toContain("harmless");
        expect(warning).toContain('a new identity created under the name "work" would start signed in as that account');
        expect(warning).toContain("`identity add work` refuses until it is deleted");
        expect(warning).toContain(`\`security delete-generic-password -s '${oldService}' -a 'alex'\``);
        expect(() => addNewIdentity(renamed.paths, "work", { run: renamed.keychain.run, platform: "darwin" })).toThrow(`\`security delete-generic-password -s '${oldService}' -a 'alex'\``);
      } finally {
        fs.rmSync(renamed.root, { recursive: true, force: true });
      }
    });
  });
});

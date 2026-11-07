import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_FAILURE, EXIT_USAGE } from "./cliError";
import { reportFatalError } from "./cliReport";
import type { CredentialCachePort } from "./credentialCache";
import { KeychainCacheDeleteError } from "./keychainLogin";
import { IdentityNamesLockBusyError, nonWaitingIdentityNamesLockPorts } from "./identityNamesLock";
import type { IdentityRenamePorts } from "./identityRename";
import { readRenameJournal, renameJournalFile, writeRenameJournal } from "./identityRenameJournal";
import type { SessionProcess } from "./identitySessions";
import { addIdentity, identityExists, identityIdOf, readActiveIdentity, useIdentity } from "./identityStore";
import { createFakeKeychain } from "./keychainTestWorld";
import { RC_SELF_HOST_MINT_MARKER } from "./frontdoor/rcSelfHostMint";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { realFarmFs } from "./realPorts";
import { realpathOrSelf } from "./realIdentityRename";
import { sameDirectory } from "./sameDirectory";
import { fakeCommandDeps } from "./test-helpers";
import { claudeCodeKeychainService } from "./usage/signIn";

const NOW_MS = 1_000;
const OWN_PID = 4242;

/** A failure `security` gives that is not an item it cannot find, as a locked Keychain gives. */
const LOCKED_KEYCHAIN_STATUS = 51;

describe("identity rename", () => {
  let root: string;
  let paths: LayoutPaths;
  let out: string[];
  let warnings: string[];
  let sessions: readonly SessionProcess[];
  /** Every cached credential the commands forgot, as `<store>:<owner>`. */
  let cacheRemovals: string[];
  /** When true, deleting from the Keychain store fails as a locked Keychain makes it. */
  let keychainDeleteFails: boolean;
  /** When true, every Keychain lookup fails as a locked Keychain makes it, which says nothing about whether an item is there. */
  let keychainFindLocked: boolean;
  /** The arguments of every `security` call that went through the unbounded runner, which the attribute-only leftover lookup must not use. */
  let unboundedCalls: (readonly string[])[];
  let duringCacheRemoval: (() => void) | undefined;
  const keychain = createFakeKeychain();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-rename-command-test-"));
    paths = buildLayoutPaths(root);
    out = [];
    warnings = [];
    sessions = [];
    cacheRemovals = [];
    keychainDeleteFails = false;
    keychainFindLocked = false;
    unboundedCalls = [];
    duringCacheRemoval = undefined;
    keychain.items.clear();
    keychain.calls.length = 0;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
      out.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args: readonly unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function ports(): IdentityRenamePorts {
    const cache: CredentialCachePort = {
      read: () => undefined,
      write: () => undefined,
      remove: (store, owner) => {
        cacheRemovals.push(`${store}:${owner}`);
        duringCacheRemoval?.();
        if (store === "keychain" && keychainDeleteFails) {
          throw new KeychainCacheDeleteError(owner, LOCKED_KEYCHAIN_STATUS);
        }
      },
    };
    return {
      fs: realFarmFs,
      credentialCache: { port: cache, platform: "darwin" },
      run: { run: (command, args, input) => {
        unboundedCalls.push(args);
        return keychain.run.run(command, args, input);
      } },
      lookupRun: { run: (command, args, input) => (keychainFindLocked && args[0] === "find-generic-password" ? { status: LOCKED_KEYCHAIN_STATUS, stdout: "", stderr: "" } : keychain.run.run(command, args, input)) },
      platform: "darwin",
      home: "/example/home",
      sameDirectory,
      realpath: realpathOrSelf,
      sessions: { sessionsOn: () => sessions },
      launches: { liveOn: () => [] },
      signals: {
        onInterrupt: () => () => undefined,
        turn: async () => {
          await Promise.resolve();
        },
      },
      lock: { nowMs: () => NOW_MS, pid: OWN_PID, isRunning: () => true, sleep: () => undefined },
    };
  }

  async function run(argv: readonly string[]): Promise<number> {
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn(), identityRenamePorts: ports() });
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

  function seed(): void {
    addIdentity(paths, "work");
    useIdentity(paths, "work");
    keychain.seed(claudeCodeKeychainService(path.join(paths.identitiesDir, "work")), "alex", "a-made-up-login-blob");
  }

  it("renames the identity, its active selection and its Keychain login, and lists what it did", async () => {
    seed();
    expect(await run(["identity", "rename", "work", "client", "--move"])).toBe(0);
    expect(identityExists(paths, "client")).toBe(true);
    expect(identityExists(paths, "work")).toBe(false);
    expect(readActiveIdentity(paths)).toBe("client");
    expect(keychain.items.has(claudeCodeKeychainService(path.join(paths.identitiesDir, "client")))).toBe(true);
    expect(keychain.items.has(claudeCodeKeychainService(path.join(paths.identitiesDir, "work")))).toBe(false);
    expect(out[0]).toBe('Renamed identity "work" to "client".');
    expect(out.join("\n")).toContain("  move identities/work to identities/client");
    expect(out.join("\n")).toContain("  rewrite active-identity");
  });

  it("with --dry-run prints the plan and changes nothing", async () => {
    seed();
    expect(await run(["identity", "rename", "work", "client", "--move", "--dry-run"])).toBe(0);
    expect(out[0]).toBe('Would rename identity "work" to "client":');
    expect(out.at(-1)).toBe("Nothing was changed.");
    expect(identityExists(paths, "work")).toBe(true);
    expect(identityExists(paths, "client")).toBe(false);
    expect(readActiveIdentity(paths)).toBe("work");
    expect(keychain.calls.every((call) => call.args[0] === "find-generic-password" && !call.args.includes("-w"))).toBe(true);
  });

  it("prints the result as JSON, naming a dry run as planned", async () => {
    seed();
    expect(await run(["identity", "rename", "work", "client", "--move", "--dry-run", "--json"])).toBe(0);
    const planned = JSON.parse(out.join("\n")) as { action: string; kind: string; name: string; value: { dryRun: boolean; steps: string[] } };
    expect(planned).toMatchObject({ action: "planned", kind: "identity", name: "client", value: { dryRun: true } });
    out.length = 0;
    expect(await run(["identity", "rename", "work", "client", "--move", "--json"])).toBe(0);
    const renamed = JSON.parse(out.join("\n")) as typeof planned;
    expect(renamed).toMatchObject({ action: "renamed", name: "client", value: { dryRun: false } });
    expect(renamed.value.steps).toEqual(planned.value.steps);
  });

  it("fails with the blocking session named, exit status 1 and nothing changed", async () => {
    seed();
    sessions = [{ pid: 4711, program: "claude" }];
    expect(await run(["identity", "rename", "work", "client", "--move"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain("pid 4711 (claude)");
    expect(identityExists(paths, "work")).toBe(true);
  });

  it("without --move changes the name alone, while a session runs on the identity, and asks nothing of the Keychain", async () => {
    seed();
    sessions = [{ pid: 4711, program: "claude" }];
    const keychainCalls = keychain.calls.length;
    expect(await run(["identity", "rename", "work", "client"])).toBe(0);
    expect(identityIdOf(paths, "client")).toBe("work");
    expect(fs.existsSync(path.join(paths.identitiesDir, "work"))).toBe(true);
    expect(readActiveIdentity(paths)).toBe("client");
    expect(keychain.calls).toHaveLength(keychainCalls);
    expect(out[0]).toBe('Renamed identity "work" to "client".');
    expect(out.join("\n")).toContain("  rewrite identities/work/identity.json: name");
    expect(out.join("\n")).not.toContain("move identities/work");
  });

  it("with --id renames the identity stored under that id, and refuses --id with --move", async () => {
    seed();
    expect(await run(["identity", "rename", "work", "client", "--id", "--move"])).toBe(EXIT_USAGE);
    expect(await run(["identity", "rename", "work", "client", "--id"])).toBe(0);
    expect(identityIdOf(paths, "client")).toBe("work");
  });

  it("lists, shows and renames by --id an identity whose directory id starts with a hyphen or lies outside isFileName, while still refusing unknown options", async () => {
    seed();
    for (const [id, name] of [
      ["-work", "work"],
      ["wörk", "umlaut"],
      ['wo"rk', "quoted"],
    ] as const) {
      fs.mkdirSync(path.join(paths.identitiesDir, id), { recursive: true });
      fs.writeFileSync(path.join(paths.identitiesDir, id, "identity.json"), JSON.stringify({ name, allowAmbientCredential: false }));
    }
    expect(await run(["identity", "list"])).toBe(0);
    expect(await run(["identity", "show", "umlaut"])).toBe(0);
    expect(await run(["identity", "show", "quoted"])).toBe(0);
    // The command DuplicateIdentityNameError, doctor and an interrupted rename print when id is -work.
    expect(await run(["identity", "rename", "-work", "work-old", "--id"])).toBe(0);
    expect(identityIdOf(paths, "work-old")).toBe("-work");
    expect(identityIdOf(paths, "work")).toBe("work");
    expect(await run(["identity", "rename", "-work", "other"])).toBe(EXIT_USAGE);
    expect(await run(["identity", "rename", "work", "other", "--bogus"])).toBe(EXIT_USAGE);
  });

  it("with --id reports the identity's old name, not the id it was given, in text and JSON, and says the references stay with the other identity when the name was shared", async () => {
    seed();
    // A second identity claiming work, stored under dup.
    fs.mkdirSync(path.join(paths.identitiesDir, "dup"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "dup", "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false }));
    expect(await run(["identity", "rename", "dup", "office", "--id"])).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain('Renamed identity "work" to "office".');
    expect(printed).not.toContain('"dup"');
    expect(printed).toContain('Another identity also has the name "work", so the references to it, here and in any committed .agent-shim.json, stay with that identity.');
    out.length = 0;
    expect(await run(["identity", "rename", "work", "client", "--id", "--json"])).toBe(0);
    const json: unknown = JSON.parse(out.join("\n"));
    expect(json).toMatchObject({ action: "renamed", value: { from: "work", to: "client", shared: false } });
  });

  it("with --id --dry-run reports the identity's old name, not the id it was given, in text and JSON, and changes nothing", async () => {
    seed();
    // An identity named office stored under desk, so the id the command is given is not its name.
    fs.mkdirSync(path.join(paths.identitiesDir, "desk"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "desk", "identity.json"), JSON.stringify({ name: "office", allowAmbientCredential: false }));
    expect(await run(["identity", "rename", "desk", "client", "--id", "--dry-run"])).toBe(0);
    expect(out[0]).toBe('Would rename identity "office" to "client":');
    expect(out.join("\n")).not.toContain('"desk"');
    out.length = 0;
    expect(await run(["identity", "rename", "desk", "client", "--id", "--dry-run", "--json"])).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ action: "planned", value: { from: "office", to: "client", dryRun: true } });
    expect(identityIdOf(paths, "office")).toBe("desk");
    expect(identityIdOf(paths, "client")).toBeUndefined();
  });

  it("identity remove forgets the credential the Keychain store caches under the removed identity's id, not its name", async () => {
    seed();
    expect(await run(["identity", "rename", "work", "client"])).toBe(0);
    expect(await run(["identity", "remove", "client", "--yes"])).toBe(0);
    expect(cacheRemovals).toEqual(["keychain:identity work"]);
  });

  it("identity remove leaves every Claude Code login item, and names the one a self-hosted identity left, after a mint and a real /login", async () => {
    addIdentity(paths, "lab");
    const labDir = path.join(paths.identitiesDir, "lab");
    fs.writeFileSync(path.join(labDir, RC_SELF_HOST_MINT_MARKER), `${JSON.stringify({ mintedAt: new Date(NOW_MS).toISOString() })}\n`);
    // After the mint the person ran /login with a real account: the CLI filed its login in the Keychain under the directory's service.
    keychain.seed(claudeCodeKeychainService(labDir), "alex", "a-made-up-real-login");
    addIdentity(paths, "work");
    keychain.seed(claudeCodeKeychainService(path.join(paths.identitiesDir, "work")), "alex", "a-made-up-real-login");
    expect(await run(["identity", "remove", "lab", "--yes"])).toBe(0);
    expect(keychain.secretOf(claudeCodeKeychainService(labDir))?.toString("utf8")).toBe("a-made-up-real-login");
    expect(warnings.join("\n")).toContain(`security delete-generic-password -s '${claudeCodeKeychainService(labDir)}' -a 'alex'`);
    expect(keychain.calls.some((call) => call.args[0] === "delete-generic-password" && call.args.includes(claudeCodeKeychainService(labDir)))).toBe(false);
    expect(keychain.calls.some((call) => call.args.includes("-g") || call.args.includes("-w"))).toBe(false);
    // An identity the mint never wrote into is removed as it always was: its item is kept and nothing is said about it.
    warnings.length = 0;
    expect(await run(["identity", "remove", "work", "--yes"])).toBe(0);
    expect(keychain.items.has(claudeCodeKeychainService(path.join(paths.identitiesDir, "work")))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("identity remove of a self-hosted identity on a Keychain that cannot be asked still reports the removal, with the warning", async () => {
    addIdentity(paths, "lab");
    const labDir = path.join(paths.identitiesDir, "lab");
    fs.writeFileSync(path.join(labDir, RC_SELF_HOST_MINT_MARKER), `${JSON.stringify({ mintedAt: new Date(NOW_MS).toISOString() })}\n`);
    keychain.seed(claudeCodeKeychainService(labDir), "alex", "a-made-up-login");
    keychainFindLocked = true;
    expect(await run(["identity", "remove", "lab", "--yes"])).toBe(0);
    expect(out.join("\n")).toContain('Removed identity "lab".');
    expect(warnings.join("\n")).toContain("The identity was removed, but the Keychain could not be checked");
  });

  it("looks a self-hosted identity's leftover login up through the bounded runner, never the unbounded one", async () => {
    addIdentity(paths, "lab");
    const labDir = path.join(paths.identitiesDir, "lab");
    fs.writeFileSync(path.join(labDir, RC_SELF_HOST_MINT_MARKER), `${JSON.stringify({ mintedAt: new Date(NOW_MS).toISOString() })}\n`);
    keychain.seed(claudeCodeKeychainService(labDir), "alex", "a-made-up-login");
    expect(await run(["identity", "remove", "lab", "--yes"])).toBe(0);
    expect(warnings.join("\n")).toContain(claudeCodeKeychainService(labDir));
    expect(unboundedCalls).toEqual([]);
  });

  it("identity remove whose Keychain cache delete fails still names a self-hosted identity's leftover login, in the one failure", async () => {
    addIdentity(paths, "lab");
    const labDir = path.join(paths.identitiesDir, "lab");
    fs.writeFileSync(path.join(labDir, RC_SELF_HOST_MINT_MARKER), `${JSON.stringify({ mintedAt: new Date(NOW_MS).toISOString() })}\n`);
    keychain.seed(claudeCodeKeychainService(labDir), "alex", "a-made-up-login");
    keychainDeleteFails = true;
    expect(await run(["identity", "remove", "lab", "--yes"])).toBe(EXIT_FAILURE);
    const printed = out.join("\n");
    expect(printed).toContain('Removed identity "lab", but could not delete its cached credential');
    expect(printed).toContain(`security delete-generic-password -s '${claudeCodeKeychainService(labDir)}' -a 'alex'`);
    expect(identityIdOf(paths, "lab")).toBeUndefined();
  });

  it("keeps the removed id reserved until the CLI deletes its Keychain cache", async () => {
    seed();
    let refusal: unknown;
    duringCacheRemoval = () => {
      try {
        addIdentity(paths, "work", { namesLock: nonWaitingIdentityNamesLockPorts });
      } catch (error: unknown) {
        refusal = error;
      }
    };
    expect(await run(["identity", "remove", "work", "--yes"])).toBe(0);
    expect(refusal).toBeInstanceOf(IdentityNamesLockBusyError);
  });

  it("says in the help of identity remove what it deletes, and that it never deletes another identity's cached credential", () => {
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn(), identityRenamePorts: ports() });
    const remove = program.commands.find((command) => command.name() === "identity")?.commands.find((command) => command.name() === "remove");
    expect(remove?.description()).toContain("its cached credential (never one recorded for another identity whose id names the same file; one cached before owners were recorded names no owner and is deleted whichever identity whose id names that file cached it)");
  });

  it("identity remove whose Keychain delete fails says the identity was removed and names the command that deletes what is left", async () => {
    seed();
    expect(await run(["identity", "rename", "work", "client"])).toBe(0);
    keychainDeleteFails = true;
    expect(await run(["identity", "remove", "client", "--yes"])).toBe(EXIT_FAILURE);
    const printed = out.join("\n");
    expect(printed).toContain('Removed identity "client", but could not delete its cached credential (identity work) from the Keychain');
    expect(printed).toContain("security delete-generic-password -s 'agent-shim-credential-cache' -a 'identity work'");
    expect(identityIdOf(paths, "client")).toBeUndefined();
  });

  it("refuses --discard-journal without --move, whose record it removes", async () => {
    seed();
    expect(await run(["identity", "rename", "work", "client", "--discard-journal"])).toBe(EXIT_USAGE);
    expect(out.join("\n")).toContain("is given with --move");
  });

  it("is a usage error when the new name is missing", async () => {
    seed();
    expect(await run(["identity", "rename", "work"])).toBe(EXIT_USAGE);
  });

  it("prints a warning on standard error when the old Keychain item cannot be deleted", async () => {
    seed();
    const original = keychain.run;
    const stubborn = { run: (command: string, args: readonly string[], input?: string) => (args[0] === "delete-generic-password" ? { status: 1, stdout: "", stderr: "denied" } : original.run(command, args, input)) };
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn(), identityRenamePorts: { ...ports(), run: stubborn } });
    await program.parseAsync(["identity", "rename", "work", "client", "--move"], { from: "user" });
    expect(identityExists(paths, "client")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("security delete-generic-password");
  });

  /** Leaves the journal of a rename of `work` to `client` that nothing applied, and removes `work`, so no identity is under either name. */
  function leaveUnfinishable(): string {
    seed();
    const file = renameJournalFile(paths.identityRenamesDir, "work", "client");
    writeRenameJournal(realFarmFs, file, { version: 1, from: "work", to: "client", startedAt: "2026-10-30T10:00:00.000Z", pid: OWN_PID, steps: [{ description: "move identities/work to identities/client", started: false, done: false }] });
    fs.rmSync(path.join(paths.identitiesDir, "work"), { recursive: true, force: true });
    return file;
  }

  it("says in its help that the rename leaves the directory and running sessions alone, and that --move is what running sessions refuse", () => {
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn(), identityRenamePorts: ports() });
    const rename = program.commands.find((command) => command.name() === "identity")?.commands.find((command) => command.name() === "rename");
    expect(rename?.description()).toContain("Its directory, login and usage stay where they are, so it goes ahead while sessions run on it.");
    expect(rename?.description()).toContain("A rename that was interrupted is finished by running the same command again.");
    const move = rename?.options.find((option) => option.long === "--move")?.description;
    expect(move).toContain("refused while a session is running on it or a launch is starting on it.");
    expect(move).toContain("One that was interrupted is finished by running the same command again.");
  });

  it("says in the help of --dry-run that it prints what would be rewritten, and moved only with --move", () => {
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn(), identityRenamePorts: ports() });
    const rename = program.commands.find((command) => command.name() === "identity")?.commands.find((command) => command.name() === "rename");
    expect(rename?.options.find((option) => option.long === "--dry-run")?.description).toBe("Print what would be rewritten (and, with --move, moved), and change nothing.");
  });

  it("says in its help what --discard-journal does and when it refuses", () => {
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn(), identityRenamePorts: ports() });
    const rename = program.commands.find((command) => command.name() === "identity")?.commands.find((command) => command.name() === "rename");
    const discard = rename?.options.find((option) => option.long === "--discard-journal")?.description;
    // The rule the code checks, in its words: accepted for an identity under neither name or under both, or under <old> alone with no step recorded as begun or done.
    expect(discard?.startsWith("Only with --move. Remove the record of an unfinished rename")).toBe(true);
    expect(discard).toContain("Accepted when the identity exists under neither name or under both, or under <old> alone and the record shows no step as begun or done");
    expect(discard).toContain("refused when the identity exists under only one name and the record shows a step as begun or done or the identity is under <new>");
    expect(discard).toContain("where running the rename again finishes it");
    expect(discard).toContain("changes no identity");
    expect(discard).not.toContain("nothing can finish");
    expect(discard).not.toContain("was applied");
  });

  it("with --discard-journal removes the record of a rename nothing can finish, and says so", async () => {
    const file = leaveUnfinishable();
    expect(await run(["identity", "rename", "work", "client", "--move"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain("agent-shim identity rename work client --move --discard-journal");
    out.length = 0;
    expect(await run(["identity", "rename", "work", "client", "--move", "--discard-journal"])).toBe(0);
    expect(out).toEqual(['Discarded the record of the unfinished rename of "work" to "client".']);
    expect(readRenameJournal(realFarmFs, file)).toBeUndefined();
  });

  it("prints the discard as JSON", async () => {
    leaveUnfinishable();
    expect(await run(["identity", "rename", "work", "client", "--move", "--discard-journal", "--json"])).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ action: "removed", kind: "rename-journal", name: "client", value: { from: "work", to: "client" } });
  });

  it("with --discard-journal is a usage error for the same name twice, as without it", async () => {
    const file = leaveUnfinishable();
    expect(await run(["identity", "rename", "work", "work", "--move", "--discard-journal"])).toBe(EXIT_USAGE);
    expect(readRenameJournal(realFarmFs, file)).toBeDefined();
  });

  it("refuses --discard-journal with --dry-run, which would have nothing to preview, and keeps the record", async () => {
    const file = leaveUnfinishable();
    expect(await run(["identity", "rename", "work", "client", "--move", "--discard-journal", "--dry-run"])).toBe(EXIT_USAGE);
    expect(out.join("\n")).toContain("no dry run");
    expect(readRenameJournal(realFarmFs, file)).toBeDefined();
  });

  it("refuses identity remove for a name an unfinished rename holds before asking for confirmation", async () => {
    leaveUnfinishable();
    expect(await run(["identity", "remove", "client"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain("an unfinished rename of identity");
  });
});

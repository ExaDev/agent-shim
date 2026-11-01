import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXIT_FAILURE, EXIT_USAGE } from "./cliError";
import { reportFatalError } from "./cliReport";
import type { CredentialCachePort } from "./credentialCache";
import type { IdentityRenamePorts } from "./identityRename";
import { readRenameJournal, renameJournalFile, writeRenameJournal } from "./identityRenameJournal";
import type { SessionProcess } from "./identitySessions";
import { addIdentity, identityExists, readActiveIdentity, useIdentity } from "./identityStore";
import { createFakeKeychain } from "./keychainTestWorld";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { sameDirectory } from "./realIdentityRename";
import { realFarmFs } from "./realPorts";
import { fakeCommandDeps } from "./test-helpers";
import { claudeCodeKeychainService } from "./usage/signIn";

const NOW_MS = 1_000;
const OWN_PID = 4242;

describe("identity rename", () => {
  let root: string;
  let paths: LayoutPaths;
  let out: string[];
  let warnings: string[];
  let sessions: readonly SessionProcess[];
  const keychain = createFakeKeychain();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-rename-command-test-"));
    paths = buildLayoutPaths(root);
    out = [];
    warnings = [];
    sessions = [];
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
    const cache: CredentialCachePort = { read: () => undefined, write: () => undefined, remove: () => undefined };
    return {
      fs: realFarmFs,
      credentialCache: { port: cache, platform: "darwin" },
      run: keychain.run,
      platform: "darwin",
      home: "/example/home",
      sameDirectory,
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
    expect(await run(["identity", "rename", "work", "client"])).toBe(0);
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
    expect(await run(["identity", "rename", "work", "client", "--dry-run"])).toBe(0);
    expect(out[0]).toBe('Would rename identity "work" to "client":');
    expect(out.at(-1)).toBe("Nothing was changed.");
    expect(identityExists(paths, "work")).toBe(true);
    expect(identityExists(paths, "client")).toBe(false);
    expect(readActiveIdentity(paths)).toBe("work");
    expect(keychain.calls.every((call) => call.args[0] === "find-generic-password" && !call.args.includes("-w"))).toBe(true);
  });

  it("prints the result as JSON, naming a dry run as planned", async () => {
    seed();
    expect(await run(["identity", "rename", "work", "client", "--dry-run", "--json"])).toBe(0);
    const planned = JSON.parse(out.join("\n")) as { action: string; kind: string; name: string; value: { dryRun: boolean; steps: string[] } };
    expect(planned).toMatchObject({ action: "planned", kind: "identity", name: "client", value: { dryRun: true } });
    out.length = 0;
    expect(await run(["identity", "rename", "work", "client", "--json"])).toBe(0);
    const renamed = JSON.parse(out.join("\n")) as typeof planned;
    expect(renamed).toMatchObject({ action: "renamed", name: "client", value: { dryRun: false } });
    expect(renamed.value.steps).toEqual(planned.value.steps);
  });

  it("fails with the blocking session named, exit status 1 and nothing changed", async () => {
    seed();
    sessions = [{ pid: 4711, program: "claude" }];
    expect(await run(["identity", "rename", "work", "client"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain("pid 4711 (claude)");
    expect(identityExists(paths, "work")).toBe(true);
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
    await program.parseAsync(["identity", "rename", "work", "client"], { from: "user" });
    expect(identityExists(paths, "client")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("security delete-generic-password");
  });

  /** Leaves the journal of a rename of `work` to `client` that nothing applied, and removes `work`, so no identity is under either name. */
  function leaveUnfinishable(): string {
    seed();
    const file = renameJournalFile(paths.identityRenamesDir, "work", "client");
    writeRenameJournal(realFarmFs, file, { version: 1, from: "work", to: "client", startedAt: "2026-10-30T10:00:00.000Z", pid: OWN_PID, steps: [{ description: "move identities/work to identities/client", done: false }] });
    fs.rmSync(path.join(paths.identitiesDir, "work"), { recursive: true, force: true });
    return file;
  }

  it("says in its help what --discard-journal does and when it refuses", () => {
    const program = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn(), identityRenamePorts: ports() });
    const rename = program.commands.find((command) => command.name() === "identity")?.commands.find((command) => command.name() === "rename");
    const discard = rename?.options.find((option) => option.long === "--discard-journal")?.description;
    expect(discard).toContain("exists under neither name or under both");
    expect(discard).toContain("changes no identity");
    expect(discard).toContain("exists under only one of them");
  });

  it("with --discard-journal removes the record of a rename nothing can finish, and says so", async () => {
    const file = leaveUnfinishable();
    expect(await run(["identity", "rename", "work", "client"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain("agent-shim identity rename work client --discard-journal");
    out.length = 0;
    expect(await run(["identity", "rename", "work", "client", "--discard-journal"])).toBe(0);
    expect(out).toEqual(['Discarded the record of the unfinished rename of "work" to "client".']);
    expect(readRenameJournal(realFarmFs, file)).toBeUndefined();
  });

  it("prints the discard as JSON", async () => {
    leaveUnfinishable();
    expect(await run(["identity", "rename", "work", "client", "--discard-journal", "--json"])).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ action: "removed", kind: "rename-journal", name: "client", value: { from: "work", to: "client" } });
  });

  it("refuses --discard-journal with --dry-run, which would have nothing to preview, and keeps the record", async () => {
    const file = leaveUnfinishable();
    expect(await run(["identity", "rename", "work", "client", "--discard-journal", "--dry-run"])).toBe(EXIT_USAGE);
    expect(out.join("\n")).toContain("no dry run");
    expect(readRenameJournal(realFarmFs, file)).toBeDefined();
  });

  it("refuses identity remove for a name an unfinished rename holds before asking for confirmation", async () => {
    leaveUnfinishable();
    expect(await run(["identity", "remove", "client"])).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toContain("an unfinished rename of identity");
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvider } from "./providersStore";
import { IdentityAlreadyExistsError, identityIdOf, readIdentity } from "./identityStore";
import { CliError } from "./cliError";
import { describeIdentityMove, moveIdentity, renameIdentity, type IdentityRenamePorts } from "./identityRename";
import { registerLaunch } from "./launcher/launchRecords";
import { realLaunchProbe } from "./realIdentityRename";
import { realFarmFs } from "./realPorts";
import { claudeCodeKeychainService } from "./usage/signIn";
import { NOW_MS, OWN_PID, type World, createWorld, treeOf, writeFile, writeJson } from "./identityRenameTestWorld";

describe("moveIdentity credential file sources held elsewhere", () => {
  let world: World;
  const movedToken = (): string => path.join(world.root, "credentials", "work.token");
  const insideDirectory = (): string => path.join(world.directory("work"), "secrets", "token");

  beforeEach(() => {
    world = createWorld();
    writeJson(path.join(world.directory("personal"), "identity.json"), {
      name: "personal",
      allowAmbientCredential: false,
      credential: { sources: [{ file: movedToken() }, { file: insideDirectory() }, { file: "/example/elsewhere/token" }, { env: "EXAMPLE_TOKEN" }], target: "oauthToken" },
    });
    writeJson(path.join(world.paths.providersDir, "z.json"), {
      displayName: "z.ai",
      baseUrl: "https://api.z.ai/api/anthropic",
      credential: { sources: [{ file: movedToken() }, { env: "Z_API_TOKEN" }] },
    });
    writeJson(path.join(world.paths.providersDir, "router.json"), { kind: "router", displayName: "Router" });
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("re-points another identity's file sources that name the moved token file or sit inside the moved directory, and leaves every other source alone", async () => {
    await moveIdentity(world.paths, "work", "client", world.ports());
    expect(readIdentity(world.paths, "personal")?.credential?.sources).toEqual([
      { file: path.join(world.root, "credentials", "client.token") },
      { file: path.join(world.directory("client"), "secrets", "token") },
      { file: "/example/elsewhere/token" },
      { env: "EXAMPLE_TOKEN" },
    ]);
  });

  it("re-points a provider's file sources the same way, and leaves a provider with no credential alone", async () => {
    await moveIdentity(world.paths, "work", "client", world.ports());
    expect(readProvider(world.paths, "z")).toMatchObject({ credential: { sources: [{ file: path.join(world.root, "credentials", "client.token") }, { env: "Z_API_TOKEN" }] } });
    expect(readProvider(world.paths, "router")).toEqual({ kind: "router", displayName: "Router" });
  });

  it("names those files among the steps, in the dry run and the real run alike", async () => {
    const planned = describeIdentityMove(world.paths, "work", "client", world.ports());
    expect(planned.steps).toContain("rewrite identities/personal/identity.json: credential source");
    expect(planned.steps).toContain("rewrite providers/z.json: credential source");
    expect((await moveIdentity(world.paths, "work", "client", world.ports())).steps).toEqual(planned.steps);
  });

  it("keeps the ~ spelling of a source that was written that way", async () => {
    writeJson(path.join(world.directory("personal"), "identity.json"), { name: "personal", allowAmbientCredential: false, credential: { sources: [{ file: "~/credentials/work.token" }, { file: "~/identities/work/secrets/token" }], target: "oauthToken" } });
    await moveIdentity(world.paths, "work", "client", world.ports({ home: world.root }));
    expect(readIdentity(world.paths, "personal")?.credential?.sources).toEqual([{ file: "~/credentials/client.token" }, { file: "~/identities/client/secrets/token" }]);
  });

  it("refuses, naming the file, when a provider file it cannot read mentions the moved token, and ignores one that does not", async () => {
    writeFile(path.join(world.paths.providersDir, "old-format.json"), `{ "tokenFile": "${movedToken()}" }\n`);
    const before = treeOf(world.root);
    expect(() => describeIdentityMove(world.paths, "work", "client", world.ports())).toThrow(/providers\/old-format\.json/);
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/providers\/old-format\.json/);
    expect(treeOf(world.root)).toEqual(before);
    fs.rmSync(path.join(world.paths.providersDir, "old-format.json"));
    writeFile(path.join(world.paths.providersDir, "unrelated.json"), '{ "tokenFile": "/example/elsewhere/token" }\n');
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).resolves.toBeDefined();
  });
});

describe("moveIdentity with a new name that is the old directory under another spelling", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** Ports whose `sameDirectory` says `alias` is the directory of `work`, as a symlink would make it. A real symlink beside the directory cannot stand in for it here: its `identity.json` is the same file, so the resolver takes the two entries for one identity before any rename guard runs. */
  function aliasing(alias: string): IdentityRenamePorts {
    const base = world.ports();
    return { ...base, sameDirectory: (first, second) => base.sameDirectory(first, second) || [first, second].sort().join("\n") === [world.directory("work"), world.directory(alias)].sort().join("\n") };
  }

  /** Expects a move of work to `alias` to be refused with `message` in the dry run and the real run, with nothing changed. */
  async function expectRefusal(alias: string, ports: IdentityRenamePorts, message: string): Promise<void> {
    const before = treeOf(world.root);
    expect(() => describeIdentityMove(world.paths, "work", alias, ports)).toThrow(message);
    await expect(moveIdentity(world.paths, "work", alias, ports)).rejects.toThrow(message);
    expect(treeOf(world.root)).toEqual(before);
  }

  it("is refused in the dry run and the real run when work-alias is a link to the directory of work, saying to remove the link or choose another name", async () => {
    await expectRefusal("work-alias", aliasing("work-alias"), '"work-alias" is a link to the directory of "work" (identities/work-alias), so --move cannot move onto it; remove the link or choose another name.');
  });

  it("is refused for Work on every filesystem, saying a filesystem that ignores case makes the two one directory and to rename without --move, which does change the case of a used identity", async () => {
    await expectRefusal(
      "Work",
      world.ports({ sameDirectory: () => false }),
      '"work" and "Work" differ only in case, which a filesystem that ignores case makes one directory, so --move cannot change the case. Rename without --move, which changes the name, case included, and leaves the directory: agent-shim identity rename work Work',
    );
    // The advice holds for an identity with requests in the usage log, which a route through a temporary id would leave stuck under that id.
    writeFile(path.join(world.paths.usageLogDir, `${new Date().toISOString().slice(0, "YYYY-MM-DD".length)}.1.jsonl`), `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), identity: "work", provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`);
    await renameIdentity(world.paths, "work", "Work", world.ports());
    expect(identityIdOf(world.paths, "Work")).toBe("work");
  });

  it("goes through a temporary name for an identity with no requests in the usage log, and is refused at the second move for one with them", async () => {
    await moveIdentity(world.paths, "work", "work-tmp", world.ports());
    await moveIdentity(world.paths, "work-tmp", "Work", world.ports());
    expect(identityIdOf(world.paths, "Work")).toBe("Work");
    writeFile(path.join(world.paths.usageLogDir, `${new Date().toISOString().slice(0, "YYYY-MM-DD".length)}.1.jsonl`), `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), identity: "Work", provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`);
    await moveIdentity(world.paths, "Work", "Work-tmp", world.ports());
    await expect(moveIdentity(world.paths, "Work-tmp", "work", world.ports())).rejects.toThrow('"work" is already in use: the usage log holds requests filed under "Work".');
  });

  it("is still refused as already existing when the other identity is a different directory", async () => {
    await expect(moveIdentity(world.paths, "work", "personal", world.ports())).rejects.toThrow(IdentityAlreadyExistsError);
  });
});

describe("moveIdentity and the usage records of the current five-hour window", () => {
  let world: World;
  const NOW = Date.parse("2026-10-30T12:00:00.000Z");
  const HOUR_MS = 3_600_000;
  const OUTSIDE_WINDOW_HOURS_AGO = 6;
  const ports = (): IdentityRenamePorts => world.ports({ lock: { nowMs: () => NOW, pid: OWN_PID, isRunning: () => true, sleep: () => undefined } });
  const NOTE = 'Usage already logged for "work" in the last five hours stays filed under that id: the usage log is appended to by the running front door, so it is not rewritten. Until those hours pass, pool ranking has no burn rate or five-hour to seven-day ratio for "client" from them. Its quota windows come from its snapshot, which moved, and are unaffected.';

  /** One logged request, as the front door writes it. */
  const record = (identity: string, hoursAgo: number, provider = "anthropic"): string =>
    JSON.stringify({ schemaVersion: 1, at: new Date(NOW - hoursAgo * HOUR_MS).toISOString(), identity, provider, route: "anthropic", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 2, outcome: "completed" });
  const log = (...lines: readonly string[]): void => {
    writeFile(path.join(world.paths.usageLogDir, "2026-10-30.77.jsonl"), `${lines.join("\n")}\n`);
  };

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("is told in the dry run and the real run that those records keep the old name, since the log is not rewritten", async () => {
    log(record("work", 2), record("personal", 1));
    const planned = describeIdentityMove(world.paths, "work", "client", ports());
    expect(planned.warnings).toEqual([NOTE]);
    expect((await moveIdentity(world.paths, "work", "client", ports())).warnings).toEqual([NOTE]);
    expect(fs.readFileSync(path.join(world.paths.usageLogDir, "2026-10-30.77.jsonl"), "utf8")).toContain('"identity":"work"');
  });

  it("says nothing when the identity has no record in the window: an older one, another identity's, or another provider's", async () => {
    log(record("work", OUTSIDE_WINDOW_HOURS_AGO), record("personal", 1), record("work", 1, "z"));
    expect(describeIdentityMove(world.paths, "work", "client", ports()).warnings).toEqual([]);
    expect((await moveIdentity(world.paths, "work", "client", ports())).warnings).toEqual([]);
  });
});

describe("moveIdentity against the launch records a launcher writes", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("refuses while a running launcher's record names the identity, and goes ahead once the launcher has removed it", async () => {
    const ports = world.ports({ launches: realLaunchProbe(world.paths) });
    const remove = registerLaunch(realFarmFs, world.paths.launchesDir, { pid: process.pid, identity: "work", startedAtMs: NOW_MS }, () => true);
    await expect(moveIdentity(world.paths, "work", "client", ports)).rejects.toThrow(/agent-shim launch/);
    expect(fs.existsSync(world.directory("work"))).toBe(true);
    remove();
    await moveIdentity(world.paths, "work", "client", ports);
    expect(fs.existsSync(world.directory("client"))).toBe(true);
  });

  it("ignores the record of a launcher that is no longer running, as one that crashed leaves", async () => {
    const deadPid = 2_147_483_646;
    registerLaunch(realFarmFs, world.paths.launchesDir, { pid: deadPid, identity: "work", startedAtMs: NOW_MS }, () => true);
    await moveIdentity(world.paths, "work", "client", world.ports({ launches: realLaunchProbe(world.paths) }));
    expect(fs.existsSync(world.directory("client"))).toBe(true);
  });
});

describe("moveIdentity and a signal to stop", () => {
  let world: World;
  const SIGINT_STATUS = 130;
  const SIGTERM_STATUS = 143;
  const SIGHUP_STATUS = 129;

  beforeEach(() => {
    world = createWorld("darwin");
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** A filesystem that sends the process `signal` once, just after the first directory move. */
  function signalAfterFirstMove(signal: NodeJS.Signals) {
    let sent = false;
    return {
      ...realFarmFs,
      rename: (from: string, to: string): void => {
        realFarmFs.rename(from, to);
        if (!sent) {
          sent = true;
          world.interrupt(signal);
        }
      },
    };
  }

  it("ends with the shell's status for the signal when the journal could not be updated as the steps rolled back, since the rename was still rolled back", async () => {
    // The journal is written once after the step the signal arrived in, and its next write is the first of the rollback, which is the one that fails.
    let writesSinceSignal: number | undefined;
    const sending = signalAfterFirstMove("SIGINT");
    const journalFull = {
      ...sending,
      rename: (from: string, to: string): void => {
        sending.rename(from, to);
        writesSinceSignal ??= 0;
      },
      writeFilePrivate: (file: string, contents: string): void => {
        if (writesSinceSignal !== undefined && file.startsWith(world.paths.identityRenamesDir)) {
          writesSinceSignal += 1;
          if (writesSinceSignal > 1) {
            throw new Error("no space left on device");
          }
        }
        realFarmFs.writeFilePrivate(file, contents);
      },
    };
    const failure: unknown = await moveIdentity(world.paths, "work", "client", world.ports({ fs: journalFull })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ exitCode: SIGINT_STATUS });
    expect(failure instanceof Error ? failure.message : "").toContain("Interrupted by SIGINT");
    expect(failure instanceof Error ? failure.message : "").toContain("no space left on device");
    // The interruption's own message already says the rename was rolled back, so it is not said a second time.
    expect(failure instanceof Error ? failure.message : "").not.toContain("This run's rollback is complete");
  });

  it("ends with the shell's status for the signal when the journal then cannot be removed, and says so beside the interruption", async () => {
    const sending = signalAfterFirstMove("SIGTERM");
    const journalStuck = {
      ...sending,
      removeRecursive: (target: string): void => {
        if (target.startsWith(world.paths.identityRenamesDir)) {
          throw new Error("EACCES: permission denied");
        }
        realFarmFs.removeRecursive(target);
      },
    };
    const failure: unknown = await moveIdentity(world.paths, "work", "client", world.ports({ fs: journalStuck })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ exitCode: SIGTERM_STATUS });
    expect(failure instanceof Error ? failure.message : "").toContain("Interrupted by SIGTERM");
    expect(failure instanceof Error ? failure.message : "").toContain("could not be removed");
    expect(failure instanceof Error ? failure.message : "").toContain("EACCES: permission denied");
  });

  it("rolls every step back, the Keychain copy included, and ends with the shell's status for SIGINT, when the signal arrives between steps", async () => {
    const before = treeOf(world.root);
    await expect(moveIdentity(world.paths, "work", "client", world.ports({ fs: signalAfterFirstMove("SIGINT") }))).rejects.toMatchObject({ exitCode: SIGINT_STATUS, message: "Interrupted by SIGINT: the rename was rolled back and nothing was changed." });
    expect(treeOf(world.root)).toEqual(before);
    expect(world.keychain.items.has(claudeCodeKeychainService(world.directory("client")))).toBe(false);
    expect(world.keychain.items.has(claudeCodeKeychainService(world.directory("work")))).toBe(true);
    expect(world.cache.get("file:identity work")?.token).toBe("a-made-up-cached-token");
  });

  it("rolls every step back and ends with the shell's status for SIGHUP, which a closed terminal sends", async () => {
    const before = treeOf(world.root);
    await expect(moveIdentity(world.paths, "work", "client", world.ports({ fs: signalAfterFirstMove("SIGHUP") }))).rejects.toMatchObject({ exitCode: SIGHUP_STATUS, message: "Interrupted by SIGHUP: the rename was rolled back and nothing was changed." });
    expect(treeOf(world.root)).toEqual(before);
    expect(world.keychain.items.has(claudeCodeKeychainService(world.directory("client")))).toBe(false);
  });

  it("ends with the shell's status for SIGTERM when that is the signal", async () => {
    await expect(moveIdentity(world.paths, "work", "client", world.ports({ fs: signalAfterFirstMove("SIGTERM") }))).rejects.toMatchObject({ exitCode: SIGTERM_STATUS });
  });

  it("removes its signal handlers whether the rename finishes, fails or is interrupted", async () => {
    await moveIdentity(world.paths, "work", "client", world.ports());
    expect(world.handlers()).toBe(0);
    world = createWorld("darwin");
    await expect(moveIdentity(world.paths, "work", "client", world.ports({ fs: signalAfterFirstMove("SIGINT") }))).rejects.toThrow();
    expect(world.handlers()).toBe(0);
    const failing = { ...realFarmFs, rename: () => { throw new Error("disk full"); } };
    await expect(moveIdentity(world.paths, "work", "client", world.ports({ fs: failing }))).rejects.toThrow(/disk full/);
    expect(world.handlers()).toBe(0);
  });

  it("lets the rename finish when the signal arrives during its last step, since there is nothing left to undo", async () => {
    const last = {
      ...realFarmFs,
      writeFilePrivate: (file: string, contents: string): void => {
        realFarmFs.writeFilePrivate(file, contents);
        if (file === world.paths.usageAnchorsFile) {
          world.interrupt("SIGINT");
        }
      },
    };
    await moveIdentity(world.paths, "work", "client", world.ports({ fs: last }));
    expect(fs.existsSync(world.directory("client"))).toBe(true);
    expect(fs.existsSync(world.directory("work"))).toBe(false);
  });

  it("hears a signal that arrived while the login was being read, and takes no lock", async () => {
    const taken: string[] = [];
    const watching = {
      ...realFarmFs,
      writeFileExclusive: (file: string, contents: string): boolean => {
        taken.push(path.basename(file));
        return realFarmFs.writeFileExclusive(file, contents);
      },
    };
    const run = {
      run: (command: string, args: readonly string[], input?: string) => {
        if (args.includes("-g")) {
          world.interrupt("SIGINT");
        }
        return world.keychain.run.run(command, args, input);
      },
    };
    await expect(moveIdentity(world.paths, "work", "client", world.ports({ fs: watching, run }))).rejects.toMatchObject({ exitCode: SIGINT_STATUS });
    expect(taken).toEqual([]);
    expect(world.keychain.items.has(claudeCodeKeychainService(world.directory("client")))).toBe(false);
  });

  /** A `security` that dies when the signal reaches it, as the terminal's whole foreground group does on Ctrl-C: it returns no status, and the process's own handler for the signal runs only once the event loop has turned. */
  function killedWhileReading(signal: NodeJS.Signals | undefined) {
    return {
      run: (command: string, args: readonly string[], input?: string) => {
        if (!args.includes("-g")) {
          return world.keychain.run.run(command, args, input);
        }
        if (signal !== undefined) {
          setImmediate(() => {
            world.interrupt(signal);
          });
        }
        return { status: null, stdout: "", stderr: "" };
      },
    };
  }

  /** The signal port as the real one behaves: a signal sent during synchronous work is delivered after two turns of the loop. */
  function realisticTurns() {
    return {
      onInterrupt: world.ports().signals.onInterrupt,
      turn: async (): Promise<void> => {
        await new Promise<void>((resolve) => {
          setImmediate(() => {
            setImmediate(resolve);
          });
        });
      },
    };
  }

  it.each([
    ["SIGINT", SIGINT_STATUS],
    ["SIGTERM", SIGTERM_STATUS],
    ["SIGHUP", SIGHUP_STATUS],
  ] as const)("ends with the status of %s, not as a Keychain failure, when it killed the login read", async (signal, status) => {
    const before = treeOf(world.root);
    await expect(moveIdentity(world.paths, "work", "client", world.ports({ run: killedWhileReading(signal), signals: realisticTurns() }))).rejects.toMatchObject({ exitCode: status, message: expect.stringContaining(`Interrupted by ${signal}`) as unknown });
    expect(treeOf(world.root)).toEqual(before);
    expect(world.handlers()).toBe(0);
  });

  it("still reports a login read that ended with no status and no signal as a Keychain failure", async () => {
    await expect(moveIdentity(world.paths, "work", "client", world.ports({ run: killedWhileReading(undefined), signals: realisticTurns() }))).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining("without a status") as unknown });
  });
});

describe("moveIdentity locking", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** Renames and returns the lock files taken, in the order they were created. */
  async function lockOrder(from: string, to: string): Promise<string[]> {
    const taken: string[] = [];
    const recording = {
      ...realFarmFs,
      writeFileExclusive: (file: string, contents: string): boolean => {
        taken.push(path.basename(file));
        return realFarmFs.writeFileExclusive(file, contents);
      },
    };
    await moveIdentity(world.paths, from, to, world.ports({ fs: recording }));
    return taken;
  }

  it("refreshes the locks it holds between steps, so a rename held up for longer than the staleness window is not taken for a crashed one", async () => {
    const STEP_MS = 50_000;
    let now = NOW_MS;
    const heldSince: number[] = [];
    const timed = {
      ...realFarmFs,
      rename: (from: string, to: string): void => {
        now += STEP_MS;
        realFarmFs.rename(from, to);
      },
      writeFilePrivate: (file: string, contents: string): void => {
        if (file === world.paths.usageAnchorsFile) {
          const lock: unknown = JSON.parse(fs.readFileSync(path.join(world.root, "identities", ".client.lock"), "utf8"));
          heldSince.push(typeof lock === "object" && lock !== null && "acquiredAtMs" in lock && typeof lock.acquiredAtMs === "number" ? lock.acquiredAtMs : -1);
        }
        realFarmFs.writeFilePrivate(file, contents);
      },
    };
    await moveIdentity(world.paths, "work", "client", world.ports({ fs: timed, lock: { nowMs: () => now, pid: OWN_PID, isRunning: () => true, sleep: () => undefined } }));
    expect(heldSince).toHaveLength(1);
    expect(heldSince[0]).toBeGreaterThan(NOW_MS + STEP_MS);
  });

  it("fails and rolls back when a lock it holds has been taken over, because nothing it guards can be assumed unchanged", async () => {
    const before = treeOf(world.root);
    const takingOver = {
      ...realFarmFs,
      rename: (from: string, to: string): void => {
        realFarmFs.rename(from, to);
        fs.writeFileSync(path.join(world.root, "identities", ".client.lock"), `${JSON.stringify({ identity: "client", pid: 1, token: "someone-else", acquiredAtMs: NOW_MS })}\n`);
      },
    };
    await expect(moveIdentity(world.paths, "work", "client", world.ports({ fs: takingOver }))).rejects.toThrow(/taken over/);
    fs.rmSync(path.join(world.root, "identities", ".client.lock"), { force: true });
    expect(treeOf(world.root)).toEqual(before);
  });

  it("takes the identity names lock first and then the two resync locks in name order whichever way round the names are given, so two opposite renames cannot each hold one and wait for the other", async () => {
    expect(await lockOrder("work", "client")).toEqual([".identity-names.lock", ".client.lock", ".work.lock"]);
    expect(await lockOrder("client", "work")).toEqual([".identity-names.lock", ".client.lock", ".work.lock"]);
  });
});

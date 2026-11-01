import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityInUseError, renameIdentity } from "./identityRename";
import type { CredentialCachePort } from "./credentialCache";
import { realFarmFs } from "./realPorts";
import { claudeCodeKeychainService } from "./usage/signIn";
import { LOGIN_SECRET, type World, createWorld, treeOf } from "./identityRenameTestWorld";

describe("renameIdentity with a macOS Keychain login", () => {
  let world: World;
  const oldService = (): string => claudeCodeKeychainService(world.directory("work"));
  const newService = (): string => claudeCodeKeychainService(world.directory("client"));

  beforeEach(() => {
    world = createWorld("darwin");
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("carries the login to the service derived from the new directory and removes the old item last", async () => {
    const oldKey = oldService();
    const newKey = newService();
    const report = await renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.keychain.items.get(newKey)?.account).toBe("alex");
    expect(world.keychain.secretOf(newKey)?.toString("utf8")).toBe(LOGIN_SECRET);
    expect(world.keychain.items.has(oldKey)).toBe(false);
    expect(report.steps[0]).toBe(`copy the Keychain login "${oldKey}" to "${newKey}"`);
    expect(report.steps.at(-1)).toBe(`delete the former Keychain login "${oldKey}"`);
  });

  it("never exposes the login in an argument list, a step, a warning or a thrown error", async () => {
    const report = await renameIdentity(world.paths, "work", "client", world.ports());
    const exposed = world.keychain.calls.map((call) => [call.command, ...call.args].join(" ")).join("\n");
    expect(exposed).not.toContain("made-up-value-for-the-rename-test");
    expect(exposed).not.toContain(Buffer.from(LOGIN_SECRET).toString("hex"));
    expect(JSON.stringify(report)).not.toContain("made-up-value-for-the-rename-test");
  });

  it("deletes the old item only after the new one has been looked up and found", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    const calls = world.keychain.calls.map((call) => `${call.args[0] ?? ""} ${call.args.includes(newService()) ? "new" : call.args.includes(oldService()) ? "old" : ""}`.trim());
    const deleteOld = calls.lastIndexOf("delete-generic-password old");
    const lookupNew = calls.lastIndexOf("find-generic-password new");
    expect(deleteOld).toBeGreaterThan(-1);
    expect(lookupNew).toBeGreaterThan(-1);
    expect(lookupNew).toBeLessThan(deleteOld);
    expect(calls.slice(deleteOld + 1)).toEqual([]);
  });

  it("reads the login and the cached credential, which can wait on a person, once and before taking any lock", async () => {
    const events: string[] = [];
    const recording = {
      ...realFarmFs,
      writeFileExclusive: (file: string, contents: string): boolean => {
        events.push("lock");
        return realFarmFs.writeFileExclusive(file, contents);
      },
    };
    const run = {
      run: (command: string, args: readonly string[], input?: string) => {
        if (args.includes("-g")) {
          events.push("read the login");
        }
        return world.keychain.run.run(command, args, input);
      },
    };
    const cachePort: CredentialCachePort = {
      read: (store, owner) => {
        events.push("read the cache");
        return world.cache.get(`${store}:${owner}`);
      },
      write: (store, owner, entry) => {
        world.cache.set(`${store}:${owner}`, entry);
      },
      remove: (store, owner) => {
        world.cache.delete(`${store}:${owner}`);
      },
    };
    await renameIdentity(world.paths, "work", "client", world.ports({ fs: recording, run, credentialCache: { port: cachePort, platform: "linux" } }));
    expect(events.filter((event) => event === "read the login")).toHaveLength(1);
    expect(events.filter((event) => event === "read the cache")).toHaveLength(1);
    expect(events.indexOf("lock")).toBeGreaterThan(events.indexOf("read the login"));
    expect(events.indexOf("lock")).toBeGreaterThan(events.indexOf("read the cache"));
  });

  it("asks for neither when a session is running, since it is going to refuse", async () => {
    world.sessions.set(world.directory("work"), [{ pid: 4711, program: "claude" }]);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(IdentityInUseError);
    expect(world.keychain.calls.some((call) => call.args.includes("-g"))).toBe(false);
  });

  it("keeps the old login and the old name when the new item cannot be created", async () => {
    world.keychain.failNextAdd(1);
    const before = treeOf(world.root);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/Could not create the login/);
    expect(treeOf(world.root)).toEqual(before);
    expect(world.keychain.items.has(oldService())).toBe(true);
    expect(world.keychain.items.has(newService())).toBe(false);
  });

  it("removes the new item and keeps the old one when a later step fails", async () => {
    const before = treeOf(world.root);
    const failing = {
      ...realFarmFs,
      writeFilePrivate: (file: string, contents: string): void => {
        if (file === world.paths.usageAnchorsFile) {
          throw new Error("disk full");
        }
        realFarmFs.writeFilePrivate(file, contents);
      },
    };
    await expect(renameIdentity(world.paths, "work", "client", world.ports({ fs: failing }))).rejects.toThrow(/disk full/);
    expect(treeOf(world.root)).toEqual(before);
    expect(world.keychain.items.has(oldService())).toBe(true);
    expect(world.keychain.items.has(newService())).toBe(false);
  });

  it("refuses when a login is already filed under the new directory, without touching either", async () => {
    world.keychain.seed(newService(), "alex", "left over");
    const before = treeOf(world.root);
    await expect(renameIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(/already holds a login/);
    expect(treeOf(world.root)).toEqual(before);
    expect(world.keychain.secretOf(newService())?.toString("utf8")).toBe("left over");
  });

  it("copies nothing for an identity with no login in the Keychain", async () => {
    world.keychain.items.delete(oldService());
    const report = await renameIdentity(world.paths, "work", "client", world.ports());
    expect(report.steps.some((step) => step.includes("Keychain"))).toBe(false);
    expect(world.keychain.calls.some((call) => call.args[0] === "-i" || call.args[0] === "delete-generic-password")).toBe(false);
  });

  it("warns, rather than undoing a finished rename, when the old item cannot be deleted", async () => {
    const original = world.keychain.run;
    const stubborn = {
      run: (command: string, args: readonly string[], input?: string) => (args[0] === "delete-generic-password" && args.includes(oldService()) ? { status: 1, stdout: "", stderr: "denied" } : original.run(command, args, input)),
    };
    const report = await renameIdentity(world.paths, "work", "client", world.ports({ run: stubborn }));
    expect(fs.existsSync(world.directory("client"))).toBe(true);
    expect(world.keychain.items.has(newService())).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain(`security delete-generic-password -s "${oldService()}"`);
  });
});

describe("renameIdentity off macOS", () => {
  it("never calls security: the credentials file moves with the directory", async () => {
    const world = createWorld("linux");
    try {
      await renameIdentity(world.paths, "work", "client", world.ports());
      expect(world.keychain.calls).toEqual([]);
      expect(fs.readFileSync(path.join(world.directory("client"), ".credentials.json"), "utf8")).toBe("{}\n");
    } finally {
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { describeIdentityMove, moveIdentity } from "./identityRename";
import { createWorld, treeOf, writeJson, type World } from "./identityRenameTestWorld";
import { claudeCodeKeychainService } from "./usage/signIn";

/** A service name of the shape Claude Code files a login under, for a directory that is not the one being moved. */
const OTHER_SERVICE = "Claude Code-credentials-ffffffff";

describe("a file that holds credential sources and cannot be re-pointed", () => {
  let world: World;
  const oldService = (): string => claudeCodeKeychainService(world.directory("work"));
  const providerFile = (name: string): string => path.join(world.paths.providersDir, `${name}.json`);

  beforeEach(() => {
    world = createWorld("darwin");
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** A provider that parses as JSON and fails the schema (`baseUrl` is a number), holding the sources given. */
  function writeInvalidProvider(name: string, sources: readonly unknown[]): void {
    writeJson(providerFile(name), { displayName: "z.ai", baseUrl: 42, credential: { sources } });
  }

  async function refusedEverywhere(file: string): Promise<void> {
    const before = treeOf(world.root);
    expect(() => describeIdentityMove(world.paths, "work", "client", world.ports())).toThrow(file);
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(file);
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.toBeInstanceOf(CliError);
    expect(treeOf(world.root)).toEqual(before);
  }

  describe("that fails the schema", () => {
    it("refuses a provider whose keychain source is on the moved login's service, since the rename deletes that login and the source could not follow it", async () => {
      writeInvalidProvider("z", [{ keychain: { service: oldService() } }]);
      await refusedEverywhere("providers/z.json");
    });

    it("refuses an identity file the same way", async () => {
      writeJson(`${world.directory("personal")}/identity.json`, { name: "personal", allowAmbientCredential: "yes", credential: { sources: [{ keychain: { service: oldService() } }], target: "oauthToken" } });
      await refusedEverywhere("identities/personal/identity.json");
    });

    it("leaves a rename alone when the invalid file names a keychain service that is not the moved login's", async () => {
      writeInvalidProvider("z", [{ keychain: { service: OTHER_SERVICE } }, { env: "Z_API_TOKEN" }]);
      await expect(moveIdentity(world.paths, "work", "client", world.ports())).resolves.toBeDefined();
      expect(fs.existsSync(world.directory("client"))).toBe(true);
    });
  });

  describe("that is not JSON", () => {
    it("does not stop a rename of an identity it has nothing to do with, and is left as it was", async () => {
      fs.mkdirSync(world.paths.providersDir, { recursive: true });
      fs.writeFileSync(providerFile("garbled"), "{ not json");
      expect(() => describeIdentityMove(world.paths, "work", "client", world.ports())).not.toThrow();
      await expect(moveIdentity(world.paths, "work", "client", world.ports())).resolves.toBeDefined();
      expect(fs.readFileSync(providerFile("garbled"), "utf8")).toBe("{ not json");
    });

    it("refuses with a message, not a stack trace, when its text names a path the rename moves", async () => {
      fs.mkdirSync(world.paths.providersDir, { recursive: true });
      fs.writeFileSync(providerFile("garbled"), `{ "credential": { "sources": [{ "file": "${path.join(world.root, "credentials", "work.token")}" `);
      await refusedEverywhere("providers/garbled.json");
      await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.not.toBeInstanceOf(SyntaxError);
    });

    it("refuses when its text names the moved login's service", async () => {
      fs.mkdirSync(world.paths.providersDir, { recursive: true });
      fs.writeFileSync(providerFile("garbled"), `{ "credential": { "sources": [{ "keychain": { "service": "${oldService()}" `);
      await refusedEverywhere("providers/garbled.json");
    });

    it("says nothing of the file's text in the refusal", async () => {
      fs.mkdirSync(world.paths.providersDir, { recursive: true });
      fs.writeFileSync(providerFile("garbled"), `made-up-secret-text ${oldService()}`);
      const failure: unknown = await moveIdentity(world.paths, "work", "client", world.ports()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CliError);
      expect(failure instanceof Error ? failure.message : "").not.toContain("made-up-secret-text");
    });
  });
});

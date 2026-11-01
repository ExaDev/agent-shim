import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeIdentityRename, renameIdentity } from "./identityRename";
import { LOGIN_SECRET, createWorld, treeOf, writeJson, type World } from "./identityRenameTestWorld";
import { readIdentity } from "./identityStore";
import { readProvider } from "./providersStore";
import { claudeCodeKeychainService } from "./usage/signIn";

/** A service name of the shape Claude Code files a login under, for a directory that is not the one being moved. */
const OTHER_SERVICE = "Claude Code-credentials-ffffffff";

describe("credential sources that name the moved login or path, held by other identities and providers", () => {
  let world: World;
  const oldService = (): string => claudeCodeKeychainService(world.directory("work"));
  const newService = (): string => claudeCodeKeychainService(world.directory("client"));

  beforeEach(() => {
    world = createWorld("darwin");
    writeJson(`${world.directory("personal")}/identity.json`, {
      name: "personal",
      allowAmbientCredential: false,
      credential: {
        sources: [
          { keychain: { service: oldService(), account: "alex" } },
          { keychain: { service: OTHER_SERVICE } },
          { command: ["cat", `${world.directory("work")}/secrets/token`] },
          { command: ["cat", "/example/elsewhere/token"] },
          { op: "op://Example/work/token" },
        ],
        target: "oauthToken",
      },
    });
    writeJson(`${world.paths.providersDir}/z.json`, {
      displayName: "z.ai",
      baseUrl: "https://api.z.ai/api/anthropic",
      credential: { sources: [{ keychain: { service: oldService() } }, { op: `op://${world.directory("work")}/token` }, { env: "Z_API_TOKEN" }] },
    });
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  const commandNote = 'Identity "personal" has a command credential source that names a path this rename moves, which it cannot update. Change it by hand once the rename is done.';
  const opNote = 'Provider "z" has an op credential source that names a path this rename moves, which it cannot update. Change it by hand once the rename is done.';

  it("re-points a keychain source naming exactly the old directory's login service, in another identity and in a provider, and leaves any other service alone", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(readIdentity(world.paths, "personal")?.credential?.sources.slice(0, 2)).toEqual([{ keychain: { service: newService(), account: "alex" } }, { keychain: { service: OTHER_SERVICE } }]);
    expect(readProvider(world.paths, "z")).toMatchObject({ credential: { sources: [{ keychain: { service: newService() } }, { op: `op://${world.directory("work")}/token` }, { env: "Z_API_TOKEN" }] } });
  });

  it("re-points one in the renamed identity's own block too", async () => {
    writeJson(`${world.directory("work")}/identity.json`, { name: "work", allowAmbientCredential: false, credential: { sources: [{ keychain: { service: oldService() } }], target: "oauthToken" } });
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(readIdentity(world.paths, "client")?.credential?.sources).toEqual([{ keychain: { service: newService() } }]);
  });

  it("deletes the old item only with every source that named it moved, so what they name afterwards exists", async () => {
    await renameIdentity(world.paths, "work", "client", world.ports());
    expect(world.keychain.items.has(oldService())).toBe(false);
    expect(world.keychain.secretOf(newService())?.toString("utf8")).toBe(LOGIN_SECRET);
    expect(readIdentity(world.paths, "personal")?.credential?.sources[0]).toEqual({ keychain: { service: newService(), account: "alex" } });
  });

  it("names the steps that rewrite them, in the dry run and the real run alike", async () => {
    const planned = describeIdentityRename(world.paths, "work", "client", world.ports());
    expect(planned.steps).toContain("rewrite identities/personal/identity.json: credential source");
    expect(planned.steps).toContain("rewrite providers/z.json: credential source");
    expect((await renameIdentity(world.paths, "work", "client", world.ports())).steps).toEqual(planned.steps);
  });

  it("says in the dry run and the real run which command and op sources name a path it moves, without printing the arguments, and leaves them as they are", async () => {
    const before = treeOf(world.root);
    const planned = describeIdentityRename(world.paths, "work", "client", world.ports());
    expect(planned.warnings).toEqual([commandNote, opNote]);
    expect(treeOf(world.root)).toEqual(before);
    const done = await renameIdentity(world.paths, "work", "client", world.ports());
    expect(done.warnings).toEqual([commandNote, opNote]);
    expect(JSON.stringify(done)).not.toContain("secrets/token");
    expect(readIdentity(world.paths, "personal")?.credential?.sources[2]).toEqual({ command: ["cat", `${world.directory("work")}/secrets/token`] });
  });

  it("does not take the directory of another identity whose name starts with this one's for the moved path", () => {
    writeJson(`${world.directory("personal")}/identity.json`, {
      name: "personal",
      allowAmbientCredential: false,
      credential: { sources: [{ command: ["cat", `${world.directory("work")}-two/secrets/token`] }], target: "oauthToken" },
    });
    writeJson(`${world.paths.providersDir}/z.json`, { displayName: "z.ai", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }] } });
    expect(describeIdentityRename(world.paths, "work", "client", world.ports()).warnings).toEqual([]);
  });

  it("says nothing about a command or op source that names no path it moves", () => {
    writeJson(`${world.directory("personal")}/identity.json`, { name: "personal", allowAmbientCredential: false, credential: { sources: [{ command: ["cat", "/example/elsewhere/token"] }, { op: "op://Example/work/token" }], target: "oauthToken" } });
    writeJson(`${world.paths.providersDir}/z.json`, { displayName: "z.ai", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }] } });
    expect(describeIdentityRename(world.paths, "work", "client", world.ports()).warnings).toEqual([]);
  });
});

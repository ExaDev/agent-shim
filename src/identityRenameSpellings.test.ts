import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { describeIdentityRename, renameIdentity } from "./identityRename";
import { createWorld, treeOf, writeJson, type World } from "./identityRenameTestWorld";
import { readIdentity } from "./identityStore";
import { buildLayoutPaths } from "./paths";

const COMMAND_NOTE = 'Identity "personal" has a command credential source that names a path or the Keychain login this rename moves, which it cannot update. Change it by hand once the rename is done.';

describe("the spellings of a moved path that a command source or an unreadable file can use", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** Gives `personal` one command source and no provider anything to do with the rename. */
  function commandSource(...command: readonly string[]): void {
    writeJson(`${world.directory("personal")}/identity.json`, { name: "personal", allowAmbientCredential: false, credential: { sources: [{ command: [...command] }], target: "oauthToken" } });
  }

  /** The warnings of a dry run and of the real run, which must agree, with `home` as the home directory. */
  async function warningsWithHome(home: string): Promise<readonly string[]> {
    const planned = describeIdentityRename(world.paths, "work", "client", world.ports({ home })).warnings;
    const done = await renameIdentity(world.paths, "work", "client", world.ports({ home }));
    expect(done.warnings).toEqual(planned);
    return planned;
  }

  describe("under the home directory", () => {
    it.each([
      ["$HOME", 'cat "$HOME/identities/work/secrets/token"'],
      ["${HOME}", 'cat "${HOME}/identities/work/secrets/token"'],
      ["~", "cat ~/identities/work/secrets/token"],
      ["$HOME for the token file", "cat $HOME/credentials/work.token"],
      ["${HOME} for the token file", "cat ${HOME}/credentials/work.token"],
    ])("warns of a command source that names it as %s", async (_spelling, script) => {
      commandSource("sh", "-c", script);
      expect(await warningsWithHome(world.root)).toEqual([COMMAND_NOTE]);
    });

    it("does not take the directory of an identity whose name starts with this one's for it", async () => {
      commandSource("sh", "-c", 'cat "$HOME/identities/work-two/secrets/token"');
      expect(await warningsWithHome(world.root)).toEqual([]);
    });

    it("does not take $HOME for the moved path when the home directory is somewhere else", async () => {
      commandSource("sh", "-c", 'cat "$HOME/identities/work/secrets/token"');
      expect(await warningsWithHome("/example/home")).toEqual([]);
    });

    it("refuses a file it cannot read whose text names it as $HOME or ${HOME}, and says nothing of the text", async () => {
      fs.mkdirSync(world.paths.providersDir, { recursive: true });
      for (const spelled of ['$HOME/credentials/work.token', '${HOME}/identities/work/secrets/token']) {
        fs.writeFileSync(path.join(world.paths.providersDir, "garbled.json"), `{ "credential": "${spelled}" madeupsecretvalue`);
        const before = treeOf(world.root);
        const failure: unknown = await renameIdentity(world.paths, "work", "client", world.ports({ home: world.root })).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(CliError);
        expect(failure instanceof Error ? failure.message : "").toContain("providers/garbled.json");
        expect(failure instanceof Error ? failure.message : "").not.toContain("madeup");
        expect(treeOf(world.root)).toEqual(before);
      }
    });
  });

  describe("through a symlink above the state root", () => {
    let linkParent: string;
    let linkedPaths: ReturnType<typeof buildLayoutPaths>;
    let realRoot: string;

    beforeEach(() => {
      linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "identity-rename-link-"));
      fs.symlinkSync(world.root, path.join(linkParent, "root-link"));
      linkedPaths = buildLayoutPaths(path.join(linkParent, "root-link"));
      realRoot = fs.realpathSync(world.root);
    });

    afterEach(() => {
      fs.rmSync(linkParent, { recursive: true, force: true });
    });

    it("warns of a command source that names the moved directory by its real path", async () => {
      commandSource("cat", `${realRoot}/identities/work/secrets/token`);
      expect(describeIdentityRename(linkedPaths, "work", "client", world.ports()).warnings).toEqual([COMMAND_NOTE]);
      expect((await renameIdentity(linkedPaths, "work", "client", world.ports())).warnings).toEqual([COMMAND_NOTE]);
    });

    it("warns of a command source that names the moved token file by its real path", () => {
      commandSource("cat", `${realRoot}/credentials/work.token`);
      expect(describeIdentityRename(linkedPaths, "work", "client", world.ports()).warnings).toEqual([COMMAND_NOTE]);
    });

    it("re-points a file source that names the token file by its real path, to the new name under the same spelling", async () => {
      writeJson(`${world.directory("personal")}/identity.json`, {
        name: "personal",
        allowAmbientCredential: false,
        credential: { sources: [{ file: `${realRoot}/credentials/work.token` }, { file: `${realRoot}/identities/work/secrets/token` }], target: "oauthToken" },
      });
      await renameIdentity(linkedPaths, "work", "client", world.ports());
      expect(readIdentity(world.paths, "personal")?.credential?.sources).toEqual([{ file: `${realRoot}/credentials/client.token` }, { file: `${realRoot}/identities/client/secrets/token` }]);
    });

    it("refuses a file it cannot read whose text names the moved directory by its real path", async () => {
      fs.mkdirSync(world.paths.providersDir, { recursive: true });
      fs.writeFileSync(path.join(world.paths.providersDir, "garbled.json"), `{ "credential": "${realRoot}/identities/work/secrets/token" `);
      const before = treeOf(world.root);
      await expect(renameIdentity(linkedPaths, "work", "client", world.ports())).rejects.toThrow("providers/garbled.json");
      expect(treeOf(world.root)).toEqual(before);
    });

    it("does not take another identity's real path for it", () => {
      commandSource("cat", `${realRoot}/identities/work-two/secrets/token`);
      expect(describeIdentityRename(linkedPaths, "work", "client", world.ports()).warnings).toEqual([]);
    });
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "./cliError";
import { collectDoctorReport } from "./doctorReport";
import { describeIdentityMove, moveIdentity } from "./identityRename";
import { createWorld, writeJson, type World } from "./identityRenameTestWorld";
import { renameProvider, type ProviderRenamePorts } from "./providerRename";
import { providerExists } from "./providersStore";
import { realFarmFs } from "./realPorts";

/** The mode of a directory nobody can enter, and the mode that gives it back to its owner so it can be removed. */
const NO_ACCESS = 0;
const OWNER_ALL = 0o700;

const runningAsRoot = process.getuid?.() === 0;

describe.skipIf(runningAsRoot)("a rename while an identity under identities/ cannot be reached", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
    fs.writeFileSync(path.join(world.root, "credentials", "work.token"), "a-made-up-token\n");
  });

  afterEach(() => {
    for (const name of ["closed", "closed-target"]) {
      const closed = name === "closed" ? world.directory(name) : path.join(world.root, name);
      if (fs.existsSync(closed)) {
        fs.chmodSync(closed, OWNER_ALL);
      }
    }
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  /** An identity whose `identity.json` names the token file that `work` is about to move, which nobody can then read. */
  function leaveClosedIdentity(): void {
    writeJson(path.join(world.directory("closed"), "identity.json"), {
      name: "closed",
      allowAmbientCredential: false,
      provider: "z",
      credential: { sources: [{ file: path.join(world.root, "credentials", "work.token") }], target: "oauthToken" },
    });
    fs.chmodSync(world.directory("closed"), NO_ACCESS);
  }

  /** The same, reached through a symlink under `identities/`. */
  function leaveClosedIdentityBehindLink(): void {
    const target = path.join(world.root, "closed-target");
    fs.mkdirSync(target);
    writeJson(path.join(target, "identity.json"), {
      name: "closed",
      allowAmbientCredential: false,
      credential: { sources: [{ file: path.join(world.root, "credentials", "work.token") }], target: "oauthToken" },
    });
    fs.symlinkSync(target, world.directory("closed"));
    fs.chmodSync(target, NO_ACCESS);
  }

  async function failureOf(attempt: () => Promise<unknown>): Promise<string> {
    const failure: unknown = await attempt().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliError);
    return failure instanceof Error ? failure.message : "";
  }

  it.each([
    ["a directory", leaveClosedIdentity],
    ["a symlink to a directory", leaveClosedIdentityBehindLink],
  ])("is refused in the dry run and the real run when %s nobody can enter may name what moves, naming the entry and why, and changes nothing", async (_kind, leave) => {
    leave();
    for (const attempt of [async () => Promise.resolve(describeIdentityMove(world.paths, "work", "client", world.ports())), async () => moveIdentity(world.paths, "work", "client", world.ports())]) {
      const message = await failureOf(attempt);
      expect(message).toContain("identities/closed");
      expect(message).toContain("EACCES");
      expect(message).toContain("cannot be reached");
      expect(message).toContain("Repair or remove it");
    }
    expect(fs.existsSync(world.directory("work"))).toBe(true);
    expect(fs.existsSync(world.directory("client"))).toBe(false);
    expect(fs.existsSync(path.join(world.root, "credentials", "work.token"))).toBe(true);
    expect(fs.existsSync(path.join(world.root, "credentials", "client.token"))).toBe(false);
  });

  it("is allowed again once the entry is repaired, and re-points what it names", async () => {
    leaveClosedIdentity();
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.toBeInstanceOf(CliError);
    fs.chmodSync(world.directory("closed"), OWNER_ALL);
    await moveIdentity(world.paths, "work", "client", world.ports());
    const repointed: unknown = JSON.parse(fs.readFileSync(path.join(world.directory("closed"), "identity.json"), "utf8"));
    expect(JSON.stringify(repointed)).toContain(path.join(world.root, "credentials", "client.token"));
  });

  it("is still reported by doctor as a warning that lets the rest of the report through", () => {
    leaveClosedIdentity();
    const report = collectDoctorReport({ paths: world.paths, env: { PATH: "" } });
    expect(report.findings.find((entry) => entry.section === "identity" && entry.subject === "closed")?.severity).toBe("warn");
  });

  describe("and a provider is renamed", () => {
    let ports: ProviderRenamePorts;

    beforeEach(() => {
      ports = { fs: realFarmFs, credentialCache: { port: { read: () => undefined, write: () => undefined, remove: () => undefined }, platform: "linux" } };
      writeJson(path.join(world.paths.providersDir, "z.json"), { displayName: "z.ai", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }] } });
    });

    it("is refused, naming the entry and why, since the provider it names could not be updated, and changes nothing", () => {
      leaveClosedIdentity();
      let message = "";
      try {
        renameProvider(world.paths, "z", "zai", ports);
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        message = error instanceof Error ? error.message : "";
      }
      expect(message).toContain("identities/closed");
      expect(message).toContain("EACCES");
      expect(message).toContain("Repair or remove it");
      expect(providerExists(world.paths, "z")).toBe(true);
      expect(providerExists(world.paths, "zai")).toBe(false);
      expect(fs.existsSync(world.paths.providerAliasesFile)).toBe(false);
    });
  });
});

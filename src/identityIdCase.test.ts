import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeIdentityMove, moveIdentity, renameIdentity } from "./identityRename";
import { createWorld, treeOf, type World } from "./identityRenameTestWorld";
import { addIdentity, identityIdOf } from "./identityStore";

/** A superseded farm of an identity stored under `Work`, named as a resync names it. */
const SUPERSEDED_WORK = ".Work.previous.5151.1c9e0f6a-2b3d-4e5f-8a7b-9c0d1e2f3a4b";

/** `fs.existsSync` as a filesystem that ignores case answers it under `root`: a path is there when some spelling of it is. */
function foldingExistsSync(root: string, real: (file: fs.PathLike) => boolean): (file: fs.PathLike) => boolean {
  return (file) => {
    const text = String(file);
    if (real(text) || !text.startsWith(`${root}${path.sep}`)) {
      return real(text);
    }
    let resolved = root;
    for (const segment of path.relative(root, text).split(path.sep)) {
      const found = real(resolved) && fs.statSync(resolved).isDirectory() ? fs.readdirSync(resolved).find((entry) => entry.toLowerCase() === segment.toLowerCase()) : undefined;
      if (found === undefined) {
        return false;
      }
      resolved = path.join(resolved, found);
    }
    return true;
  };
}

describe("ids that differ only in case", () => {
  let world: World;

  /** Leaves an identity named Work under id Work only in a superseded farm, as a resync killed between the two renames of its swap leaves it. */
  function displacedWork(): void {
    fs.mkdirSync(path.join(world.paths.identitiesDir, SUPERSEDED_WORK), { recursive: true });
    fs.writeFileSync(path.join(world.paths.identitiesDir, SUPERSEDED_WORK, "identity.json"), JSON.stringify({ name: "Work", allowAmbientCredential: false }));
  }

  beforeEach(() => {
    world = createWorld();
    // The world's own work is renamed away, so the name work and the id work are both free.
    fs.renameSync(world.directory("work"), world.directory("office"));
    fs.writeFileSync(path.join(world.directory("office"), "identity.json"), JSON.stringify({ name: "office", allowAmbientCredential: false }));
    for (const entry of fs.readdirSync(world.paths.identitiesDir).filter((candidate) => candidate.startsWith(".work."))) {
      fs.rmSync(path.join(world.paths.identitiesDir, entry), { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("are never both given out: a superseded farm, a resync lock, an id-keyed file or a usage record under another spelling takes the id", () => {
    displacedWork();
    addIdentity(world.paths, "work");
    expect(identityIdOf(world.paths, "work")).toBe("work-2");
    fs.writeFileSync(path.join(world.paths.identitiesDir, ".Desk.lock"), "{}\n");
    addIdentity(world.paths, "desk");
    expect(identityIdOf(world.paths, "desk")).toBe("desk-2");
    fs.mkdirSync(path.dirname(path.join(world.paths.root, "credentials", "x")), { recursive: true });
    fs.writeFileSync(path.join(world.paths.root, "credentials", "Home.token"), "placeholder\n");
    addIdentity(world.paths, "home");
    expect(identityIdOf(world.paths, "home")).toBe("home-2");
    fs.mkdirSync(world.paths.usageLogDir, { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(world.paths.usageLogDir, `${at.slice(0, "YYYY-MM-DD".length)}.1.jsonl`), `${JSON.stringify({ schemaVersion: 1, at, identity: "Lab", provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`);
    addIdentity(world.paths, "lab");
    expect(identityIdOf(world.paths, "lab")).toBe("lab-2");
    // And the other way round: an upper-case id is kept from a superseded farm spelled in lower case.
    fs.mkdirSync(path.join(world.paths.identitiesDir, ".shop.previous.5151.1c9e0f6a-2b3d-4e5f-8a7b-9c0d1e2f3a4b"), { recursive: true });
    addIdentity(world.paths, "Shop");
    expect(identityIdOf(world.paths, "Shop")).toBe("Shop-2");
  });

  it("keeps a displaced identity from being taken for another identity's directory spelled differently, on a filesystem that ignores case", async () => {
    displacedWork();
    // A directory work made before ids were allocated with case folded, holding another identity.
    fs.mkdirSync(world.directory("work"), { recursive: true });
    fs.writeFileSync(path.join(world.directory("work"), "identity.json"), JSON.stringify({ name: "work", allowAmbientCredential: false }));
    const real = fs.existsSync.bind(fs);
    vi.spyOn(fs, "existsSync").mockImplementation(foldingExistsSync(world.paths.identitiesDir, real));
    const before = treeOf(world.root);
    await expect(renameIdentity(world.paths, "Work", "job", world.ports())).rejects.toThrow("cannot be renamed yet");
    expect(treeOf(world.root)).toEqual(before);
  });
});

describe("--move to an id that differs only in case from one in use", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld("darwin");
    // Another identity, bob, stored under Client.
    fs.mkdirSync(world.directory("Client"), { recursive: true });
    fs.writeFileSync(path.join(world.directory("Client"), "identity.json"), JSON.stringify({ name: "bob", allowAmbientCredential: false }));
  });

  afterEach(() => {
    fs.rmSync(world.root, { recursive: true, force: true });
  });

  it("is refused by the dry run and the real run, naming the clashing directory, with nothing touched and the Keychain not asked to change anything", async () => {
    const message = `"client" is already in use: ${path.join(world.paths.identitiesDir, "Client")} exists, and an id that differs from "client" only in case is the same directory on a filesystem that ignores case.`;
    expect(() => describeIdentityMove(world.paths, "work", "client", world.ports())).toThrow(message);
    const before = treeOf(world.root);
    world.keychain.calls.length = 0;
    await expect(moveIdentity(world.paths, "work", "client", world.ports())).rejects.toThrow(message);
    expect(treeOf(world.root)).toEqual(before);
    expect(world.keychain.calls.filter((call) => call.args[0] !== "find-generic-password")).toEqual([]);
  });

  it("refuses a move that only changes the case of the id, on a filesystem that keeps case too", async () => {
    // A filesystem that keeps case sees two directories; the refusal does not depend on asking it.
    const keepsCase = world.ports({ sameDirectory: () => false });
    await expect(moveIdentity(world.paths, "work", "WORK", keepsCase)).rejects.toThrow('"work" and "WORK" differ only in case, which a filesystem that ignores case makes one directory, so --move cannot change the case.');
    expect(() => describeIdentityMove(world.paths, "work", "WORK", keepsCase)).toThrow('"work" and "WORK" differ only in case, which a filesystem that ignores case makes one directory, so --move cannot change the case.');
  });
});

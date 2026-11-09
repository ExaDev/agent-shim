import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigFileNotJsonError } from "./config/load";
import { DuplicateIdentityNameError } from "./identityRecords";
import { identityRecords, indexIdentityRecords, addIdentity, createIdentityNameReader, IdentityAlreadyExistsError, identityExists, identityIdOf, identityNameOf, listIdentities, readIdentity, removeIdentity, setIdentityLabel, useIdentity } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

describe("identities stored under an id that is not their name", () => {
  let root: string;
  let paths: LayoutPaths;

  /** Writes an identity named `name` into the directory of id `id`, as a rename of the name alone leaves it. */
  function store(id: string, name: string): void {
    fs.mkdirSync(path.join(paths.identitiesDir, id), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, id, "identity.json"), `${JSON.stringify({ name, allowAmbientCredential: false })}\n`);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-store-ids-test-"));
    paths = buildLayoutPaths(root);
    store("work", "client");
    store("personal", "personal");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds an identity by its name, never by its directory's", () => {
    expect(identityExists(paths, "client")).toBe(true);
    expect(identityExists(paths, "work")).toBe(false);
    expect(identityIdOf(paths, "client")).toBe("work");
    expect(identityNameOf(paths, "work")).toBe("client");
    expect(readIdentity(paths, "client")?.name).toBe("client");
    expect(readIdentity(paths, "work")).toBeUndefined();
  });

  it("lists each identity by its name with its id, sorted by name", () => {
    expect(listIdentities(paths).map((entry) => [entry.name, entry.id])).toEqual([
      ["client", "work"],
      ["personal", "personal"],
    ]);
  });

  it("writes a setting into the directory of the identity's id", () => {
    setIdentityLabel(paths, "client", "the client");
    expect(JSON.parse(fs.readFileSync(path.join(paths.identitiesDir, "work", "identity.json"), "utf8"))).toMatchObject({ name: "client", label: "the client" });
  });

  it("selects an identity by its name", () => {
    useIdentity(paths, "client");
    expect(listIdentities(paths).find((entry) => entry.isActive)?.id).toBe("work");
  });

  it("gives a new identity whose name's directory is taken the next free directory, and never touches the identity there", () => {
    addIdentity(paths, "work");
    expect(identityIdOf(paths, "work")).toBe("work-2");
    expect(JSON.parse(fs.readFileSync(path.join(paths.identitiesDir, "work", "identity.json"), "utf8"))).toMatchObject({ name: "client" });
    expect(() => addIdentity(paths, "client")).toThrow(IdentityAlreadyExistsError);
  });

  it("gives a new identity a free directory when a lock or a stray file stands in its name's place", () => {
    fs.writeFileSync(path.join(paths.identitiesDir, ".fresh.lock"), "{}");
    addIdentity(paths, "fresh");
    expect(identityIdOf(paths, "fresh")).toBe("fresh-2");
    fs.writeFileSync(path.join(paths.identitiesDir, "plain"), "not an identity");
    addIdentity(paths, "plain");
    expect(identityIdOf(paths, "plain")).toBe("plain-2");
  });

  it("removes the directory of the named identity only", () => {
    addIdentity(paths, "work");
    removeIdentity(paths, "work");
    expect(fs.existsSync(path.join(paths.identitiesDir, "work-2"))).toBe(false);
    expect(identityIdOf(paths, "client")).toBe("work");
    removeIdentity(paths, "client");
    expect(fs.existsSync(path.join(paths.identitiesDir, "work"))).toBe(false);
  });

  it("lets a corrupt identity.json block no healthy identity, and still reports it when it is addressed by its id", () => {
    // client was renamed to old, then work to client; then identities/client/identity.json is damaged.
    store("client", "old");
    fs.writeFileSync(path.join(paths.identitiesDir, "client", "identity.json"), "{ not json");
    expect(identityIdOf(paths, "client")).toBe("work");
    expect(readIdentity(paths, "client")?.name).toBe("client");
    expect(identityExists(paths, "old")).toBe(false);
    store("broken", "broken");
    fs.writeFileSync(path.join(paths.identitiesDir, "broken", "identity.json"), "{ not json");
    expect(() => readIdentity(paths, "broken")).toThrow(ConfigFileNotJsonError);
  });

  it("takes a symlink beside an identity's directory for the identity it reaches, as one identity listed once", () => {
    fs.symlinkSync(path.join(paths.identitiesDir, "personal"), path.join(paths.identitiesDir, "alias"));
    expect(identityIdOf(paths, "personal")).toBe("personal");
    expect(listIdentities(paths).map((entry) => entry.id)).toEqual(["work", "personal"]);
  });

  it("removes the files a removed identity's id keys, so an identity added later under that id inherits none of them", () => {
    const keyed = [path.join(root, "credentials", "work.token"), path.join(root, "credential-cache", "identity_work.json"), path.join(paths.usageSnapshotsDir, "work.json")];
    for (const file of keyed) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{}");
    }
    removeIdentity(paths, "client");
    expect(keyed.filter((file) => fs.existsSync(file))).toEqual([]);
    addIdentity(paths, "work");
    expect(identityIdOf(paths, "work")).toBe("work");
  });

  it("gives a new identity a free id when a leftover token, cached credential, snapshot or usage record is filed under its name", () => {
    const leftovers: readonly [string, string][] = [
      ["token", path.join(root, "credentials", "token.token")],
      ["cache", path.join(root, "credential-cache", "identity_cache.json")],
      ["snap", path.join(paths.usageSnapshotsDir, "snap.json")],
    ];
    for (const [name, file] of leftovers) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{}");
      addIdentity(paths, name);
      expect(identityIdOf(paths, name)).toBe(`${name}-2`);
    }
    fs.mkdirSync(paths.usageLogDir, { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(paths.usageLogDir, `${at.slice(0, "YYYY-MM-DD".length)}.1.jsonl`), `${JSON.stringify({ schemaVersion: 1, at, identity: "logged", provider: "anthropic", route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`);
    addIdentity(paths, "logged");
    expect(identityIdOf(paths, "logged")).toBe("logged-2");
  });

  it("gives a new identity a free id when only a superseded farm a resync left is filed under its name", () => {
    fs.mkdirSync(path.join(paths.identitiesDir, ".farmed.previous.4242.0f8fad5b-d9cb-469f-a165-70867728950e"), { recursive: true });
    addIdentity(paths, "farmed");
    expect(identityIdOf(paths, "farmed")).toBe("farmed-2");
  });

  it("refuses a name two identities claim, and lists both", () => {
    store("other", "client");
    expect(() => identityExists(paths, "client")).toThrow(DuplicateIdentityNameError);
    expect(() => readIdentity(paths, "client")).toThrow(DuplicateIdentityNameError);
    expect(() => {
      removeIdentity(paths, "client");
    }).toThrow(DuplicateIdentityNameError);
    expect(listIdentities(paths).filter((entry) => entry.name === "client").map((entry) => entry.id)).toEqual(["other", "work"]);
  });
});

/** How far the rewrite's mtime is moved on: more than any filesystem's timestamp resolution. */
const ONE_SECOND_MS = 1000;

/** A modification time in whole seconds, as `utimesSync` takes it, which a file can be set back to exactly. */
const WHOLE_SECOND_MTIME = 1_790_000_000;

describe("createIdentityNameReader", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-name-reader-test-"));
    paths = buildLayoutPaths(root);
    fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "client", allowAmbientCredential: false }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads an id's identity.json once while it is unchanged, and again once it is rewritten with the same size and a new mtime", () => {
    const reader = createIdentityNameReader(paths);
    expect(reader.nameOf("work")).toBe("client");
    expect(reader.nameOf("work")).toBe("client");
    expect(reader.reads()).toBe(1);
    const file = path.join(paths.identitiesDir, "work", "identity.json");
    // "office" has as many letters as "client", so the file keeps its size and only the content and the mtime change.
    fs.writeFileSync(file, JSON.stringify({ name: "office", allowAmbientCredential: false }));
    const later = new Date(fs.statSync(file).mtimeMs + ONE_SECOND_MS);
    fs.utimesSync(file, later, later);
    expect(reader.nameOf("work")).toBe("office");
    expect(reader.reads()).toBe(2);
    expect(reader.nameOf("gone")).toBeUndefined();
  });

  it("reads it again after it is replaced by a new file of the same size, whose mtime is set back to the old one", () => {
    const file = path.join(paths.identitiesDir, "work", "identity.json");
    // A whole-second mtime, which setting it back restores exactly.
    fs.utimesSync(file, WHOLE_SECOND_MTIME, WHOLE_SECOND_MTIME);
    const reader = createIdentityNameReader(paths);
    expect(reader.nameOf("work")).toBe("client");
    const before = fs.statSync(file);
    // Written beside it and renamed over it, as an atomic write does, so only the inode tells the files apart.
    const replacement = `${file}.new`;
    fs.writeFileSync(replacement, JSON.stringify({ name: "office", allowAmbientCredential: false }));
    fs.renameSync(replacement, file);
    fs.utimesSync(file, WHOLE_SECOND_MTIME, WHOLE_SECOND_MTIME);
    expect(fs.statSync(file)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
    expect(fs.statSync(file).ino).not.toBe(before.ino);
    expect(reader.nameOf("work")).toBe("office");
    expect(reader.reads()).toBe(2);
  });

  it("reads it again after it is rewritten in place to another size, with its mtime set back to the old one", () => {
    const file = path.join(paths.identitiesDir, "work", "identity.json");
    // A whole-second mtime, which setting it back restores exactly.
    fs.utimesSync(file, WHOLE_SECOND_MTIME, WHOLE_SECOND_MTIME);
    const reader = createIdentityNameReader(paths);
    expect(reader.nameOf("work")).toBe("client");
    const before = fs.statSync(file);
    fs.writeFileSync(file, JSON.stringify({ name: "a-longer-client", allowAmbientCredential: false }));
    fs.utimesSync(file, WHOLE_SECOND_MTIME, WHOLE_SECOND_MTIME);
    expect(fs.statSync(file)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
    expect(reader.nameOf("work")).toBe("a-longer-client");
    expect(reader.reads()).toBe(2);
  });
});

describe("indexIdentityRecords", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-index-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists the identities directory once however many records it is asked about, and finds the displaced one", () => {
    const IDENTITIES = 25;
    for (let index = 0; index < IDENTITIES; index += 1) {
      const directory = path.join(paths.identitiesDir, `id${String(index)}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "identity.json"), JSON.stringify({ name: `n${String(index)}` }));
    }
    // A superseded farm whose identity has no directory of its own: its record is displaced.
    const lostId = "lost";
    const farm = path.join(paths.identitiesDir, `.${lostId}.previous.4242.0f8fad5b-d9cb-469f-a165-70867728950e`);
    fs.mkdirSync(farm, { recursive: true });
    fs.writeFileSync(path.join(farm, "identity.json"), JSON.stringify({ name: "lost-name" }));
    const records = identityRecords(paths);
    const listings = vi.spyOn(fs, "readdirSync");
    const index = indexIdentityRecords(paths, records, new Set());
    expect(listings).toHaveBeenCalledTimes(1);
    expect(index.displaced.map((record) => record.id)).toEqual([lostId]);
    expect([...index.displacedIds]).toEqual([lostId]);
    expect(index.names.get("id3")).toBe("n3");
  });
});

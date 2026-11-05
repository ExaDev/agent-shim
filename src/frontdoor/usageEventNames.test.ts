import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentityNameReader } from "../identityStore";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { USAGE_SCHEMA_VERSION, type UsageSnapshot } from "../usage/schema";
import { usageEventPublisher, type UsageChangeEvent } from "./eventSchemas";

/** A superseded farm an interrupted resync of the identity stored under `farmed` left, holding its record while its directory is missing. */
const SUPERSEDED_FARMED = ".farmed.previous.4242.0f8fad5b-d9cb-469f-a165-70867728950e";

/** A modification time in whole seconds, as `utimesSync` takes it, which a directory can be set back to exactly. */
const WHOLE_SECOND_MTIME = 1_790_000_000;

function snapshot(identity: string): UsageSnapshot {
  return { schemaVersion: USAGE_SCHEMA_VERSION, identity, updatedAt: "2026-10-30T10:00:00.000Z", providers: {} };
}

describe("the usage events the door publishes, named through its name reader", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-event-names-test-"));
    paths = buildLayoutPaths(root);
    fs.mkdirSync(path.join(paths.identitiesDir, "work"), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, "work", "identity.json"), JSON.stringify({ name: "client", allowAmbientCredential: false }));
    fs.mkdirSync(path.join(paths.identitiesDir, SUPERSEDED_FARMED), { recursive: true });
    fs.writeFileSync(path.join(paths.identitiesDir, SUPERSEDED_FARMED, "identity.json"), JSON.stringify({ name: "office", allowAmbientCredential: false }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("names a renamed identity, one a resync left displaced in a superseded farm, and none for an id no identity has", () => {
    const published: UsageChangeEvent[] = [];
    const publish = usageEventPublisher((event) => {
      published.push(event);
    }, createIdentityNameReader(paths).nameOf);
    publish(snapshot("work"));
    publish(snapshot("farmed"));
    publish(snapshot("gone"));
    expect(published.map((event) => [event.id, event.name])).toEqual([
      ["work", "client"],
      ["farmed", "office"],
      ["gone", undefined],
    ]);
  });

  it("reads every identity's record once for an id with no identity.json, and again once the identities directory changes", () => {
    const reader = createIdentityNameReader(paths);
    expect(reader.nameOf("farmed")).toBe("office");
    expect(reader.nameOf("farmed")).toBe("office");
    expect(reader.resolves()).toBe(1);
    // The launch that puts the displaced identity back renames its superseded farm into place, an entry change of the identities directory.
    fs.renameSync(path.join(paths.identitiesDir, SUPERSEDED_FARMED), path.join(paths.identitiesDir, "farmed"));
    fs.rmSync(path.join(paths.identitiesDir, "farmed", "identity.json"));
    fs.mkdirSync(path.join(paths.identitiesDir, "other"));
    expect(reader.nameOf("farmed")).toBeUndefined();
    expect(reader.resolves()).toBe(2);
  });

  it("reads them again when a superseded farm appears within one tick of the directory's mtime", () => {
    fs.utimesSync(paths.identitiesDir, WHOLE_SECOND_MTIME, WHOLE_SECOND_MTIME);
    const reader = createIdentityNameReader(paths);
    expect(reader.nameOf("late")).toBeUndefined();
    const farm = path.join(paths.identitiesDir, ".late.previous.4242.0f8fad5b-d9cb-469f-a165-70867728950e");
    fs.mkdirSync(farm);
    fs.writeFileSync(path.join(farm, "identity.json"), JSON.stringify({ name: "home", allowAmbientCredential: false }));
    // The mtime set back to the one the first answer was kept with, as a coarse timestamp would leave it.
    fs.utimesSync(paths.identitiesDir, WHOLE_SECOND_MTIME, WHOLE_SECOND_MTIME);
    expect(reader.nameOf("late")).toBe("home");
    expect(reader.resolves()).toBe(2);
  });

  it("reads them again when the identities directory is replaced by another with the same entry names and mtime", () => {
    fs.utimesSync(paths.identitiesDir, WHOLE_SECOND_MTIME, WHOLE_SECOND_MTIME);
    const reader = createIdentityNameReader(paths);
    expect(reader.nameOf("farmed")).toBe("office");
    // A copy whose superseded farm names another identity, swapped into place, so only the directory's inode differs.
    const replacement = `${paths.identitiesDir}.new`;
    fs.cpSync(paths.identitiesDir, replacement, { recursive: true });
    fs.writeFileSync(path.join(replacement, SUPERSEDED_FARMED, "identity.json"), JSON.stringify({ name: "elsewhere", allowAmbientCredential: false }));
    fs.renameSync(paths.identitiesDir, `${paths.identitiesDir}.old`);
    fs.renameSync(replacement, paths.identitiesDir);
    fs.utimesSync(paths.identitiesDir, WHOLE_SECOND_MTIME, WHOLE_SECOND_MTIME);
    expect(reader.nameOf("farmed")).toBe("elsewhere");
    expect(reader.resolves()).toBe(2);
  });
});

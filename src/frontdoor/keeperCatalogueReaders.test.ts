import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildLayoutPaths } from "../paths";
import { catalogueCachePath, catalogueSettingsPath } from "../providerCatalogue";
import { keeperCatalogueReaders } from "./keeperCatalogueReaders";

describe("the files the catalogue keeper reads", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  const GENERATION = "10000000-0000-4000-8000-000000000001";
  const SUPERVISOR = 4242;

  it("are an http provider's catalogue and its digest file, and a codex provider's catalogue in the door's own generation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-keeper-readers-"));
    roots.push(root);
    const real = buildLayoutPaths(root);
    const put = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    put(catalogueCachePath(real, "h"), "http catalogue");
    put(catalogueSettingsPath(real, "h"), "http digest");
    put(catalogueCachePath(real, "c", SUPERVISOR, GENERATION), "codex catalogue");
    // A catalogue of the same name in the shared directory and in another generation's is not a codex provider's: the keeper reads its own generation's.
    put(catalogueCachePath(real, "c"), "shared catalogue");
    put(catalogueCachePath(real, "c", SUPERVISOR, "10000000-0000-4000-8000-000000000002"), "another generation's catalogue");
    const readers = keeperCatalogueReaders(real, SUPERVISOR, GENERATION);
    expect(readers.readCache("h", { displayName: "H", baseUrl: "https://h.example", credential: { sources: [{ literal: "unused" }] }, catalogue: { tier: "sonnet" } })).toBe("http catalogue");
    expect(readers.readSettings("h")).toBe("http digest");
    expect(readers.readCache("c", { kind: "codex", displayName: "C", credential: { sources: [{ literal: "unused" }] } })).toBe("codex catalogue");
    expect(readers.readCache("c", { displayName: "C", baseUrl: "https://c.example", credential: { sources: [{ literal: "unused" }] }, catalogue: { tier: "sonnet" } })).toBe("shared catalogue");
    expect(readers.readSettings("absent")).toBeUndefined();
  });
});

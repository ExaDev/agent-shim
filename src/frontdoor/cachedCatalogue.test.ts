import { describe, expect, it } from "vitest";

import type { HttpProvider, ProviderCatalogue } from "../config/schema";
import { buildLayoutPaths } from "../paths";
import { catalogueCachePath, catalogueSettingsFingerprint, catalogueSettingsPath, catalogueSettingsText } from "../providerCatalogue";
import { StoredCatalogue, TolerantReader, raiseUnreadableCatalogue } from "../storedCatalogue";
import { cachingCatalogueModels } from "./cachedCatalogue";

const paths = buildLayoutPaths("/home/user/.agent-shim");
/** A provider with the settings a stored catalogue is fetched under, and the catalogue setting given (none for one that did not opt in). */
const providerWith = (catalogue?: ProviderCatalogue): HttpProvider => ({ displayName: "Spark", baseUrl: "https://x.example", credential: { sources: [{ env: "SPARK_KEY" }] }, ...(catalogue === undefined ? {} : { catalogue }) });
/** The digest file of a catalogue fetched under the provider of these tests as it stands. */
const OWN_DIGEST = catalogueSettingsText(catalogueSettingsFingerprint(providerWith({ tier: "sonnet" })), 1);
/** A stored catalogue file listing `ids`. */
const storedOf = (ids: readonly string[]): string => JSON.stringify({ fetchedAt: 1, url: "https://x.example/v1/models", models: ids.map((id) => ({ id })) });
const stored = storedOf(["keep", "skip-me"]);
/** A reader over the files of provider `spark`: its catalogue and the digest file beside it (none when `digest` is undefined). */
const readerOf = (digest: string | undefined, catalogue: string = stored) => (filePath: string): string | undefined => {
  if (filePath === catalogueCachePath(paths, "spark")) return catalogue;
  return filePath === catalogueSettingsPath(paths, "spark") ? digest : undefined;
};
const read = readerOf(OWN_DIGEST);
/** The models lookup over `reader`'s files with no revision to keep a parse under, so every call reads the files. */
const uncached = (reader: (filePath: string) => string | undefined): ReturnType<typeof cachingCatalogueModels> => cachingCatalogueModels(new StoredCatalogue(paths, new TolerantReader(reader, raiseUnreadableCatalogue)), () => undefined);

describe("the stored catalogue models of a provider, read on every call", () => {
  it("lists the stored models after the provider's own filters", () => {
    expect(uncached(read)("spark", providerWith({ tier: "sonnet", exclude: ["skip-*"] }))).toEqual([{ id: "keep" }]);
  });

  it.each([
    ["a provider whose settings are not the ones the digest records", read, { ...providerWith({ tier: "sonnet" }), baseUrl: "https://moved.example" }],
    ["a catalogue with no digest, as an older door stores it", readerOf(undefined), providerWith({ tier: "sonnet" })],
    ["a digest file that is not one", readerOf("{ not json"), providerWith({ tier: "sonnet" })],
    ["a digest that names another catalogue, as one rewritten by a release before the digest leaves it", readerOf(catalogueSettingsText(catalogueSettingsFingerprint(providerWith({ tier: "sonnet" })), 2)), providerWith({ tier: "sonnet" })],
    ["a digest that records no catalogue at all, as an earlier shape of the file does", readerOf(JSON.stringify({ settings: catalogueSettingsFingerprint(providerWith({ tier: "sonnet" })) })), providerWith({ tier: "sonnet" })],
  ])("lists none for %s", (_label, reader, provider) => {
    expect(uncached(reader)("spark", provider)).toEqual([]);
  });

  it("lists none for a provider that did not opt in, or one with nothing stored", () => {
    expect(uncached(read)("spark", providerWith())).toEqual([]);
    expect(uncached(read)("other", providerWith({ tier: "sonnet" }))).toEqual([]);
  });
});

/** How many lookups follow each change of the files' revision. */
const CALLS_EACH_REVISION = 4;
const REVISIONS_SEEN = 3;

describe("the caching of the stored catalogue of a provider that did not opt in", () => {
  it("lists none and never reads a file, whatever is stored", () => {
    let reads = 0;
    const models = cachingCatalogueModels(
      new StoredCatalogue(paths, new TolerantReader(() => {
        reads += 1;
        return stored;
      }, raiseUnreadableCatalogue)),
      () => "r1",
    );
    expect(models("spark", providerWith())).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe("the caching of a provider's stored catalogue", () => {
  const provider = providerWith({ tier: "sonnet" });

  /** A reader that counts how many times the catalogue file is read, over files whose revisions the test sets. */
  function counting(): {
    readonly models: ReturnType<typeof cachingCatalogueModels>;
    readonly reads: () => number;
    readonly setRevision: (revision: string | undefined) => void;
    readonly setSettingsRevision: (revision: string | undefined) => void;
    readonly setText: (text: string) => void;
    readonly setDigest: (digest: string | undefined) => void;
  } {
    let reads = 0;
    let revision: string | undefined = "r1";
    let settingsRevision: string | undefined = "s1";
    let text = stored;
    let digest: string | undefined = OWN_DIGEST;
    const models = cachingCatalogueModels(
      new StoredCatalogue(paths, new TolerantReader((filePath) => {
        if (filePath === catalogueCachePath(paths, "spark")) {
          reads += 1;
          return text;
        }
        return filePath === catalogueSettingsPath(paths, "spark") ? digest : undefined;
      }, raiseUnreadableCatalogue)),
      (filePath) => (filePath === catalogueSettingsPath(paths, "spark") ? settingsRevision : revision),
    );
    return { models, reads: () => reads, setRevision: (next) => { revision = next; }, setSettingsRevision: (next) => { settingsRevision = next; }, setText: (next) => { text = next; }, setDigest: (next) => { digest = next; } };
  }

  it("reads and parses the files once for requests while their revisions are unchanged", () => {
    const world = counting();
    const asked = Array.from({ length: 5 }, () => world.models("spark", provider));
    expect(world.reads()).toBe(1);
    for (const models of asked) {
      expect(models).toEqual([{ id: "keep" }, { id: "skip-me" }]);
    }
  });

  it("reads them again when the catalogue's revision changes, and follows what it now holds", () => {
    const world = counting();
    world.models("spark", provider);
    world.setText(storedOf(["newer"]));
    world.setRevision("r2");
    expect(world.models("spark", provider)).toEqual([{ id: "newer" }]);
    expect(world.reads()).toBe(2);
  });

  it("reads them again when only the digest's revision changes, and follows the digest it now holds", () => {
    const world = counting();
    expect(world.models("spark", provider)).toHaveLength(2);
    world.setDigest(catalogueSettingsText("settings-of-another-server", 1));
    world.setSettingsRevision("s2");
    expect(world.models("spark", provider)).toEqual([]);
    world.setDigest(OWN_DIGEST);
    world.setSettingsRevision("s3");
    expect(world.models("spark", provider)).toHaveLength(2);
    expect(world.reads()).toBe(REVISIONS_SEEN);
  });

  it.each([["the catalogue", "catalogue"], ["the digest", "digest"]] as const)("reads files with no revision for %s each time, since nothing says they are unchanged", (_label, which) => {
    const world = counting();
    if (which === "catalogue") world.setRevision(undefined);
    else world.setSettingsRevision(undefined);
    world.models("spark", provider);
    world.models("spark", provider);
    expect(world.reads()).toBe(2);
  });

  it("lists none for a provider whose settings differ from those the digest records, whether asked before or after the parse is kept, without reading the files again", () => {
    const world = counting();
    const moved = { ...provider, baseUrl: "https://moved.example" };
    expect(world.models("spark", moved)).toEqual([]);
    expect(world.models("spark", provider)).toHaveLength(2);
    expect(world.models("spark", moved)).toEqual([]);
    expect(world.models("spark", provider)).toHaveLength(2);
    expect(world.reads()).toBe(1);
  });

  it("applies each provider's own filters to the one parse", () => {
    const world = counting();
    expect(world.models("spark", providerWith({ tier: "sonnet", exclude: ["skip-*"] }))).toEqual([{ id: "keep" }]);
    expect(world.models("spark", provider)).toEqual([{ id: "keep" }, { id: "skip-me" }]);
    expect(world.reads()).toBe(1);
  });

  it("gives no models once a new revision does not parse, not the models of the revision before", () => {
    const world = counting();
    expect(world.models("spark", provider)).toHaveLength(2);
    world.setText("{ not a catalogue");
    world.setRevision("r2");
    expect(world.models("spark", provider)).toEqual([]);
    expect(world.models("spark", provider)).toEqual([]);
    expect(world.reads()).toBe(2);
  });

  it("parses once for each revision it sees, however many calls follow each change", () => {
    const world = counting();
    for (const [revision, id] of [["r1", "one"], ["r2", "two"], ["r3", "three"]] as const) {
      world.setText(storedOf([id]));
      world.setRevision(revision);
      for (let call = 0; call < CALLS_EACH_REVISION; call += 1) {
        expect(world.models("spark", provider)).toEqual([{ id }]);
      }
    }
    expect(world.reads()).toBe(REVISIONS_SEEN);
  });

  it("keeps no parse when a revision changed while the files were read, and keeps the next one that did not", () => {
    let reads = 0;
    // The revisions read r and s, then r and moved (after the first read), then r and s every time.
    const revisions = ["r", "s", "r", "moved"];
    const models = cachingCatalogueModels(
      new StoredCatalogue(paths, new TolerantReader((filePath) => {
        if (filePath === catalogueCachePath(paths, "spark")) {
          reads += 1;
          return stored;
        }
        return OWN_DIGEST;
      }, raiseUnreadableCatalogue)),
      (filePath) => revisions.shift() ?? (filePath === catalogueSettingsPath(paths, "spark") ? "s" : "r"),
    );
    models("spark", provider);
    models("spark", provider);
    models("spark", provider);
    expect(reads).toBe(2);
  });
});

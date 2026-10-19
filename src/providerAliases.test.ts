import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigValidationError } from "./config/load";
import type { FsPort } from "./launcher/ports";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { aliasesAfterRename, aliasesOf, aliasFindings, canonicalProviderName, createProviderCanonicaliser, loadProviderAliases, ProviderAliasNotFoundError, readProviderAliases, removeProviderAlias, writeProviderAliases } from "./providerAliases";

describe("canonicalProviderName", () => {
  const aliases = { z: "zai", o: "openrouter" };

  it("maps a former name to the provider it became", () => {
    expect(canonicalProviderName("z", () => false, () => aliases)).toBe("zai");
  });

  it("leaves a current provider name alone without reading the aliases", () => {
    let reads = 0;
    const name = canonicalProviderName("zai", (candidate) => candidate === "zai", () => {
      reads += 1;
      return aliases;
    });
    expect(name).toBe("zai");
    expect(reads).toBe(0);
  });

  it("lets a provider file win over an alias of the same name", () => {
    expect(canonicalProviderName("z", (candidate) => candidate === "z", () => aliases)).toBe("z");
  });

  it("leaves an unknown name unchanged, for the caller to refuse", () => {
    expect(canonicalProviderName("nothing", () => false, () => aliases)).toBe("nothing");
  });
});

describe("createProviderCanonicaliser", () => {
  it("reports each former name once, however many requests use it", () => {
    const lines: string[] = [];
    const canonical = createProviderCanonicaliser({ defined: (name) => name === "zai", aliases: () => ({ z: "zai" }), log: (line) => {
        lines.push(line);
      } });
    expect([canonical("z"), canonical("z"), canonical("zai")]).toEqual(["zai", "zai", "zai"]);
    expect(lines).toEqual(["provider z is a former name of zai; a session launched under it is still running"]);
  });

  it("logs an unreadable aliases file and serves as though there were none", () => {
    const lines: string[] = [];
    const canonical = createProviderCanonicaliser({
      defined: () => false,
      aliases: () => {
        throw new Error("not json");
      },
      log: (line) => {
        lines.push(line);
      },
    });
    expect(canonical("z")).toBe("z");
    expect(lines).toEqual(["provider aliases ignored, the aliases file is unreadable: not json"]);
  });
});

describe("aliasesAfterRename", () => {
  it("records the old name as an alias of the new one", () => {
    expect(aliasesAfterRename({}, "z", "zai")).toEqual({ z: "zai" });
  });

  it("repoints aliases that targeted the renamed provider, so a lookup stays one step", () => {
    expect(aliasesAfterRename({ z: "zai" }, "zai", "glm")).toEqual({ z: "glm", zai: "glm" });
  });

  it("drops an alias named like the new name, since that name is now a provider file", () => {
    expect(aliasesAfterRename({ zai: "z" }, "z", "zai")).toEqual({ z: "zai" });
  });
});

describe("aliasesOf", () => {
  it("lists a provider's former names in order", () => {
    expect(aliasesOf({ b: "zai", a: "zai", c: "other" }, "zai")).toEqual(["a", "b"]);
  });
});

describe("aliasFindings", () => {
  it("passes an alias whose target exists and whose own name is free", () => {
    expect(aliasFindings({ z: "zai" }, new Set(["zai"])).map((finding) => finding.level)).toEqual(["pass"]);
  });

  it("fails an alias whose target is no provider", () => {
    expect(aliasFindings({ z: "zai" }, new Set()).map((finding) => finding.level)).toEqual(["fail"]);
  });

  it("warns about an alias shadowed by a provider of the same name", () => {
    expect(aliasFindings({ z: "zai" }, new Set(["zai", "z"])).map((finding) => finding.level)).toEqual(["warn"]);
  });
});

describe("the aliases file", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-aliases-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const port = (files: Readonly<Record<string, unknown>>): FsPort => ({ readFileUtf8: () => undefined, readConfigFile: (file) => files[file], readdir: () => [] });

  it("reads as none when no provider was ever renamed", () => {
    expect(readProviderAliases(paths)).toEqual({});
    expect(loadProviderAliases(paths.providerAliasesFile, port({}))).toEqual({});
  });

  it("round-trips through write and both readers", () => {
    writeProviderAliases(paths, { z: "zai" });
    expect(readProviderAliases(paths)).toEqual({ z: "zai" });
    expect(loadProviderAliases(paths.providerAliasesFile, port({ [paths.providerAliasesFile]: { z: "zai" } }))).toEqual({ z: "zai" });
  });

  it("removes the file when the last alias goes, so nothing of the feature is left behind", () => {
    writeProviderAliases(paths, { z: "zai" });
    removeProviderAlias(paths, "z");
    expect(fs.existsSync(paths.providerAliasesFile)).toBe(false);
  });

  it("refuses to forget a name that is not recorded", () => {
    expect(() => {
      removeProviderAlias(paths, "z");
    }).toThrow(ProviderAliasNotFoundError);
  });

  it("names the file when its contents are not an alias map", () => {
    expect(() => loadProviderAliases(paths.providerAliasesFile, port({ [paths.providerAliasesFile]: { z: 1 } }))).toThrow(ConfigValidationError);
  });
});

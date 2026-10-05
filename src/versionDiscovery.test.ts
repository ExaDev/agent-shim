import { describe, expect, it } from "vitest";
import {
  ClaudeVersionNotInstalledError,
  compareVersions,
  discoverClaudeBinary,
  installedVersions,
  isNumericDottedVersion,
  pickHighestVersion,
  type VersionsDirEntry,
} from "./versionDiscovery";

function file(name: string, opts: Readonly<Partial<Omit<VersionsDirEntry, "name">>> = {}): VersionsDirEntry {
  return {
    name,
    isFile: true,
    isExecutable: true,
    sizeBytes: 1024,
    ...opts,
  };
}

describe("isNumericDottedVersion", () => {
  it("accepts plain dotted-numeric strings", () => {
    expect(isNumericDottedVersion("2.1.220")).toBe(true);
    expect(isNumericDottedVersion("1")).toBe(true);
    expect(isNumericDottedVersion("10.0")).toBe(true);
  });

  it("rejects non-numeric or malformed names", () => {
    expect(isNumericDottedVersion(".DS_Store")).toBe(false);
    expect(isNumericDottedVersion("2.1.220-beta")).toBe(false);
    expect(isNumericDottedVersion("")).toBe(false);
    expect(isNumericDottedVersion("2..1")).toBe(false);
    expect(isNumericDottedVersion("v2.1.220")).toBe(false);
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexicographically", () => {
    expect(compareVersions("2.9.0", "2.10.0")).toBeLessThan(0);
    expect(compareVersions("2.10.0", "2.9.0")).toBeGreaterThan(0);
  });

  it("treats a missing trailing segment as 0", () => {
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
    expect(compareVersions("2.1", "2.1.1")).toBeLessThan(0);
    expect(compareVersions("2.1.1", "2.1")).toBeGreaterThan(0);
  });

  it("returns 0 for identical versions", () => {
    expect(compareVersions("2.1.220", "2.1.220")).toBe(0);
  });

  it("throws for a non-numeric-dotted input", () => {
    expect(() => compareVersions("not-a-version", "2.1.220")).toThrow();
    expect(() => compareVersions("2.1.220", "not-a-version")).toThrow();
  });
});

describe("pickHighestVersion", () => {
  it("picks the highest version by real numeric comparison", () => {
    const entries = [file("2.1.220"), file("2.9.0"), file("2.10.0"), file("1.99.99")];
    expect(pickHighestVersion(entries)).toBe("2.10.0");
  });

  it("skips non-file entries (e.g. a directory)", () => {
    const entries = [file("2.1.220"), file("9.9.9", { isFile: false })];
    expect(pickHighestVersion(entries)).toBe("2.1.220");
  });

  it("skips non-executable entries", () => {
    const entries = [file("2.1.220"), file("9.9.9", { isExecutable: false })];
    expect(pickHighestVersion(entries)).toBe("2.1.220");
  });

  it("skips zero-size entries", () => {
    const entries = [file("2.1.220"), file("9.9.9", { sizeBytes: 0 })];
    expect(pickHighestVersion(entries)).toBe("2.1.220");
  });

  it("skips entries whose name isn't a valid numeric-dotted version, like .DS_Store", () => {
    const entries = [file("2.1.220"), file(".DS_Store")];
    expect(pickHighestVersion(entries)).toBe("2.1.220");
  });

  it("returns undefined when nothing qualifies (missing/empty versions dir)", () => {
    expect(pickHighestVersion([])).toBeUndefined();
    expect(pickHighestVersion([file(".DS_Store"), file("9.9.9", { sizeBytes: 0 })])).toBeUndefined();
  });
});

describe("discoverClaudeBinary", () => {
  it("prefers the highest version from the versions directory", () => {
    const result = discoverClaudeBinary({
      versionsDir: "/fake/versions",
      listVersionsDir: () => [file("2.1.220"), file("2.10.0")],
      pathDirs: ["/fake/bin"],
      findExecutableInDir: () => undefined,
      isOwnBinary: () => false,
    });

    expect(result.source).toBe("versions-dir");
    expect(result.version).toBe("2.10.0");
    expect(result.path).toBe("/fake/versions/2.10.0");
  });

  it("falls back to PATH when the versions directory has nothing usable", () => {
    const result = discoverClaudeBinary({
      versionsDir: "/fake/versions",
      listVersionsDir: () => [],
      pathDirs: ["/fake/empty-bin", "/fake/other-bin"],
      findExecutableInDir: (dir, name) => (dir === "/fake/other-bin" ? `${dir}/${name}` : undefined),
      isOwnBinary: () => false,
    });

    expect(result.source).toBe("path-fallback");
    expect(result.path).toBe("/fake/other-bin/claude");
  });

  it("discovers a different package's claude sitting in the same directory as agent-shim itself (one npm global prefix, #188)", () => {
    // The co-location layout: agent-shim and claude-code both installed under one npm prefix, so `<prefix>/bin/claude` is a genuinely different package's executable regular file in the very directory agent-shim runs from. The directory must not be excluded wholesale; only agent-shim's own files are.
    const prefixBin = "/fake/prefix/bin";
    const asked: string[] = [];
    const result = discoverClaudeBinary({
      versionsDir: "/fake/versions",
      listVersionsDir: () => [],
      pathDirs: [prefixBin],
      findExecutableInDir: (dir, name) => {
        asked.push(dir);
        return `${dir}/${name}`;
      },
      isOwnBinary: (candidate) => candidate === `${prefixBin}/agent-shim`,
    });

    expect(result.source).toBe("path-fallback");
    expect(result.path).toBe(`${prefixBin}/claude`);
    expect(asked).toEqual([prefixBin]);
  });

  it("never returns this tool's own binary from the PATH fallback, and keeps searching later directories", () => {
    const result = discoverClaudeBinary({
      versionsDir: "/fake/versions",
      listVersionsDir: () => [],
      pathDirs: ["/fake/own-install", "/fake/other-bin"],
      findExecutableInDir: (dir, name) => `${dir}/${name}`,
      isOwnBinary: (candidate) => candidate === "/fake/own-install/claude",
    });

    expect(result.source).toBe("path-fallback");
    expect(result.path).toBe("/fake/other-bin/claude");
  });

  it("fails loudly when the only PATH candidate is this tool's own binary (a `shim enable` copy named claude)", () => {
    expect(() =>
      discoverClaudeBinary({
        versionsDir: "/fake/versions",
        listVersionsDir: () => [],
        pathDirs: ["/fake/own-install"],
        findExecutableInDir: (dir, name) => `${dir}/${name}`,
        isOwnBinary: () => true,
      }),
    ).toThrow(/Could not find a claude binary/);
  });

  it("throws a clear, actionable error when nothing is found anywhere, never crashing silently", () => {
    expect(() =>
      discoverClaudeBinary({
        versionsDir: "/fake/versions",
        listVersionsDir: () => [],
        pathDirs: [],
        findExecutableInDir: () => undefined,
        isOwnBinary: () => false,
      }),
    ).toThrow(/Could not find a claude binary/);
  });
});

describe("discoverClaudeBinary with a pinned version", () => {
  const options = (entries: readonly VersionsDirEntry[], extra: Readonly<{ findExecutableInDir?: () => string | undefined }> = {}) => ({
    versionsDir: "/fake/versions",
    listVersionsDir: () => [...entries],
    pathDirs: ["/fake/bin"],
    findExecutableInDir: extra.findExecutableInDir ?? (() => undefined),
    isOwnBinary: () => false,
  });

  it("runs exactly the pinned version, not the highest", () => {
    const result = discoverClaudeBinary({ ...options([file("2.1.220"), file("2.1.289")]), version: "2.1.220" });
    expect(result).toEqual({ path: "/fake/versions/2.1.220", source: "versions-dir", version: "2.1.220" });
  });

  it("fails with the installed versions listed when the pin is not installed, never falling back to the highest version or to PATH", () => {
    const run = () => discoverClaudeBinary({ ...options([file("2.1.287"), file("2.1.289")], { findExecutableInDir: () => "/fake/bin/claude" }), version: "2.1.200" });
    expect(run).toThrow(ClaudeVersionNotInstalledError);
    expect(run).toThrow(/Claude Code 2\.1\.200 is pinned .* Installed: 2\.1\.287, 2\.1\.289\./);
  });

  it("says no versions are installed when the directory has nothing runnable", () => {
    expect(() => discoverClaudeBinary({ ...options([]), version: "2.1.200" })).toThrow(/no versions are installed there/);
  });

  it("does not count an entry that is not runnable as installed", () => {
    for (const broken of [file("2.1.200", { isExecutable: false }), file("2.1.200", { sizeBytes: 0 }), file("2.1.200", { isFile: false })]) {
      expect(() => discoverClaudeBinary({ ...options([broken, file("2.1.289")]), version: "2.1.200" })).toThrow(ClaudeVersionNotInstalledError);
    }
  });
});

describe("installedVersions", () => {
  it("lists the runnable versions oldest first and skips everything else", () => {
    expect(installedVersions([file("2.1.289"), file("2.1.9"), file(".DS_Store"), file("2.1.288", { isExecutable: false })])).toEqual(["2.1.9", "2.1.289"]);
  });
});

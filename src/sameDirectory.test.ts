import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ignoresCase, sameDirectory } from "./sameDirectory";

// The other tests of this module are cases of the conformance corpus (conformance/function/same-directory.json). These two depend on what the filesystem under the temporary directory does with letter case, which no case can hold.

describe("sameDirectory", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "same-directory-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is true for two spellings of a name only where the filesystem ignores case", () => {
    fs.mkdirSync(path.join(root, "Mixed"));
    expect(sameDirectory(path.join(root, "Mixed"), path.join(root, "MIXED"))).toBe(fs.existsSync(path.join(root, "MIXED")));
  });
});

describe("ignoresCase", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ignores-case-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("answers what the filesystem does with a name in the directory, without leaving anything behind", () => {
    fs.mkdirSync(path.join(root, "probe"));
    const expected = fs.existsSync(path.join(root, "PROBE"));
    fs.rmSync(path.join(root, "probe"), { recursive: true });
    expect(ignoresCase(root)).toBe(expected);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

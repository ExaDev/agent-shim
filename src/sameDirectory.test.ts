import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ignoresCase, sameDirectory } from "./sameDirectory";


describe("sameDirectory", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "same-directory-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is true for a directory and a symlink to it, false for two directories, and false when either does not exist", () => {
    fs.mkdirSync(path.join(root, "a"));
    fs.mkdirSync(path.join(root, "b"));
    fs.symlinkSync(path.join(root, "a"), path.join(root, "link"));
    expect(sameDirectory(path.join(root, "a"), path.join(root, "link"))).toBe(true);
    expect(sameDirectory(path.join(root, "a"), path.join(root, "b"))).toBe(false);
    expect(sameDirectory(path.join(root, "a"), path.join(root, "missing"))).toBe(false);
    expect(sameDirectory(path.join(root, "missing"), path.join(root, "also-missing"))).toBe(false);
  });

  it("is false, not thrown, for a path that cannot be reached: a cycle of links, or a path through a file", () => {
    fs.mkdirSync(path.join(root, "a"));
    fs.symlinkSync(path.join(root, "loop-b"), path.join(root, "loop-a"));
    fs.symlinkSync(path.join(root, "loop-a"), path.join(root, "loop-b"));
    fs.writeFileSync(path.join(root, "file"), "");
    expect(sameDirectory(path.join(root, "loop-a"), path.join(root, "loop-b"))).toBe(false);
    expect(sameDirectory(path.join(root, "a"), path.join(root, "loop-a"))).toBe(false);
    expect(sameDirectory(path.join(root, "file", "below"), path.join(root, "a"))).toBe(false);
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

  it("is false for a directory that does not exist, which has no names to fold", () => {
    expect(ignoresCase(path.join(root, "missing"))).toBe(false);
  });
});

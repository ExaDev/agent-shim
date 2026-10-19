import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { realStatuslinePorts } from "./ports";

/** More bytes than any file these tests write, so a read of that size returns a file whole. */
const MORE_THAN_THE_FILE = 1_000;

describe("realStatuslinePorts", () => {
  const ports = realStatuslinePorts({ HOME: "/h" });

  it("carries the environment it was given and the home directory", () => {
    expect(ports.env).toEqual({ HOME: "/h" });
    expect(ports.homeDirectory).toBe(os.homedir());
  });

  it("reads a file's text, and reports a file it cannot read as undefined", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      const file = path.join(dir, "a.txt");
      fs.writeFileSync(file, "hello");
      expect(ports.readText(file)).toBe("hello");
      expect(ports.readText(path.join(dir, "missing.txt"))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("reads the end of a file from a line boundary, the whole file when it fits, and undefined when it cannot be read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      const file = path.join(dir, "log.jsonl");
      fs.writeFileSync(file, "first line\nsecond line\nthird line\n");
      expect(ports.readTail(file, MORE_THAN_THE_FILE)).toBe("first line\nsecond line\nthird line\n");
      // A cut inside the second line drops its partial remainder, leaving only the whole line after it.
      expect(ports.readTail(file, "d line\nthird line\n".length)).toBe("third line\n");
      expect(ports.readTail(file, "third line\n".length)).toBe("");
      expect(ports.readTail(path.join(dir, "missing.jsonl"), MORE_THAN_THE_FILE)).toBeUndefined();
      // A multi-byte character cut in half sits in the partial first line, so it never reaches the text.
      fs.writeFileSync(file, "caf\u00e9 au lait\nnext\n");
      expect(ports.readTail(file, "\u00a9 au lait\nnext\n".length - 1)).toBe("next\n");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("runs a program without a shell in the directory given, and reports a failure as undefined", () => {
    expect(ports.run(process.execPath, ["-p", "process.cwd()"], os.tmpdir())).toBe(`${fs.realpathSync(os.tmpdir())}\n`);
    expect(ports.run(process.execPath, ["-e", "process.exit(3)"], os.tmpdir())).toBeUndefined();
    expect(ports.run("/nonexistent/program", [], os.tmpdir())).toBeUndefined();
    expect(ports.run("echo", ["$HOME"], os.tmpdir())).toBe("$HOME\n");
  });

  it("tells a directory from anything else without following a final link, and nothing from a missing path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "file"), "x");
      fs.symlinkSync(path.join(dir, "sub"), path.join(dir, "link"));
      expect(ports.entryKind(path.join(dir, "sub"))).toBe("directory");
      expect(ports.entryKind(path.join(dir, "file"))).toBe("other");
      expect(ports.entryKind(path.join(dir, "link"))).toBe("other");
      expect(ports.entryKind(path.join(dir, "missing"))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("resolves links to the real path, and reports a missing path as undefined", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.symlinkSync(path.join(dir, "sub"), path.join(dir, "link"));
      expect(ports.realPath(path.join(dir, "link"))).toBe(fs.realpathSync(path.join(dir, "sub")));
      expect(ports.realPath(path.join(dir, "missing"))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("reads when a file was last modified, and reports a missing file as undefined", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      const file = path.join(dir, "a.txt");
      fs.writeFileSync(file, "x");
      const modified = new Date("2026-01-02T03:04:05.000Z");
      fs.utimesSync(file, modified, modified);
      expect(ports.modifiedAtMs(file)).toBe(modified.getTime());
      expect(ports.modifiedAtMs(path.join(dir, "missing"))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

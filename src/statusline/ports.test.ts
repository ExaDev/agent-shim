import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { realStatuslinePorts } from "./ports";

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

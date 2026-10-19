import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { realStatuslinePorts } from "./ports";

/** The ten bytes the range tests read from, and the ranges they read: from, length. */
const DIGITS = "0123456789";
const MID_RANGE = { start: 2, length: 3 };
const TAIL_RANGE = { start: 8, length: 100 };
const AT_END_RANGE = { start: 10, length: 5 };
const PAST_END_RANGE = { start: 50, length: 5 };

describe("realStatuslinePorts", () => {
  const ports = realStatuslinePorts({ HOME: "/h" });

  it("carries the environment it was given and the home directory", () => {
    expect(ports.env).toEqual({ HOME: "/h" });
    expect(ports.homeDirectory).toBe(os.homedir());
  });

  it("tells the time in the machine's own locale and time zone", () => {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    expect(ports.clock).toEqual({ locale: resolved.locale, timeZone: resolved.timeZone });
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

  it("reads a range of a file with the file's whole size, never more bytes than asked for", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      const file = path.join(dir, "range.txt");
      fs.writeFileSync(file, DIGITS);
      const text = ({ start, length }: { start: number; length: number }): { size: number | undefined; text: string | undefined } => {
        const range = ports.readRange(file, start, length);
        return { size: range?.size, text: range === undefined ? undefined : new TextDecoder().decode(range.bytes) };
      };
      expect(text(MID_RANGE)).toEqual({ size: 10, text: "234" });
      expect(text(TAIL_RANGE)).toEqual({ size: 10, text: "89" });
      expect(text(AT_END_RANGE)).toEqual({ size: 10, text: "" });
      expect(text(PAST_END_RANGE)).toEqual({ size: 10, text: "" });
      expect(text({ start: 0, length: 0 })).toEqual({ size: 10, text: "" });
      expect(ports.readRange(path.join(dir, "missing.txt"), 0, MID_RANGE.length)).toBeUndefined();
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

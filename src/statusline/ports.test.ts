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

/** The permission bits of a file only its owner may read and write, and the mask that selects the permission bits of a mode. */
const OWNER_READ_WRITE = 0o600;
const OWNER_ONLY_MASK = 0o777;

describe("realStatuslinePorts", () => {
  const ports = realStatuslinePorts({ HOME: "/h" }, "/state");

  it("carries the environment it was given and the home directory", () => {
    expect(ports.env).toEqual({ HOME: "/h" });
    expect(ports.homeDirectory).toBe(os.homedir());
  });

  it("tells the time in the time zone the process runs under, and in a locale that is a well-formed tag", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Asia/Tokyo";
      const { clock } = realStatuslinePorts({}, "/state");
      expect(clock.timeZone).toBe("Asia/Tokyo");
      expect(Intl.getCanonicalLocales(clock.locale)).toEqual([clock.locale]);
    } finally {
      if (original === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = original;
      }
    }
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

  describe("a program that outruns the limit", () => {
    /** How long the programs below ask to run for: far longer than the limit, so returning before it is over can only mean the program was killed. */
    const PROGRAM_RUN_MS = 60_000;

    it("is killed with a signal it cannot trap, and the call returns before the program would have finished", () => {
      const script = `process.on("SIGTERM", () => {}); setTimeout(() => {}, ${String(PROGRAM_RUN_MS)});`;
      const start = Date.now();
      expect(ports.run(process.execPath, ["-e", script], os.tmpdir())).toBeUndefined();
      expect(Date.now() - start).toBeLessThan(PROGRAM_RUN_MS);
    });

    it("does not hold the call through a process it started that still has the output open", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
      const pidFile = path.join(dir, "pid");
      const leftover = `setTimeout(() => {}, ${String(PROGRAM_RUN_MS)});`;
      const script = `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leftover)}], { stdio: ["ignore", "inherit", "ignore"] }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setTimeout(() => {}, ${String(PROGRAM_RUN_MS)});`;
      try {
        const start = Date.now();
        expect(ports.run(process.execPath, ["-e", script], os.tmpdir())).toBeUndefined();
        expect(Date.now() - start).toBeLessThan(PROGRAM_RUN_MS);
      } finally {
        // The leftover is outside what the port can reach, so the test ends it.
        if (fs.existsSync(pidFile)) {
          process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
        }
        fs.rmSync(dir, { recursive: true });
      }
    });
    it("returns the output of a program that exits at once, though a process it started still has the output open", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
      const pidFile = path.join(dir, "pid");
      const leftover = `setTimeout(() => {}, ${String(PROGRAM_RUN_MS)});`;
      const script = `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leftover)}], { stdio: ["ignore", "inherit", "ignore"] }); child.unref(); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); process.stdout.write("parent\\n");`;
      try {
        const start = Date.now();
        expect(ports.run(process.execPath, ["-e", script], os.tmpdir())).toBe("parent\n");
        expect(Date.now() - start).toBeLessThan(PROGRAM_RUN_MS);
      } finally {
        // The leftover is outside what the port can reach, so the test ends it.
        if (fs.existsSync(pidFile)) {
          process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
        }
        fs.rmSync(dir, { recursive: true });
      }
    });
  });

  describe("the output of a program", () => {
    const OUTPUT_BYTES = 100_000;
    /** The bound on a program's output, 1 MiB, and one byte over twice that, past which no shell lets the file grow. */
    const OUTPUT_BOUND_BYTES = 1_048_576;
    const TOO_MUCH_BYTES = OUTPUT_BOUND_BYTES * 2 + 1;
    const write = (bytes: number): string[] => ["-e", `require("node:fs").writeSync(1, "x".repeat(${String(bytes)}));`];

    it("is returned whole when it is within the bound", () => {
      expect(ports.run(process.execPath, write(OUTPUT_BYTES), os.tmpdir())?.length).toBe(OUTPUT_BYTES);
    });

    it.skipIf(process.platform === "win32")("is not returned, and the program is stopped, when it writes more than the bound", () => {
      expect(ports.run(process.execPath, write(TOO_MUCH_BYTES), os.tmpdir())).toBeUndefined();
    });

    it.skipIf(process.platform === "win32")("starts the program with a limit on the size of the file it writes, so a program that never stops cannot fill the disk", () => {
      /** The bound on a program's output, 1 MiB, in the 512-byte blocks `ulimit -f` is asked in. */
      const boundInBlocks = 2048;
      expect(Number(ports.run("/bin/sh", ["-c", "ulimit -f"], os.tmpdir())?.trim())).toBe(boundInBlocks);
    });

    it("leaves no file behind, whether the program succeeded, failed, or was killed", () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
      const previous = process.env.TMPDIR;
      process.env.TMPDIR = scratch;
      try {
        expect(ports.run(process.execPath, ["-p", "1"], os.tmpdir())).toBe("1\n");
        expect(ports.run(process.execPath, ["-e", "process.exit(3)"], os.tmpdir())).toBeUndefined();
        expect(ports.run(process.execPath, write(TOO_MUCH_BYTES), os.tmpdir())).toBeUndefined();
        expect(ports.run("/nonexistent/program", [], os.tmpdir())).toBeUndefined();
        expect(fs.readdirSync(scratch)).toEqual([]);
      } finally {
        if (previous === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = previous;
        }
        fs.rmSync(scratch, { recursive: true });
      }
    });

    it("keeps its arguments as they are, whatever characters they hold, and runs a program named like an option", () => {
      expect(ports.run(process.execPath, ["-p", "process.argv[1]", "--", "a b; $HOME 'q' \"d\""], os.tmpdir())).toBe("a b; $HOME 'q' \"d\"\n");
    });
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

  it("carries the state directory it was given", () => {
    expect(ports.stateDirectory).toBe("/state");
  });

  it("lists a directory's entries, and reports what is missing as undefined", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "x");
      fs.symlinkSync(dir, path.join(dir, "self"));
      expect(ports.listDirectory(dir)).toEqual(expect.arrayContaining(["a.txt", "self"]));
      expect(ports.listDirectory(path.join(dir, "missing"))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("writes a file's text, creating its directories, replacing it whole and leaving no temporary file behind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      const file = path.join(dir, "deep", "er", "ledger.json");
      ports.writeText(file, "first");
      ports.writeText(file, "second");
      expect(fs.readFileSync(file, "utf8")).toBe("second");
      expect(fs.readdirSync(path.dirname(file))).toEqual(["ledger.json"]);
      expect(fs.statSync(file).mode & OWNER_ONLY_MASK).toBe(OWNER_READ_WRITE);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("drops a write it cannot make, without throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      fs.writeFileSync(path.join(dir, "blocker"), "x");
      expect(() => {
        ports.writeText(path.join(dir, "blocker", "ledger.json"), "x");
      }).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("removes a file or a whole directory, and a path that is not there is not an error", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      fs.mkdirSync(path.join(dir, "tree", "inner"), { recursive: true });
      fs.writeFileSync(path.join(dir, "tree", "inner", "a.txt"), "x");
      fs.writeFileSync(path.join(dir, "b.txt"), "x");
      ports.removePath(path.join(dir, "tree"));
      ports.removePath(path.join(dir, "b.txt"));
      expect(() => {
        ports.removePath(path.join(dir, "missing"));
      }).not.toThrow();
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("reports the machine's memory in use against its total", () => {
    const use = ports.memoryUse();
    expect(use?.totalBytes).toBe(os.totalmem());
    expect(use?.usedBytes).toBeGreaterThan(0);
    expect(use?.usedBytes).toBeLessThanOrEqual(os.totalmem());
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { execFileSync, spawnSync } from "node:child_process";

import { fileSizeLimitedCommand, realStatuslinePorts, RUN_MAX_OUTPUT_BYTES, RUN_TIMEOUT_MS, STALE_RUN_DIRECTORY_MS } from "./ports";

/** The ten bytes the range tests read from, and the ranges they read: from, length. */
const DIGITS = "0123456789";
const MID_RANGE = { start: 2, length: 3 };
const TAIL_RANGE = { start: 8, length: 100 };
const AT_END_RANGE = { start: 10, length: 5 };
const PAST_END_RANGE = { start: 50, length: 5 };

/** The permission bits of a file only its owner may read and write, and the mask that selects the permission bits of a mode. */
const OWNER_READ_WRITE = 0o600;
const OWNER_ONLY_MASK = 0o777;

/** How old a run directory is made for the next call to sweep it: well past the age at which one is stale. */
const STALE_MS = STALE_RUN_DIRECTORY_MS * 2;

/** How many times the size POSIX counts `ulimit -f` in a shell's own block may be: bash counts in blocks twice that size, so under the limit a file may reach this multiple of the bound and no further. */
const MAX_BLOCK_MULTIPLE = 2;

/** What the programs that write a large file ask to write: a whole bound more than any shell lets a file reach under the limit. */
const LARGE_FILE_BYTES = RUN_MAX_OUTPUT_BYTES * (MAX_BLOCK_MULTIPLE + 1);

/** The limit the tests that read a program's output give the ports: far beyond what a loaded machine takes to start an interpreter, so a program killed at the production limit under load is never mistaken for one that returned nothing. The tests of the limit itself give their own. */
const OUTPUT_TEST_RUN_MS = 60_000;

/** `use`d with ports whose state directory is a throwaway one (the file-backed runs need to write there), removed afterwards, and whose runs are killed after `runTimeoutMs`. */
function withStateDirectory<T>(use: (ports: ReturnType<typeof realStatuslinePorts>) => T, runTimeoutMs: number = OUTPUT_TEST_RUN_MS): T {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
  try {
    return use(realStatuslinePorts({}, state, runTimeoutMs));
  } finally {
    fs.rmSync(state, { recursive: true });
  }
}

describe("realStatuslinePorts", () => {
  const ports = realStatuslinePorts({ HOME: "/h" }, "/state", OUTPUT_TEST_RUN_MS);

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

  it.skipIf(process.platform === "win32")("reads nothing from a FIFO instead of blocking until something opens its other end", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
    try {
      const fifo = path.join(dir, "pipe");
      execFileSync("mkfifo", [fifo]);
      // Holding the FIFO open for reading and writing keeps a regression from blocking this test: an open for reading then succeeds at once and the reads below return something, where the ports must return nothing.
      const held = fs.openSync(fifo, fs.constants.O_RDWR);
      try {
        expect(ports.readRange(fifo, 0, MID_RANGE.length)).toBeUndefined();
      } finally {
        fs.closeSync(held);
      }
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

    it.each([[{}], [{ outputInFile: true }]])("is killed at the limit the ports were given, not only at the production one (%j)", (options) => {
      const GIVEN_LIMIT_MS = 100;
      const script = `setTimeout(() => {}, ${String(PROGRAM_RUN_MS)});`;
      const start = Date.now();
      expect(withStateDirectory((withFiles) => withFiles.run(process.execPath, ["-e", script], os.tmpdir(), options), GIVEN_LIMIT_MS)).toBeUndefined();
      expect(Date.now() - start).toBeLessThan(RUN_TIMEOUT_MS);
    });

    it.each([[{}], [{ outputInFile: true }]])("is killed with a signal it cannot trap, and the call returns before the program would have finished (%j)", (options) => {
      const script = `process.on("SIGTERM", () => {}); setTimeout(() => {}, ${String(PROGRAM_RUN_MS)});`;
      const start = Date.now();
      expect(withStateDirectory((withFiles) => withFiles.run(process.execPath, ["-e", script], os.tmpdir(), options), RUN_TIMEOUT_MS)).toBeUndefined();
      expect(Date.now() - start).toBeLessThan(PROGRAM_RUN_MS);
    });

    it("returns the output of a program that exits at once, though a process it started still has the output open, when the output goes to a file", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
      const pidFile = path.join(dir, "pid");
      const leftover = `setTimeout(() => {}, ${String(PROGRAM_RUN_MS)});`;
      const script = `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leftover)}], { stdio: ["ignore", "inherit", "ignore"] }); child.unref(); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); process.stdout.write("parent\\n");`;
      try {
        const start = Date.now();
        expect(withStateDirectory((withFiles) => withFiles.run(process.execPath, ["-e", script], os.tmpdir(), { outputInFile: true }))).toBe("parent\n");
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
    /** Half the bound on a program's output: within it, with room to spare. */
    const OUTPUT_BYTES = RUN_MAX_OUTPUT_BYTES / 2;
    /** One byte over the most a shell lets a file grow to under the limit, past which no output is kept. */
    const TOO_MUCH_BYTES = RUN_MAX_OUTPUT_BYTES * MAX_BLOCK_MULTIPLE + 1;
    const write = (bytes: number): string[] => ["-e", `require("node:fs").writeSync(1, "x".repeat(${String(bytes)}));`];

    it.each([[{}], [{ outputInFile: true }]])("is returned whole when it is within the bound (%j)", (options) => {
      expect(withStateDirectory((withFiles) => withFiles.run(process.execPath, write(OUTPUT_BYTES), os.tmpdir(), options))?.length).toBe(OUTPUT_BYTES);
    });

    it("is not returned from a file when it reaches the bound, as a shell that counts the limit in POSIX's blocks leaves a file cut off there by a program that ignores the signal and exits normally", () => {
      expect(withStateDirectory((withFiles) => withFiles.run(process.execPath, write(RUN_MAX_OUTPUT_BYTES), os.tmpdir(), { outputInFile: true }))).toBeUndefined();
      expect(withStateDirectory((withFiles) => withFiles.run(process.execPath, write(RUN_MAX_OUTPUT_BYTES - 1), os.tmpdir(), { outputInFile: true }))?.length).toBe(RUN_MAX_OUTPUT_BYTES - 1);
    });

    it.each([[{}], [{ outputInFile: true }]])("is not returned when it is more than the bound (%j)", (options) => {
      expect(withStateDirectory((withFiles) => withFiles.run(process.execPath, write(TOO_MUCH_BYTES), os.tmpdir(), options))).toBeUndefined();
    });

    it.skipIf(process.platform === "win32")("goes to a file under a limit on the size of any file the program writes, so a program that never stops cannot fill the disk", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
      const written = path.join(dir, "written");
      const writeLargeFileTo = ["-c", `head -c ${String(LARGE_FILE_BYTES)} /dev/zero > "$0"; exit 0`, written];
      try {
        withStateDirectory((withFiles) => withFiles.run("/bin/sh", writeLargeFileTo, os.tmpdir(), { outputInFile: true }));
        expect(fs.statSync(written).size).toBeGreaterThanOrEqual(RUN_MAX_OUTPUT_BYTES);
        expect(fs.statSync(written).size).toBeLessThanOrEqual(RUN_MAX_OUTPUT_BYTES * MAX_BLOCK_MULTIPLE);
        withStateDirectory((withFiles) => withFiles.run("/bin/sh", writeLargeFileTo, os.tmpdir()));
        expect(fs.statSync(written).size).toBe(LARGE_FILE_BYTES);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });

    it.skipIf(process.platform === "win32")("goes to a file only its owner may read and write", () => {
      // The program states the mode of its own standard output, which is the file the port made; the permission bits mean nothing on Windows, which is why the test is skipped there.
      const mode = withStateDirectory((withFiles) => withFiles.run(process.execPath, ["-p", `require("node:fs").fstatSync(1).mode & ${String(OWNER_ONLY_MASK)}`], os.tmpdir(), { outputInFile: true }));
      expect(mode).toBe(`${String(OWNER_READ_WRITE)}\n`);
    });

    it("keeps its arguments as they are, whatever characters they hold", () => {
      const awkward = "a b; $HOME 'q' \"d\" *";
      for (const options of [{}, { outputInFile: true }]) {
        expect(withStateDirectory((withFiles) => withFiles.run(process.execPath, ["-p", "process.argv[1]", "--", awkward], os.tmpdir(), options))).toBe(`${awkward}\n`);
      }
    });

    it("sweeps what other calls left whatever state it is in: a dangling link, an entry that vanishes while it is looked at, and old directories after them", () => {
      const state = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
      const runRoot = path.join(state, "run");
      fs.mkdirSync(runRoot, { recursive: true });
      const longAgo = new Date(Date.now() - STALE_MS);
      const old = path.join(runRoot, "agent-shim-run-b-old");
      fs.mkdirSync(old);
      fs.utimesSync(old, longAgo, longAgo);
      const dangling = path.join(runRoot, "agent-shim-run-a-dangling");
      fs.symlinkSync(path.join(state, "nowhere"), dangling);
      fs.lutimesSync(dangling, longAgo, longAgo);
      const vanishing = path.join(runRoot, "agent-shim-run-c-vanishing");
      fs.mkdirSync(vanishing);
      const lstat = fs.lstatSync;
      const spy = vi.spyOn(fs, "lstatSync").mockImplementation((target: fs.PathLike) => {
        if (String(target) === vanishing) {
          throw new Error("ENOENT: no such file or directory");
        }
        return lstat(target);
      });
      try {
        expect(realStatuslinePorts({}, state, OUTPUT_TEST_RUN_MS).run(process.execPath, ["-p", "1"], os.tmpdir(), { outputInFile: true })).toBe("1\n");
      } finally {
        spy.mockRestore();
      }
      try {
        expect(fs.readdirSync(runRoot).sort()).toEqual(["agent-shim-run-c-vanishing"]);
      } finally {
        fs.rmSync(state, { recursive: true });
      }
    });

    it("keeps the run directory of a call that is still running, even one that has outrun its limit twice over, and sweeps one past the stale age", () => {
      const state = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
      const runRoot = path.join(state, "run");
      const overrun = path.join(runRoot, "agent-shim-run-overrun");
      const stale = path.join(runRoot, "agent-shim-run-stale");
      fs.mkdirSync(overrun, { recursive: true });
      fs.mkdirSync(stale);
      const setAge = (directory: string, ageMs: number): void => {
        const time = new Date(Date.now() - ageMs);
        fs.utimesSync(directory, time, time);
      };
      // A call on a loaded machine can take well past its limit before it is killed; its directory must survive the other calls' sweeps meanwhile.
      setAge(overrun, RUN_TIMEOUT_MS * 2);
      setAge(stale, STALE_RUN_DIRECTORY_MS + 1);
      try {
        expect(realStatuslinePorts({}, state, OUTPUT_TEST_RUN_MS).run(process.execPath, ["-p", "1"], os.tmpdir(), { outputInFile: true })).toBe("1\n");
        expect(fs.readdirSync(runRoot)).toEqual(["agent-shim-run-overrun"]);
      } finally {
        fs.rmSync(state, { recursive: true });
      }
    });

    it("does not make the run directory when the memory is read, which uses a pipe", () => {
      const state = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
      try {
        realStatuslinePorts({}, state).memoryUse();
        expect(fs.existsSync(path.join(state, "run"))).toBe(false);
      } finally {
        fs.rmSync(state, { recursive: true });
      }
    });

    it("leaves no file behind, whether the program succeeded, failed, or was killed, and sweeps what a cancelled call left", () => {
      const state = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-ports-"));
      const runRoot = path.join(state, "run");
      const stale = path.join(runRoot, "agent-shim-run-stale");
      const fresh = path.join(runRoot, "agent-shim-run-fresh");
      const unrelated = path.join(runRoot, "other");
      fs.mkdirSync(stale, { recursive: true });
      fs.mkdirSync(fresh);
      fs.mkdirSync(unrelated);
      const longAgo = new Date(Date.now() - STALE_MS);
      fs.utimesSync(stale, longAgo, longAgo);
      fs.utimesSync(unrelated, longAgo, longAgo);
      try {
        const own = realStatuslinePorts({}, state, OUTPUT_TEST_RUN_MS);
        expect(own.run(process.execPath, ["-p", "1"], os.tmpdir(), { outputInFile: true })).toBe("1\n");
        expect(fs.readdirSync(runRoot).sort()).toEqual(["agent-shim-run-fresh", "other"]);
        expect(own.run(process.execPath, ["-e", "process.exit(3)"], os.tmpdir(), { outputInFile: true })).toBeUndefined();
        expect(own.run(process.execPath, write(TOO_MUCH_BYTES), os.tmpdir(), { outputInFile: true })).toBeUndefined();
        expect(own.run("/nonexistent/program", [], os.tmpdir(), { outputInFile: true })).toBeUndefined();
        expect(fs.readdirSync(runRoot).sort()).toEqual(["agent-shim-run-fresh", "other"]);
      } finally {
        fs.rmSync(state, { recursive: true });
      }
    });
  });

  describe("the command that limits the size of a file, under each POSIX shell that stands in for /bin/sh", () => {
    /** The shells a system may have as /bin/sh, by where they are found: dash on Debian and Ubuntu, bash (which runs in POSIX mode when started as `sh`), the Korn shell, zsh (which emulates sh when started as `sh`) and busybox's ash. A shell that is not here is skipped, and the test says so by name. */
    const SHELLS: readonly (readonly [string, readonly string[]])[] = [
      ["dash", ["/bin/dash", "/usr/bin/dash"]],
      ["bash", ["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"]],
      ["ksh", ["/bin/ksh", "/usr/bin/ksh"]],
      ["zsh", ["/bin/zsh", "/usr/bin/zsh"]],
      ["busybox", ["/bin/busybox", "/usr/bin/busybox"]],
    ];
    const found = (candidates: readonly string[]): string | undefined => candidates.find((candidate) => fs.existsSync(candidate));

    /** Runs `file` and `args` through the limited command with `binary` started under the name `sh`, which is how a shell learns to behave as POSIX sh. */
    function through(binary: string, file: string, args: readonly string[]): { readonly status: number | null; readonly stdout: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-shell-"));
      try {
        const shell = path.join(dir, "sh");
        fs.symlinkSync(binary, shell);
        const { command, args: commandArgs } = fileSizeLimitedCommand(shell, file, args);
        const result = spawnSync(command, [...commandArgs], { encoding: "utf8" });
        return { status: result.status, stdout: result.stdout };
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    }

    for (const [name, candidates] of SHELLS) {
      const binary = process.platform === "win32" ? undefined : found(candidates);
      // A shell that is not installed here is a skipped test whose title says so, not a pass.
      (binary === undefined ? it.skip : it)(`${name}${binary === undefined ? " is not installed on this machine, so the limited command is not run under it" : " runs the program with the limit set and its arguments untouched"}`, () => {
        if (binary === undefined) {
          return;
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-shell-"));
        try {
          const written = path.join(dir, "written");
          expect(through(binary, "/bin/sh", ["-c", `head -c ${String(LARGE_FILE_BYTES)} /dev/zero > "$0"; exit 0`, written]).status).toBe(0);
          // A shell that counts the limit in POSIX's blocks stops the file at the bound, one that counts in larger blocks at a multiple of it (at most MAX_BLOCK_MULTIPLE), and none lets it reach what the program wrote.
          expect(fs.statSync(written).size).toBeGreaterThanOrEqual(RUN_MAX_OUTPUT_BYTES);
          expect(fs.statSync(written).size).toBeLessThanOrEqual(RUN_MAX_OUTPUT_BYTES * MAX_BLOCK_MULTIPLE);
        } finally {
          fs.rmSync(dir, { recursive: true });
        }
        expect(through(binary, process.execPath, ["-p", "process.argv[1]", "--", "a b; $HOME 'q'"])).toEqual({ status: 0, stdout: "a b; $HOME 'q'\n" });
        expect(through(binary, "/nonexistent/program", []).status).not.toBe(0);
      });
    }
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { realCredentialPort, resolveContentSourcePath, resolveExecutableCandidate, resolveOwnExecutablePath } from "./realPorts";

/** Owner read and write only: the mode a secret file is written with here. */
const OWNER_ONLY_PERMISSIONS = 0o600;
/** The permission bits of a file mode, without its type bits. */
const PERMISSION_BITS = 0o777;

describe("realCredentialPort", () => {
  it("reads a secret file with its permission bits, and reports a missing one as not found", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-port-"));
    try {
      const file = path.join(dir, "token");
      fs.writeFileSync(file, "tok\n", { mode: OWNER_ONLY_PERMISSIONS });
      const read = realCredentialPort.readSecretFile(file);
      expect(read).toMatchObject({ found: true, content: "tok\n" });
      if (process.platform !== "win32") {
        expect(read.found && read.mode !== undefined && (read.mode & PERMISSION_BITS)).toBe(OWNER_ONLY_PERMISSIONS);
      }
      expect(realCredentialPort.readSecretFile(path.join(dir, "missing"))).toEqual({ found: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures a command's stdout, and its stderr and status when it fails", () => {
    const options = { timeoutMs: 10_000, interactive: false };
    expect(realCredentialPort.runCommand([process.execPath, "-e", "process.stdout.write('tok')"], options)).toEqual({
      status: 0,
      stdout: "tok",
      stderr: "",
      timedOut: false,
    });
    expect(realCredentialPort.runCommand([process.execPath, "-e", "process.stderr.write('nope'); process.exit(3)"], options)).toMatchObject({
      status: 3,
      stderr: "nope",
      timedOut: false,
    });
  });

  it("captures an interactive command's stdout while its stderr goes to the terminal", () => {
    expect(realCredentialPort.runCommand([process.execPath, "-e", "process.stdout.write('tok')"], { timeoutMs: 10_000, interactive: true })).toEqual({
      status: 0,
      stdout: "tok",
      stderr: "",
      timedOut: false,
    });
  });

  it("kills a command that outlives its timeout and reports it as timed out", () => {
    const result = realCredentialPort.runCommand([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 200, interactive: false });
    expect(result.timedOut).toBe(true);
    expect(result.status).toBeNull();
  });

  it("explains a program that cannot be started", () => {
    const result = realCredentialPort.runCommand(["claude-use-no-such-program"], { timeoutMs: 10_000, interactive: false });
    expect(result).toMatchObject({ status: null, timedOut: false });
    expect(result.stderr).toContain("ENOENT");
  });
});

describe("resolveContentSourcePath", () => {
  it("uses execPath when running as a single executable application", () => {
    const result = resolveContentSourcePath({ isSea: true, execPath: "/opt/homebrew/Cellar/claude-use/0.2.3/bin/claude-use", argv1: "claude-use" });
    expect(result).toBe("/opt/homebrew/Cellar/claude-use/0.2.3/bin/claude-use");
  });

  it("uses argv1 (the shebang-resolved script path) when not a single executable application", () => {
    // execPath here would be the Node interpreter itself, not claude-use's own content -- useless.
    const result = resolveContentSourcePath({ isSea: false, execPath: "/usr/local/bin/node", argv1: "/usr/local/lib/node_modules/claude-use/dist/cli.cjs" });
    expect(result).toBe("/usr/local/lib/node_modules/claude-use/dist/cli.cjs");
  });

  it("falls back to execPath when not a single executable application and argv1 is undefined", () => {
    const result = resolveContentSourcePath({ isSea: false, execPath: "/usr/local/bin/node", argv1: undefined });
    expect(result).toBe("/usr/local/bin/node");
  });
});

// A regular file with no execute bit set (owner/group/other all read-write only).
const NON_EXECUTABLE_MODE = 0o644;
// A regular file with the owner's execute bit set, alongside group/other read+execute.
const EXECUTABLE_MODE = 0o755;
// Read-write for owner/group/other, deliberately with no execute bit at all -- used only in the Windows-branch tests below, where mode bits must be irrelevant to the result.
const MODE_WITHOUT_EXECUTE_BITS = 0o666;

describe("resolveExecutableCandidate", () => {
  it("on POSIX, requires the execute mode bits to be set", () => {
    const modes = new Map([["/usr/bin/claude-use", NON_EXECUTABLE_MODE]]); // regular file, not executable
    const result = resolveExecutableCandidate("/usr/bin", "claude-use", {
      platform: "linux",
      pathext: undefined,
      statFileMode: (candidate) => modes.get(candidate),
    });
    expect(result).toBeUndefined();
  });

  it("on POSIX, finds a file whose execute bits are set", () => {
    const modes = new Map([["/usr/bin/claude-use", EXECUTABLE_MODE]]);
    const result = resolveExecutableCandidate("/usr/bin", "claude-use", {
      platform: "linux",
      pathext: undefined,
      statFileMode: (candidate) => modes.get(candidate),
    });
    expect(result).toBe("/usr/bin/claude-use");
  });

  // These use POSIX-style dir/name strings even though they exercise the "platform: win32" branch -- `resolveExecutableCandidate` calls the real `node:path` module internally, which joins/formats paths using whichever platform actually runs the test (POSIX on this machine), independent of the injected `platform` flag (that flag only selects which *branch* of matching logic runs: PATHEXT-based vs POSIX mode-bit-based). Hardcoding backslash-separated expected strings here would silently depend on the host OS actually being Windows to produce a matching join, which this dev machine and most CI runners of this test suite are not.

  it("on Windows, mode bits are irrelevant -- a plain .exe with no execute bits at all must still be found", () => {
    // This is the confirmed real bug: Node's own docs state fs.Stats.mode on Windows only ever exposes owner read/write, never execute -- a POSIX-style (mode & 0o111) check silently rejects every file on Windows, which is exactly why the Scoop shim redirect (a real, explicitly-named .exe) was never found in CI.
    const modes = new Map([[path.join("/scoop/shims", "claude-use.exe"), MODE_WITHOUT_EXECUTE_BITS]]);
    const result = resolveExecutableCandidate("/scoop/shims", "claude-use.exe", {
      platform: "win32",
      pathext: ".COM;.EXE;.BAT;.CMD",
      statFileMode: (candidate) => modes.get(candidate),
    });
    expect(result).toBe(path.join("/scoop/shims", "claude-use.exe"));
  });

  // A real Windows filesystem is case-insensitive, so `statFileMode`'s fake here does a lowercased lookup too -- the implementation appends PATHEXT entries verbatim (".EXE", not ".exe"), which only resolves correctly against a real filesystem or a fake that itself accounts for case-insensitivity, matching Windows' own semantics rather than a Map's exact-case default.
  function caseInsensitiveModes(entries: readonly (readonly [string, number])[]): (candidate: string) => number | undefined {
    const modes = new Map(entries.map(([candidate, mode]) => [candidate.toLowerCase(), mode]));
    return (candidate) => modes.get(candidate.toLowerCase());
  }

  it("on Windows, tries each PATHEXT extension in turn for a bare name with no extension", () => {
    const statFileMode = caseInsensitiveModes([[`${path.join("/bin", "claude")}.exe`, MODE_WITHOUT_EXECUTE_BITS]]);
    const result = resolveExecutableCandidate("/bin", "claude", {
      platform: "win32",
      pathext: ".COM;.EXE;.BAT;.CMD",
      statFileMode,
    });
    expect(result).toBe(`${path.join("/bin", "claude")}.EXE`);
  });

  it("on Windows, stops at the first PATHEXT extension that matches", () => {
    const statFileMode = caseInsensitiveModes([
      [`${path.join("/bin", "claude")}.bat`, MODE_WITHOUT_EXECUTE_BITS],
      [`${path.join("/bin", "claude")}.cmd`, MODE_WITHOUT_EXECUTE_BITS],
    ]);
    const result = resolveExecutableCandidate("/bin", "claude", {
      platform: "win32",
      pathext: ".COM;.EXE;.BAT;.CMD",
      statFileMode,
    });
    expect(result).toBe(`${path.join("/bin", "claude")}.BAT`);
  });

  it("on Windows, falls back to the documented default PATHEXT list when unset", () => {
    const statFileMode = caseInsensitiveModes([[`${path.join("/bin", "claude")}.exe`, MODE_WITHOUT_EXECUTE_BITS]]);
    const result = resolveExecutableCandidate("/bin", "claude", {
      platform: "win32",
      pathext: undefined,
      statFileMode,
    });
    expect(result).toBe(`${path.join("/bin", "claude")}.EXE`);
  });

  it("on Windows, returns undefined when nothing matches any extension", () => {
    const result = resolveExecutableCandidate("/bin", "claude", {
      platform: "win32",
      pathext: ".COM;.EXE;.BAT;.CMD",
      statFileMode: () => undefined,
    });
    expect(result).toBeUndefined();
  });
});

describe("resolveOwnExecutablePath", () => {
  const execPath = "/opt/homebrew/Cellar/claude-use/0.2.0/bin/claude-use";
  const cwd = "/Users/runner/work/claude-use/claude-use";

  it("falls back to execPath when argv1 is undefined and no PATH-visible entry exists", () => {
    const result = resolveOwnExecutablePath({
      argv1: undefined,
      execPath,
      cwd,
      pathDirs: [],
      findExecutableInDir: () => undefined,
    });
    expect(result).toBe(execPath);
  });

  it("redirects an execPath fallback (argv1 undefined) to a PATH-visible sibling too", () => {
    // It's unconfirmed whether a Windows SEA binary duplicates argv[0] into argv[1] the way the POSIX build does (confirmed via a real macOS/Linux SEA binary) -- if it doesn't, argv1 comes back undefined and this falls through to execPath instead. The same Scoop-style redirect must apply here too, not just to a path-shaped argv1, since execPath's own directory can equally be a Scoop-style off-PATH app directory.
    const offPathExecPath = "/Users/runneradmin/scoop/apps/claude-use/current/claude-use";
    const result = resolveOwnExecutablePath({
      argv1: undefined,
      execPath: offPathExecPath,
      cwd,
      pathDirs: ["/Users/runneradmin/scoop/shims"],
      findExecutableInDir: (dir, name) =>
        dir === "/Users/runneradmin/scoop/shims" && name === "claude-use" ? "/Users/runneradmin/scoop/shims/claude-use" : undefined,
    });
    expect(result).toBe("/Users/runneradmin/scoop/shims/claude-use");
  });

  it("resolves an absolute argv1 directly when its directory is itself on PATH", () => {
    const result = resolveOwnExecutablePath({
      argv1: "/opt/homebrew/bin/claude-use",
      execPath,
      cwd,
      pathDirs: ["/opt/homebrew/bin"],
      findExecutableInDir: () => {
        throw new Error("must not search PATH when the direct candidate's directory is already on PATH");
      },
    });
    expect(result).toBe("/opt/homebrew/bin/claude-use");
  });

  it("resolves a relative argv1 against cwd when cwd is on PATH", () => {
    const result = resolveOwnExecutablePath({
      argv1: "./claude-use",
      execPath,
      cwd,
      pathDirs: [cwd],
      findExecutableInDir: () => undefined,
    });
    expect(result).toBe(path.join(cwd, "claude-use"));
  });

  it("redirects to a separately PATH-visible entry when argv1's own directory isn't on PATH -- the Scoop re-exec case", () => {
    // Scoop's own shim (~/scoop/shims/claude-use.exe) is a compiled proxy that launches the real target -- living in a versioned app directory Scoop deliberately keeps off PATH -- as a child process, so this process's own argv1 is an absolute path outside every PATH entry. Confirmed against a real Scoop install: without this redirect, `shim enable` placed `claude.exe` next to the real target, in a directory PATH could never see. Expressed with POSIX-style separators here (rather than real Windows backslash paths) purely so the test is meaningful under whichever platform's native `path` module happens to run it -- the separate backslash-detection test above already covers the platform-specific separator character.
    const result = resolveOwnExecutablePath({
      argv1: "/Users/runneradmin/scoop/apps/claude-use/current/claude-use.exe",
      execPath,
      cwd: "/Users/runneradmin",
      pathDirs: ["/Users/runneradmin/scoop/shims"],
      findExecutableInDir: (dir, name) =>
        dir === "/Users/runneradmin/scoop/shims" && name === "claude-use.exe" ? "/Users/runneradmin/scoop/shims/claude-use.exe" : undefined,
    });
    expect(result).toBe("/Users/runneradmin/scoop/shims/claude-use.exe");
  });

  it("falls back to the direct candidate when its directory isn't on PATH and no PATH-visible entry exists either -- a fresh, not-yet-installed local build", () => {
    const directCandidate = "/Users/joe/dev/claude-use/dist/claude-use-sea";
    const result = resolveOwnExecutablePath({
      argv1: directCandidate,
      execPath,
      cwd: "/Users/joe/dev/claude-use",
      pathDirs: ["/usr/bin", "/opt/homebrew/bin"],
      findExecutableInDir: () => undefined,
    });
    expect(result).toBe(directCandidate);
  });

  it("searches PATH for a bare argv1 -- the SEA-binary-invoked-via-PATH-lookup case", () => {
    // This is the exact scenario that broke every release-verification job: a SEA binary invoked as a bare command found via PATH (e.g. typing `claude-use` at a shell prompt) gets argv1 === "claude-use", with no directory component at all -- confirmed empirically against a real built SEA binary, since Node's own docs only document the direct-invocation case, not this one.
    const pathDirs = ["/usr/bin", "/opt/homebrew/bin", "/other/dir"];
    const result = resolveOwnExecutablePath({
      argv1: "claude-use",
      execPath,
      cwd,
      pathDirs,
      findExecutableInDir: (dir, name) => (dir === "/opt/homebrew/bin" && name === "claude-use" ? "/opt/homebrew/bin/claude-use" : undefined),
    });
    expect(result).toBe("/opt/homebrew/bin/claude-use");
  });

  it("preserves a PATH-visible symlink rather than resolving through it -- the Homebrew Cellar-symlink case", () => {
    // findExecutableInDir returns whatever PATH-visible entry it found (which may itself be a symlink into a Cellar keg) -- resolveOwnExecutablePath must hand that back verbatim, not realpath it, since callers need the PATH-visible location to place a new file where PATH will actually find it.
    const result = resolveOwnExecutablePath({
      argv1: "claude-use",
      execPath,
      cwd,
      pathDirs: ["/opt/homebrew/bin"],
      findExecutableInDir: () => "/opt/homebrew/bin/claude-use",
    });
    expect(result).toBe("/opt/homebrew/bin/claude-use");
  });

  it("stops at the first PATH directory containing a match", () => {
    const seen: string[] = [];
    resolveOwnExecutablePath({
      argv1: "claude-use",
      execPath,
      cwd,
      pathDirs: ["/first", "/second", "/third"],
      findExecutableInDir: (dir) => {
        seen.push(dir);
        return dir === "/first" ? "/first/claude-use" : undefined;
      },
    });
    expect(seen).toEqual(["/first"]);
  });

  it("falls back to execPath when a bare argv1 isn't found anywhere on PATH", () => {
    const result = resolveOwnExecutablePath({
      argv1: "claude-use",
      execPath,
      cwd,
      pathDirs: ["/usr/bin", "/opt/homebrew/bin"],
      findExecutableInDir: () => undefined,
    });
    expect(result).toBe(execPath);
  });

  it("resolves a Windows-style backslash argv1 as a path, not a bare word", () => {
    const argv1 = "bin\\claude-use.exe";
    const winCwd = "C:\\Users\\runner\\work";
    const directCandidate = path.resolve(winCwd, argv1);
    const directDir = path.dirname(directCandidate);
    const result = resolveOwnExecutablePath({
      argv1,
      execPath,
      cwd: winCwd,
      pathDirs: [directDir],
      findExecutableInDir: () => {
        throw new Error("must not search PATH when the direct candidate's directory is already on PATH");
      },
    });
    expect(result).toBe(directCandidate);
  });
});

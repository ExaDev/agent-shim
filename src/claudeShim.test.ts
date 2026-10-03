import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ForeignClaudeEntryError,
  UnsupportedShimSourceError,
  claudeTargetFilename,
  commandFilename,
  disableClaudeShim,
  enableClaudeShim,
  findPathShadow,
  isInvokedAsClaude,
  resolveClaudeTargetPath,
  type LinkFs,
} from "./claudeShim";
import { buildLayoutPaths, type LayoutPaths } from "./paths";

// The owner/group/other execute bits -- a nonzero result means at least one of the three "may execute" bits is set.
const EXECUTE_BITS_MASK = 0o111;

// A minimal NodeJS.ErrnoException-shaped error for tests that need to simulate a specific fs error code -- a real class property, not Object.assign onto a constructed instance, so the code field is type-checked like any other.
class CodedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

describe("claudeShim", () => {
  let root: string;
  let paths: LayoutPaths;
  let binDir: string;
  let sourcePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-shim-test-"));
    paths = buildLayoutPaths(root);
    // realpathSync immediately: enableClaudeShim/disableClaudeShim resolve the running executable's own realpath before deriving a target path (so a package manager's symlink indirection never produces a symlink-of-a- symlink), and macOS's os.tmpdir() itself resolves through a symlink (/var -> /private/var) -- without this, targetPath assertions below would compare a symlinked path against its own dereferenced form and fail.
    binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-shim-bin-test-")));
    sourcePath = path.join(binDir, "agent-shim");
    fs.writeFileSync(sourcePath, "fake-binary-v1", { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  describe("claudeTargetFilename", () => {
    it("names the target `claude` for an extensionless source", () => {
      expect(claudeTargetFilename("/usr/local/bin/agent-shim")).toBe("claude");
    });

    it("names the target `claude.exe` for a .exe source", () => {
      expect(claudeTargetFilename("C:\\bin\\agent-shim.exe")).toBe("claude.exe");
    });

    it("names the target bare `claude`, not `claude.cjs`, for an npm install's dist/cli.cjs", () => {
      expect(claudeTargetFilename("/usr/local/lib/node_modules/agent-shim/dist/cli.cjs")).toBe("claude");
    });
  });

  describe("commandFilename", () => {
    it("adds no extension for an extensionless source, whatever the command name", () => {
      expect(commandFilename("/usr/local/bin/agent-shim", "agent-shim")).toBe("agent-shim");
    });

    it("adds .exe for a .exe source, so doctor looks for the filename PATH would actually hold on Windows", () => {
      expect(commandFilename("C:\\bin\\agent-shim.exe", "agent-shim")).toBe("agent-shim.exe");
    });
  });

  describe("isInvokedAsClaude", () => {
    it("matches the extensionless POSIX name", () => {
      expect(isInvokedAsClaude("claude")).toBe(true);
    });

    it("matches the Windows .exe name -- the confirmed real bug: path.basename includes the extension, so a bare === \"claude\" comparison never matched here, silently falling through to agent-shim's own CLI instead of the launcher", () => {
      expect(isInvokedAsClaude("claude.exe")).toBe(true);
    });

    it("matches the Windows .exe name case-insensitively", () => {
      expect(isInvokedAsClaude("Claude.EXE")).toBe(true);
    });

    it("does not match agent-shim itself", () => {
      expect(isInvokedAsClaude("agent-shim")).toBe(false);
    });

    it("does not match agent-shim.exe", () => {
      expect(isInvokedAsClaude("agent-shim.exe")).toBe(false);
    });
  });

  describe("enableClaudeShim", () => {
    it("creates a fresh, executable claude next to the source", () => {
      const result = enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false });
      expect(result.action).toBe("enabled");
      expect(result.method).toBe("hardlink");
      expect(result.targetPath).toBe(path.join(binDir, "claude"));
      expect(fs.readFileSync(result.targetPath, "utf8")).toBe("fake-binary-v1");
      expect(fs.statSync(result.targetPath).mode & EXECUTE_BITS_MASK).not.toBe(0);
    });

    it("places the shim next to a PATH-visible symlink, not next to its realpath target (Homebrew's Cellar layout)", () => {
      // Mirrors Homebrew's real layout: /opt/homebrew/bin/agent-shim -> ../Cellar/agent-shim/<version>/bin/agent-shim.
      const cellarDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-shim-cellar-test-"));
      const cellarFile = path.join(cellarDir, "agent-shim");
      fs.writeFileSync(cellarFile, "fake-binary-v1", { mode: 0o755 });
      const symlinkPath = path.join(binDir, "agent-shim-symlinked");
      fs.symlinkSync(cellarFile, symlinkPath);

      try {
        const result = enableClaudeShim({ paths, ownExecutablePath: symlinkPath, contentSourcePath: symlinkPath, platform: "linux", force: false });
        expect(result.targetPath).toBe(path.join(binDir, "claude"));
        expect(fs.readFileSync(result.targetPath, "utf8")).toBe("fake-binary-v1");
      } finally {
        fs.rmSync(cellarDir, { recursive: true, force: true });
      }
    });

    it("hardlinks the real content, never a proxy binary that merely lives at the placement location (Scoop's own shim)", () => {
      // Confirmed against a real Scoop install: ownExecutablePath (where `claude` should be placed -- PATH-visible) can differ entirely from contentSourcePath (what this process actually is). Scoop's own shim.exe, a generic compiled proxy, sits at the PATH-visible location while the real agent-shim binary lives in a separate, off-PATH versioned app directory -- fs.realpathSync can't see through Scoop's own paired-.shim-file indirection (it isn't a filesystem symlink), so using ownExecutablePath as the link source hardlinks Scoop's proxy itself, producing a `claude.exe` that fails with Scoop's own "Cannot open shim file for read" the moment it's invoked (it's missing its own paired claude.shim).
      const placementDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-shim-placement-test-"));
      const scoopProxyPath = path.join(placementDir, "agent-shim.exe");
      fs.writeFileSync(scoopProxyPath, "scoop-generic-shim-proxy", { mode: 0o755 });
      const realContentPath = path.join(binDir, "agent-shim-real.exe");
      fs.writeFileSync(realContentPath, "fake-binary-v1", { mode: 0o755 });

      try {
        const result = enableClaudeShim({
          paths,
          ownExecutablePath: scoopProxyPath,
          contentSourcePath: realContentPath,
          platform: "win32",
          force: false,
        });
        expect(result.targetPath).toBe(path.join(placementDir, "claude.exe"));
        expect(fs.readFileSync(result.targetPath, "utf8")).toBe("fake-binary-v1");
        expect(fs.readFileSync(scoopProxyPath, "utf8")).toBe("scoop-generic-shim-proxy"); // untouched
      } finally {
        fs.rmSync(placementDir, { recursive: true, force: true });
      }
    });

    it("is idempotent when re-run against the exact same source", () => {
      enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false });
      const second = enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false });
      expect(second.action).toBe("reenabled");
    });

    it("refreshes after the source is overwritten in place (version drift), via the marker rather than the inode", () => {
      enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false });
      fs.rmSync(sourcePath);
      fs.writeFileSync(sourcePath, "fake-binary-v2", { mode: 0o755 }); // new inode, same path
      const result = enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false });
      expect(result.action).toBe("reenabled");
      expect(fs.readFileSync(result.targetPath, "utf8")).toBe("fake-binary-v2");
    });

    it("refuses to overwrite a foreign file at the target without --force", () => {
      const targetPath = resolveClaudeTargetPath(sourcePath);
      fs.writeFileSync(targetPath, "someone-elses-claude", { mode: 0o755 });
      expect(() => enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false })).toThrow(
        ForeignClaudeEntryError,
      );
      expect(fs.readFileSync(targetPath, "utf8")).toBe("someone-elses-claude");
    });

    it("overwrites a foreign file when --force is given", () => {
      const targetPath = resolveClaudeTargetPath(sourcePath);
      fs.writeFileSync(targetPath, "someone-elses-claude", { mode: 0o755 });
      enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: true });
      expect(fs.readFileSync(targetPath, "utf8")).toBe("fake-binary-v1");
    });

    it("honours --dir, creating the directory if needed", () => {
      const dir = path.join(binDir, "elsewhere");
      const result = enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", dir, force: false });
      expect(result.targetPath).toBe(path.join(dir, "claude"));
      expect(fs.existsSync(result.targetPath)).toBe(true);
    });

    it("refuses on Windows when the source has no .exe extension", () => {
      expect(() => enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "win32", force: false })).toThrow(
        UnsupportedShimSourceError,
      );
    });

    it("succeeds on Windows when the source is a real .exe", () => {
      const exeSource = path.join(binDir, "agent-shim.exe");
      fs.writeFileSync(exeSource, "fake-binary-v1", { mode: 0o755 });
      const result = enableClaudeShim({ paths, ownExecutablePath: exeSource, contentSourcePath: exeSource,platform: "win32", force: false });
      expect(result.targetPath).toBe(path.join(binDir, "claude.exe"));
    });

    it("produces a bare `claude`, not `claude.cjs`, when enabling from an npm-style .cjs bundle", () => {
      const cjsSource = path.join(binDir, "cli.cjs");
      fs.writeFileSync(cjsSource, "#!/usr/bin/env node\nfake-bundle", { mode: 0o755 });
      const result = enableClaudeShim({ paths, ownExecutablePath: cjsSource, contentSourcePath: cjsSource,platform: "linux", force: false });
      expect(result.targetPath).toBe(path.join(binDir, "claude"));
    });

    it("does not apply the Windows guard on other platforms even without a .exe extension", () => {
      const result = enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "darwin", force: false });
      expect(result.action).toBe("enabled");
    });

    it("falls back to copy on a cross-device (EXDEV) error, via the injectable LinkFs seam", () => {
      const calls: string[] = [];
      const fakeLinkFs: LinkFs = {
        link: () => {
          calls.push("link");
          throw new CodedError("cross-device", "EXDEV");
        },
        copyFile: (src, dest) => {
          calls.push("copyFile");
          fs.copyFileSync(src, dest);
        },
        chmod: (target, mode) => {
          calls.push("chmod");
          fs.chmodSync(target, mode);
        },
      };
      const result = enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false }, fakeLinkFs);
      expect(result.method).toBe("copy");
      expect(calls).toEqual(["link", "copyFile", "chmod"]);
    });

    it("propagates any other link error unchanged, without falling back", () => {
      const fakeLinkFs: LinkFs = {
        link: () => {
          throw new CodedError("permission denied", "EACCES");
        },
        copyFile: () => {
          throw new Error("should not be called");
        },
        chmod: () => {
          throw new Error("should not be called");
        },
      };
      expect(() => enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false }, fakeLinkFs)).toThrow(
        "permission denied",
      );
    });
  });

  describe("disableClaudeShim", () => {
    it("removes a shim it created", () => {
      const enabled = enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false });
      const result = disableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,force: false });
      expect(result.action).toBe("disabled");
      expect(fs.existsSync(enabled.targetPath)).toBe(false);
      expect(fs.existsSync(paths.claudeShimFile)).toBe(false);
    });

    it("is a no-op, not an error, when nothing is enabled", () => {
      const result = disableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,force: false });
      expect(result.action).toBe("not-enabled");
    });

    it("clears a dangling marker when the target has since been deleted by other means", () => {
      const enabled = enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false });
      fs.rmSync(enabled.targetPath);
      const result = disableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,force: false });
      expect(result.action).toBe("not-enabled");
      expect(fs.existsSync(paths.claudeShimFile)).toBe(false);
    });

    it("refuses to remove a foreign file without --force", () => {
      const targetPath = resolveClaudeTargetPath(sourcePath);
      fs.writeFileSync(targetPath, "someone-elses-claude", { mode: 0o755 });
      expect(() => disableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,force: false })).toThrow(ForeignClaudeEntryError);
      expect(fs.existsSync(targetPath)).toBe(true);
    });

    it("removes a foreign file when --force is given", () => {
      const targetPath = resolveClaudeTargetPath(sourcePath);
      fs.writeFileSync(targetPath, "someone-elses-claude", { mode: 0o755 });
      const result = disableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,force: true });
      expect(result.action).toBe("disabled");
      expect(fs.existsSync(targetPath)).toBe(false);
    });

    it("prefers --dir over a marker pointing elsewhere", () => {
      enableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,platform: "linux", force: false }); // marker points at binDir
      const otherDir = path.join(binDir, "elsewhere");
      fs.mkdirSync(otherDir, { recursive: true });
      const otherTarget = path.join(otherDir, "claude");
      fs.linkSync(sourcePath, otherTarget);
      const result = disableClaudeShim({ paths, ownExecutablePath: sourcePath, contentSourcePath: sourcePath,dir: otherDir, force: false });
      expect(result.targetPath).toBe(otherTarget);
      expect(fs.existsSync(otherTarget)).toBe(false);
    });
  });

  describe("findPathShadow", () => {
    it("reports ok when the own directory is first on PATH with a match", () => {
      const status = findPathShadow({
        pathDirs: ["/own/dir", "/other/dir"],
        targetDir: "/own/dir",
        targetFilename: "claude",
        findExecutableInDir: (dir, name) => (dir === "/own/dir" ? `/own/dir/${name}` : undefined),
      });
      expect(status).toEqual({ status: "ok" });
    });

    it("reports shadowed when an earlier PATH directory has a match", () => {
      const status = findPathShadow({
        pathDirs: ["/earlier/dir", "/own/dir"],
        targetDir: "/own/dir",
        targetFilename: "claude",
        findExecutableInDir: (dir, name) => (dir === "/earlier/dir" ? `/earlier/dir/${name}` : undefined),
      });
      expect(status).toEqual({ status: "shadowed", by: "/earlier/dir/claude" });
    });

    it("reports not-on-path when the own directory isn't in pathDirs at all and nothing matches", () => {
      const status = findPathShadow({
        pathDirs: ["/other/dir"],
        targetDir: "/own/dir",
        targetFilename: "claude",
        findExecutableInDir: () => undefined,
      });
      expect(status).toEqual({ status: "not-on-path" });
    });
  });
});

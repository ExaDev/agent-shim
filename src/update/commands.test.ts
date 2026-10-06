import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../package.json";
import type * as realPortsModule from "../realPorts";
import { EXIT_FAILURE } from "../cliError";
import { reportFatalError } from "../cliReport";
import { buildLayoutPaths, type LayoutPaths } from "../paths";
import { buildProgram } from "../program";
import { fakeCommandDeps } from "../test-helpers";
import { formatUpdateReport } from "./commands";
import type { UpdateFsPort, UpdateHttpPort, UpdatePorts } from "./update";

/** The version the CLI reports through `-V`, which the wiring passes as the current one; the newer release this test advertises is one patch above it. */
const CURRENT = packageJson.version;
const LATEST = (() => {
  const [major, minor, patch] = CURRENT.split(".");
  return `${major ?? "0"}.${minor ?? "0"}.${String(Number(patch ?? 0) + 1)}`;
})();
const TAG_URL = `https://github.com/ExaDev/agent-shim/releases/tag/v${LATEST}`;
const SAME_TAG_URL = `https://github.com/ExaDev/agent-shim/releases/tag/v${CURRENT}`;
/** A stand-in release binary, built from hex so no byte value appears as a bare literal. */
const RELEASE_BINARY = new Uint8Array(Buffer.from("7f454c46070809", "hex"));
/** The permission bits of a file mode, without its type bits. */
const PERMISSION_BITS = 0o777;
/** The mode the installed binary carries. */
const EXECUTABLE_MODE = 0o755;

// Where `realOwnExecutablePath` reports the running executable as being: the real function resolves vitest's own worker, so the module mock points it at whatever path the current test stands up instead.
const own = vi.hoisted(() => ({ path: "/home/testuser/.local/bin/agent-shim" }));

vi.mock("../realPorts", async (importOriginal) => {
  const actual = await importOriginal<typeof realPortsModule>();
  return { ...actual, realOwnExecutablePath: () => own.path };
});

let root: string;
let paths: LayoutPaths;
let executable: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-update-command-"));
  paths = buildLayoutPaths(root);
  executable = path.join(root, "bin", "agent-shim");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "old binary");
  own.path = executable;
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The ports the wiring test runs against: a fake network, and the real filesystem confined to the throwaway layout (a genuine symlink-resolving realpath, and a genuine same-directory rename when an install happens).
 *
 * `fsPort` answers for any path under the real `os.tmpdir()`, which is where both the layout and the download temp directory live.
 */
function fakePorts(options: { readonly tagUrl?: string; readonly lockHolderAlive?: boolean } = {}): UpdatePorts & { readonly downloaded: readonly string[] } {
  const tagUrl = options.tagUrl ?? TAG_URL;
  const downloaded: string[] = [];
  const http: UpdateHttpPort = {
    effectiveUrl: async () => await Promise.resolve(tagUrl),
    download: async (url) => {
      downloaded.push(url);
      if (url.endsWith(".sha256")) {
        return await Promise.resolve(new Uint8Array(Buffer.from(`${createHash("sha256").update(RELEASE_BINARY).digest("hex")}  agent-shim-release-asset\n`, "utf8")));
      }
      return await Promise.resolve(RELEASE_BINARY);
    },
  };
  const fsPort: UpdateFsPort = {
    realpath: (target) => fs.realpathSync(target),
    readFileUtf8: (filePath) => {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return undefined;
      }
    },
    readFileBytes: (filePath) => {
      try {
        return new Uint8Array(fs.readFileSync(filePath));
      } catch {
        return undefined;
      }
    },
    readFileHead: (filePath, length) => {
      const descriptor = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(descriptor, buffer, 0, length, 0);
        return buffer.toString("latin1", 0, read);
      } finally {
        fs.closeSync(descriptor);
      }
    },
    writeFileUtf8: (filePath, contents) => {
      fs.writeFileSync(filePath, contents, "utf8");
    },
    writeFileBytes: (filePath, contents) => {
      fs.writeFileSync(filePath, contents);
    },
    writeFileExclusive: (filePath, contents) => {
      try {
        fs.writeFileSync(filePath, contents, { encoding: "utf8", flag: "wx" });
        return true;
      } catch {
        return false;
      }
    },
    unlink: (filePath) => {
      fs.rmSync(filePath, { force: true });
    },
    rename: (from, to) => {
      fs.renameSync(from, to);
    },
    chmod: (filePath, mode) => {
      fs.chmodSync(filePath, mode);
    },
    mkdtemp: () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-update-cli-")),
    rmRecursive: (targetPath) => {
      fs.rmSync(targetPath, { recursive: true, force: true });
    },
  };
  return { http, fs: fsPort, isProcessAlive: () => options.lockHolderAlive ?? false, downloaded };
}

/** Runs one `agent-shim` invocation against the throwaway layout the way `src/cli.ts` does, with the executable resolution pointed at the test's own binary and the update ports faked. */
async function cli(argv: readonly string[], updatePorts: UpdatePorts = fakePorts()): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
    out.push(`${args.map(String).join(" ")}\n`);
  });
  vi.spyOn(console, "error").mockImplementation((...args: readonly unknown[]) => {
    err.push(`${args.map(String).join(" ")}\n`);
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  let code: number;
  try {
    await buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn<(args: readonly string[]) => Promise<void>>(), updatePorts }).parseAsync([...argv], { from: "user" });
    code = typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    code = reportFatalError(error, {
      writeErr: (line) => {
        err.push(`${line}\n`);
      },
      env: {},
    });
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("agent-shim update", () => {
  it("is registered on the program with --check and --json", () => {
    const built = buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn<(args: readonly string[]) => Promise<void>>() });
    const command = built.commands.find((candidate) => candidate.name() === "update");
    expect(command).toBeDefined();
    expect(command?.options.map((option) => option.long)).toEqual(["--check", "--json"]);
  });

  it("reports already being at the latest release and exits 0, downloading nothing and writing no lock", async () => {
    const ports = fakePorts({ tagUrl: SAME_TAG_URL });
    const result = await cli(["update"], ports);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`already at the latest release (${CURRENT})`);
    expect(ports.downloaded).toEqual([]);
    expect(fs.readFileSync(executable, "utf8")).toBe("old binary");
    expect(fs.existsSync(path.join(paths.root, "update.lock"))).toBe(false);
  });

  it("--check reports the newer release without changing the executable or downloading anything", async () => {
    const ports = fakePorts();
    const result = await cli(["update", "--check"], ports);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`update available: ${CURRENT} -> ${LATEST}`);
    expect(ports.downloaded).toEqual([]);
    expect(fs.readFileSync(executable, "utf8")).toBe("old binary");
  });

  it("--check --json prints the result object", async () => {
    const result = await cli(["update", "--check", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ current: CURRENT, latest: LATEST, action: "available" });
  });

  it("installs the verified new binary over the running executable and removes the lock", async () => {
    const result = await cli(["update"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`updated agent-shim: ${CURRENT} -> ${LATEST}`);
    expect(new Uint8Array(fs.readFileSync(executable))).toEqual(RELEASE_BINARY);
    expect(fs.statSync(executable).mode & PERMISSION_BITS).toBe(EXECUTABLE_MODE);
    expect(fs.existsSync(path.join(paths.root, "update.lock"))).toBe(false);
  });

  it("exits 1 with the channel's own upgrade command when the executable is a script rather than a release binary, before any network access", async () => {
    fs.writeFileSync(executable, "#!/usr/bin/env node\n");
    const ports = fakePorts();
    const result = await cli(["update"], ports);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain("agent-shim:");
    expect(result.stderr).toContain("npm install -g agent-shim@latest");
    expect(ports.downloaded).toEqual([]);
    expect(fs.readFileSync(executable, "utf8")).toBe("#!/usr/bin/env node\n");
  });

  it("exits 1 naming the holding pid when another update holds the lock", async () => {
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(path.join(paths.root, "update.lock"), "999999\n");
    const result = await cli(["update"], fakePorts({ lockHolderAlive: true }));
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain("pid 999999");
    expect(fs.readFileSync(executable, "utf8")).toBe("old binary");
  });
});

describe("formatUpdateReport", () => {
  it("renders each outcome as one line", () => {
    expect(formatUpdateReport({ current: CURRENT, latest: CURRENT, action: "current" })).toBe(`already at the latest release (${CURRENT})`);
    expect(formatUpdateReport({ current: CURRENT, latest: LATEST, action: "available" })).toBe(`update available: ${CURRENT} -> ${LATEST} (run \`agent-shim update\` to install it)`);
    expect(formatUpdateReport({ current: CURRENT, latest: LATEST, action: "updated" })).toBe(`updated agent-shim: ${CURRENT} -> ${LATEST}`);
  });
});

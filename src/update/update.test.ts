import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CliError } from "../cliError";
import {
  acquireUpdateLock,
  channelRefusalMessage,
  channelUpgradeCommand,
  compareVersions,
  detectChannel,
  DOWNLOAD_BASE_URL,
  LATEST_RELEASE_URL,
  releaseTagFromUrl,
  runSelfUpdate,
  selectAsset,
  UpdateChannelError,
  UpdateConflictError,
  UpdateDownloadError,
  type UpdateChannel,
  type UpdateFsPort,
  type UpdateHttpPort,
} from "./update";

const CURRENT = "8.20.2";
const LATEST = "8.21.0";
const LATEST_TAG_URL = `https://github.com/ExaDev/agent-shim/releases/tag/v${LATEST}`;
const SAME_TAG_URL = `https://github.com/ExaDev/agent-shim/releases/tag/v${CURRENT}`;
const ASSET = "agent-shim-macos-arm64";
const ASSET_URL = `${DOWNLOAD_BASE_URL}/${ASSET}`;
const EXECUTABLE = "/home/testuser/.local/bin/agent-shim";
const LOCK_PATH = "/home/testuser/.agent-shim/update.lock";
const PID = 4242;
const LIVE_PID = 999;
/** The mode the installed binary carries, as a decimal in the fake's recorded chmod details. */
const EXECUTABLE_MODE = 0o755;

/** A stand-in release binary: an ELF-magic-prefixed blob, built from hex so no byte value appears as a bare literal. */
const RELEASE_BINARY = new Uint8Array(Buffer.from("7f454c46010203040506", "hex"));
const OLD_BINARY = new Uint8Array(Buffer.from("010203", "hex"));

function sha256(bytes: Readonly<Uint8Array>): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The error a rejected attempt actually rejected with, so a test asserts on its type and message directly. */
async function rejectionOf(attempt: Readonly<Promise<unknown>>): Promise<Error> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the attempt to reject");
}

/** One recorded filesystem mutation, so tests can assert the install's exact write shape. */
interface RecordedWrite {
  readonly op: "write" | "write-bytes" | "write-exclusive" | "unlink" | "rename" | "chmod" | "mkdtemp" | "rm";
  readonly detail: string;
}

/**
 * An in-memory `UpdateFsPort` over a flat path-to-content map: string values are text files and Uint8Array values are binary ones. Records every mutation, and resolves symlinks through the `symlinks` map so a test can stand up a Homebrew or npm layout the way those channels really install one.
 */
function fakeUpdateFs(files: Readonly<Record<string, string | Uint8Array>> = {}, symlinks: Readonly<Record<string, string>> = {}): UpdateFsPort & {
  readonly writes: readonly RecordedWrite[];
  readonly contentsOf: (filePath: string) => string | Uint8Array | undefined;
  readonly exists: (filePath: string) => boolean;
} {
  const store = new Map<string, string | Uint8Array>(Object.entries(files));
  const recorded: RecordedWrite[] = [];
  let tempCount = 0;
  const fs: UpdateFsPort & { readonly writes: readonly RecordedWrite[]; readonly contentsOf: (filePath: string) => string | Uint8Array | undefined; readonly exists: (filePath: string) => boolean } = {
    writes: recorded,
    contentsOf: (filePath) => store.get(filePath),
    exists: (filePath) => store.has(filePath),
    realpath: (target) => {
      let current = target;
      const seen = new Set<string>();
      while (symlinks[current] !== undefined && !seen.has(current)) {
        seen.add(current);
        current = symlinks[current] ?? current;
      }
      return current;
    },
    readFileUtf8: (filePath) => {
      const value = store.get(filePath);
      return typeof value === "string" ? value : undefined;
    },
    readFileBytes: (filePath) => {
      const value = store.get(filePath);
      return value instanceof Uint8Array ? value : undefined;
    },
    readFileHead: (filePath, length) => {
      const value = store.get(filePath);
      if (value === undefined) {
        return undefined;
      }
      const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
      return bytes.subarray(0, length).toString("latin1");
    },
    writeFileUtf8: (filePath, contents) => {
      recorded.push({ op: "write", detail: filePath });
      store.set(filePath, contents);
    },
    writeFileBytes: (filePath, contents) => {
      recorded.push({ op: "write-bytes", detail: filePath });
      store.set(filePath, contents);
    },
    writeFileExclusive: (filePath, contents) => {
      if (store.has(filePath)) {
        return false;
      }
      recorded.push({ op: "write-exclusive", detail: filePath });
      store.set(filePath, contents);
      return true;
    },
    unlink: (filePath) => {
      if (store.delete(filePath)) {
        recorded.push({ op: "unlink", detail: filePath });
      }
    },
    rename: (from, to) => {
      recorded.push({ op: "rename", detail: `${from} -> ${to}` });
      const value = store.get(from);
      if (value === undefined) {
        throw new Error(`Cannot rename ${from}: it does not exist.`);
      }
      store.delete(from);
      store.set(to, value);
    },
    chmod: (filePath, mode) => {
      recorded.push({ op: "chmod", detail: `${filePath} ${String(mode)}` });
    },
    mkdtemp: () => {
      tempCount += 1;
      const dir = `/tmp/agent-shim-update-test-${String(tempCount)}`;
      recorded.push({ op: "mkdtemp", detail: dir });
      store.set(dir, "");
      return dir;
    },
    rmRecursive: (targetPath) => {
      recorded.push({ op: "rm", detail: targetPath });
      store.delete(targetPath);
    },
  };
  return fs;
}

/** An `UpdateHttpPort` serving scripted responses: the tag URL the latest-release redirect resolves to, and asset bodies by URL. */
function fakeHttp(options: { readonly tagUrl?: string; readonly assets?: Readonly<Record<string, Uint8Array | string>> } = {}): UpdateHttpPort & { readonly requested: readonly string[] } {
  const requested: string[] = [];
  const tagUrl = options.tagUrl ?? LATEST_TAG_URL;
  const http: UpdateHttpPort & { readonly requested: readonly string[] } = {
    requested,
    effectiveUrl: async (url) => {
      requested.push(url);
      if (url !== LATEST_RELEASE_URL) {
        return await Promise.reject(new Error(`unexpected effectiveUrl call: ${url}`));
      }
      return await Promise.resolve(tagUrl);
    },
    download: async (url) => {
      requested.push(url);
      const asset = options.assets?.[url];
      if (asset === undefined) {
        return await Promise.reject(new Error(`HTTP 404 for ${url}`));
      }
      return await Promise.resolve(typeof asset === "string" ? new Uint8Array(Buffer.from(asset, "utf8")) : asset);
    },
  };
  return http;
}

function ports(fs: UpdateFsPort, http: UpdateHttpPort, alive: ReadonlySet<number> = new Set([LIVE_PID])) {
  return { fs, http, isProcessAlive: (pid: number) => alive.has(pid) };
}

function selfOptions(overrides: Partial<Parameters<typeof runSelfUpdate>[1]> = {}): Parameters<typeof runSelfUpdate>[1] {
  return {
    currentVersion: CURRENT,
    platform: "darwin",
    arch: "arm64",
    executablePath: EXECUTABLE,
    lockPath: LOCK_PATH,
    checkOnly: false,
    pid: PID,
    ...overrides,
  };
}

describe("compareVersions", () => {
  it("orders major, minor and patch numerically", () => {
    expect(compareVersions("8.21.0", "8.20.2")).toBeGreaterThan(0);
    expect(compareVersions("8.20.2", "8.21.0")).toBeLessThan(0);
    expect(compareVersions("9.0.0", "8.99.99")).toBeGreaterThan(0);
    expect(compareVersions("8.21.0", "8.21.0")).toBe(0);
    expect(compareVersions("8.21.10", "8.21.9")).toBeGreaterThan(0);
  });

  it("refuses a version that is not a plain release rather than guessing", () => {
    expect(() => compareVersions("8.21.0-rc.1", "8.21.0")).toThrow();
  });
});

describe("releaseTagFromUrl", () => {
  it("takes the trailing v-prefixed version from the redirect's effective URL", () => {
    expect(releaseTagFromUrl(LATEST_TAG_URL)).toBe(LATEST);
    expect(releaseTagFromUrl("https://github.com/ExaDev/agent-shim/releases/tag/v1.2.3")).toBe("1.2.3");
  });

  it("ignores a query string and returns undefined for anything that is not a plain v-prefixed version", () => {
    expect(releaseTagFromUrl(`${LATEST_TAG_URL}?t=1`)).toBe(LATEST);
    expect(releaseTagFromUrl("https://github.com/ExaDev/agent-shim/releases/latest")).toBeUndefined();
    expect(releaseTagFromUrl("https://github.com/ExaDev/agent-shim/releases/tag/vnext")).toBeUndefined();
    expect(releaseTagFromUrl("https://github.com/ExaDev/agent-shim/releases/tag/8.21.0")).toBeUndefined();
  });
});

describe("selectAsset", () => {
  it("mirrors install.sh's platform table", () => {
    expect(selectAsset("darwin", "arm64")).toBe("agent-shim-macos-arm64");
    expect(selectAsset("linux", "arm64")).toBe("agent-shim-linux-arm64");
    expect(selectAsset("linux", "aarch64")).toBe("agent-shim-linux-arm64");
    expect(selectAsset("linux", "x64")).toBe("agent-shim-linux-x64");
  });

  it("has no asset where install.sh also refuses", () => {
    expect(selectAsset("darwin", "x64")).toBeUndefined();
    expect(selectAsset("win32", "arm64")).toBeUndefined();
    expect(selectAsset("freebsd", "x64")).toBeUndefined();
  });
});

describe("detectChannel", () => {
  const detect = (overrides: Partial<Parameters<typeof detectChannel>[0]> = {}): UpdateChannel =>
    detectChannel({ platform: "darwin", arch: "arm64", executableRealPath: EXECUTABLE, fileHead: undefined, ...overrides });

  it("classifies a standalone binary as self-updatable", () => {
    expect(detect()).toEqual({ kind: "self" });
  });

  it("classifies a path under a Homebrew prefix as Homebrew, including through the .bin symlink", () => {
    expect(detect({ executableRealPath: "/opt/homebrew/Cellar/agent-shim/8.21.0/bin/agent-shim" })).toEqual({ kind: "brew" });
    expect(detect({ executableRealPath: "/usr/local/Cellar/agent-shim/8.21.0/bin/agent-shim" })).toEqual({ kind: "brew" });
    expect(detect({ executableRealPath: "/home/linuxbrew/.linuxbrew/Cellar/agent-shim/8.21.0/bin/agent-shim", platform: "linux", arch: "x64" })).toEqual({ kind: "brew" });
    expect(detect({ executableRealPath: "/opt/homebrew/bin/agent-shim" })).toEqual({ kind: "brew" });
  });

  it("classifies a path inside node_modules as npm", () => {
    expect(detect({ executableRealPath: "/usr/local/lib/node_modules/agent-shim/bin/agent-shim", platform: "linux", arch: "x64" })).toEqual({ kind: "npm", reason: "node_modules" });
  });

  it("classifies a script file (first two bytes #!) as npm", () => {
    expect(detect({ fileHead: "#!" })).toEqual({ kind: "npm", reason: "script" });
    expect(detect({ fileHead: "#!/usr/bin/env node" })).toEqual({ kind: "npm", reason: "script" });
  });

  it("classifies a binary without #! as self even when the head is binary garbage", () => {
    expect(detect({ fileHead: "\u007fELF" })).toEqual({ kind: "self" });
  });

  it("defers Windows to Scoop", () => {
    expect(detect({ platform: "win32", arch: "x64", executableRealPath: "C:/Users/u/scoop/shims/agent-shim.exe" })).toEqual({ kind: "scoop" });
  });

  it("defers macOS x64 to npm, since the standalone binary is broken upstream there", () => {
    expect(detect({ platform: "darwin", arch: "x64" })).toEqual({ kind: "npm", reason: "macos-x64" });
  });

  it("keeps a Homebrew macOS x64 install on the Homebrew channel, since the formula owns it", () => {
    expect(detect({ platform: "darwin", arch: "x64", executableRealPath: "/opt/homebrew/Cellar/agent-shim/8.21.0/bin/agent-shim" })).toEqual({ kind: "brew" });
  });
});

describe("channel refusal messages", () => {
  it("name the channel and its upgrade command", () => {
    expect(channelUpgradeCommand({ kind: "brew" })).toBe("brew upgrade agent-shim");
    expect(channelUpgradeCommand({ kind: "npm", reason: "node_modules" })).toBe("npm install -g agent-shim@latest");
    expect(channelUpgradeCommand({ kind: "scoop" })).toBe("scoop update agent-shim");
    expect(channelRefusalMessage({ kind: "brew" })).toContain("brew upgrade agent-shim");
    expect(channelRefusalMessage({ kind: "npm", reason: "node_modules" })).toContain("npm install -g agent-shim@latest");
    expect(channelRefusalMessage({ kind: "npm", reason: "script" })).toContain("script");
    expect(channelRefusalMessage({ kind: "npm", reason: "macos-x64" })).toContain("macOS x64 binary is currently broken upstream");
    expect(channelRefusalMessage({ kind: "scoop" })).toContain("scoop update agent-shim");
  });
});

describe("runSelfUpdate: version comparison", () => {
  it("reports already at the latest release, downloading nothing, when the running version is the latest", async () => {
    const http = fakeHttp({ tagUrl: SAME_TAG_URL });
    const fs = fakeUpdateFs({ [EXECUTABLE]: RELEASE_BINARY });
    const report = await runSelfUpdate(ports(fs, http), selfOptions());
    expect(report).toEqual({ current: CURRENT, latest: CURRENT, action: "current" });
    expect(http.requested).toEqual([LATEST_RELEASE_URL]);
    expect(fs.exists(LOCK_PATH)).toBe(false);
  });

  it("never downgrades a running version newer than the newest release", async () => {
    const http = fakeHttp({ tagUrl: SAME_TAG_URL });
    const report = await runSelfUpdate(ports(fakeUpdateFs({ [EXECUTABLE]: RELEASE_BINARY }), http), selfOptions({ currentVersion: LATEST }));
    expect(report).toEqual({ current: LATEST, latest: LATEST, action: "current" });
  });

  it("refuses an effective URL without a readable version tag", async () => {
    const http = fakeHttp({ tagUrl: "https://github.com/ExaDev/agent-shim/releases" });
    const error = await rejectionOf(runSelfUpdate(ports(fakeUpdateFs({ [EXECUTABLE]: RELEASE_BINARY }), http), selfOptions()));
    expect(error).toBeInstanceOf(UpdateDownloadError);
  });
});

describe("runSelfUpdate: --check", () => {
  it("reports the newer release and changes nothing: no lock, no download, no write", async () => {
    const http = fakeHttp();
    const fs = fakeUpdateFs({ [EXECUTABLE]: RELEASE_BINARY });
    const report = await runSelfUpdate(ports(fs, http), selfOptions({ checkOnly: true }));
    expect(report).toEqual({ current: CURRENT, latest: LATEST, action: "available" });
    expect(http.requested).toEqual([LATEST_RELEASE_URL]);
    expect(fs.writes).toEqual([]);
    expect(fs.contentsOf(EXECUTABLE)).toEqual(RELEASE_BINARY);
  });
});

describe("runSelfUpdate: channel refusals", () => {
  it("refuses a Homebrew installation without any network access", async () => {
    const http = fakeHttp();
    const symlinks = { "/opt/homebrew/bin/agent-shim": "/opt/homebrew/Cellar/agent-shim/8.21.0/bin/agent-shim" };
    const fs = fakeUpdateFs({ "/opt/homebrew/Cellar/agent-shim/8.21.0/bin/agent-shim": RELEASE_BINARY }, symlinks);
    const error = await rejectionOf(runSelfUpdate(ports(fs, http), selfOptions({ executablePath: "/opt/homebrew/bin/agent-shim" })));
    expect(error).toBeInstanceOf(UpdateChannelError);
    expect(error.message).toContain("brew upgrade agent-shim");
    expect(http.requested).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  it("refuses an npm installation by its resolved node_modules path", async () => {
    const real = "/usr/local/lib/node_modules/agent-shim/dist/cli.cjs";
    const fs = fakeUpdateFs({ [real]: "#!/usr/bin/env node" }, { "/usr/local/bin/agent-shim": real });
    const error = await rejectionOf(runSelfUpdate(ports(fs, fakeHttp()), selfOptions({ platform: "linux", arch: "x64", executablePath: "/usr/local/bin/agent-shim" })));
    expect(error).toBeInstanceOf(UpdateChannelError);
    expect(error.message).toContain("npm install -g agent-shim@latest");
  });

  it("refuses a script installation even outside node_modules", async () => {
    const fs = fakeUpdateFs({ [EXECUTABLE]: "#!/usr/bin/env node\n" });
    const error = await rejectionOf(runSelfUpdate(ports(fs, fakeHttp()), selfOptions()));
    expect(error).toBeInstanceOf(UpdateChannelError);
    expect(error.message).toContain("script");
  });

  it("refuses Windows with the Scoop command", async () => {
    const error = await rejectionOf(runSelfUpdate(ports(fakeUpdateFs(), fakeHttp()), selfOptions({ platform: "win32", executablePath: "C:/scoop/shims/agent-shim.exe" })));
    expect(error).toBeInstanceOf(UpdateChannelError);
    expect(error.message).toContain("scoop update agent-shim");
  });

  it("refuses macOS x64 with the upstream note and the npm command", async () => {
    const error = await rejectionOf(runSelfUpdate(ports(fakeUpdateFs({ [EXECUTABLE]: RELEASE_BINARY }), fakeHttp()), selfOptions({ arch: "x64" })));
    expect(error).toBeInstanceOf(UpdateChannelError);
    expect(error.message).toContain("broken upstream");
    expect(error.message).toContain("npm install -g agent-shim@latest");
  });

  it("refuses a platform with no release asset, naming it", async () => {
    const error = await rejectionOf(runSelfUpdate(ports(fakeUpdateFs({ [EXECUTABLE]: RELEASE_BINARY }), fakeHttp()), selfOptions({ platform: "freebsd", arch: "x64" })));
    expect(error).toBeInstanceOf(UpdateChannelError);
    expect(error.message).toContain("freebsd x64");
  });
});

describe("runSelfUpdate: install", () => {
  const goodHttp = () =>
    fakeHttp({ assets: { [ASSET_URL]: RELEASE_BINARY, [`${ASSET_URL}.sha256`]: `${sha256(RELEASE_BINARY)}  ${ASSET}\n` } });

  it("verifies the sha256 sidecar and installs over the target with a same-directory temp rename", async () => {
    const fs = fakeUpdateFs({ [EXECUTABLE]: OLD_BINARY });
    const report = await runSelfUpdate(ports(fs, goodHttp()), selfOptions());
    expect(report).toEqual({ current: CURRENT, latest: LATEST, action: "updated" });

    const rename = fs.writes.find((write) => write.op === "rename");
    const [tempPath, renameTarget] = rename?.detail.split(" -> ") ?? [];
    expect(renameTarget).toBe(EXECUTABLE);
    expect(tempPath?.startsWith("/home/testuser/.local/bin/.agent-shim.")).toBe(true);
    expect(fs.contentsOf(EXECUTABLE)).toEqual(RELEASE_BINARY);
    // The temp file itself is gone: only the rename destination holds the new binary.
    expect(fs.writes.filter((write) => write.op === "write-bytes" && write.detail === tempPath)).toHaveLength(1);
    expect(fs.exists(tempPath ?? "")).toBe(false);
    const chmod = fs.writes.find((write) => write.op === "chmod");
    expect(chmod?.detail).toBe(`${tempPath ?? ""} ${String(EXECUTABLE_MODE)}`);
  });

  it("downloads both the asset and its sidecar from the latest-release download base", async () => {
    const http = goodHttp();
    await runSelfUpdate(ports(fakeUpdateFs({ [EXECUTABLE]: RELEASE_BINARY }), http), selfOptions());
    expect(http.requested).toEqual([LATEST_RELEASE_URL, ASSET_URL, `${ASSET_URL}.sha256`]);
  });

  it("removes the update lock when it finishes", async () => {
    const fs = fakeUpdateFs({ [EXECUTABLE]: RELEASE_BINARY });
    await runSelfUpdate(ports(fs, goodHttp()), selfOptions());
    expect(fs.exists(LOCK_PATH)).toBe(false);
  });

  it("fails on a checksum mismatch without touching the target, and still removes the lock and the temp directory", async () => {
    const wrongSha = sha256(new Uint8Array(Buffer.from("not the release binary", "utf8")));
    const fs = fakeUpdateFs({ [EXECUTABLE]: OLD_BINARY });
    const http = fakeHttp({ assets: { [ASSET_URL]: RELEASE_BINARY, [`${ASSET_URL}.sha256`]: `${wrongSha}  ${ASSET}\n` } });
    const error = await rejectionOf(runSelfUpdate(ports(fs, http), selfOptions()));
    expect(error).toBeInstanceOf(UpdateDownloadError);
    expect(error.message).toContain(`checksum mismatch for ${ASSET}`);
    expect(error.message).toContain(wrongSha);
    expect(fs.contentsOf(EXECUTABLE)).toEqual(OLD_BINARY);
    expect(fs.writes.find((write) => write.op === "rename")).toBeUndefined();
    expect(fs.exists(LOCK_PATH)).toBe(false);
    expect(fs.writes.some((write) => write.op === "rm")).toBe(true);
  });

  it("turns a failed download into the command's own error", async () => {
    const fs = fakeUpdateFs({ [EXECUTABLE]: RELEASE_BINARY });
    const error = await rejectionOf(runSelfUpdate(ports(fs, fakeHttp()), selfOptions()));
    expect(error).toBeInstanceOf(UpdateDownloadError);
    expect(fs.exists(LOCK_PATH)).toBe(false);
  });
});

describe("acquireUpdateLock", () => {
  it("takes a free lock and releases it on demand", () => {
    const fs = fakeUpdateFs();
    const release = acquireUpdateLock(fs, () => false, PID, LOCK_PATH);
    expect(fs.readFileUtf8(LOCK_PATH)).toBe(`${String(PID)}\n`);
    release();
    expect(fs.exists(LOCK_PATH)).toBe(false);
  });

  it("refuses a lock held by a live pid, naming it", () => {
    const fs = fakeUpdateFs({ [LOCK_PATH]: `${String(LIVE_PID)}\n` });
    expect(() => acquireUpdateLock(fs, (pid) => pid === LIVE_PID, PID, LOCK_PATH)).toThrow(UpdateConflictError);
    expect(() => acquireUpdateLock(fs, (pid) => pid === LIVE_PID, PID, LOCK_PATH)).toThrow(/pid 999/);
    expect(fs.readFileUtf8(LOCK_PATH)).toBe(`${String(LIVE_PID)}\n`);
  });

  it("replaces a stale lock whose pid is no longer running", () => {
    const fs = fakeUpdateFs({ [LOCK_PATH]: "1\n" });
    const release = acquireUpdateLock(fs, () => false, PID, LOCK_PATH);
    expect(fs.readFileUtf8(LOCK_PATH)).toBe(`${String(PID)}\n`);
    release();
    expect(fs.exists(LOCK_PATH)).toBe(false);
  });

  it("replaces an unreadable lock rather than blocking every future update", () => {
    const fs = fakeUpdateFs({ [LOCK_PATH]: "not a pid" });
    const release = acquireUpdateLock(fs, () => true, PID, LOCK_PATH);
    expect(fs.readFileUtf8(LOCK_PATH)).toBe(`${String(PID)}\n`);
    release();
  });
});

describe("error classes", () => {
  it("extend CliError so the CLI reports them as expected failures, not bugs", () => {
    expect(new UpdateChannelError("x")).toBeInstanceOf(CliError);
    expect(new UpdateConflictError("x")).toBeInstanceOf(CliError);
    expect(new UpdateDownloadError("x")).toBeInstanceOf(CliError);
  });
});

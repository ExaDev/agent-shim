import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { CliError } from "../cliError";

/** Where the latest release's tag is discovered: the redirect target of this page, exactly as install.sh resolves it, rather than the GitHub JSON API (which is rate-limited per address). */
export const LATEST_RELEASE_URL = "https://github.com/ExaDev/agent-shim/releases/latest";

/** Where release assets are downloaded from: the same base install.sh uses. */
export const DOWNLOAD_BASE_URL = "https://github.com/ExaDev/agent-shim/releases/latest/download";

/** The directory the macOS x64 SEA limitation is documented under, quoted by that channel's refusal message exactly as install.sh quotes it. */
const MACOS_X64_NOTE = "the standalone macOS x64 binary is currently broken upstream (see https://github.com/ExaDev/agent-shim#build-node-sea)";

/** The filesystem prefixes under which a Homebrew installation lives, on macOS (both prefixes) and Linux (the default linuxbrew one). */
const BREW_PREFIXES = ["/opt/homebrew", "/usr/local/Cellar", "/home/linuxbrew/.linuxbrew"] as const;

/** The mode a downloaded binary is installed with, matching what install.sh leaves in `~/.local/bin`. */
const EXECUTABLE_MODE = 0o755;

/**
 * Raised when the running installation belongs to a channel that must update through its own package manager (Homebrew, npm, Scoop) rather than in place. The message names the channel and its upgrade command.
 */
export class UpdateChannelError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "UpdateChannelError";
  }
}

/** Raised when another update holds the lock: its message names the holding pid. */
export class UpdateConflictError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "UpdateConflictError";
  }
}

/** Raised when the latest release cannot be discovered, downloaded or verified: a redirect without a readable tag, a failed fetch, or a checksum mismatch. */
export class UpdateDownloadError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "UpdateDownloadError";
  }
}

/** What `agent-shim update` needs from the network: the final URL a redirect chain lands on, and a download as bytes. */
export interface UpdateHttpPort {
  /** Resolves `url` following redirects, and reports the effective URL it landed on. */
  readonly effectiveUrl: (url: string) => Promise<string>;
  /** Downloads `url` in full. Throws on any failure, including a non-2xx status. */
  readonly download: (url: string) => Promise<Uint8Array>;
}

/** What `agent-shim update` needs from the filesystem. ENOENT reads return undefined rather than throwing; `unlink` and `rmRecursive` succeed silently on a missing path, since both are cleanup. */
export interface UpdateFsPort {
  /** Resolves `target` through every symlink in it, like `fs.realpathSync`. */
  readonly realpath: (target: string) => string;
  readonly readFileUtf8: (filePath: string) => string | undefined;
  readonly readFileBytes: (filePath: string) => Uint8Array | undefined;
  /** The first `length` bytes of `filePath` as text, or undefined when it does not exist: how a shebang is detected without reading a whole binary. */
  readonly readFileHead: (filePath: string, length: number) => string | undefined;
  readonly writeFileUtf8: (filePath: string, contents: string) => void;
  readonly writeFileBytes: (filePath: string, contents: Uint8Array) => void;
  /** Creates `filePath` with `contents` only when it does not exist, reporting whether this call was the one to create it: the atomic primitive the update lock rests on. */
  readonly writeFileExclusive: (filePath: string, contents: string) => boolean;
  readonly unlink: (filePath: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly chmod: (filePath: string, mode: number) => void;
  /** Creates and returns a fresh temporary directory. */
  readonly mkdtemp: () => string;
  readonly rmRecursive: (targetPath: string) => void;
}

/** Everything the self-update logic needs from its host: the network, the filesystem, and whether a pid is still running. */
export interface UpdatePorts {
  readonly http: UpdateHttpPort;
  readonly fs: UpdateFsPort;
  readonly isProcessAlive: (pid: number) => boolean;
}

/** What `agent-shim update` reports: the versions compared and what it did about them. */
export interface UpdateReport {
  readonly current: string;
  readonly latest: string;
  /** `current` when nothing was needed, `available` when `--check` found a newer release and changed nothing, `updated` when the new binary was installed. */
  readonly action: "current" | "available" | "updated";
}

/** The inputs to a self-update, everything the CLI adapter supplies. */
export interface SelfUpdateOptions {
  /** The running version, the same `packageJson.version` `-V` reports. */
  readonly currentVersion: string;
  readonly platform: string;
  readonly arch: string;
  /** The running executable's PATH-visible location, as `resolveOwnExecutablePath` reports it; symlinked to its real content before any decision is made. */
  readonly executablePath: string;
  /** The update lock's path, `<root>/update.lock`. */
  readonly lockPath: string;
  /** Stop after the version comparison, downloading and changing nothing. */
  readonly checkOnly: boolean;
  /** This process's pid, held in the lock file while an install is in flight. */
  readonly pid: number;
}

/**
 * Compares two plain semantic versions numerically, major to patch. Returns a negative number when `left` is older, `0` when equal, positive when newer.
 *
 * Only the plain `major.minor.patch` releases are compared; a tag with any other shape is refused earlier, by `releaseTagFromUrl`.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (version: string): readonly [number, number, number] => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (match === null) {
      throw new Error(`not a plain release version: ${version}`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  // The first differing position decides; every later one is irrelevant once an earlier one differs.
  return leftParts.map((part, index) => part - (rightParts[index] ?? 0)).find((difference) => difference !== 0) ?? 0;
}

/**
 * The release version carried by the URL the `releases/latest` redirect lands on, without its leading `v`: `.../tag/v8.21.0` yields `8.21.0`.
 *
 * Returns undefined when the URL's last path segment is not a `v`-prefixed plain version, the same refusal install.sh makes when its own check finds no version.
 */
export function releaseTagFromUrl(url: string): string | undefined {
  const segment = url.split("?")[0]?.split("/").at(-1);
  const candidate = segment?.startsWith("v") === true ? segment.slice(1) : undefined;
  return candidate !== undefined && /^\d+\.\d+\.\d+$/.test(candidate) ? candidate : undefined;
}

/**
 * The release asset name for a platform and architecture, mirroring install.sh's case table: `agent-shim-macos-arm64`, `agent-shim-linux-arm64` or `agent-shim-linux-x64`. Undefined where install.sh also refuses (no other macOS architecture; any non-macOS, non-Linux platform, which the channel rules have already sent elsewhere).
 */
export function selectAsset(platform: string, arch: string): string | undefined {
  if (platform === "darwin") {
    return arch === "arm64" ? "agent-shim-macos-arm64" : undefined;
  }
  if (platform === "linux") {
    if (arch === "arm64" || arch === "aarch64") {
      return "agent-shim-linux-arm64";
    }
    return arch === "x64" ? "agent-shim-linux-x64" : undefined;
  }
  return undefined;
}

/** How the running installation was installed, and so who owns updating it. */
export type UpdateChannel =
  /** A standalone release binary (install.sh's `~/.local/bin` install): the one channel `agent-shim update` may replace in place. */
  | { readonly kind: "self" }
  /** Under a Homebrew prefix: updating it in place would leave the formula's records stale. */
  | { readonly kind: "brew" }
  /** An npm-managed installation, with the reason it was classified that way. */
  | { readonly kind: "npm"; readonly reason: "node_modules" | "script" | "macos-x64" }
  /** Windows, where Scoop owns the install. */
  | { readonly kind: "scoop" };

/** Every channel except the self-updatable one: the channels whose upgrade command and refusal message the helpers below produce. */
export type ManagedChannel = Exclude<UpdateChannel, { kind: "self" }>;

/** The upgrade command each non-self channel runs instead. */
export function channelUpgradeCommand(channel: ManagedChannel): string {
  switch (channel.kind) {
    case "brew":
      return "brew upgrade agent-shim";
    case "npm":
      return "npm install -g agent-shim@latest";
    case "scoop":
      return "scoop update agent-shim";
    default:
      return channel satisfies never;
  }
}

/**
 * Names why a channel cannot update itself, and what to run instead.
 *
 * Every message is one sentence the CLI can print as-is under the failure exit status.
 */
export function channelRefusalMessage(channel: ManagedChannel): string {
  const command = channelUpgradeCommand(channel);
  switch (channel.kind) {
    case "brew":
      return `this agent-shim was installed by Homebrew, so it updates through Homebrew instead: ${command}`;
    case "npm":
      switch (channel.reason) {
        case "node_modules":
          return `this agent-shim was installed by npm, so it updates through npm instead: ${command}`;
        case "script":
          return `the running agent-shim is a script rather than a release binary, so it updates through npm instead: ${command}`;
        case "macos-x64":
          return `${MACOS_X64_NOTE}, so it updates through npm instead: ${command}`;
        default:
          return channel.reason satisfies never;
      }
    case "scoop":
      return `this agent-shim was installed by Scoop, so it updates through Scoop instead: ${command}`;
    default:
      return channel satisfies never;
  }
}

function underBrewPrefix(executableRealPath: string): boolean {
  return BREW_PREFIXES.some((prefix) => executableRealPath === prefix || executableRealPath.startsWith(`${prefix}/`));
}

/**
 * Decides who owns updating this installation, from facts the caller resolves: the platform and architecture, the executable's real path (already resolved through symlinks, so a Homebrew or npm `.bin` entry is classified by where it actually leads) and the file's first two bytes.
 *
 * A script (`#!`) or `node_modules` installation belongs to npm; a Homebrew prefix to Homebrew; Windows to Scoop; macOS x64 to npm because the standalone binary is broken upstream there, mirroring install.sh's own case table. Everything else is a standalone binary this command may replace.
 */
export function detectChannel(env: {
  readonly platform: string;
  readonly arch: string;
  readonly executableRealPath: string;
  readonly fileHead: string | undefined;
}): UpdateChannel {
  if (env.platform === "win32") {
    return { kind: "scoop" };
  }
  if (underBrewPrefix(env.executableRealPath)) {
    return { kind: "brew" };
  }
  if (env.executableRealPath.split(/[\\/]/).includes("node_modules")) {
    return { kind: "npm", reason: "node_modules" };
  }
  if ((env.fileHead ?? "").startsWith("#!")) {
    return { kind: "npm", reason: "script" };
  }
  if (env.platform === "darwin" && env.arch === "x64") {
    return { kind: "npm", reason: "macos-x64" };
  }
  return { kind: "self" };
}

/** Reads the pid a lock file holds, or undefined when its contents are not a bare integer: an unreadable lock is treated as stale rather than blocking every future update. */
function lockHolder(contents: string | undefined): number | undefined {
  const pid = Number((contents ?? "").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Takes the update lock: creates `lockPath` holding `pid`, refusing only when another live update holds it.
 *
 * A lock whose pid is no longer running (or whose contents are unreadable) was left behind by a crashed update and is replaced. Returns the release function, which removes the lock whether the update succeeded or failed.
 */
export function acquireUpdateLock(fs: UpdateFsPort, isProcessAlive: (pid: number) => boolean, pid: number, lockPath: string): () => void {
  const take = (): boolean => fs.writeFileExclusive(lockPath, `${String(pid)}\n`);
  const release = (): void => {
    fs.unlink(lockPath);
  };
  if (take()) {
    return release;
  }
  const holder = lockHolder(fs.readFileUtf8(lockPath));
  if (holder !== undefined && holder !== pid && isProcessAlive(holder)) {
    throw new UpdateConflictError(`another agent-shim update (pid ${String(holder)}) is already running`);
  }
  fs.unlink(lockPath);
  if (!take()) {
    throw new UpdateConflictError("another agent-shim update took the lock while it was being replaced");
  }
  return release;
}

/** The first whitespace-separated field of a `.sha256` sidecar, the digest the file asserts. */
function expectedSha256(sidecar: string): string | undefined {
  const first = sidecar.trim().split(/\s+/)[0];
  return first === "" ? undefined : first;
}

/** Downloads `url`, turning any failure into the command's own expected error so a network problem never reports as a bug. */
async function mustDownload(http: UpdateHttpPort, url: string): Promise<Uint8Array> {
  try {
    return await http.download(url);
  } catch (error) {
    throw new UpdateDownloadError(`could not download ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Downloads and verifies the release asset, then installs it over `target` atomically: the verified bytes are written to a temporary file in the target's own directory (so the rename that follows can never cross a filesystem) and renamed into place.
 *
 * Nothing else is touched: a `claude-use` sibling is a symlink to the target and keeps pointing at the new binary on its own.
 */
async function downloadAndInstall(ports: UpdatePorts, asset: string, target: string): Promise<void> {
  const tempDir = ports.fs.mkdtemp();
  try {
    const assetUrl = `${DOWNLOAD_BASE_URL}/${asset}`;
    ports.fs.writeFileBytes(path.join(tempDir, asset), await mustDownload(ports.http, assetUrl));
    ports.fs.writeFileUtf8(path.join(tempDir, `${asset}.sha256`), Buffer.from(await mustDownload(ports.http, `${assetUrl}.sha256`)).toString("utf8"));

    // Verified from what landed on disk, so the bytes renamed over the target are exactly the bytes the sidecar vouches for.
    const downloaded = ports.fs.readFileBytes(path.join(tempDir, asset));
    const sidecar = ports.fs.readFileUtf8(path.join(tempDir, `${asset}.sha256`));
    if (downloaded === undefined || sidecar === undefined) {
      throw new UpdateDownloadError(`the downloaded files for ${asset} are missing from ${tempDir}`);
    }
    const expected = expectedSha256(sidecar);
    const actual = createHash("sha256").update(downloaded).digest("hex");
    if (expected === undefined || expected !== actual) {
      throw new UpdateDownloadError(`checksum mismatch for ${asset} (expected ${expected ?? "(none)"}, got ${actual})`);
    }

    const tempBinary = path.join(path.dirname(target), `.${path.basename(target)}.${String(process.pid)}.${randomUUID()}.tmp`);
    ports.fs.writeFileBytes(tempBinary, downloaded);
    try {
      ports.fs.chmod(tempBinary, EXECUTABLE_MODE);
      ports.fs.rename(tempBinary, target);
    } catch (error) {
      ports.fs.unlink(tempBinary);
      throw error;
    }
  } finally {
    ports.fs.rmRecursive(tempDir);
  }
}

/**
 * Runs `agent-shim update`'s whole decision: which channel owns this installation, whether a newer release exists, and (unless `checkOnly`) the verified, locked, atomic install of the new binary over the running one.
 *
 * Throws `UpdateChannelError` when a package manager owns the update, `UpdateConflictError` when a live update holds the lock, and `UpdateDownloadError` when discovery, download or verification fails; all three exit with the failure status and a message naming exactly what to do instead.
 */
export async function runSelfUpdate(ports: UpdatePorts, options: SelfUpdateOptions): Promise<UpdateReport> {
  const executableRealPath = ports.fs.realpath(options.executablePath);
  const channel = detectChannel({ platform: options.platform, arch: options.arch, executableRealPath, fileHead: ports.fs.readFileHead(executableRealPath, 2) });
  if (channel.kind !== "self") {
    throw new UpdateChannelError(channelRefusalMessage(channel));
  }
  const asset = selectAsset(options.platform, options.arch);
  if (asset === undefined) {
    throw new UpdateChannelError(`no release binary exists for ${options.platform} ${options.arch}; install agent-shim through one of the documented channels instead (see docs/installation.md)`);
  }

  let effectiveUrl: string;
  try {
    effectiveUrl = await ports.http.effectiveUrl(LATEST_RELEASE_URL);
  } catch (error) {
    throw new UpdateDownloadError(`could not resolve the latest release from ${LATEST_RELEASE_URL}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const latest = releaseTagFromUrl(effectiveUrl);
  if (latest === undefined) {
    throw new UpdateDownloadError(`could not read the latest release version from ${effectiveUrl}`);
  }
  // Not newer means nothing to do, and never a downgrade: a local build ahead of the newest release stays as it is.
  if (compareVersions(latest, options.currentVersion) <= 0) {
    return { current: options.currentVersion, latest: options.currentVersion, action: "current" };
  }
  if (options.checkOnly) {
    return { current: options.currentVersion, latest, action: "available" };
  }

  const releaseLock = acquireUpdateLock(ports.fs, ports.isProcessAlive, options.pid, options.lockPath);
  try {
    await downloadAndInstall(ports, asset, executableRealPath);
  } finally {
    releaseLock();
  }
  return { current: options.currentVersion, latest, action: "updated" };
}

import os from "node:os";
import path from "node:path";

import { CliError } from "./cliError";

/** One entry observed inside a versions directory (e.g. ~/.local/share/claude/versions/2.1.220). */
export interface VersionsDirEntry {
  /** The entry's own name — expected to be a plain dotted-numeric version like "2.1.220". */
  name: string;
  /** Whether the entry is a regular file (not a directory, symlink-to-directory, etc). */
  isFile: boolean;
  /** Whether the entry has at least one execute bit set. */
  isExecutable: boolean;
  /** The entry's size in bytes. */
  sizeBytes: number;
}

/** Injected dependencies for discoverClaudeBinary, so no test ever touches a real filesystem or PATH. */
export interface DiscoverClaudeBinaryOptions {
  /** Directory to scan for versioned claude binaries. Defaults to ~/.local/share/claude/versions. */
  versionsDir?: string;
  /** Lists the entries of a versions directory. Injected so tests never touch the real filesystem. */
  listVersionsDir: (dir: string) => VersionsDirEntry[];
  /** The PATH-like list of directories to search as a fallback, in order. */
  pathDirs: string[];
  /** Looks up an executable of the given name inside one PATH directory, returning its full path if found. */
  findExecutableInDir: (dir: string, name: string) => string | undefined;
  /** An exact version to run instead of the highest one. It must be installed: a missing pin is an error, never a fallback to the highest version or to PATH. */
  version?: string;
  /** Decides whether a PATH-found `claude` candidate is this very tool (its own executable, or the `claude`-named copy `shim enable` makes of it), which the fallback must never return: spawning it would recursively launch agent-shim instead of Claude Code. The check is per candidate file, not per directory, because a shared bin directory can legitimately hold another package's claude beside agent-shim: under one npm global prefix, claude-code's `claude` sits in exactly the directory agent-shim was installed from. */
  isOwnBinary: (candidate: string) => boolean;
}

/** The result of a successful discovery. */
export interface DiscoveredClaudeBinary {
  /** Full path to the discovered `claude` executable. */
  path: string;
  /** Which strategy found it. */
  source: "versions-dir" | "path-fallback";
  /** The version string, when discovered via the versions directory. */
  version?: string;
}

/** What a launch asks binary discovery for: nothing (the highest installed version) or an exact version. */
interface ClaudeBinaryRequest {
  readonly version?: string;
}

/** Discovers the real `claude` binary to spawn, for the version a launch asked for. Injected into the launcher so it never reads the filesystem or PATH itself. */
export type ClaudeBinaryResolver = (request?: Readonly<ClaudeBinaryRequest>) => DiscoveredClaudeBinary;

/** The default versions directory, matching the legacy bash tool's own layout. */
export function defaultVersionsDir(): string {
  return path.join(os.homedir(), ".local", "share", "claude", "versions");
}

/** A plain dotted-numeric version such as `2.1.220`: the names Claude Code's versions directory uses, and what a pinned version must be. */
export const NUMERIC_DOTTED_VERSION_RE = /^\d+(?:\.\d+)*$/;

/** True when `name` is a plain dotted-numeric version string like "2.1.220" (never full semver — no pre-release/build metadata is expected here). */
export function isNumericDottedVersion(name: string): boolean {
  return NUMERIC_DOTTED_VERSION_RE.test(name);
}

/**
 * Compares two plain dotted-numeric version strings segment by segment, treating a missing trailing segment as 0 (so "2.1" sorts before "2.1.1"). Returns a negative number when `a` is the earlier version, a positive number when `a` is the later one, and 0 when equal. Throws if either string isn't a valid numeric-dotted version — callers must filter with isNumericDottedVersion first, since a naive string/lexicographic sort would incorrectly rank "2.9.0" ahead of "2.10.0".
 */
export function compareVersions(a: string, b: string): number {
  if (!isNumericDottedVersion(a)) {
    throw new Error(`compareVersions: "${a}" is not a valid plain dotted-numeric version`);
  }
  if (!isNumericDottedVersion(b)) {
    throw new Error(`compareVersions: "${b}" is not a valid plain dotted-numeric version`);
  }

  const segmentsA = a.split(".").map(Number);
  const segmentsB = b.split(".").map(Number);
  const length = Math.max(segmentsA.length, segmentsB.length);

  for (let i = 0; i < length; i += 1) {
    const segmentA = segmentsA[i] ?? 0;
    const segmentB = segmentsB[i] ?? 0;
    if (segmentA !== segmentB) {
      return segmentA - segmentB;
    }
  }
  return 0;
}

/** Raised when a launch pins a Claude Code version that is not in the versions directory. */
export class ClaudeVersionNotInstalledError extends CliError {
  constructor(readonly version: string, readonly versionsDir: string, readonly installed: readonly string[]) {
    super(
      `Claude Code ${version} is pinned for this launch but is not installed under "${versionsDir}"` +
        (installed.length === 0 ? " (no versions are installed there)." : `. Installed: ${installed.join(", ")}.`) +
        " Install it, or change or remove the pin (--claude-version, AGENT_SHIM_CLAUDE_VERSION, or launch.claudeVersion).",
    );
    this.name = "ClaudeVersionNotInstalledError";
  }
}

/** The versions that are genuinely runnable in a versions directory (executable, non-empty regular files named like a version), oldest first. */
export function installedVersions(entries: readonly VersionsDirEntry[]): readonly string[] {
  return entries
    .filter((entry) => entry.isFile && entry.isExecutable && entry.sizeBytes > 0 && isNumericDottedVersion(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersions);
}

/**
 * Filters `entries` to genuinely-executable, non-empty regular files whose name is a valid dotted-numeric version (skipping things like .DS_Store or a stray empty file), then picks the highest version by a real numeric-segment comparison. Returns undefined when nothing qualifies.
 */
export function pickHighestVersion(entries: readonly VersionsDirEntry[]): string | undefined {
  const candidates = entries.filter(
    (entry) => entry.isFile && entry.isExecutable && entry.sizeBytes > 0 && isNumericDottedVersion(entry.name),
  );

  if (candidates.length === 0) {
    return undefined;
  }

  return candidates.reduce((highest, candidate) =>
    compareVersions(candidate.name, highest.name) > 0 ? candidate : highest,
  ).name;
}

/**
 * Discovers the real `claude` binary to launch: first by scanning the versions directory and picking the highest genuinely-executable version, then falling back to a PATH search for a `claude` executable, never returning this tool's own binary so the launcher cannot recursively select itself. Throws a clear, actionable error when neither strategy finds anything — this is a deliberate improvement over the legacy bash tool, which crashed cryptically on a missing or empty versions directory instead of reporting the problem.
 */
export function discoverClaudeBinary(options: DiscoverClaudeBinaryOptions): DiscoveredClaudeBinary {
  const versionsDir = options.versionsDir ?? defaultVersionsDir();
  const entries = options.listVersionsDir(versionsDir);
  const highestVersion = pickHighestVersion(entries);

  if (options.version !== undefined) {
    const installed = installedVersions(entries);
    if (!installed.includes(options.version)) {
      throw new ClaudeVersionNotInstalledError(options.version, versionsDir, installed);
    }
    return { path: path.join(versionsDir, options.version), source: "versions-dir", version: options.version };
  }

  if (highestVersion !== undefined) {
    return {
      path: path.join(versionsDir, highestVersion),
      source: "versions-dir",
      version: highestVersion,
    };
  }

  for (const dir of options.pathDirs) {
    const found = options.findExecutableInDir(dir, "claude");
    if (found !== undefined && !options.isOwnBinary(found)) {
      return { path: found, source: "path-fallback" };
    }
  }

  throw new Error(
    `Could not find a claude binary. Looked for genuinely-executable versioned binaries under ` +
      `"${versionsDir}" (missing, empty, or containing nothing executable) and for a "claude" ` +
      `executable on PATH (never this tool's own binary). Install Claude Code, or ` +
      `set the versions directory / PATH correctly, then try again.`,
  );
}

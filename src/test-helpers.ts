import path from "node:path";

import categoriesDefaultJson from "./config/categories.default.json";
import { CategoryClassificationSchema, type CategoryClassification } from "./config/schema";
import type { CommandDeps } from "./cli/commandDeps";
import type { MultiselectParams, PromptsPort, SelectParams } from "./configure";
import type { HeadroomSocketTrustPorts, SocketPathStat } from "./headroom/socket";
import type { FarmFs, FarmStat } from "./launcher/ports";
import type { LayoutPaths } from "./paths";
import type { EntryFact, EntryFacts } from "./resolve/types";
import { vi, type Mock } from "vitest";

import { runLauncher, type FarmRuntime, type RunLauncherParams } from "./launcher";
import type { CredentialCommandResult, CredentialPort } from "./credential";
import type { FsPort, FrontDoorPort, LogPort, ProcPort, SpawnPort, SpawnResult } from "./launcher/ports";
import { buildLayoutPaths } from "./paths";
import type { CascadeInput } from "./resolve/walk";
import type { DiscoveredClaudeBinary } from "./versionDiscovery";
import type { PipelineDeps } from "./frontdoor/pipeline";
import { AUTH_HEADER } from "./frontdoor/route";

/** The shipped classification map, parsed once, for use as the default in tests. */
export const shippedClassification: CategoryClassification = CategoryClassificationSchema.parse(categoriesDefaultJson);

/** A fake home directory. Deliberately not the real one: nothing in this project's tests may resolve to a path Joe actually uses. */
export const FAKE_HOME = "/home/testuser";
/** A fake `~/.claude`, matching FAKE_HOME. */
export const FAKE_CLAUDE_HOME = `${FAKE_HOME}/.claude`;

/** How one fake entry should look. Anything omitted gets a deterministic default. */
export interface FakeEntrySpec {
  readonly dir?: boolean;
  readonly symlink?: boolean;
  readonly mtimeMs?: number;
  readonly sizeBytes?: number;
}

const FAKE_NOW_YEAR = 2026;
const FAKE_NOW_MONTH_INDEX = 0;
const FAKE_NOW_DAY = 15;
const FAKE_NOW_HOUR = 12;

/** Fixed "now" for every test, so no assertion is time-dependent. */
export const FAKE_NOW_MS = Date.UTC(FAKE_NOW_YEAR, FAKE_NOW_MONTH_INDEX, FAKE_NOW_DAY, FAKE_NOW_HOUR, 0, 0);

/** Milliseconds in one day, for writing readable relative mtimes in fixtures. */
export const DAY_MS = 86_400_000;

/** A fake `sleep(ms)` for lock/retry tests: never actually sleeps, but records every requested delay so a test can assert on backoff behaviour instead of being a bare no-op. */
export function fakeSleep(): { readonly sleep: (ms: number) => void; readonly delays: number[] } {
  const delays: number[] = [];
  return {
    sleep: (ms: number) => {
      delays.push(ms);
    },
    delays,
  };
}

function parentOf(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index === -1 ? "" : rel.slice(0, index);
}

/**
 * Builds a fake `EntryFacts` manifest from a flat path-to-spec map.
 *
 * Any parent directory implied by a path but not declared is created automatically, and every directory's `latestMtimeMs` and `totalSizeBytes` are aggregated over its whole subtree — matching what a real fact-builder must do, and what a directory-scoped `newerThan`/`maxSizeBytes` condition depends on.
 */
export function makeFacts(
  specs: Readonly<Record<string, FakeEntrySpec | true>>,
  overrides: Partial<Omit<EntryFacts, "entries">> = {},
): EntryFacts {
  const normalised = new Map<string, FakeEntrySpec>();
  for (const [rel, spec] of Object.entries(specs)) {
    normalised.set(rel, spec === true ? {} : spec);
    let parent = parentOf(rel);
    while (parent !== "") {
      if (!normalised.has(parent)) {
        // An implied parent directory gets a zero mtime and size so it never dominates its own subtree's aggregates — a real directory's own inode stat says nothing about what it contains, and a fixture that accidentally asserted otherwise would hide the very bug the subtree aggregation exists to prevent.
        normalised.set(parent, { dir: true, mtimeMs: 0, sizeBytes: 0 });
      }
      parent = parentOf(parent);
    }
  }

  const children = new Map<string, string[]>();
  for (const rel of normalised.keys()) {
    const parent = parentOf(rel);
    const bucket = children.get(parent);
    if (bucket === undefined) {
      children.set(parent, [rel]);
    } else {
      bucket.push(rel);
    }
  }

  const isDirectory = (rel: string): boolean => normalised.get(rel)?.dir === true || (children.get(rel) ?? []).length > 0;

  const aggregate = (rel: string): { latestMtimeMs: number; totalSizeBytes: number } => {
    const spec = normalised.get(rel) ?? {};
    let latest = spec.mtimeMs ?? FAKE_NOW_MS;
    let total = spec.sizeBytes ?? (isDirectory(rel) ? 0 : 1);
    for (const child of children.get(rel) ?? []) {
      const childAggregate = aggregate(child);
      latest = Math.max(latest, childAggregate.latestMtimeMs);
      total += childAggregate.totalSizeBytes;
    }
    return { latestMtimeMs: latest, totalSizeBytes: total };
  };

  const entries = new Map<string, EntryFact>();
  for (const [rel, spec] of normalised) {
    const directory = isDirectory(rel);
    const { latestMtimeMs, totalSizeBytes } = aggregate(rel);
    entries.set(rel, {
      relPath: rel,
      isDirectory: directory,
      isSymlink: spec.symlink ?? false,
      mtimeMs: spec.mtimeMs ?? FAKE_NOW_MS,
      latestMtimeMs,
      sizeBytes: spec.sizeBytes ?? (directory ? 0 : 1),
      totalSizeBytes,
    });
  }

  return {
    nowMs: FAKE_NOW_MS,
    home: FAKE_HOME,
    claudeHome: FAKE_CLAUDE_HOME,
    cwd: `${FAKE_HOME}/work`,
    env: {},
    ...overrides,
    entries,
  };
}

/** The modes the owner-only primitives record, mirroring the real port's. */
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

/** One node of the in-memory filesystem behind `createFakeFarmFs`. */
type FakeNode =
  | { kind: "dir"; mtimeMs: number }
  | { kind: "file"; mtimeMs: number; content: string }
  | { kind: "symlink"; mtimeMs: number; target: string };

/** One mutating operation the fake filesystem performed, recorded so a test can assert that a resync wrote nothing at all. */
interface FakeFsWrite {
  readonly op: "mkdirp" | "symlink" | "rename" | "remove" | "copy" | "write" | "append";
  readonly path: string;
}

/** How one seeded entry should look. A string is shorthand for a file with that content. */
export type FakeFsSeed = string | { readonly symlink: string } | { readonly dir: true };

/** An in-memory `FarmFs` plus the extra handles a test needs to seed it and inspect what it did. */
export interface FakeFarmFs extends FarmFs {
  /** Creates entries (and any missing parent directories) from a flat path-to-content map. */
  readonly seed: (entries: Readonly<Record<string, FakeFsSeed>>) => void;
  /** Every mutating operation performed so far, in order. */
  readonly writes: FakeFsWrite[];
  /** Every path currently present, sorted — the whole filesystem, for a snapshot-style assertion. */
  readonly snapshot: (root?: string) => string[];
  /** The symlink target at `path`, or undefined when it is not a symlink. */
  readonly linkTarget: (path: string) => string | undefined;
  /** The permission mode recorded for `path` by `mkdirPrivate` or `writeFilePrivate`, or undefined for anything created without an explicit mode. */
  readonly modeOf: (path: string) => number | undefined;
}

/**
 * Builds an in-memory `FarmFs`.
 *
 * Deliberately stricter than the real thing in the two places where being lenient would hide a bug: writing a file into a directory that does not exist throws rather than creating it, and renaming onto an existing path throws rather than silently replacing it. Both are mistakes the real implementation would surface as an exception too, just later and less legibly.
 */
export function createFakeFarmFs(initial: Readonly<Record<string, FakeFsSeed>> = {}): FakeFarmFs {
  const nodes = new Map<string, FakeNode>();
  const modes = new Map<string, number>();
  const writes: FakeFsWrite[] = [];
  let clock = 1_000;

  const nextMtime = (): number => {
    clock += 1;
    return clock;
  };

  const mkdirp = (dirPath: string): void => {
    const parts = path.resolve(dirPath).split("/").filter((part) => part !== "");
    let current = "";
    for (const part of parts) {
      current = `${current}/${part}`;
      const existing = nodes.get(current);
      if (existing === undefined) {
        nodes.set(current, { kind: "dir", mtimeMs: nextMtime() });
      } else if (existing.kind !== "dir") {
        throw new Error(`Cannot create directory ${dirPath}: ${current} exists and is a ${existing.kind}.`);
      }
    }
  };

  const descendantsOf = (target: string): string[] =>
    [...nodes.keys()].filter((candidate) => candidate.startsWith(`${target}/`));

  const seed = (entries: Readonly<Record<string, FakeFsSeed>>): void => {
    for (const [entryPath, value] of Object.entries(entries)) {
      const resolved = path.resolve(entryPath);
      mkdirp(path.dirname(resolved));
      if (typeof value === "string") {
        nodes.set(resolved, { kind: "file", mtimeMs: nextMtime(), content: value });
      } else if ("symlink" in value) {
        nodes.set(resolved, { kind: "symlink", mtimeMs: nextMtime(), target: value.symlink });
      } else {
        mkdirp(resolved);
      }
    }
  };

  seed(initial);
  writes.length = 0;

  const statOf = (node: FakeNode): FarmStat => {
    if (node.kind === "file") {
      return { kind: "file", mtimeMs: node.mtimeMs, sizeBytes: node.content.length };
    }
    if (node.kind === "symlink") {
      return { kind: "symlink", mtimeMs: node.mtimeMs, sizeBytes: node.target.length };
    }
    return { kind: "dir", mtimeMs: node.mtimeMs, sizeBytes: 0 };
  };

  const fs: FakeFarmFs = {
    seed,
    writes,
    modeOf: (target: string) => modes.get(path.resolve(target)),
    snapshot: (root?: string) =>
      [...nodes.keys()].filter((candidate) => root === undefined || candidate === root || candidate.startsWith(`${root}/`)).sort(),
    linkTarget: (linkPath: string) => {
      const node = nodes.get(path.resolve(linkPath));
      return node?.kind === "symlink" ? node.target : undefined;
    },
    lstat: (target: string) => {
      const node = nodes.get(path.resolve(target));
      return node === undefined ? undefined : statOf(node);
    },
    readdir: (dirPath: string) => {
      const resolved = path.resolve(dirPath);
      if (nodes.get(resolved)?.kind !== "dir") {
        return [];
      }
      const prefix = `${resolved}/`;
      const names = new Set<string>();
      for (const candidate of nodes.keys()) {
        if (!candidate.startsWith(prefix)) {
          continue;
        }
        const rest = candidate.slice(prefix.length);
        const head = rest.split("/")[0];
        if (head !== undefined && head !== "") {
          names.add(head);
        }
      }
      return [...names].sort();
    },
    mkdirp: (dirPath: string) => {
      writes.push({ op: "mkdirp", path: dirPath });
      mkdirp(dirPath);
    },
    mkdirPrivate: (dirPath: string) => {
      writes.push({ op: "mkdirp", path: dirPath });
      mkdirp(dirPath);
      modes.set(path.resolve(dirPath), OWNER_ONLY_DIR_MODE);
    },
    writeFilePrivate: (filePath: string, contents: string) => {
      const resolved = path.resolve(filePath);
      writes.push({ op: "write", path: resolved });
      if (nodes.get(path.dirname(resolved))?.kind !== "dir") {
        throw new Error(`Cannot write ${resolved}: its parent directory does not exist.`);
      }
      nodes.set(resolved, { kind: "file", mtimeMs: nextMtime(), content: contents });
      modes.set(resolved, OWNER_ONLY_FILE_MODE);
    },
    appendFilePrivate: (filePath: string, contents: string) => {
      const resolved = path.resolve(filePath);
      writes.push({ op: "append", path: resolved });
      if (nodes.get(path.dirname(resolved))?.kind !== "dir") {
        throw new Error(`Cannot append to ${resolved}: its parent directory does not exist.`);
      }
      const existing = nodes.get(resolved);
      if (existing !== undefined && existing.kind !== "file") {
        throw new Error(`Cannot append to ${resolved}: it is a ${existing.kind}.`);
      }
      nodes.set(resolved, { kind: "file", mtimeMs: nextMtime(), content: `${existing?.content ?? ""}${contents}` });
      modes.set(resolved, OWNER_ONLY_FILE_MODE);
    },
    symlink: (target: string, linkPath: string) => {
      const resolved = path.resolve(linkPath);
      writes.push({ op: "symlink", path: resolved });
      if (nodes.has(resolved)) {
        throw new Error(`Cannot create symlink ${resolved}: it already exists.`);
      }
      nodes.set(resolved, { kind: "symlink", mtimeMs: nextMtime(), target });
    },
    rename: (from: string, to: string) => {
      const source = path.resolve(from);
      const destination = path.resolve(to);
      writes.push({ op: "rename", path: `${source} -> ${destination}` });
      const node = nodes.get(source);
      if (node === undefined) {
        throw new Error(`Cannot rename ${source}: it does not exist.`);
      }
      if (nodes.has(destination)) {
        throw new Error(`Cannot rename ${source} to ${destination}: the destination already exists.`);
      }
      for (const descendant of descendantsOf(source)) {
        const moved = nodes.get(descendant);
        if (moved !== undefined) {
          nodes.set(`${destination}${descendant.slice(source.length)}`, moved);
          nodes.delete(descendant);
        }
      }
      nodes.set(destination, node);
      nodes.delete(source);
    },
    removeRecursive: (target: string) => {
      const resolved = path.resolve(target);
      writes.push({ op: "remove", path: resolved });
      for (const descendant of descendantsOf(resolved)) {
        nodes.delete(descendant);
      }
      nodes.delete(resolved);
    },
    copyRecursive: (from: string, to: string) => {
      const source = path.resolve(from);
      const destination = path.resolve(to);
      writes.push({ op: "copy", path: `${source} -> ${destination}` });
      const node = nodes.get(source);
      if (node === undefined) {
        throw new Error(`Cannot copy ${source}: it does not exist.`);
      }
      nodes.set(destination, { ...node });
      for (const descendant of descendantsOf(source)) {
        const copied = nodes.get(descendant);
        if (copied !== undefined) {
          nodes.set(`${destination}${descendant.slice(source.length)}`, { ...copied });
        }
      }
    },
    readFileUtf8: (filePath: string) => {
      const node = nodes.get(path.resolve(filePath));
      return node?.kind === "file" ? node.content : undefined;
    },
    writeFileUtf8: (filePath: string, contents: string) => {
      const resolved = path.resolve(filePath);
      writes.push({ op: "write", path: resolved });
      if (nodes.get(path.dirname(resolved))?.kind !== "dir") {
        throw new Error(`Cannot write ${resolved}: its parent directory does not exist.`);
      }
      nodes.set(resolved, { kind: "file", mtimeMs: nextMtime(), content: contents });
    },
    writeFileExclusive: (filePath: string, contents: string) => {
      const resolved = path.resolve(filePath);
      if (nodes.has(resolved)) {
        return false;
      }
      writes.push({ op: "write", path: resolved });
      if (nodes.get(path.dirname(resolved))?.kind !== "dir") {
        throw new Error(`Cannot write ${resolved}: its parent directory does not exist.`);
      }
      nodes.set(resolved, { kind: "file", mtimeMs: nextMtime(), content: contents });
      return true;
    },
    hashFile: (filePath: string) => {
      const node = nodes.get(path.resolve(filePath));
      return node?.kind === "file" ? `sha:${node.content}` : undefined;
    },
  };

  return fs;
}

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process would exit with code ${String(code)}`);
  }
}

export const paths = buildLayoutPaths("/home/testuser/.agent-shim");

export function fakeProc(env: Readonly<Record<string, string | undefined>>, argv: readonly string[]): ProcPort {
  return {
    env,
    argv,
    exit: (code: number): never => {
      throw new ExitCalled(code);
    },
  };
}

/** The identities every launcher test can select by name: each has an `identity.json`, since a launch naming an identity without one is refused. */
const EXISTING_IDENTITIES: Readonly<Record<string, unknown>> = Object.fromEntries(
  ["work", "personal"].map((name) => [`${paths.identitiesDir}/${name}/identity.json`, { name, allowAmbientCredential: false }]),
);

/** A fake `FsPort` over `ownFiles`, layered over `EXISTING_IDENTITIES` so a test only spells out the files it is actually about. */
export function fakeFs(ownFiles: Record<string, unknown>): FsPort {
  const files: Record<string, unknown> = { ...EXISTING_IDENTITIES, ...ownFiles };
  return {
    readFileUtf8: (filePath) => {
      const value = files[filePath];
      return typeof value === "string" ? value : undefined;
    },
    readConfigFile: (filePath) => {
      const value = files[filePath];
      return value === undefined || typeof value === "string" ? undefined : value;
    },
    readdir: (dir) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => file.slice(dir.length + 1).split("/")[0] ?? "")
        .filter((name) => name !== ""),
  };
}

/** The trust bundle path every fake front door hands its launches. */
export const FAKE_TRUST_BUNDLE = "/home/testuser/.agent-shim/frontdoor/ca/ca.pem";

/** A fake `FrontDoorPort` that counts its bring-ups and releases and records the inherited CA bundle each bring-up was given, so a test can assert both that the door came up and that the launcher released its session. */
export function fakeFrontDoorPort(
  port = 4100,
  connectPort = 4200,
  trust: { readonly path: string; readonly warning?: string } = { path: FAKE_TRUST_BUNDLE },
): FrontDoorPort & { readonly ensures: () => number; readonly releases: () => number; readonly inherited: () => readonly (string | undefined)[] } {
  let ensures = 0;
  let releases = 0;
  const inherited: (string | undefined)[] = [];
  return {
    ensures: () => ensures,
    releases: () => releases,
    inherited: () => inherited,
    ensure: (inheritedExtraCaCerts) => {
      ensures += 1;
      inherited.push(inheritedExtraCaCerts);
      return { port, connectPort, trustBundlePath: trust.path, ...(trust.warning === undefined ? {} : { trustWarning: trust.warning }), sessionToken: "launch-token-for-tests" };
    },
    release: () => {
      releases += 1;
    },
  };
}

/** An admission step that routes every request with its forwardable headers unchanged: for tests exercising the pipeline's other stages, never for one asserting what a listener admits. */
export const admitEverything: PipelineDeps["admit"] = (request) => ({ ok: true, headers: { ...request.forwardable } });

/** An admission step that routes only requests presenting `token` as their launch capability, the way a client-facing listener admits a live launch. */
export function admitLaunchToken(token: string): PipelineDeps["admit"] {
  return (request) => (request.headers[AUTH_HEADER] === token ? { ok: true, headers: { ...request.forwardable } } : { ok: false, message: "no live capability" });
}

export function fakeLog(): LogPort & { infos: string[]; warns: string[]; errors: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warns,
    errors,
    info: (message) => { infos.push(message); },
    warn: (message) => { warns.push(message); },
    error: (message) => { errors.push(message); },
  };
}

export function fakeSpawn(result: SpawnResult = { status: 0, signal: null }): SpawnPort & { spawnSync: Mock<SpawnPort["spawnSync"]> } {
  return { spawnSync: vi.fn<SpawnPort["spawnSync"]>().mockReturnValue(result) };
}

/** The env the child was spawned with, from the first spawn call: for tests that assert a few specific keys of an otherwise large environment. */
export function spawnedEnv(spawn: ReturnType<typeof fakeSpawn>): Record<string, string | undefined> {
  const call = spawn.spawnSync.mock.calls[0];
  if (call === undefined) {
    throw new Error("expected spawnSync to have been called");
  }
  const options = call[2];
  return options.env;
}

/** What a `fakeCredentials` port answers: secret files by path, one scripted result for every command, and whether a person is present. */
export interface FakeCredentialOptions {
  readonly files?: Readonly<Record<string, { readonly content: string; readonly mode?: number }>>;
  readonly command?: Partial<CredentialCommandResult>;
  readonly personPresent?: boolean;
}

/** An owner-only secret file's mode, the one `file` sources accept. */
const OWNER_ONLY_MODE = 0o100600;

/** A `CredentialPort` over scripted answers, recording each call, so no test runs `op`, reads the Keychain or needs a terminal. Every command succeeds with empty stdout unless `command` says otherwise, and a person is present unless `personPresent` is false. */
export function fakeCredentials(options: FakeCredentialOptions = {}): CredentialPort & {
  readonly runCommand: Mock<CredentialPort["runCommand"]>;
  readonly readSecretFile: Mock<CredentialPort["readSecretFile"]>;
} {
  return {
    readSecretFile: vi.fn<CredentialPort["readSecretFile"]>((filePath) => {
      const file = options.files?.[filePath];
      return file === undefined ? { found: false } : { found: true, content: file.content, mode: file.mode ?? OWNER_ONLY_MODE };
    }),
    runCommand: vi
      .fn<CredentialPort["runCommand"]>()
      .mockReturnValue({ status: 0, stdout: "", stderr: "", timedOut: false, ...options.command }),
    personPresent: () => options.personPresent ?? true,
  };
}

export const discovered: DiscoveredClaudeBinary = { path: "/home/testuser/.local/share/claude/versions/2.1.0", source: "versions-dir", version: "2.1.0" };

export function runAndCaptureExit(params: RunLauncherParams): number {
  try {
    runLauncher(params);
  } catch (error) {
    if (error instanceof ExitCalled) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected runLauncher to reach spawnClaude's proc.exit");
}

export function fakeFarm(fs: FakeFarmFs, cliOverride?: CascadeInput["cliOverride"]): FarmRuntime {
  return {
    fs,
    claudeHome: FAKE_CLAUDE_HOME,
    home: FAKE_HOME,
    cwd: `${FAKE_HOME}/work`,
    classification: { defaults: shippedClassification },
    loadCascade: () => ({
      home: FAKE_HOME,
      loadProfile: () => undefined,
      levels: [],
      ...(cliOverride === undefined ? {} : { cliOverride }),
    }),
    now: () => FAKE_NOW_MS,
    uniqueSuffix: "launcher-test",
    lock: { pid: 42, isRunning: () => true, sleep: fakeSleep().sleep, maxAttempts: 2 },
  };
}

/** A scripted `PromptsPort`: each prompt call consumes the next answer in order. A symbol answer is a cancellation; a select or multiselect answer must name one of the prompt's own options. */
export function scriptedPrompts(answers: readonly unknown[]): PromptsPort {
  let index = 0;
  const next = (): unknown => {
    const value = answers[index];
    index += 1;
    return value;
  };
  return {
    select: async <Value extends string>(params: SelectParams<Value>): Promise<Value | symbol> => {
      const answer = next();
      if (typeof answer === "symbol") return Promise.resolve(answer);
      const option = params.options.find((o) => o.value === answer);
      if (option === undefined) throw new Error(`scripted select answer not in options: ${String(answer)}`);
      return Promise.resolve(option.value);
    },
    multiselect: async <Value extends string>(params: MultiselectParams<Value>): Promise<readonly Value[] | symbol> => {
      const answer = next();
      if (typeof answer === "symbol") return Promise.resolve(answer);
      if (!Array.isArray(answer)) throw new Error(`scripted multiselect answer is not an array: ${String(answer)}`);
      const selected: Value[] = [];
      for (const item of answer) {
        const option = params.options.find((o) => o.value === item);
        if (option === undefined) throw new Error(`scripted multiselect answer not in options: ${String(item)}`);
        selected.push(option.value);
      }
      return Promise.resolve(selected);
    },
    text: async (): Promise<string | symbol> => {
      const answer = next();
      if (typeof answer === "symbol") return Promise.resolve(answer);
      if (typeof answer !== "string") throw new Error(`scripted text answer is not a string: ${String(answer)}`);
      return Promise.resolve(answer);
    },
    isCancel: (value: unknown): value is symbol => typeof value === "symbol",
    cancel: () => undefined,
    intro: () => undefined,
    outro: () => undefined,
  };
}

/** Raised by `fakeCommandDeps`' `exit`, so a test sees the status a command asked to exit with instead of the process ending. */
class FakeExit extends Error {
  constructor(readonly code: number) {
    super(`process would exit with code ${String(code)}`);
  }
}

/** A `CommandDeps` for command tests: a non-interactive terminal with no scripted answers unless `options` says otherwise, and an `exit` that throws `FakeExit`. */
export function fakeCommandDeps(
  layout: LayoutPaths,
  options: Readonly<{ interactive?: boolean; answers?: readonly unknown[] }> = {},
): CommandDeps {
  return {
    paths: layout,
    prompts: scriptedPrompts(options.answers ?? []),
    isInteractive: () => options.interactive ?? false,
    exit: (code: number): never => {
      throw new FakeExit(code);
    },
  };
}

/** The uid the fake socket trust reports for this process and, unless overridden, for every path it stats. */
export const FAKE_UID = 501;

/** The mode the fake socket trust reports for a fake directory created without an explicit one: an ordinary `mkdir` under a 022 umask. */
const FAKE_DEFAULT_DIR_MODE = 0o755;

/**
 * A `HeadroomSocketTrustPorts` over a fake farm filesystem: a fake directory stats as owned by `FAKE_UID` with the mode the fake recorded (`mkdirPrivate` records 0700) or an ordinary 0755, a fake symlink as a symlink, and anything listed in `overrides` (keyed by resolved path) exactly as given, which is how a test stands up a socket, another user's directory, or a wide mode without a real filesystem.
 */
export function fakeSocketTrust(
  fs: FakeFarmFs,
  options: { readonly platform?: string; readonly overrides?: Readonly<Record<string, SocketPathStat>> } = {},
): HeadroomSocketTrustPorts {
  return {
    platform: options.platform ?? "linux",
    currentUid: () => FAKE_UID,
    lstat: (target) => {
      const resolved = path.resolve(target);
      const override = options.overrides?.[resolved];
      if (override !== undefined) {
        return override;
      }
      const stat = fs.lstat(resolved);
      if (stat === undefined) {
        return undefined;
      }
      const kind = stat.kind === "dir" ? "dir" : stat.kind === "symlink" ? "symlink" : "other";
      return { kind, uid: FAKE_UID, mode: fs.modeOf(resolved) ?? FAKE_DEFAULT_DIR_MODE };
    },
  };
}

import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { ProviderSchema, type Provider } from "../config/schema";
import type { FarmFs } from "../launcher/ports";

/**
 * The two names the headroom state has lived at: the one name every release shares (`LayoutPaths.headroomStateFile`, `state.json`), and the previous release's versioned name for it (`state.v2.json`), read only while a supervisor from that release is still alive and cleaned up once its generation has drained. A supervisor from an older release keeps running, and writing, until its own sessions end, which is why the shared name is arbitrated by ownership rather than by another version bump: a supervisor stands down while the state file names another live supervisor, treats an absent or dead-owner record (including one from a schema it cannot parse, such as the TCP-port era's) as claimable, and a superseded generation's last write is its own shutdown record, which the next claim heals. The realistic cost is that during the rare cross-era window a displaced record can cause one extra supervisor spawn, which then claims and serves; sessions are never cut off, because each generation's daemon serves only its own registered sessions on its own pid-named socket.
 */
export interface HeadroomStateFiles {
  readonly stateFile: string;
  readonly legacyStateFile: string;
}

/**
 * The headroom supervisor's state file under `<home>/headroom/`. Every field is optional because the file exists in stages: a fresh supervisor writes only `supervisorPid` before the daemon is up, and a shut-down daemon leaves the file with everything cleared except any `lastError` worth surfacing.
 */
export const HeadroomStateSchema = z.strictObject({
  /** The supervisor process owning the daemon. Alive means someone is keeping headroom running. */
  supervisorPid: z.number().int().positive().optional(),
  /** The headroom proxy process itself, recorded as soon as it is spawned (before it is ready, which `socketPath` signals) so a successor can find a daemon whose supervisor died during its start. Absent while the supervisor is between restarts. */
  headroomPid: z.number().int().positive().optional(),
  /**
   * The unix socket the proxy serves on, inside the owner-only socket directory. Absent until the proxy has passed its readiness check, so "socketPath is set" is itself the ready signal a launcher polls for. The front door reads it on every hop, so a restart (which keeps the generation's path) is followed without anything being relaunched.
   */
  socketPath: z.string().min(1).optional(),
  /** The `headroom --version` output of the running install. */
  version: z.string().optional(),
  /**
   * Hash of the allowlist the running proxy serves. The supervisor records it in the same tick it writes that allowlist to `LayoutPaths.headroomAllowlistFile`, which the proxy re-reads on its next request, so a provider launch, whose requests come back through its front door's direct origin, waits until this names an allowlist holding that origin. A supervisor from an earlier release records here the hash of the allowlist its daemon was started with instead (see `earlierRelease.ts`).
   */
  allowlistHash: z.string().optional(),
  /** Hash of the token-saving settings the running proxy was started with, so a settings change is detected as drift. */
  settingsHash: z.string().optional(),
  /** The install spec the running install was last installed from, so a `source` config change is detected as drift. */
  installedSource: z.string().optional(),
  /** The install spec the supervisor is installing right now, present only while `uv tool install` runs, so a launcher that finds a live supervisor with no daemon yet keeps waiting for the install instead of counting it against its start bound. Cleared by the write that follows the install, whatever its outcome. */
  installing: z.string().optional(),
  /** The last fatal error, kept across shutdowns so `headroom status` can explain a daemon that is not running. */
  lastError: z.string().optional(),
});
export type HeadroomState = z.infer<typeof HeadroomStateSchema>;

/** The filesystem operations headroom coordination needs: the same shape as `FarmFs`, injected so every decision over state, sessions, and the start lock runs against an in-memory fake in tests. */
export type HeadroomFs = Pick<
  FarmFs,
  "mkdirp" | "mkdirPrivate" | "readFileUtf8" | "writeFileUtf8" | "writeFilePrivate" | "writeFileExclusive" | "readdir" | "removeRecursive"
>;

/**
 * The record held in one session-registry file. `supervisorPid` names the supervisor whose daemon the launch connected to: several supervisors can be alive at once (a superseded one keeps serving the sessions it already has), and each must judge idle shutdown and drift restarts by its own sessions only, or none would ever retire.
 */
const HeadroomSessionSchema = z.strictObject({ pid: z.number().int().positive(), startedAt: z.number(), supervisorPid: z.number().int().positive() });
export type HeadroomSession = z.infer<typeof HeadroomSessionSchema>;

/** The exclusive-create start lock's recorded holder. */
const HeadroomLockSchema = z.strictObject({ pid: z.number().int().positive(), at: z.number() });
export type HeadroomLock = z.infer<typeof HeadroomLockSchema>;

function parseJson<T>(raw: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = schema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : undefined;
}

/** Reads the state file, or undefined when absent. A malformed file is treated as absent: the lock-and-spawn flow below overwrites it with a fresh supervisor's state rather than crashing every future launch over one bad write. */
export function readHeadroomState(fs: HeadroomFs, stateFile: string): HeadroomState | undefined {
  try {
    return parseJson(fs.readFileUtf8(stateFile), HeadroomStateSchema);
  } catch {
    return undefined;
  }
}

/**
 * Writes the state file atomically (a temporary sibling renamed into place), so a concurrent reader never sees a partial file. A reader treats a malformed file as absent, and a launcher that finds no supervisor in state spawns one, so a torn write read mid-flight started a redundant supervisor and daemon.
 */
export function writeHeadroomState(fs: HeadroomFs, stateFile: string, state: Readonly<HeadroomState>): void {
  fs.mkdirp(path.dirname(stateFile));
  fs.writeFilePrivate(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** What `resolveServingHeadroomState` found: the record a launch would join, and the file it was read from (the shared name once migration has run, the legacy name while that generation still serves). */
export interface ServingHeadroomState {
  readonly path: string;
  readonly state: HeadroomState;
}

/**
 * Resolves the serving state read-only: the shared file when it parses, otherwise the legacy file when it parses and names a live supervisor (a supervisor from the previous release, still serving its own sessions through the name that release used). A legacy record whose supervisor is not live is not serving anything and is left for `migrateHeadroomState` to claim; the return is undefined, which is the "spawn a supervisor" answer.
 */
export function resolveServingHeadroomState(fs: HeadroomFs, files: HeadroomStateFiles, isRunning: (pid: number) => boolean): ServingHeadroomState | undefined {
  const current = readHeadroomState(fs, files.stateFile);
  if (current !== undefined) {
    return { path: files.stateFile, state: current };
  }
  const legacy = readHeadroomState(fs, files.legacyStateFile);
  if (legacy?.supervisorPid !== undefined && isRunning(legacy.supervisorPid)) {
    return { path: files.legacyStateFile, state: legacy };
  }
  return undefined;
}

/**
 * Migrates the state files toward the one shared name: once the shared file parses, the legacy file is deleted unless it names a live supervisor; while the shared file is absent or unparseable (the TCP-port era's content reads exactly that way), a legacy record whose supervisor is not live is rewritten onto the shared name and the legacy file removed, and a legacy file that cannot be parsed at all is removed (nothing coordinates through a record its own reader treats as absent). Live-supervisor legacy records are left untouched: that generation keeps serving and writing its own file until it drains, and the next migration after it has gone claims or deletes what it left. Called from the two writers of the coordination (a launch's ensure and a supervisor's start), never from a read-only report, so the status and doctor collectors can stay pure by resolving without migrating.
 */
export function migrateHeadroomState(fs: HeadroomFs, files: HeadroomStateFiles, isRunning: (pid: number) => boolean): void {
  const legacy = readHeadroomState(fs, files.legacyStateFile);
  const legacyLive = legacy?.supervisorPid !== undefined && isRunning(legacy.supervisorPid);
  const current = readHeadroomState(fs, files.stateFile);
  if (current !== undefined || legacyLive) {
    // The shared name is already claimed, or a live previous-release generation still owns the legacy one: the only remaining work is removing a legacy file nothing live can still write.
    if (!legacyLive && fs.readFileUtf8(files.legacyStateFile) !== undefined) {
      fs.removeRecursive(files.legacyStateFile);
    }
    return;
  }
  if (legacy !== undefined) {
    writeHeadroomState(fs, files.stateFile, legacy);
  }
  fs.removeRecursive(files.legacyStateFile);
}

/** A stable hash of an allowlist, so drift detection compares one short string instead of recomputing set equality against a running process it cannot interrogate. */
export function hashAllowlist(allowlist: readonly string[]): string {
  return createHash("sha256").update(allowlist.join("\n")).digest("hex");
}

/** The `headroom proxy` option naming the allowlist file the daemon reads and re-reads on change. */
export const HEADROOM_ALLOWLIST_FILE_FLAG = "--allowed-base-urls-file";

/** The allowlist file's content: one entry per line in the order given (the supervisor writes the live doors' origins sorted), newline-terminated. Headroom separates entries by commas, tabs, carriage returns and line breaks; one per line keeps it readable and lets the supervisor compare it byte for byte against what it would write. */
export function formatAllowlistFile(allowlist: readonly string[]): string {
  return allowlist.map((entry) => `${entry}\n`).join("");
}

/** The hash of the entries an allowlist file's content lists, as a set: what the supervisor records once the file is in place, since it writes the entries sorted and without repeats, and what a reader compares that record against, whatever order a hand edit left them in. */
export function hashAllowlistFile(content: string): string {
  return hashAllowlist([...new Set(parseAllowlistFile(content))].sort());
}

/** The line boundaries headroom's parser recognises (Python's `str.splitlines`): newline, carriage return, vertical tab, form feed, the file, group and record separators, next line, and the Unicode line and paragraph separators. Each ends a line, and so a comment, and separates entries. */
// Regular-expression source, escaped, so the characters can sit inside a character class.
const ALLOWLIST_LINE_BREAKS = "\\n\\r\\u000b\\u000c\\u001c\\u001d\\u001e\\u0085\\u2028\\u2029";

/** The characters Python's `str.isspace` counts as whitespace, which headroom uses both to start a comment after and to reject an entry containing: wider than a JavaScript `\s` (the file, group, record and unit separators, and next line) and without its byte-order mark. */
const ALLOWLIST_WHITESPACE = "\\t\\n\\u000b\\u000c\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/** The entry separators headroom's allowlist file accepts: commas, tabs and every line boundary. */
const ALLOWLIST_FILE_SEPARATORS = new RegExp(`[,\\t${ALLOWLIST_LINE_BREAKS}]`, "u");

/** A comment in headroom's allowlist file: a `#` at the very start of the content, or after any whitespace character, through to the next line boundary. A `#` anywhere else is part of an entry. */
const ALLOWLIST_FILE_COMMENT = new RegExp(`(?:^|(?<=[${ALLOWLIST_WHITESPACE}]))#[^${ALLOWLIST_LINE_BREAKS}]*`, "gu");

/** Any whitespace character headroom counts, for rejecting an entry that contains one. */
const ALLOWLIST_ENTRY_WHITESPACE = new RegExp(`[${ALLOWLIST_WHITESPACE}]`, "u");

/** Leading and trailing whitespace as Python's `str.strip` removes it. */
const ALLOWLIST_SURROUNDING_WHITESPACE = new RegExp(`^[${ALLOWLIST_WHITESPACE}]+|[${ALLOWLIST_WHITESPACE}]+$`, "gu");

/** The URL schemes headroom's guard admits an origin for. */
const ALLOWLIST_SAFE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);

/** Whether a scheme-less entry is a hostname and nothing else, as headroom requires of one: no path, query, fragment or userinfo, and no colon outside an IPv6 literal's brackets (a colon there could only start a port, which a bare host, admitting every port, may not name). */
function isBareHost(entry: string): boolean {
  if (/[/?#@]/.test(entry)) {
    return false;
  }
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    return close > 1 && !entry.slice(close + 1).includes(":");
  }
  return entry !== "" && !entry.includes(":");
}

/** Whether a URL entry has a scheme headroom admits, a host, and a port that parses. */
function isAdmissibleUrl(entry: string): boolean {
  try {
    const url = new URL(entry);
    return ALLOWLIST_SAFE_SCHEMES.has(url.protocol) && url.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * The entries headroom would accept from an allowlist file's content, as written, following the rules of headroom's own parser (`headroom/proxy/upstream_guard.py` in the ExaDev fork): a leading byte-order mark is ignored; a `#` at the start of the content or after any whitespace character begins a comment that runs to the next line boundary; entries are separated by commas, tabs and line boundaries (`ALLOWLIST_LINE_BREAKS`), with surrounding whitespace and blank entries ignored; an entry containing whitespace, as Python's `str.isspace` counts it, is invalid; a scheme-less entry must be a hostname and nothing else (no port, even an empty one, and no path, userinfo, query or fragment); and a URL entry must use http, https, ws or wss and name a host with a port that parses. Invalid entries are dropped, as headroom skips them. Headroom then normalises each entry to a host or an origin; these are returned as written, so a caller compares them with the origins the supervisor writes, and a hand-written variant of the same origin reads as a different entry.
 */
export function parseAllowlistFile(content: string): readonly string[] {
  return content
    .replace(/^\uFEFF/, "")
    .replace(ALLOWLIST_FILE_COMMENT, "")
    .split(ALLOWLIST_FILE_SEPARATORS)
    .map((entry) => entry.replace(ALLOWLIST_SURROUNDING_WHITESPACE, ""))
    .filter((entry) => entry !== "" && !ALLOWLIST_ENTRY_WHITESPACE.test(entry) && (entry.includes("://") ? isAdmissibleUrl(entry) : isBareHost(entry)));
}

/** Replaces the allowlist file with `allowlist`, owner-only and atomically (a temporary sibling renamed into place): headroom notices the replacement by the file's changed identity and reads it whole, so it never serves a partial list. Throws when the write fails. */
export function writeAllowlistFile(fs: HeadroomFs, allowlistFile: string, allowlist: readonly string[]): void {
  fs.mkdirPrivate(path.dirname(allowlistFile));
  fs.writeFilePrivate(allowlistFile, formatAllowlistFile(allowlist));
}

/** Removes a temporary allowlist file (`<allowlist file>.<writer pid>.tmp`) that `writeFilePrivate` left behind when its writer died between writing and renaming: a temporary file exists only while its writer is between the two, so one whose writer is no longer running is stale, and a live writer's is left alone. `isRunning` must be zombie-aware. */
export function pruneStaleAllowlistTemporaries(fs: HeadroomFs, allowlistFile: string, isRunning: (pid: number) => boolean): void {
  const prefix = `${path.basename(allowlistFile)}.`;
  for (const name of fs.readdir(path.dirname(allowlistFile))) {
    const writer = name.startsWith(prefix) ? /^([1-9]\d*)\.tmp$/.exec(name.slice(prefix.length))?.[1] : undefined;
    if (writer !== undefined && !isRunning(Number(writer))) {
      fs.removeRecursive(path.join(path.dirname(allowlistFile), name));
    }
  }
}

/** Every provider definition under `providersDir`, best-effort: an unreadable or invalid file is skipped, so a caller listing providers is not failed by one broken file. */
export function readAllProviders(fs: HeadroomFs, providersDir: string): readonly { name: string; provider: Provider }[] {
  const result: { name: string; provider: Provider }[] = [];
  for (const name of fs.readdir(providersDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = parseJson(fs.readFileUtf8(path.join(providersDir, name)), ProviderSchema);
      if (parsed !== undefined) {
        result.push({ name: name.slice(0, -".json".length), provider: parsed });
      }
    } catch {
      continue;
    }
  }
  return result;
}

/** One live session-registry entry, or undefined when the launcher pid has no file. */
export function readSession(fs: HeadroomFs, sessionsDir: string, pid: number): HeadroomSession | undefined {
  try {
    return parseJson(fs.readFileUtf8(path.join(sessionsDir, `${String(pid)}.json`)), HeadroomSessionSchema);
  } catch {
    return undefined;
  }
}

/** Registers this launch in the session registry: the fact the daemon must keep serving, and the fact whose disappearance starts the idle shutdown clock. */
export function writeSession(fs: HeadroomFs, sessionsDir: string, session: Readonly<HeadroomSession>): void {
  fs.mkdirp(sessionsDir);
  fs.writeFileUtf8(path.join(sessionsDir, `${String(session.pid)}.json`), `${JSON.stringify(session, null, 2)}\n`);
}

/** Removes a launcher's registry entry. Idempotent: an absent entry is not an error, because the supervisor's own pruning may have removed it first. */
export function removeSession(fs: HeadroomFs, sessionsDir: string, pid: number): void {
  fs.removeRecursive(path.join(sessionsDir, `${String(pid)}.json`));
}

/** Every registry entry on disk, unreadable files skipped, sorted by pid: what `headroom status` prints and what the supervisor's idle and drift decisions read. */
export function listSessions(fs: HeadroomFs, sessionsDir: string): readonly HeadroomSession[] {
  const sessions: HeadroomSession[] = [];
  for (const name of fs.readdir(sessionsDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = parseJson(fs.readFileUtf8(path.join(sessionsDir, name)), HeadroomSessionSchema);
      if (parsed !== undefined) {
        sessions.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return sessions.sort((a, b) => a.pid - b.pid);
}

/** The registry entries recorded against one supervisor: the sessions whose daemon that supervisor is responsible for keeping up. */
export function sessionsForSupervisor(fs: HeadroomFs, sessionsDir: string, supervisorPid: number): readonly HeadroomSession[] {
  return listSessions(fs, sessionsDir).filter((session) => session.supervisorPid === supervisorPid);
}

/**
 * Removes every registry entry whose pid is no longer running: a launcher that died without releasing its entry must not keep the daemon awake or block a drift restart forever. The predicate must be zombie-aware (see `realIsProcessRunning`): a launcher that exited but was never reaped still answers signal 0 as alive, which would keep its session registered indefinitely.
 */
export function pruneDeadSessions(
  fs: HeadroomFs,
  sessionsDir: string,
  isRunning: (pid: number) => boolean,
): readonly number[] {
  const removed: number[] = [];
  for (const session of listSessions(fs, sessionsDir)) {
    if (!isRunning(session.pid)) {
      removeSession(fs, sessionsDir, session.pid);
      removed.push(session.pid);
    }
  }
  return removed;
}

/** Reads the start lock, or undefined when absent or unreadable. */
export function readStartLock(fs: HeadroomFs, lockFile: string): HeadroomLock | undefined {
  try {
    return parseJson(fs.readFileUtf8(lockFile), HeadroomLockSchema);
  } catch {
    return undefined;
  }
}

import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { ProviderSchema, type Provider } from "../config/schema";
import type { FarmFs } from "../launcher/ports";

/** The upstream headroom serves when no provider's base URL claims the request: Claude Code's own API. */
export const HEADROOM_ANTHROPIC_UPSTREAM = "https://api.anthropic.com";

/**
 * The headroom supervisor's state.json under `<home>/headroom/`. Every field is optional because the file exists in stages: a fresh supervisor writes only `supervisorPid` before the daemon is up, and a shut-down daemon leaves the file with everything cleared except any `lastError` worth surfacing.
 */
export const HeadroomStateSchema = z.strictObject({
  /** The supervisor process owning the daemon. Alive means someone is keeping headroom running. */
  supervisorPid: z.number().int().positive().optional(),
  /** The headroom proxy process itself. Absent while the supervisor is between restarts. */
  headroomPid: z.number().int().positive().optional(),
  /** The loopback port the proxy listens on. Absent until the proxy has passed its readiness check, so "port is set" is itself the ready signal a launcher polls for. */
  port: z.number().int().positive().optional(),
  /** The `headroom --version` output of the running install. */
  version: z.string().optional(),
  /** Hash of the allowlist the running proxy was started with, so a provider-file change is detected as drift. */
  allowlistHash: z.string().optional(),
  /** The install spec the running install was last installed from, so a `source` config change is detected as drift. */
  installedSource: z.string().optional(),
  /** The last fatal error, kept across shutdowns so `headroom status` can explain a daemon that is not running. */
  lastError: z.string().optional(),
});
export type HeadroomState = z.infer<typeof HeadroomStateSchema>;

/** The filesystem operations headroom coordination needs: the same shape as `FarmFs`, injected so every decision over state, sessions, and the start lock runs against an in-memory fake in tests. */
export type HeadroomFs = Pick<
  FarmFs,
  "mkdirp" | "readFileUtf8" | "writeFileUtf8" | "writeFileExclusive" | "readdir" | "removeRecursive"
>;

/** The record held in one session-registry file. */
const HeadroomSessionSchema = z.strictObject({ pid: z.number().int().positive(), startedAt: z.number() });
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

/** Reads state.json, or undefined when absent. A malformed file is treated as absent: the lock-and-spawn flow below overwrites it with a fresh supervisor's state rather than crashing every future launch over one bad write. */
export function readHeadroomState(fs: HeadroomFs, stateFile: string): HeadroomState | undefined {
  try {
    return parseJson(fs.readFileUtf8(stateFile), HeadroomStateSchema);
  } catch {
    return undefined;
  }
}

/**
 * Writes state.json. A plain write rather than the write-then-rename most config files get: state.json is advisory coordination, read tolerantly (`readHeadroomState` treats a malformed file as absent) and rewritten constantly by the supervisor, and the exclusive-create start lock below, not this file, is the actual mutual exclusion.
 */
export function writeHeadroomState(fs: HeadroomFs, stateFile: string, state: Readonly<HeadroomState>): void {
  fs.mkdirp(path.dirname(stateFile));
  fs.writeFileUtf8(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** The allowlist the daemon is started with: every provider's base URL plus Claude Code's own API, so a session with no provider selected reaches the real Anthropic upstream through the same proxy. */
export function headroomAllowlist(providers: readonly { readonly baseUrl: string }[]): readonly string[] {
  const urls = new Set<string>([HEADROOM_ANTHROPIC_UPSTREAM]);
  for (const provider of providers) {
    urls.add(provider.baseUrl);
  }
  return [...urls].sort();
}

/** A stable hash of an allowlist, so drift detection compares one short string instead of recomputing set equality against a running process it cannot interrogate. */
export function hashAllowlist(allowlist: readonly string[]): string {
  return createHash("sha256").update(allowlist.join("\n")).digest("hex");
}

/** Every provider definition under `providersDir`, best-effort: unreadable files are skipped, because the allowlist's job is to open every upstream a launch might use, not to fail a launch over one broken file. */
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

/** Removes every registry entry whose pid is no longer alive: a launcher that died without releasing its entry must not keep the daemon awake or block a drift restart forever. Returns the pids removed. */
export function pruneDeadSessions(
  fs: HeadroomFs,
  sessionsDir: string,
  isProcessAlive: (pid: number) => boolean,
): readonly number[] {
  const removed: number[] = [];
  for (const session of listSessions(fs, sessionsDir)) {
    if (!isProcessAlive(session.pid)) {
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

import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { isCodexProvider, ProviderSchema, type Provider } from "../config/schema";
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
  /**
   * The loopback port the supervisor's in-process MITM CONNECT proxy listens on. Absent whenever no supervisor is serving it, so "mitmPort is set" is the ready signal an OAuth launch polls for alongside `port`.
   */
  mitmPort: z.number().int().positive().optional(),
  /**
   * The sticky MITM port preference, the exact analogue of `lastPort` for the second server: it survives every shutdown, because every OAuth session's environment was frozen at launch with HTTPS_PROXY pointing at this address and a restart that moves strands them.
   */
  lastMitmPort: z.number().int().positive().optional(),
  /**
   * The sticky port preference: the address the daemon last served on, kept across crashes, restarts, and idle shutdowns so the next start reuses it. Distinct from `port` on purpose: `port` is the ready signal (absent whenever nothing is serving), while `lastPort` survives every shutdown, because every live session's environment was frozen at launch pointing at this address and a restart that moves strands them.
   */
  lastPort: z.number().int().positive().optional(),
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

/**
 * The upstreams a set of providers routes to through headroom: every `http` provider's base URL, plus the codex daemon's origin when there is a codex provider and the daemon has ever served. A codex session routed through headroom carries the daemon's address in `x-headroom-base-url`, so headroom must admit it like any provider's; the daemon's port is sticky, so its origin stays stable across restarts. Before the daemon has ever served there is no address to admit, and the first codex launch starts it before bringing headroom up, so a freshly started headroom daemon already sees it.
 */
export function headroomUpstreams(providers: readonly Provider[], codexOrigin: string | undefined): readonly { readonly baseUrl: string }[] {
  const upstreams: { baseUrl: string }[] = [];
  let hasCodex = false;
  for (const provider of providers) {
    if (isCodexProvider(provider)) {
      hasCodex = true;
    } else {
      upstreams.push({ baseUrl: provider.baseUrl });
    }
  }
  if (hasCodex && codexOrigin !== undefined) {
    upstreams.push({ baseUrl: codexOrigin });
  }
  return upstreams;
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

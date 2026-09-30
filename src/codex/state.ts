import path from "node:path";
import { z } from "zod";

import type { HeadroomFs } from "../headroom/state";

/**
 * The codex supervisor's state.json under `<home>/codex/`. Every field is optional because the file exists in stages, exactly like headroom's: a fresh supervisor writes its own pid before the worker is up, and a shut-down daemon leaves only the sticky `lastPort` and any `lastError` worth surfacing.
 */
const CodexStateSchema = z.strictObject({
  /** The supervisor process keeping the translation worker alive. */
  supervisorPid: z.number().int().positive().optional(),
  /** The worker process serving the translation listener. Absent while the supervisor is between restarts. */
  workerPid: z.number().int().positive().optional(),
  /** The loopback port the worker listens on. Absent until the worker has answered its health check, so "port is set" is the ready signal a launcher polls for. */
  port: z.number().int().positive().optional(),
  /** The sticky port preference: kept across crashes, restarts and idle shutdowns so every session, whose base URL was frozen at launch, keeps finding the daemon at the same address. */
  lastPort: z.number().int().positive().optional(),
  /** The last fatal error, kept across shutdowns so `codex status` can explain a daemon that is not running. */
  lastError: z.string().optional(),
});
export type CodexState = z.infer<typeof CodexStateSchema>;

/** Reads state.json, or undefined when absent or malformed: a malformed file is overwritten by the next supervisor rather than failing every launch over one bad write. */
export function readCodexState(fs: HeadroomFs, stateFile: string): CodexState | undefined {
  let raw: string | undefined;
  try {
    raw = fs.readFileUtf8(stateFile);
  } catch {
    return undefined;
  }
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  try {
    const parsed = CodexStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Writes state.json. A plain write, for the reason headroom's is: the file is advisory coordination read tolerantly, and the exclusive-create start lock is the actual mutual exclusion. */
export function writeCodexState(fs: HeadroomFs, stateFile: string, state: Readonly<CodexState>): void {
  fs.mkdirp(path.dirname(stateFile));
  fs.writeFileUtf8(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** The origin a codex provider's requests reach the daemon at, or undefined before the daemon has ever served: what the headroom allowlist must admit for a codex provider routed through headroom. */
export function codexDaemonOrigin(state: CodexState | undefined): string | undefined {
  const port = state?.port ?? state?.lastPort;
  return port === undefined ? undefined : `http://127.0.0.1:${String(port)}`;
}

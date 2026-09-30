import path from "node:path";
import { z } from "zod";

import type { HeadroomFs } from "../headroom/state";

/**
 * The front-door supervisor's state.json under `<home>/frontdoor/`. Every field is optional because the file exists in stages, exactly like headroom's and the old codex daemon's: a fresh supervisor writes its own pid before the listener is up, and a shut-down front door leaves only the sticky `lastPort` and any `lastError` worth surfacing.
 */
const FrontDoorStateSchema = z.strictObject({
  /** The supervisor process serving the front door. Alive means both listeners are up in that process. */
  supervisorPid: z.number().int().positive().optional(),
  /** The loopback port the plain-HTTP front-door listener serves on. Absent until the listener has bound and answered its health probe, so "port is set" is itself the ready signal a launcher polls for. */
  port: z.number().int().positive().optional(),
  /**
   * The sticky port preference for the plain-HTTP listener: kept across crashes, restarts and idle shutdowns so every provider session, whose base URL was frozen at launch, keeps finding the front door at the same address.
   */
  lastPort: z.number().int().positive().optional(),
  /**
   * The loopback port the CONNECT surface listens on. Absent whenever no supervisor is serving it, so "connectPort is set" is the ready signal an OAuth launch polls for alongside `port`.
   */
  connectPort: z.number().int().positive().optional(),
  /**
   * The sticky port preference for the CONNECT surface, the exact analogue of `lastPort` for the second listener: it survives every shutdown, because every OAuth session's environment was frozen at launch with HTTPS_PROXY pointing at this address and a restart that moves strands them.
   */
  lastConnectPort: z.number().int().positive().optional(),
  /**
   * The loopback port the direct listener serves on: the listener a headroom hop tells the daemon to forward routed traffic back to. Sticky like the others, because headroom's allowlist admits its exact origin and an ephemeral port would invalidate the allowlist on every restart.
   */
  directPort: z.number().int().positive().optional(),
  /** The sticky port preference for the direct listener, for the reason `directPort` gives. */
  lastDirectPort: z.number().int().positive().optional(),
  /** The last fatal error, kept across shutdowns so `frontdoor status` can explain a front door that is not running. */
  lastError: z.string().optional(),
});
export type FrontDoorState = z.infer<typeof FrontDoorStateSchema>;

/** Reads state.json, or undefined when absent or malformed: a malformed file is overwritten by the next supervisor rather than failing every launch over one bad write. */
export function readFrontDoorState(fs: HeadroomFs, stateFile: string): FrontDoorState | undefined {
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
    const parsed = FrontDoorStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Writes state.json. A plain write, for the reason headroom's is: the file is advisory coordination read tolerantly, and the exclusive-create start lock is the actual mutual exclusion. */
export function writeFrontDoorState(fs: HeadroomFs, stateFile: string, state: Readonly<FrontDoorState>): void {
  fs.mkdirp(path.dirname(stateFile));
  fs.writeFileUtf8(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The origin the headroom hop forwards routed traffic back to (the direct listener's), or undefined before the front door has ever served: what the headroom allowlist must admit for a provider routed through headroom, since headroom reaches the door's routes at exactly this address.
 */
export function frontDoorOrigin(state: FrontDoorState | undefined): string | undefined {
  const port = state?.directPort ?? state?.lastDirectPort;
  return port === undefined ? undefined : `http://127.0.0.1:${String(port)}`;
}

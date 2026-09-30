import { randomUUID } from "node:crypto";

import { CliError } from "../cliError";
import type { LayoutPaths } from "../paths";
import { readStartLock, type HeadroomFs, type HeadroomLock } from "../headroom/state";
import { readFrontDoorState, writeFrontDoorSession } from "./state";

/** How long one launch waits for the front door. The listener is this same binary binding one loopback port, so a cold start takes a second or two; the bound only bites when something is genuinely broken. */
const FRONTDOOR_START_TIMEOUT_MS = 30_000;

/** The launcher's poll rate while waiting for the door. */
const FRONTDOOR_LAUNCHER_POLL_MS = 100;

/** Raised when the front door cannot be brought up in time or has recorded a fatal error: a routed launch has no other way to reach its provider, so it must fail rather than start a session that can never answer. */
export class FrontDoorStartError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "FrontDoorStartError";
  }
}

/** Every effect the ensure step performs, injected so it runs against fakes in tests. */
export interface EnsureFrontDoorPorts {
  readonly fs: HeadroomFs;
  /** Zombie-aware liveness (see `realIsProcessRunning`). */
  readonly isRunning: (pid: number) => boolean;
  readonly now: () => number;
  readonly sleep: (ms: number) => void;
  /** Spawns the detached front-door supervisor, returning its pid. */
  readonly spawnSupervisor: (paths: LayoutPaths) => number;
}

/**
 * Brings the front door up for this launch, or finds it serving, and registers this launcher pid in its session registry: the fact that keeps the door from idling out while this session lives, and the record that holds this launch's capability token. The same lock-and-poll coordination as headroom's and the old codex daemon's ensure: the exclusive-create start lock decides which of several concurrent launches spawns the one supervisor, everyone waits on state.json, and a lock whose holder died is removed and retried. Ready means state names a live supervisor and both listeners' ports, which the supervisor writes only after both have bound (and the plain listener has answered its health probe).
 */
export function ensureFrontDoor(params: { readonly paths: LayoutPaths; readonly launcherPid: number; readonly ports: EnsureFrontDoorPorts }): { readonly port: number; readonly connectPort: number; readonly token: string } {
  const { paths, ports } = params;
  const deadline = ports.now() + FRONTDOOR_START_TIMEOUT_MS;
  let spawned = false;

  for (;;) {
    const state = readFrontDoorState(ports.fs, paths.frontdoorStateFile);
    if (state?.supervisorPid !== undefined && ports.isRunning(state.supervisorPid)) {
      if (state.port !== undefined && state.connectPort !== undefined) {
        // The token is generated here, per launch: the registry entry is what the door's listeners check requests against, and a fresh launch invalidates nothing (its entry is added alongside the live ones).
        const token = randomUUID();
        writeFrontDoorSession(ports.fs, paths.frontdoorSessionsDir, { pid: params.launcherPid, startedAt: ports.now(), token });
        return { port: state.port, connectPort: state.connectPort, token };
      }
      if (state.lastError !== undefined) {
        throw new FrontDoorStartError(`claude-use: the front door reported a fatal error and is not serving: ${state.lastError} (daemon log: ${paths.frontdoorLogPath})`);
      }
    } else if (!spawned) {
      ports.fs.mkdirp(paths.frontdoorDir);
      const created = ports.fs.writeFileExclusive(paths.frontdoorLockFile, `${JSON.stringify({ pid: params.launcherPid, at: ports.now() } satisfies HeadroomLock)}\n`);
      if (created) {
        ports.spawnSupervisor(paths);
        spawned = true;
      } else {
        const lock = readStartLock(ports.fs, paths.frontdoorLockFile);
        if (lock === undefined || !ports.isRunning(lock.pid)) {
          // A dead holder's lock is litter from a launcher that died before its supervisor could clear it.
          ports.fs.removeRecursive(paths.frontdoorLockFile);
          continue;
        }
      }
    }

    if (ports.now() >= deadline) {
      const lastError = state?.lastError;
      throw new FrontDoorStartError(
        `claude-use: the front door did not become ready within ${String(FRONTDOOR_START_TIMEOUT_MS)}ms` +
          (lastError === undefined ? "" : ` (last error: ${lastError})`) +
          `. Daemon log: ${paths.frontdoorLogPath}`,
      );
    }
    ports.sleep(FRONTDOOR_LAUNCHER_POLL_MS);
  }
}

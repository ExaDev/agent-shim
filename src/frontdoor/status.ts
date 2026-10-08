import { verifyHeadroomSocket, type HeadroomSocketTarget, type HeadroomSocketTrustPorts } from "../headroom/socket";
import { readHeadroomState, type HeadroomFs } from "../headroom/state";
import type { LayoutPaths } from "../paths";
import { listFrontDoorSessions, readFrontDoorState, type FrontDoorSessionSummary, type FrontDoorState } from "./state";

/**
 * The front door's read-only status: the data `agent-shim frontdoor status` prints and the door's own typed `frontdoor.status` procedure returns, collected without starting or stopping anything. Kept here, beside the state file and session registry it reads, so both the command layer and the typed API's schema layer share one shape and one collector with no dependency on the CLI's command wiring.
 */

/**
 * The headroom daemon's socket as the hop may use it, read from the daemon's state on every routed request that needs the hop and authenticated each time: a new supervisor generation serves on a new path while this door keeps listening, and the hop must follow it (and answer 502 while the daemon is between restarts, or refuse a socket that fails the owner-only check). Undefined while no socket is recorded.
 */
export function headroomSocketTarget(fsPort: HeadroomFs, trust: HeadroomSocketTrustPorts, paths: LayoutPaths): HeadroomSocketTarget | undefined {
  // The shared name first, then the previous release's while a socket is recorded there: the hop is a read-only per-request view, so a legacy record is followed without liveness (a dead generation's socket fails verification or the dial exactly as any between-restart window does) and without migrating anything. One consequence of following a draining generation: its daemon runs an older allowlist, so a provider added since can meet a hard "Rejected unsafe upstream base URL" where the no-legacy behaviour would be a retriable 502, for exactly as long as that generation keeps serving.
  const socketPath = readHeadroomState(fsPort, paths.headroomStateFile)?.socketPath ?? readHeadroomState(fsPort, paths.headroomLegacyStateFile)?.socketPath;
  return socketPath === undefined ? undefined : verifyHeadroomSocket(socketPath, trust);
}

/** One session-registry entry plus whether its launcher is still running. */
export interface FrontDoorSessionStatus extends FrontDoorSessionSummary {
  readonly alive: boolean;
}

/** Everything `agent-shim frontdoor status` reports, collected read-only: no process is started or stopped. */
export interface FrontDoorStatus {
  readonly state: FrontDoorState;
  readonly supervisorAlive: boolean;
  readonly sessions: readonly FrontDoorSessionStatus[];
  /** The headroom daemon's socket as the door's hop reads and authenticates it live: undefined when no socket is recorded, a refusal when the recorded one fails the owner-only check. */
  readonly headroomSocket: HeadroomSocketTarget | undefined;
  readonly logPath: string;
  readonly logExists: boolean;
}

/** Collects the front door's read-only status. */
export function collectFrontDoorStatus(fsPort: HeadroomFs, socketTrust: HeadroomSocketTrustPorts, paths: LayoutPaths, isRunning: (pid: number) => boolean): FrontDoorStatus {
  const state = readFrontDoorState(fsPort, paths.frontdoorStateFile) ?? {};
  return {
    state,
    supervisorAlive: state.supervisorPid !== undefined && isRunning(state.supervisorPid),
    sessions: listFrontDoorSessions(fsPort, paths.frontdoorSessionsDir).map((session) => ({ ...session, alive: isRunning(session.pid) })),
    headroomSocket: headroomSocketTarget(fsPort, socketTrust, paths),
    logPath: paths.frontdoorLogPath,
    logExists: fsPort.readFileUtf8(paths.frontdoorLogPath) !== undefined,
  };
}

/** Formats `agent-shim frontdoor status`, one line per entry. */
export function formatFrontDoorStatus(status: FrontDoorStatus, caCertPath: string): string[] {
  const lines: string[] = [];
  if (status.state.supervisorPid === undefined) {
    lines.push("supervisor: not running");
  } else {
    lines.push(`supervisor: pid ${String(status.state.supervisorPid)} (${status.supervisorAlive ? "alive" : "NOT running"})`);
  }
  if (status.state.port === undefined) {
    lines.push(`front door: not listening${status.state.lastPort === undefined ? "" : ` (next start on 127.0.0.1:${String(status.state.lastPort)})`}`);
  } else {
    lines.push(`front door: listening on https://127.0.0.1:${String(status.state.port)}, routing /providers/<name> requests`);
  }
  if (status.state.connectPort === undefined) {
    lines.push(`connect surface: not listening${status.state.lastConnectPort === undefined ? "" : ` (next start on 127.0.0.1:${String(status.state.lastConnectPort)})`}`);
  } else {
    lines.push(`connect surface: listening on 127.0.0.1:${String(status.state.connectPort)}, CA ${caCertPath}`);
  }
  if (status.headroomSocket === undefined) {
    lines.push("headroom hop: the daemon is not serving (sessions asking for headroom fail until it is up)");
  } else if (status.headroomSocket.refused === undefined) {
    lines.push(`headroom hop: daemon on unix socket ${status.headroomSocket.socketPath}`);
  } else {
    lines.push(`headroom hop: REFUSING the daemon's socket (sessions asking for headroom fail until it is fixed): ${status.headroomSocket.refused}`);
  }
  if (status.sessions.length === 0) {
    lines.push("sessions: none");
  } else {
    const pids = status.sessions.map((session) => `${String(session.pid)}${session.alive ? "" : " (dead)"}`);
    lines.push(`sessions: ${String(status.sessions.length)} registered (${pids.join(", ")})`);
  }
  if (status.state.lastError !== undefined) {
    lines.push(`last error: ${status.state.lastError}`);
  }
  lines.push(`daemon log: ${status.logPath}${status.logExists ? "" : " (not created yet)"}`);
  return lines;
}

import path from "node:path";
import { z } from "zod";

import { ModelsConfigSchema, type ModelsConfig } from "../config/schema";
import type { HeadroomFs } from "../headroom/state";

/**
 * The launcher-to-door wire protocol this release speaks: the headers a launch's child presents, the capability registry's record format, and the routes. Bump it when a change would stop a door of this release serving launches made by an older one, or an older door serving this release's launches.
 *
 * Protocol 2: the door's headroom hop dials the daemon's unix socket from the versioned headroom state file. A protocol 1 door reads the earlier state file's loopback TCP port, so it would keep sending this release's headroom sessions over the unauthenticated hop (or to no daemon at all), and is replaced.
 *
 * Protocol 3: the door attaches an http provider's own credential at its route, and this release's launcher no longer hands the child a provider credential to present. A protocol 2 door forwards whatever the child presented, so a protocol 3 launcher's provider sessions would arrive with no credential at all and fail at the provider; the door is replaced rather than joined.
 *
 * Protocol 5: the door resolves a request's model name through the models block for every session, with no launch opting in. A protocol 4 door resolves only the sessions whose launch stated the choice in a session header this release no longer sends, so its sessions would reach their own provider with a name it does not serve; the door is replaced rather than joined.
 *
 * The rule that makes a bump safe: a door accepts every lower protocol's launches (protocol 1 accepts the former `x-claude-use-*` header names), and a launcher replaces a door whose protocol is lower than its own, never one that is higher. Replacing is safe because restarts are what the door is designed for: the capability registry is on disk and the listeners keep their sticky ports, so launches already running reach the replacement on the addresses they froze at launch.
 */
export const FRONT_DOOR_PROTOCOL = 5;

/**
 * The record held in one front-door session-registry file: the launcher's pid plus the per-launch capability token its child presents on every request, and the supervisor of the door the launch was sent to. `sessionId` is the id the launch's requests carry in their session header, and `models` the models block this launch resolved when its directory, profile or committed file added definitions of its own to the global block (absent otherwise, so the door follows the global block live). `supervisorPid` is absent on a record written before it existed and on a door's own transparent-surface record; such a launch cannot be attributed to a door, so a superseded door treats it as its own.
 */
const FrontDoorSessionSchema = z.strictObject({ pid: z.number().int().positive(), startedAt: z.number(), token: z.string().min(1), supervisorPid: z.number().int().positive().optional(), sessionId: z.string().min(1).optional(), models: ModelsConfigSchema.optional() });
export type FrontDoorSession = z.infer<typeof FrontDoorSessionSchema>;

/**
 * The front-door supervisor's state.json under `<home>/frontdoor/`. Every field is optional because the file exists in stages, exactly like headroom's and the old codex daemon's: a fresh supervisor writes its own pid before the listener is up, and a shut-down front door leaves only the sticky `lastPort` and any `lastError` worth surfacing.
 */
export const FrontDoorStateSchema = z.strictObject({
  /**
   * The launcher-to-door wire protocol this supervisor speaks, written once it is serving; absent in state written by a release that predates the field, which `ensureFrontDoor` reads as protocol 0. A launcher replaces a door whose protocol is lower than its own (see `FRONT_DOOR_PROTOCOL`).
   */
  protocol: z.number().int().nonnegative().optional(),
  /** The supervisor process serving the front door. Alive means both listeners are up in that process. */
  supervisorPid: z.number().int().positive().optional(),
  /** The loopback port the HTTPS provider listener serves on. Absent until the listener has bound and answered its health probe, so "port is set" is itself the ready signal a launcher polls for. */
  port: z.number().int().positive().optional(),
  /**
   * The sticky port preference for the provider listener: kept across crashes, restarts and idle shutdowns so every provider session, whose base URL was frozen at launch, keeps finding the front door at the same address.
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
   * The loopback port the direct listener serves on: the listener a headroom hop tells the daemon to forward routed traffic back to. Sticky like the others, because headroom's allowlist admits its exact origin: the headroom supervisor rewrites the daemon's allowlist file when the origin moves, but a provider launch waits at its gate until it has, so an ephemeral port would hold launches up after every restart.
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
  fs.writeFilePrivate(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** The highest TCP port; a number above it names no listener. */
export const MAX_TCP_PORT = 65535;

/** The loopback origin of a direct listener on `port`. */
export function directOrigin(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

/**
 * The origin the headroom hop forwards routed traffic back to (the direct listener's), or undefined before the front door has ever served: what the headroom allowlist must admit for a provider routed through headroom, since headroom reaches the door's routes at exactly this address.
 */
export function frontDoorOrigin(state: FrontDoorState | undefined): string | undefined {
  const port = state?.directPort ?? state?.lastDirectPort;
  return port === undefined ? undefined : directOrigin(port);
}

/**
 * One live front door's own direct port, recorded under its supervisor pid. `state.json` names only the door launches are sent to, while a door it superseded keeps serving its own sessions, whose headroom traffic still comes back to that door's direct origin; these records are how headroom keeps admitting every door that still serves.
 */
const FrontDoorDirectRecordSchema = z.strictObject({ directPort: z.number().int().positive().max(MAX_TCP_PORT) });

/** A recorded front door: its supervisor pid and its direct listener's port. */
export interface FrontDoorDirectRecord {
  readonly pid: number;
  readonly directPort: number;
}

/** Records a door's direct port under its supervisor pid, once its direct listener is bound. */
export function writeFrontDoorDirectRecord(fs: HeadroomFs, recordsDir: string, record: FrontDoorDirectRecord): void {
  fs.mkdirp(recordsDir);
  fs.writeFilePrivate(path.join(recordsDir, `${String(record.pid)}.json`), `${JSON.stringify({ directPort: record.directPort })}\n`);
}

/** Removes a door's record. Idempotent: the headroom supervisor may already have pruned it. */
export function removeFrontDoorDirectRecord(fs: HeadroomFs, recordsDir: string, pid: number): void {
  fs.removeRecursive(path.join(recordsDir, `${String(pid)}.json`));
}

/** Marks door `pid` as draining: it has released its addresses and is finishing the connections it carried. The marker is what tells `frontdoor status` and `doctor` this running door is retiring and not an extra serving one. */
export function markFrontDoorDraining(fs: HeadroomFs, markersDir: string, pid: number): void {
  fs.mkdirp(markersDir);
  fs.writeFilePrivate(path.join(markersDir, String(pid)), "\n");
}

/** Removes a door's draining marker. Idempotent. */
export function unmarkFrontDoorDraining(fs: HeadroomFs, markersDir: string, pid: number): void {
  fs.removeRecursive(path.join(markersDir, String(pid)));
}

/** The pids of the doors marked as draining that are still running, sorted. A marker left by a door that died without removing it is not listed. */
export function listDrainingFrontDoors(fs: HeadroomFs, markersDir: string, isRunning: (pid: number) => boolean): readonly number[] {
  return fs
    .readdir(markersDir)
    .flatMap((file) => (/^[1-9]\d*$/.test(file) && Number.isSafeInteger(Number(file)) ? [Number(file)] : []))
    .filter(isRunning)
    .sort((a, b) => a - b);
}

/** What reading one entry of the records directory found: a record, an entry named like a record whose content is not one, or nothing this listing can judge (a name that is not a record's, or an entry that cannot be read, such as a directory or a file it may not open). */
type DirectRecordEntry = { readonly record: FrontDoorDirectRecord; readonly malformed?: never } | { readonly malformed: true; readonly record?: never } | undefined;

/** The pid a record file's name carries, or undefined when the name is not `<positive pid>.json` with a pid that is an exact integer: a longer one cannot be a process id, and asked about it would make ps refuse the whole batch. */
function recordPid(file: string): number | undefined {
  const pidText = /^([1-9]\d*)\.json$/.exec(file)?.[1];
  const pid = pidText === undefined ? undefined : Number(pidText);
  return pid !== undefined && Number.isSafeInteger(pid) ? pid : undefined;
}

/** Reads one entry of the records directory; never throws, since one bad entry must not stop the supervisor's tick. */
function readDirectRecordEntry(fs: HeadroomFs, recordsDir: string, file: string): DirectRecordEntry {
  const pid = recordPid(file);
  if (pid === undefined) {
    return undefined;
  }
  let raw: string | undefined;
  try {
    raw = fs.readFileUtf8(path.join(recordsDir, file));
  } catch {
    return undefined;
  }
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = FrontDoorDirectRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { record: { pid, directPort: parsed.data.directPort } } : { malformed: true };
  } catch {
    return { malformed: true };
  }
}

/** Every recorded door, sorted by pid. An entry that is not a readable record is skipped, never thrown over: a directory or an unreadable file named like a record, or one whose content is not a record (`pruneMalformedFrontDoorDirectFiles` removes those). */
export function listFrontDoorDirectRecords(fs: HeadroomFs, recordsDir: string): readonly FrontDoorDirectRecord[] {
  return fs
    .readdir(recordsDir)
    .flatMap((file) => {
      const entry = readDirectRecordEntry(fs, recordsDir, file);
      return entry?.record === undefined ? [] : [entry.record];
    })
    .sort((a, b) => a.pid - b.pid);
}

/** A temporary file `writeFilePrivate` leaves beside a record (`<pid>.json.<writer pid>.tmp`) when its writer dies between the write and the rename. */
const RECORD_TEMPORARY_FILE = /^[1-9]\d*\.json\.([1-9]\d*)\.tmp$/;

/**
 * Removes what the records directory holds that no door will ever clean up: a file named like a record whose content is not one (a truncated write, a hand edit), and a temporary file whose writer, named in its own name, is no longer running. A temporary file exists only while its writer is between writing and renaming, so a live writer's is left alone. `isRunning` must be zombie-aware.
 */
export function pruneMalformedFrontDoorDirectFiles(fs: HeadroomFs, recordsDir: string, isRunning: (pid: number) => boolean): void {
  for (const file of fs.readdir(recordsDir)) {
    const writer = RECORD_TEMPORARY_FILE.exec(file)?.[1];
    const stale = writer !== undefined && !isRunning(Number(writer));
    if (stale || readDirectRecordEntry(fs, recordsDir, file)?.malformed === true) {
      fs.removeRecursive(path.join(recordsDir, file));
    }
  }
}

/**
 * Which recorded doors are still running as front-door supervisors, as reads of the process table answer it: `doors` holds the pids the table shows running (not zombies) with the front-door supervisor's command line; `unknown` holds the pids no read could answer for, each with why (ps failed to run, was killed, timed out or reported an error). Every other pid asked about is known not to be a door: gone, a zombie, or a process that reused a crashed door's pid.
 */
export interface FrontDoorLiveness {
  readonly doors: ReadonlySet<number>;
  readonly unknown: ReadonlyMap<number, string>;
}

/** The records that still count as live doors: those `liveness` names as doors, and those it cannot answer for, since withdrawing a live door's origin on an unreadable table would refuse its sessions. */
export function liveFrontDoorDirectRecords(records: readonly FrontDoorDirectRecord[], liveness: FrontDoorLiveness): readonly FrontDoorDirectRecord[] {
  return records.filter((record) => liveness.doors.has(record.pid) || liveness.unknown.has(record.pid));
}

/** Removes the records `liveness` positively shows are no longer front-door supervisors: a door that crashed never removed its own, and its pid may since have been reused. A record whose pid no read could answer for is kept, since a door writes its record only once and a live door's deleted record would never come back. */
export function pruneDeadFrontDoorDirectRecords(fs: HeadroomFs, recordsDir: string, records: readonly FrontDoorDirectRecord[], liveness: FrontDoorLiveness): void {
  for (const record of records) {
    if (!liveness.doors.has(record.pid) && !liveness.unknown.has(record.pid)) {
      removeFrontDoorDirectRecord(fs, recordsDir, record.pid);
    }
  }
}

/** What a launch records about itself in its registry entry beyond the token: the id its requests carry and, when it resolved one that differs from the global block, its models block. */
export interface FrontDoorSessionDetails {
  readonly sessionId: string;
  readonly models?: ModelsConfig;
}

/** The fields of a registry entry that `details` contributes, none when the launch told the door nothing. */
export function recordOf(details: FrontDoorSessionDetails | undefined): Pick<FrontDoorSession, "sessionId" | "models"> | Record<string, never> {
  return details === undefined ? {} : { sessionId: details.sessionId, ...(details.models === undefined ? {} : { models: details.models }) };
}

/**
 * Writes one launch's session record: the registry entry that both keeps the door from idling out and holds the token that launch's requests must present. The token is a bearer capability, so the directory is created owner-only (0700) and the record written owner-only (0600): on a multi-user host another local account must be able neither to list nor to read it, since presenting it to a listener would spend the victim's provider credential or Codex login.
 */
export function writeFrontDoorSession(fs: HeadroomFs, sessionsDir: string, session: Readonly<FrontDoorSession>): void {
  fs.mkdirPrivate(sessionsDir);
  fs.writeFilePrivate(path.join(sessionsDir, `${String(session.pid)}.json`), `${JSON.stringify(session, null, 2)}\n`);
}

/** A registered launch as status and the idle decision see it: the pid and start time, never the token, so nothing that prints or serialises a session can leak the capability. */
export type FrontDoorSessionSummary = Pick<FrontDoorSession, "pid" | "startedAt" | "supervisorPid">;

/**
 * Every registered launch, unreadable or malformed files skipped, sorted by pid. Read through `FrontDoorSessionSchema`, which carries the token: headroom's token-less `listSessions` is strict and rejects every front-door record, which would make a live session invisible to the supervisor's idle decision and close the listeners (releasing the sticky ports) under a running child.
 */
export function listFrontDoorSessions(fs: HeadroomFs, sessionsDir: string): readonly FrontDoorSessionSummary[] {
  const sessions: FrontDoorSessionSummary[] = [];
  for (const name of fs.readdir(sessionsDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = FrontDoorSessionSchema.safeParse(JSON.parse(fs.readFileUtf8(path.join(sessionsDir, name)) ?? ""));
      if (parsed.success) {
        sessions.push({ pid: parsed.data.pid, startedAt: parsed.data.startedAt, ...(parsed.data.supervisorPid === undefined ? {} : { supervisorPid: parsed.data.supervisorPid }) });
      }
    } catch {
      continue;
    }
  }
  return sessions.sort((a, b) => a.pid - b.pid);
}

/** Removes one launcher's registry entry, and with it that launch's capability. Idempotent. */
export function removeFrontDoorSession(fs: HeadroomFs, sessionsDir: string, pid: number): void {
  fs.removeRecursive(path.join(sessionsDir, `${String(pid)}.json`));
}

/** Removes every entry whose launcher is no longer running, so a dead launch's capability stops being accepted and cannot keep the door awake. The predicate must be zombie-aware, as for headroom's. */
export function pruneDeadFrontDoorSessions(fs: HeadroomFs, sessionsDir: string, isRunning: (pid: number) => boolean): readonly number[] {
  const removed: number[] = [];
  for (const session of listFrontDoorSessions(fs, sessionsDir)) {
    if (!isRunning(session.pid)) {
      removeFrontDoorSession(fs, sessionsDir, session.pid);
      removed.push(session.pid);
    }
  }
  return removed;
}

/**
 * Every live session's token, read fresh: what a client-facing listener checks a request's capability against. Malformed files are skipped for the same reason `readFrontDoorState` tolerates them.
 */
export function liveSessionTokens(fs: HeadroomFs, sessionsDir: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const name of fs.readdir(sessionsDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = FrontDoorSessionSchema.safeParse(JSON.parse(fs.readFileUtf8(path.join(sessionsDir, name)) ?? ""));
      if (parsed.success) {
        tokens.add(parsed.data.token);
      }
    } catch {
      continue;
    }
  }
  return tokens;
}

/** The models block a launch resolved for itself, found by the session id its requests carry, or undefined when no live launch carries one by that id or the launch added nothing to the global block. Read from the registry the launch wrote, so it lives and is pruned with the launch. */
export function readFrontDoorSessionModels(fs: HeadroomFs, sessionsDir: string, sessionId: string): ModelsConfig | undefined {
  for (const name of fs.readdir(sessionsDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = FrontDoorSessionSchema.safeParse(JSON.parse(fs.readFileUtf8(path.join(sessionsDir, name)) ?? ""));
      if (parsed.success && parsed.data.sessionId === sessionId) {
        return parsed.data.models;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

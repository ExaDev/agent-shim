import path from "node:path";
import { z } from "zod";

import { ModelsConfigSchema, type ModelsConfig } from "../config/schema";
import type { HeadroomFs } from "../headroom/state";
import type { LayoutPaths } from "../paths";
import { MAX_TCP_PORT } from "../baseUrlDial";
import { catalogueCachePath } from "../providerCatalogue";

/** Stores one provider's refresh state within the supervisor generation that owns it. */
export function writeCatalogueStatus(fs: HeadroomFs, paths: LayoutPaths, pid: number, generation: string, name: string, status: "running" | "ready" | "failed", fingerprint?: string, recordedAt?: number): void {
  const dir = path.dirname(catalogueCachePath(paths, name, pid, generation));
  fs.mkdirp(dir);
  fs.writeFilePrivate(path.join(dir, `${name}.status.json`), JSON.stringify({ status, ...(fingerprint === undefined ? {} : { fingerprint }), ...(recordedAt === undefined ? {} : { recordedAt }) }));
}

/** Reads the refresh state recorded for a provider in a supervisor generation. */
export function readCatalogueStatus(fs: Pick<HeadroomFs, "readFileUtf8">, paths: LayoutPaths, pid: number, generation: string, name: string): { readonly status: "running" | "ready" | "failed"; readonly fingerprint?: string; readonly recordedAt?: number } | undefined {
  const file = path.join(path.dirname(catalogueCachePath(paths, name, pid, generation)), `${name}.status.json`);
  const raw = fs.readFileUtf8(file);
  if (raw === undefined) return undefined;
  try {
    const value = z.strictObject({ status: z.enum(["running", "ready", "failed"]), fingerprint: z.string().min(1).optional(), recordedAt: z.number().optional() }).safeParse(JSON.parse(raw));
    return value.success ? value.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The launcher-to-door wire protocol this release speaks: the headers a launch's child presents, the capability registry's record format, and the routes. Bump it when a change would stop a door of this release serving launches made by an older one, or an older door serving this release's launches.
 *
 * Protocol 2: the door's headroom hop dials the daemon's unix socket from the versioned headroom state file. A protocol 1 door reads the earlier state file's loopback TCP port, so it would keep sending this release's headroom sessions over the unauthenticated hop (or to no daemon at all), and is replaced.
 *
 * Protocol 3: the door attaches an http provider's own credential at its route, and this release's launcher no longer hands the child a provider credential to present. A protocol 2 door forwards whatever the child presented, so a protocol 3 launcher's provider sessions would arrive with no credential at all and fail at the provider; the door is replaced rather than joined.
 *
 * Protocol 5: the door resolves a request's model name through the models block for every session, with no launch opting in. A protocol 4 door resolves only the sessions whose launch stated the choice in a session header this release no longer sends, so its sessions would reach their own provider with a name it does not serve; the door is replaced rather than joined.
 *
 * Protocol 6: the door hands its listening sockets to a successor it starts itself when a launcher sends it `SIGUSR2` (see `./handover.ts`), so a requested replacement keeps every address accepting. A protocol 5 door has no handler for that signal, whose default action ends the process outright, so a launcher must know the door's protocol before it sends one; such a door is replaced the stop-and-start way, which its drain already makes safe for the connections it carries.
 *
 * Protocol 7: the door publishes a unique catalogue generation used by launchers to find its Codex models. A protocol 6 door cannot publish the generation-scoped catalogue this launcher reads.
 *
 * Protocol 8: a launch's registry record names the identity the launch runs as, so the door attributes a request that carries no identity header (Remote Control's calls ride the capability the tunnel supplies) to the launch's identity. The record's schema is strict, so a protocol 7 door cannot read a record with the new field and would refuse the launch; it is replaced rather than joined.
 *
 * The rule that makes a bump safe: a door accepts every lower protocol's launches (protocol 1 accepts the former `x-claude-use-*` header names), and a launcher replaces a door whose protocol is lower than its own, never one that is higher. Replacing is safe because restarts are what the door is designed for: the capability registry is on disk and the listeners keep their sticky ports, so launches already running reach the replacement on the addresses they froze at launch.
 */
export const FRONT_DOOR_PROTOCOL = 8;

/** The first protocol whose door hands its listeners over on `SIGUSR2` (see protocol 6 above): a launcher sends that request only to a door recording this protocol or a later one. */
export const FRONT_DOOR_HANDOVER_PROTOCOL = 6;

/**
 * The record held in one front-door session-registry file: the launcher's pid plus the per-launch capability token its child presents on every request, and the supervisor of the door the launch was sent to. `sessionId` is the id the launch's requests carry in their session header, and `models` the models block this launch resolved when its directory, profile or committed file added definitions of its own to the global block (absent otherwise, so the door follows the global block live). `supervisorPid` is absent on a record written before it existed and on a door's own transparent-surface record; such a launch cannot be attributed to a door, so a superseded door treats it as its own.
 */
const FrontDoorSessionSchema = z.strictObject({ pid: z.number().int().positive(), startedAt: z.number(), token: z.string().min(1), supervisorPid: z.number().int().positive().optional(), sessionId: z.string().min(1).optional(), identity: z.string().min(1).optional(), models: ModelsConfigSchema.optional() });
export type FrontDoorSession = z.infer<typeof FrontDoorSessionSchema>;

/** What names one launch: its launcher's pid and the time it registered. A launcher that registers again under its own pid (a relaunch after an account move, a `--resume`) writes a new start time, so per-launch state the door keeps never passes from one launch to the next, even when both carry the same session id. */
export type FrontDoorLaunch = Pick<FrontDoorSession, "pid" | "startedAt">;

/** The longest a model name or a credential description in a route context may be: far above any real one, and the bound that keeps the file written per launch small whatever a request names. */
export const MAX_CONTEXT_TEXT_LENGTH = 256;

const ContextText = z.string().min(1).max(MAX_CONTEXT_TEXT_LENGTH);

/** The facts about a route that are names, never values: the credential by what describes it (a variable name, a path, a program, a reference, a Keychain service, the identity whose login it is), and the models by name. */
const ContextFacts = { credential: ContextText.optional(), requestedModel: ContextText.optional(), servedModel: ContextText.optional() };

/**
 * What the door knows of a launch's main loop, held per launch: the route it is on (the Anthropic route, Claude Code's own API, or a provider by name) and, as names, the credential that route uses and the model the main loop last asked for with the one the route served it under. The configuration that applied is not part of it: the provider file and the models block are read afresh for every request, so a changed file applies to the next one, and a stored copy would only go stale.
 */
const RouteContextSchema = z.union([z.strictObject({ kind: z.literal("anthropic"), ...ContextFacts }), z.strictObject({ kind: z.literal("provider"), provider: z.string().min(1), ...ContextFacts })]);
export type RouteContext = z.infer<typeof RouteContextSchema>;

/** The key one launch is known by in a map. */
export function launchKeyOf(launch: Readonly<FrontDoorLaunch>): string {
  return `${String(launch.pid)}-${String(launch.startedAt)}`;
}

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

/** Records the Codex home used by one supervisor separately from the shared front-door state. */
export function writeFrontDoorCodexHome(fs: HeadroomFs, frontdoorDir: string, pid: number, codexHome: string, generation: string): void {
  const directory = path.join(frontdoorDir, "codex-homes");
  fs.mkdirp(directory);
  fs.writeFilePrivate(path.join(directory, `${String(pid)}.json`), `${JSON.stringify({ codexHome, generation })}\n`);
}

/** Reads the recorded Codex home and generation for one supervisor. */
export function readFrontDoorCodexRecord(fs: Pick<HeadroomFs, "readFileUtf8">, frontdoorDir: string, pid: number): { readonly codexHome: string; readonly generation: string } | undefined {
  const raw = fs.readFileUtf8(path.join(frontdoorDir, "codex-homes", `${String(pid)}.json`));
  if (raw === undefined) return undefined;
  try {
    const parsed = z.strictObject({ codexHome: z.string().min(1), generation: z.uuid() }).safeParse(JSON.parse(raw));
    return parsed.success && path.isAbsolute(parsed.data.codexHome) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the recorded Codex home for one supervisor, or undefined if no valid record exists. */
export function readFrontDoorCodexHome(fs: Pick<HeadroomFs, "readFileUtf8">, frontdoorDir: string, pid: number): string | undefined {
  return readFrontDoorCodexRecord(fs, frontdoorDir, pid)?.codexHome;
}

/** Removes one supervisor's Codex home record. */
export function removeFrontDoorCodexHome(fs: HeadroomFs, frontdoorDir: string, pid: number): void {
  fs.removeRecursive(path.join(frontdoorDir, "codex-homes", `${String(pid)}.json`));
}

/** Reads state.json, or undefined when absent or malformed: a malformed file is overwritten by the next supervisor rather than failing every launch over one bad write. */
export function readFrontDoorState(fs: Pick<HeadroomFs, "readFileUtf8">, stateFile: string): FrontDoorState | undefined {
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
  /** The id of the identity the launch runs as: what the door attributes the launch's requests to even when a request carries no identity header of its own (Remote Control's calls ride the capability the tunnel supplies). */
  readonly identity?: string;
  readonly models?: ModelsConfig;
}

/** The fields of a registry entry that `details` contributes, none when the launch told the door nothing. */
export function recordOf(details: FrontDoorSessionDetails | undefined): Pick<FrontDoorSession, "sessionId" | "identity" | "models"> | Record<string, never> {
  return details === undefined ? {} : { sessionId: details.sessionId, ...(details.identity === undefined ? {} : { identity: details.identity }), ...(details.models === undefined ? {} : { models: details.models }) };
}

/** The durable store a door keeps launches' main-loop routes in: the registry directory, which outlives any door process. */
export function launchRouteStore(fs: HeadroomFs, sessionsDir: string, log: (line: string) => void): MainLoopRouteStore {
  // The launches whose stat is failing, so a stat that keeps failing is reported once per launch until one succeeds, not once per helper request.
  const failing = new Set<string>();
  return {
    read: (launch) => readLaunchRoute(fs, sessionsDir, launch),
    write: (launch, route) => {
      writeLaunchRoute(fs, sessionsDir, launch, route);
    },
    // Best effort and the one place that owns its failure: the identity only saves a read, so a stat that cannot be made (no permission, an I/O error, a path that is not a directory) is no identity, never a failed request.
    identity: (launch) => {
      const key = launchKeyOf(launch);
      try {
        const stat = fs.lstat(path.join(sessionsDir, launchRouteName(launch.pid)));
        failing.delete(key);
        return stat === undefined ? undefined : `${String(stat.mtimeMs)}:${String(stat.sizeBytes)}`;
      } catch (error) {
        if (!failing.has(key)) {
          failing.add(key);
          log(`front door: could not stat where launch ${String(launch.pid)}'s main loop went, so a route another door writes may go unseen until its next main-loop request: ${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
      }
    },
  };
}

/** What a door keeps a launch's main-loop route in. */
export interface MainLoopRouteStore {
  /** Where the launch's main loop last went as the store holds it, or undefined for none; throws for a copy that exists and cannot be read. */
  readonly read: (launch: Readonly<FrontDoorLaunch>) => RouteContext | undefined;
  readonly write: (launch: Readonly<FrontDoorLaunch>, route: RouteContext) => void;
  /** What identifies the copy as it is now (its modification time and size), or undefined when there is none or it cannot be told: one stat of one file, so a door can tell that another door rewrote it without reading it. Never throws. An undefined identity is never a reason to read. */
  readonly identity: (launch: Readonly<FrontDoorLaunch>) => string | undefined;
}

/**
 * Writes one launch's session record: the registry entry that both keeps the door from idling out and holds the token that launch's requests must present. The token is a bearer capability, so the directory is created owner-only (0700) and the record written owner-only (0600): on a multi-user host another local account must be able neither to list nor to read it, since presenting it to a listener would spend the victim's provider credential or Codex login.
 */
export function writeFrontDoorSession(fs: HeadroomFs, sessionsDir: string, session: Readonly<FrontDoorSession>): void {
  fs.mkdirPrivate(sessionsDir);
  // A launch registering again under this pid is a new launch: the route the pid's earlier launch left is not its own.
  fs.removeRecursive(path.join(sessionsDir, launchRouteName(session.pid)));
  fs.writeFilePrivate(path.join(sessionsDir, sessionRecordName(session.pid)), `${JSON.stringify(session, null, 2)}\n`);
}

/** A registered launch as status and the idle decision see it: the pid and start time, never the token, so nothing that prints or serialises a session can leak the capability. */
export type FrontDoorSessionSummary = Pick<FrontDoorSession, "pid" | "startedAt" | "supervisorPid">;

/** The name of the file that holds launcher `pid`'s registry record. */
export function sessionRecordName(pid: number): string {
  return `${String(pid)}.json`;
}

/** Whether `name` is a registry entry's file name, as opposed to anything else a directory listing returns. */
export function isSessionRecordName(name: string): boolean {
  return /^[1-9]\d*\.json$/.test(name);
}

/** The file beside launcher `pid`'s registry record that holds where the launch's main loop last went. Not a field of the record: the launcher owns the record, and a door rewriting it could overwrite a launcher that registered again in the meantime. */
function launchRouteName(pid: number): string {
  return `${String(pid)}.route.json`;
}

/**
 * The version of the route file this door writes. Version 1, written before the route carried a credential and models, named a route only and is a route context with no facts, so it is read as one; a file of a higher version was written by a newer door whose format this one cannot judge, so it is reported as unreadable, never taken for "no route".
 */
const LAUNCH_ROUTE_FILE_VERSION = 2;

const LaunchRouteFileSchema = z.strictObject({ version: z.union([z.literal(1), z.literal(LAUNCH_ROUTE_FILE_VERSION)]), startedAt: z.number(), route: RouteContextSchema });

/**
 * Records where `launch`'s main loop last went, in the registry directory beside the launch's own record, so a restarted or replacing door finds it and the launch's helper requests keep following it. Written only while the launch's record is still on disk: the door admits a request from its cached view of the registry, which can outlive the launch's release by a tick, and a route written after the release would be an orphan nothing but the prune removes. The check reads the record at the write, so the window left is the two synchronous calls between the read and the write.
 */
export function writeLaunchRoute(fs: HeadroomFs, sessionsDir: string, launch: Readonly<FrontDoorLaunch>, route: RouteContext): void {
  if (readFrontDoorSessionRecord(fs, sessionsDir, sessionRecordName(launch.pid))?.startedAt !== launch.startedAt) {
    return;
  }
  fs.mkdirPrivate(sessionsDir);
  fs.writeFilePrivate(path.join(sessionsDir, launchRouteName(launch.pid)), `${JSON.stringify({ version: LAUNCH_ROUTE_FILE_VERSION, startedAt: launch.startedAt, route })}\n`);
}

/**
 * Where `launch`'s main loop last went, or undefined when none was recorded or the file belongs to an earlier launch under the same pid (a different start time). A file that exists and cannot be read as a route of this door's version (not JSON, not the shape, written by a newer door, or unreadable) throws, naming which: a launch's helpers are then sent down the launch's own route, and that must be reported, not taken for "nothing recorded".
 */
export function readLaunchRoute(fs: Pick<HeadroomFs, "readFileUtf8">, sessionsDir: string, launch: Readonly<FrontDoorLaunch>): RouteContext | undefined {
  const name = launchRouteName(launch.pid);
  const text = fs.readFileUtf8(path.join(sessionsDir, name));
  if (text === undefined) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${name} is not JSON`);
  }
  const version = typeof json === "object" && json !== null && "version" in json ? json.version : undefined;
  if (typeof version === "number" && version > LAUNCH_ROUTE_FILE_VERSION) {
    throw new Error(`${name} is version ${String(version)}, written by a newer door than this one reads (version ${String(LAUNCH_ROUTE_FILE_VERSION)})`);
  }
  const parsed = LaunchRouteFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${name} is not a route file this door reads`);
  }
  return parsed.data.startedAt === launch.startedAt ? parsed.data.route : undefined;
}

/** What a registry record shows without its capability: the one projection every listing uses, so a token can never ride along into something that prints or serialises a session. */
export function summaryOf(session: Readonly<FrontDoorSession>): FrontDoorSessionSummary {
  return { pid: session.pid, startedAt: session.startedAt, ...(session.supervisorPid === undefined ? {} : { supervisorPid: session.supervisorPid }) };
}

/** Reads one registry file, or undefined when it is unreadable or not a record: one bad file must not stop a listing, so this never throws. */
export function readFrontDoorSessionRecord(fs: HeadroomFs, sessionsDir: string, name: string): FrontDoorSession | undefined {
  try {
    const parsed = FrontDoorSessionSchema.safeParse(JSON.parse(fs.readFileUtf8(path.join(sessionsDir, name)) ?? ""));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every registered launch, unreadable or malformed files skipped, sorted by pid. Read through `FrontDoorSessionSchema`, which carries the token: headroom's token-less `listSessions` is strict and rejects every front-door record, which would make a live session invisible to the supervisor's idle decision and close the listeners (releasing the sticky ports) under a running child.
 */
export function listFrontDoorSessions(fs: HeadroomFs, sessionsDir: string): readonly FrontDoorSessionSummary[] {
  const sessions: FrontDoorSessionSummary[] = [];
  for (const name of fs.readdir(sessionsDir)) {
    const record = isSessionRecordName(name) ? readFrontDoorSessionRecord(fs, sessionsDir, name) : undefined;
    if (record !== undefined) {
      sessions.push(summaryOf(record));
    }
  }
  return sessions.sort((a, b) => a.pid - b.pid);
}

/** The pid a route file's name belongs to, or undefined for any other name. */
function routeFilePid(name: string): number | undefined {
  const match = /^([1-9]\d*)\.route\.json$/.exec(name);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Removes one launcher's registry entry, and with it that launch's capability and its recorded main-loop route. Idempotent. */
export function removeFrontDoorSession(fs: HeadroomFs, sessionsDir: string, pid: number): void {
  fs.removeRecursive(path.join(sessionsDir, sessionRecordName(pid)));
  fs.removeRecursive(path.join(sessionsDir, launchRouteName(pid)));
}

/**
 * Removes every entry of `listed` whose launcher is no longer running, so a dead launch's capability stops being accepted and cannot keep the door awake. The predicate must be zombie-aware, as for headroom's.
 *
 * `listed` is the listing `isRunning` was computed over, never a fresh read of the directory: a launch that registered after that listing was taken has not been checked, so the predicate would call it dead and delete a live session's capability.
 *
 * It also removes every route file with no registry record beside it. The door writes a route after finding its launch, and a prune between the two leaves the file behind; a launch registering under that pid later removes it itself, but until then nothing would. A route file is only ever written for a launch whose record exists, so one without a record is a leftover, and a launch that registered after the listing has its record and keeps its file.
 */
export function pruneDeadFrontDoorSessions(fs: HeadroomFs, sessionsDir: string, listed: readonly FrontDoorSessionSummary[], isRunning: (pid: number) => boolean): readonly number[] {
  const removed: number[] = [];
  for (const session of listed) {
    if (!isRunning(session.pid)) {
      removeFrontDoorSession(fs, sessionsDir, session.pid);
      removed.push(session.pid);
    }
  }
  const names = fs.readdir(sessionsDir);
  for (const name of names) {
    const pid = routeFilePid(name);
    if (pid !== undefined && !names.includes(sessionRecordName(pid))) {
      fs.removeRecursive(path.join(sessionsDir, name));
    }
  }
  return removed;
}

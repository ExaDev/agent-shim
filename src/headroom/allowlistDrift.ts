import { EARLIER_RELEASE_ALLOWLIST, type EarlierReleaseDaemon } from "./earlierRelease";
import { hashAllowlistFile, parseAllowlistFile } from "./state";

/**
 * How the allowlist the headroom daemon serves lags the allowlist computed now. The daemon re-reads its allowlist file on every request that follows a change to it, and its supervisor rewrites the file and records the hash in the same tick, so a lag that lasts beyond one tick means the supervisor is not running or cannot write the file. A daemon started by an earlier release reads no file, and is reported as such instead.
 */
export type AllowlistDrift = FileAllowlistDrift | EarlierReleaseAllowlistDrift;

/** A daemon started by an earlier release whose fixed allowlist, by its recorded hash, does not admit the serving door. */
interface EarlierReleaseAllowlistDrift {
  readonly startedByEarlierRelease: true;
  readonly missingFromFile?: never;
  readonly staleInFile?: never;
  readonly hashLags?: never;
}

/** A daemon reading the allowlist file, whose file or recorded hash lags the computed allowlist. */
interface FileAllowlistDrift {
  readonly startedByEarlierRelease?: never;
  /** Computed entries the file does not list: the daemon refuses every request to these upstreams. A missing file lists nothing, so every entry is here. */
  readonly missingFromFile: readonly string[];
  /** Entries the file lists that the computed allowlist no longer holds: origins of doors that are gone, which the daemon still admits although nothing routes to them. */
  readonly staleInFile: readonly string[];
  /** Whether the recorded hash is not the hash of the entries the file lists: the supervisor has not recorded the file as served, and a provider launch's gate waits until it has. */
  readonly hashLags: boolean;
}

/**
 * Compares the computed allowlist with the file the daemon reads and the hash its supervisor recorded, or returns undefined when both are current or no daemon has recorded an allowlist at all (nothing is serving, so nothing can lag). The file's entries are compared as headroom reads them, so layout differences are not drift.
 */
export function diagnoseAllowlistDrift(params: {
  readonly allowlist: readonly string[];
  readonly fileContent: string | undefined;
  readonly recordedHash: string | undefined;
  /** What `earlierReleaseDaemon` says of the serving daemon: undefined for this release's, which reads the allowlist file. */
  readonly earlierRelease: EarlierReleaseDaemon | undefined;
}): AllowlistDrift | undefined {
  const { allowlist, fileContent, recordedHash, earlierRelease } = params;
  if (recordedHash === undefined) {
    return undefined;
  }
  if (earlierRelease !== undefined) {
    return earlierRelease.admitsServingDoor ? undefined : { startedByEarlierRelease: true };
  }
  const served = fileContent === undefined ? [] : parseAllowlistFile(fileContent);
  const listed = new Set(served);
  const computed = new Set(allowlist);
  const missingFromFile = allowlist.filter((entry) => !listed.has(entry));
  const staleInFile = served.filter((entry) => !computed.has(entry)).sort();
  const hashLags = recordedHash !== (fileContent === undefined ? undefined : hashAllowlistFile(fileContent));
  if (missingFromFile.length === 0 && staleInFile.length === 0 && !hashLags) {
    return undefined;
  }
  return { missingFromFile, staleInFile, hashLags };
}

/**
 * What the allowlist drift is, what it costs, and why it has not healed: the live doors' origins the file lacks (every request a provider launch sends back through such a door is refused) and the gone doors' it still lists, whether provider launches are held at their gate, and whether a supervisor is there to rewrite the file. Shared by `headroom status` and `doctor`.
 */
export function describeAllowlistDrift(params: {
  readonly drift: AllowlistDrift;
  readonly allowlistFile: string;
  /** The supervisor that keeps the file current, or undefined when none is running. */
  readonly liveSupervisorPid: number | undefined;
  /** The log the supervisor reports a failed write to. */
  readonly logPath: string;
}): string {
  const { drift, allowlistFile, liveSupervisorPid } = params;
  if (drift.startedByEarlierRelease === true) {
    return `the daemon was ${EARLIER_RELEASE_ALLOWLIST}, its allowlist cannot be shown to admit the serving front door (the door moved, or a provider changed, since it started), and until then provider launches are refused`;
  }
  const parts: string[] = [];
  if (drift.missingFromFile.length > 0) {
    // Every allowlist entry is a live door's direct origin, so each one missing is a door whose provider launches the daemon refuses.
    parts.push(`${allowlistFile} lacks ${drift.missingFromFile.join(", ")} (live front doors' direct origins, so the daemon refuses every request a provider launch sends back through those doors)`);
  }
  if (drift.staleInFile.length > 0) {
    parts.push(`${allowlistFile} still lists ${drift.staleInFile.join(", ")}`);
  }
  if (drift.hashLags) {
    parts.push("the supervisor has not yet recorded the file's allowlist as served, and provider launches through headroom wait until it does");
  }
  const healing =
    liveSupervisorPid === undefined
      ? "the supervisor is not running, so nothing rewrites the file until the next launch through headroom starts one"
      : `supervisor ${String(liveSupervisorPid)} rewrites the file on its next tick, so drift that persists means it cannot write it (see ${params.logPath})`;
  return `${parts.join("; ")}; ${healing}`;
}


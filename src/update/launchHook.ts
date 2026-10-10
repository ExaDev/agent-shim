import { compareVersions, LATEST_RELEASE_URL, releaseTagFromUrl } from "./update";
import type { GlobalConfig, UpdateMode } from "../config/schema";

/**
 * How long one launch-time update check stands for the next: a full day (86,400,000 milliseconds), so a working day of back-to-back launches makes at most one request to GitHub and a release published today is noticed tomorrow at the latest.
 */
export const UPDATE_CHECK_COOLDOWN_MS = 86_400_000;

/**
 * The `update.mode` a launch resolves to: the setting's value when the global config carries one, `off` when it does not (or no global config exists at all), so an absent setting never touches the network.
 */
export function resolveUpdateMode(globalConfig: GlobalConfig | undefined): UpdateMode {
  return globalConfig?.update?.mode ?? "off";
}

/**
 * Whether the cooldown stamp `contents` (an ISO timestamp written by a previous check) still stands at `nowMs`: false means the check behind it may run again. A stamp that is missing, unparseable, or in the future by any margin reads as stale rather than suppressing checks forever, the same treatment `acquireUpdateLock` gives an unreadable lock.
 */
export function updateCheckDue(contents: string | undefined, nowMs: number, cooldownMs: number = UPDATE_CHECK_COOLDOWN_MS): boolean {
  if (contents === undefined) {
    return true;
  }
  const checkedAt = Date.parse(contents.trim());
  if (Number.isNaN(checkedAt)) {
    return true;
  }
  const age = nowMs - checkedAt;
  return age < 0 || age >= cooldownMs;
}

/**
 * Everything the launch-time update check needs from its host, injected so tests run it against scripted answers and no launch ever reaches GitHub by accident. Deliberately narrower than `UpdatePorts`: the launch path never downloads anything (the detached `agent-shim update` does), so only the release check, the cooldown stamp, the clock, the background spawn and the terminal are wired.
 */
export interface UpdateLaunchPort {
  /** Resolves the URL the `releases/latest` redirect lands on, exactly as `agent-shim update` resolves the newest version. */
  readonly effectiveUrl: (url: string) => Promise<string>;
  /** Reads the cooldown stamp, or undefined when it does not exist. */
  readonly readStamp: (filePath: string) => string | undefined;
  /** Writes the cooldown stamp atomically: a reader either sees the previous whole stamp or the new one, never a partial write. */
  readonly writeStamp: (filePath: string, contents: string) => void;
  /** The clock the cooldown reads, in epoch milliseconds. */
  readonly now: () => number;
  /** Re-invokes this very binary with `args` as a detached child whose stdio is ignored and which is unref'd, so it outlives the launch and never holds the terminal. */
  readonly spawnDetached: (args: readonly string[]) => void;
  /** Writes one line to the launching terminal's stderr. */
  readonly writeErr: (line: string) => void;
}

/** What `runLaunchUpdateCheck` hands back: the marker the spawner calls the moment the child takes over the terminal. */
export interface LaunchUpdateCheckHandle {
  /**
   * Marks the launch's child as started. From this moment the check prints nothing: a line emitted after the child took over the terminal would land mid-session and corrupt its display. Safe to call more than once.
   */
  readonly markChildStarted: () => void;
}

const NOOP_HANDLE: LaunchUpdateCheckHandle = { markChildStarted: () => undefined };

/** The one line the notify path prints, on stderr so it never intermingles with the child's stdout when it is captured. */
export function updateNotifyLine(currentVersion: string, latest: string): string {
  return `agent-shim: update available: ${currentVersion} -> ${latest} (run \`agent-shim update\` to install it)`;
}

/**
 * The launch-time half of `update.mode`: when the mode is `notify` or `auto` and the cooldown stamp is due, stamps the cooldown file first (before any network work, so a fleet of concurrent launches reads the fresh stamp and skips rather than stampeding), then fires the release check without awaiting it. When the answer names a newer release, `notify` prints one stderr line and `auto` additionally spawns `agent-shim update` as a detached child; a running version that is current or ahead produces nothing at all.
 *
 * The launch is never delayed, blocked or failed by any of this: the function is synchronous, every step is wrapped so a network or filesystem failure is invisible, and the check's answer is acted on only through the returned handle's `markChildStarted` marker. With the mode `off` or no port wired it touches nothing at all.
 */
export function runLaunchUpdateCheck(params: {
  /** The resolved `update.mode`; see `resolveUpdateMode`. */
  readonly mode: UpdateMode;
  /** The cooldown stamp's path, `<root>/update.check`. */
  readonly checkPath: string;
  /** The running version, the same `packageJson.version` `-V` reports. */
  readonly currentVersion: string;
  readonly port: UpdateLaunchPort | undefined;
}): LaunchUpdateCheckHandle {
  const { mode, checkPath, currentVersion, port } = params;
  if (mode === "off" || port === undefined) {
    return NOOP_HANDLE;
  }
  let childStarted = false;
  try {
    if (!updateCheckDue(port.readStamp(checkPath), port.now())) {
      return NOOP_HANDLE;
    }
    port.writeStamp(checkPath, new Date(port.now()).toISOString());
  } catch {
    // The cooldown is an optimisation over the network, not a launch input: a stamp that cannot be read or written leaves the check to run (or not) without ever surfacing why.
    return NOOP_HANDLE;
  }
  const answer = (url: string): void => {
    try {
      const latest = releaseTagFromUrl(url);
      if (latest === undefined || compareVersions(latest, currentVersion) <= 0) {
        return;
      }
      if (mode === "auto") {
        // The detached child does the downloading behind the update command's own lock; the launch process never awaits it.
        port.spawnDetached(["update", "--restart-door"]);
      }
      if (!childStarted) {
        port.writeErr(updateNotifyLine(currentVersion, latest));
      }
    } catch {
      // Invisible by contract: nothing the check does once the launch is under way may disturb it.
    }
  };
  port.effectiveUrl(LATEST_RELEASE_URL).then(
    (url) => {
      answer(url);
    },
    () => undefined,
  );
  return {
    markChildStarted: () => {
      childStarted = true;
    },
  };
}

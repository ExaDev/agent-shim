import type { Anchor } from "../config/schema";
import { dueAnchor } from "./anchor";
import { readHandled, writeHandled, type StampsFs } from "./handledStamps";
import { effectiveWindow, formatAge } from "./preflight";
import { rankPool } from "./pick";
import { ANTHROPIC_PROVIDER } from "./middleware";
import type { UsageSnapshot } from "./schema";

/**
 * The window keeper: at each of an identity's anchors, opens a five-hour window when none is open, so the window's reset falls where the person wants it. Pure orchestration over injected ports (clock, snapshots, the opener, the handled-anchor file), so the front door's timer and the tests share one decision.
 */

/** Opens a five-hour window for an identity by sending the smallest real request, or throws with why it could not. */
export type WindowOpener = (identity: string) => Promise<void>;

/** An identity with the anchors the keeper acts on. */
export interface AnchoredIdentity {
  readonly identity: string;
  readonly anchors: readonly Anchor[];
}

export interface WindowKeeperPorts {
  readonly fs: StampsFs;
  readonly stampsFile: string;
  readonly nowMs: () => number;
  /** The zone an anchor without one is read in. */
  readonly timeZone: string;
  /** The identities that have anchors, read fresh each run so a change takes effect without a restart. */
  readonly anchored: () => readonly AnchoredIdentity[];
  readonly snapshot: (identity: string) => UsageSnapshot | undefined;
  readonly open: WindowOpener;
  readonly log: (line: string) => void;
}

/** What one run did for one identity. `armed` is the first sight of its anchors (nothing before that moment counts as missed); `waiting` means no anchor has fallen since the last one handled. */
export interface KeeperOutcome {
  readonly identity: string;
  readonly status: "armed" | "waiting" | "opened" | "skipped" | "failed";
  readonly detail: string;
}

/** Why an identity cannot be served right now, or undefined when it can: the account is refused, or the snapshot says so. Shared by everything that acts on an identity unattended. */
export function refusalReason(identity: string, snapshot: UsageSnapshot | undefined, nowMs: number): string | undefined {
  if (snapshot === undefined) {
    return undefined;
  }
  const candidate = rankPool({ members: [{ identity, snapshot, records: [] }], nowMs, resuming: false }).candidates[0];
  return candidate?.class === "ineligible" ? `it is refused right now (${candidate.reasons[0] ?? "no reason recorded"})` : undefined;
}

/** Why a window should not be opened for this identity right now, or undefined when one should. A window is already open, the account is refused, or it reports no five-hour window to anchor (an API key, or an account metered by extra usage alone). */
export function reasonNotToOpen(identity: string, snapshot: UsageSnapshot | undefined, nowMs: number): string | undefined {
  // A request spends tokens and starts a window, so it is only ever sent knowing where the account's windows stand: an identity whose quota has not been read has an unknown reset, and opening one then could restart or move a window someone else opened.
  const unified = snapshot?.providers[ANTHROPIC_PROVIDER]?.rateLimit?.unified;
  if (snapshot === undefined || unified === undefined) {
    return "its quota has not been read, so whether a window is open is unknown";
  }
  if (unified.fiveHour === undefined && unified.sevenDay === undefined) {
    return "it reports no plan windows, so there is no five-hour window to anchor";
  }
  const five = unified.fiveHour === undefined ? undefined : effectiveWindow(unified.fiveHour, nowMs);
  if (five?.resetsAtMs !== undefined) {
    return `a five-hour window is already open, resetting in ${formatAge(five.resetsAtMs - nowMs)}`;
  }
  return refusalReason(identity, snapshot, nowMs);
}

/**
 * Deals with every anchor that has fallen since the keeper last handled each identity, once per identity: opens a window when none is open and the account is not refused, otherwise records why not. An identity seen for the first time is armed at the current instant, so anchors from before it was configured are never replayed. Only the latest due anchor counts when several were missed. An opener failure is logged and the anchor is still marked handled, so a persistent failure (a signed-out identity) is retried at the next anchor rather than on every run.
 */
export async function runWindowKeeper(ports: Readonly<WindowKeeperPorts>): Promise<readonly KeeperOutcome[]> {
  const nowMs = ports.nowMs();
  const anchored = ports.anchored();
  const previous = readHandled(ports.fs, ports.stampsFile);
  // Identities that lost their anchors drop out of the file with them.
  const handled: Record<string, number> = Object.fromEntries(anchored.flatMap(({ identity }) => (previous[identity] === undefined ? [] : [[identity, previous[identity]]])));
  const outcomes: KeeperOutcome[] = [];
  for (const { identity, anchors } of anchored) {
    const last = handled[identity];
    if (last === undefined) {
      handled[identity] = nowMs;
      outcomes.push({ identity, status: "armed", detail: "anchors noted; the next anchor to fall is the first acted on" });
      continue;
    }
    const due = dueAnchor(anchors, nowMs, last, ports.timeZone);
    if (due === undefined) {
      outcomes.push({ identity, status: "waiting", detail: "no anchor has fallen since the last handled" });
      continue;
    }
    handled[identity] = nowMs;
    const reason = reasonNotToOpen(identity, ports.snapshot(identity), nowMs);
    if (reason !== undefined) {
      outcomes.push({ identity, status: "skipped", detail: `anchor ${new Date(due).toISOString()}: ${reason}` });
      continue;
    }
    try {
      await ports.open(identity);
      outcomes.push({ identity, status: "opened", detail: `anchor ${new Date(due).toISOString()}: opened a five-hour window` });
    } catch (error) {
      outcomes.push({ identity, status: "failed", detail: `anchor ${new Date(due).toISOString()}: could not open a window: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  writeHandled(ports.fs, ports.stampsFile, handled);
  for (const outcome of outcomes) {
    if (outcome.status === "opened" || outcome.status === "skipped" || outcome.status === "failed") {
      ports.log(`window keeper: ${outcome.identity}: ${outcome.detail}`);
    }
  }
  return outcomes;
}

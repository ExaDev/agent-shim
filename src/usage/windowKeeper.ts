import path from "node:path";

import { z } from "zod";

import type { Anchor } from "../config/schema";
import type { FarmFs } from "../launcher/ports";
import { dueAnchor } from "./anchor";
import { effectiveWindow, formatAge } from "./preflight";
import { rankPool } from "./pick";
import { ANTHROPIC_PROVIDER } from "./middleware";
import type { UsageSnapshot } from "./schema";

/**
 * The window keeper: at each of an identity's anchors, opens a five-hour window when none is open, so the window's reset falls where the person wants it. Pure orchestration over injected ports (clock, snapshots, the opener, the handled-anchor file), so the front door's timer and the tests share one decision.
 */

const STAMPS_SCHEMA_VERSION = 1;

/** The `usage/anchors.json` file: for each identity, the instant up to which its anchors have been dealt with, whether by opening a window or by finding a reason not to. */
const StampsFileSchema = z.strictObject({
  schemaVersion: z.literal(STAMPS_SCHEMA_VERSION),
  handled: z.record(z.string().min(1), z.iso.datetime()),
});
type StampsFile = z.infer<typeof StampsFileSchema>;

/** The filesystem effects the keeper performs on its own file. */
type KeeperFs = Pick<FarmFs, "readFileUtf8" | "writeFilePrivate" | "mkdirPrivate">;

/** Opens a five-hour window for an identity by sending the smallest real request, or throws with why it could not. */
export type WindowOpener = (identity: string) => Promise<void>;

/** An identity with the anchors the keeper acts on. */
export interface AnchoredIdentity {
  readonly identity: string;
  readonly anchors: readonly Anchor[];
}

export interface WindowKeeperPorts {
  readonly fs: KeeperFs;
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

function readStamps(fs: Pick<FarmFs, "readFileUtf8">, file: string): Record<string, number> {
  const raw = fs.readFileUtf8(file);
  if (raw === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const result = StampsFileSchema.safeParse(parsed);
  // An unreadable file reads as "nothing handled": every anchored identity is armed afresh, which loses at most the anchors that fell while it was unreadable, never opens a window the person did not ask for.
  return result.success ? Object.fromEntries(Object.entries(result.data.handled).map(([identity, at]) => [identity, Date.parse(at)])) : {};
}

function writeStamps(fs: KeeperFs, file: string, handled: Readonly<Record<string, number>>): void {
  const next: StampsFile = { schemaVersion: STAMPS_SCHEMA_VERSION, handled: Object.fromEntries(Object.entries(handled).map(([identity, at]) => [identity, new Date(at).toISOString()])) };
  fs.mkdirPrivate(path.dirname(file));
  fs.writeFilePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
}

/** Why a window should not be opened for this identity right now, or undefined when one should. A window is already open, the account is refused, or it reports no five-hour window to anchor (an API key, or an account metered by extra usage alone). */
export function reasonNotToOpen(identity: string, snapshot: UsageSnapshot | undefined, nowMs: number): string | undefined {
  if (snapshot === undefined) {
    return undefined;
  }
  const unified = snapshot.providers[ANTHROPIC_PROVIDER]?.rateLimit?.unified;
  if (unified !== undefined && unified.fiveHour === undefined && unified.sevenDay === undefined) {
    return "it reports no plan windows, so there is no five-hour window to anchor";
  }
  const five = unified?.fiveHour === undefined ? undefined : effectiveWindow(unified.fiveHour, nowMs);
  if (five?.resetsAtMs !== undefined) {
    return `a five-hour window is already open, resetting in ${formatAge(five.resetsAtMs - nowMs)}`;
  }
  const candidate = rankPool({ members: [{ identity, snapshot, records: [] }], nowMs, resuming: false }).candidates[0];
  return candidate?.class === "ineligible" ? `it is refused right now (${candidate.reasons[0] ?? "no reason recorded"})` : undefined;
}

/**
 * Deals with every anchor that has fallen since the keeper last handled each identity, once per identity: opens a window when none is open and the account is not refused, otherwise records why not. An identity seen for the first time is armed at the current instant, so anchors from before it was configured are never replayed. Only the latest due anchor counts when several were missed. An opener failure is logged and the anchor is still marked handled, so a persistent failure (a signed-out identity) is retried at the next anchor rather than on every run.
 */
export async function runWindowKeeper(ports: Readonly<WindowKeeperPorts>): Promise<readonly KeeperOutcome[]> {
  const nowMs = ports.nowMs();
  const anchored = ports.anchored();
  const previous = readStamps(ports.fs, ports.stampsFile);
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
  writeStamps(ports.fs, ports.stampsFile, handled);
  for (const outcome of outcomes) {
    if (outcome.status === "opened" || outcome.status === "skipped" || outcome.status === "failed") {
      ports.log(`window keeper: ${outcome.identity}: ${outcome.detail}`);
    }
  }
  return outcomes;
}

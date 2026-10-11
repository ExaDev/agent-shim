import { effectiveWindow, formatAge } from "./preflight";
import { soleOverageWindow } from "./rateLimit";
import type { ResetRow, ResetSchedule } from "./resetsSchema";
import type { ProviderQuotaWindow, QuotaWindow, UsageSnapshot } from "./schema";

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const PERCENT = 100;

/** A provider-reported window's length as its largest whole unit, `5h` or `30d`, or the provider's own wording when the unit was not recognised. */
export function formatPeriod(window: Readonly<ProviderQuotaWindow>): string {
  if (window.periodMs === undefined) {
    return window.period ?? "unknown period";
  }
  const hours = window.periodMs / MS_PER_HOUR;
  return hours >= HOURS_PER_DAY && Number.isInteger(hours / HOURS_PER_DAY) ? `${String(hours / HOURS_PER_DAY)}d` : `${String(hours)}h`;
}

/** Where a row sorts: still to reset, already reset, or no reset time known. */
function groupOf(row: Readonly<ResetRow>): number {
  return row.resetsAt === undefined ? 2 : row.reset ? 1 : 0;
}

function compareRows(left: Readonly<ResetRow>, right: Readonly<ResetRow>): number {
  return (
    groupOf(left) - groupOf(right) ||
    (left.resetsAt ?? "").localeCompare(right.resetsAt ?? "") ||
    left.identity.localeCompare(right.identity) ||
    left.provider.localeCompare(right.provider) ||
    left.window.localeCompare(right.window)
  );
}

function rowOf(snapshot: UsageSnapshot, provider: string, window: string, observedAt: string, recorded: Readonly<QuotaWindow>, nowMs: number): ResetRow {
  const effective = effectiveWindow(recorded, nowMs);
  return {
    identity: snapshot.identity,
    provider,
    window,
    observedAt,
    ...(recorded.resetsAt === undefined ? {} : { resetsAt: recorded.resetsAt }),
    reset: effective.reset,
    ...(effective.utilization === undefined ? {} : { utilization: effective.utilization }),
    ...(effective.status === undefined ? {} : { status: effective.status }),
  };
}

/**
 * Every quota window the snapshots record, one row per identity, provider and window, read at `nowMs`: the five-hour, seven-day and extra-usage windows an Anthropic account's headers report, and the windows a provider's own usage endpoint reports. Pure, so the CLI, the front door's typed API and the tests share one reading. A window whose reset has passed is still listed, as reset and empty, because that is what the recording stands for until the next request refreshes it.
 */
export function collectResets(snapshots: readonly UsageSnapshot[], nowMs: number): ResetSchedule {
  const rows = snapshots.flatMap((snapshot) =>
    Object.entries(snapshot.providers).flatMap(([provider, state]) => {
      const unified = state.rateLimit?.unified;
      const observedAt = state.rateLimit?.observedAt;
      const overage = unified === undefined ? undefined : soleOverageWindow(unified);
      const headerRows =
        observedAt === undefined || unified === undefined
          ? []
          : [
              ...(unified.fiveHour === undefined ? [] : [rowOf(snapshot, provider, "5h", observedAt, unified.fiveHour, nowMs)]),
              ...(unified.sevenDay === undefined ? [] : [rowOf(snapshot, provider, "7d", observedAt, unified.sevenDay, nowMs)]),
              ...(overage === undefined ? [] : [rowOf(snapshot, provider, "extra usage", observedAt, overage, nowMs)]),
            ];
      const quota = state.quota;
      const quotaRows = quota === undefined ? [] : quota.windows.map((window) => rowOf(snapshot, provider, `${window.measures} ${formatPeriod(window)}`, quota.observedAt, window, nowMs));
      return [...headerRows, ...quotaRows];
    }),
  );
  return { resets: rows.sort(compareRows) };
}

/** One row as a line: `identity / provider: 5h 56% used, resets <instant> (in 2h)`, or `has reset` once its time has passed. */
export function formatResetRow(row: Readonly<ResetRow>, nowMs: number): string {
  const used = row.utilization === undefined ? "usage unknown" : `${String(Math.round(row.utilization * PERCENT))}% used`;
  const when = row.resetsAt === undefined ? "no reset time reported" : row.reset ? `reset at ${row.resetsAt}` : `resets ${row.resetsAt} (in ${formatAge(Date.parse(row.resetsAt) - nowMs)})`;
  return `${row.identity} / ${row.provider}: ${row.window} ${used}, ${when}${row.status === undefined ? "" : ` (${row.status})`}`;
}

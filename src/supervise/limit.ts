import type { LayoutPaths } from "../paths";
import { readUsageLog, readUsageSnapshot, type UsageReadFs } from "../usage/read";
import { refusalReason } from "../usage/windowKeeper";

/** The usage store paths a limit check reads. */
type LimitPaths = Pick<LayoutPaths, "usageSnapshotsDir" | "usageLogDir">;

/** A session's own request refused for want of quota, and when the quota returns, if the upstream said. */
export interface QuotaHit {
  /** Why the identity cannot be served now, from its snapshot. */
  readonly reason: string;
  readonly resetAt?: string;
}

/**
 * The quota refusal a session has met, or undefined while it has met none. Two things have to hold: the identity's snapshot says it is refused right now, and the usage log holds a request of this very session, made since `sinceMs`, that the door classified as quota-exhausted. The snapshot is cheap and changes on every response, so it gates the log read; the log record is what attributes the refusal to this session, since a refusal another session met says nothing about whether this one's turn is in flight. Throws `UsageSnapshotError` for a snapshot that is present but unreadable.
 */
export function quotaHitOf(fs: UsageReadFs, paths: LimitPaths, identity: string, sessionId: string, sinceMs: number, nowMs: number): QuotaHit | undefined {
  const reason = refusalReason(identity, readUsageSnapshot(fs, paths.usageSnapshotsDir, identity), nowMs);
  if (reason === undefined) {
    return undefined;
  }
  const { records } = readUsageLog(fs, paths.usageLogDir, { sinceMs });
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.sessionId === sessionId && record.identity === identity && record.limit?.kind === "quota-exhausted") {
      return { reason, ...(record.limit.resetAt === undefined ? {} : { resetAt: record.limit.resetAt }) };
    }
  }
  return undefined;
}

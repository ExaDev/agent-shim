import type { Pool } from "../config/schema";
import { poolMemberIdentity } from "../config/schema";
import { poolNameOf } from "../launcher/identity";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { FIVE_HOUR_WINDOW_MS, SEVEN_DAY_WINDOW_MS, type PoolMember } from "./pick";
import { planOf } from "./plan";
import type { QuotaWindow, RateLimitState, UnifiedRateLimit } from "./schema";

const PERCENT = 100;

/**
 * How old Anthropic's recorded rate-limit state may be before fetching it again would tell something new: one percent of the shortest window it covers, because the usage endpoint reports whole percentages (the derivation `quotaFreshnessMs` applies to a provider's own quota).
 */
export const ANTHROPIC_USAGE_FRESHNESS_MS = FIVE_HOUR_WINDOW_MS / PERCENT;

/** How long an answer that carried no plan windows stays current. Whether an account has plan windows at all (a subscription login rather than an API key or an unauthenticated identity) changes only when the account does, so the question is asked again at the pace of one percent of the longest window, not the shortest. */
const NO_PLAN_WINDOWS_FRESHNESS_MS = SEVEN_DAY_WINDOW_MS / PERCENT;

/** One window of the usage endpoint's answer: the percentage used (0 to 100) and the ISO instant it resets, each null when the endpoint did not know it. */
interface ReportedWindow {
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

/** The plan windows of the usage endpoint's answer, as the Agent SDK's usage report carries them. */
export interface ReportedRateLimits {
  readonly five_hour?: ReportedWindow | null;
  readonly seven_day?: ReportedWindow | null;
}

/** The instant as the store writes it (UTC, millisecond precision): the endpoint answers with a numeric offset and finer precision, which the store's schema does not accept. Undefined for a value that is not a date. */
function normalisedInstant(value: string): string | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A quota window from one reported window. A window that is entirely used is marked refused; the endpoint reports no per-window status, so a warning level is never invented. */
function windowOf(reported: ReportedWindow | null | undefined): QuotaWindow | undefined {
  if (reported === null || reported === undefined) {
    return undefined;
  }
  const utilization = reported.utilization === null ? undefined : reported.utilization / PERCENT;
  const resetsAt = reported.resets_at === null ? undefined : normalisedInstant(reported.resets_at);
  if (utilization === undefined && resetsAt === undefined) {
    return undefined;
  }
  return {
    ...(utilization === undefined ? {} : { utilization }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(utilization !== undefined && utilization >= 1 ? { status: "rejected" } : {}),
  };
}

/** The unified rate-limit state a usage-endpoint answer describes, or undefined when it reported neither plan window (an API-key lane, or a token without the profile scope). */
export function unifiedFromReportedLimits(reported: ReportedRateLimits | null): UnifiedRateLimit | undefined {
  const fiveHour = windowOf(reported?.five_hour);
  const sevenDay = windowOf(reported?.seven_day);
  if (fiveHour === undefined && sevenDay === undefined) {
    return undefined;
  }
  return { ...(fiveHour === undefined ? {} : { fiveHour }), ...(sevenDay === undefined ? {} : { sevenDay }) };
}

/** Whether the usage endpoint can be asked about a member at all: a subscription member. A pay-per-use member has no plan windows. */
export function isAnthropicUsageProbeable(member: Pick<PoolMember, "snapshot" | "account">): boolean {
  return planOf(member.account ?? member.snapshot?.account).kind === "subscription";
}

/** Whether a member's Anthropic usage is worth fetching now: it can be fetched at all, and no rate-limit state was ever observed for it (a member that has made no request included) or the recorded one is older than its freshness period. */
export function isAnthropicUsageStale(member: Pick<PoolMember, "snapshot" | "account">, nowMs: number): boolean {
  const rateLimit = member.snapshot?.providers[ANTHROPIC_PROVIDER]?.rateLimit;
  const freshnessMs = rateLimit?.unified === undefined ? NO_PLAN_WINDOWS_FRESHNESS_MS : ANTHROPIC_USAGE_FRESHNESS_MS;
  return isAnthropicUsageProbeable(member) && (rateLimit === undefined || nowMs - Date.parse(rateLimit.observedAt) >= freshnessMs);
}

/** Every identity a pool and the pools it nests name, each once, in first-seen order. A nested pool that is not defined, or that closes a cycle, contributes nothing: ranking refuses those, and this only lists. */
export function poolIdentityNames(pools: Readonly<Record<string, Pool>>, poolName: string): readonly string[] {
  const seenPools = new Set<string>();
  const identities = new Set<string>();
  const walk = (name: string): void => {
    const pool = pools[name];
    if (pool === undefined || seenPools.has(name)) {
      return;
    }
    seenPools.add(name);
    for (const entry of pool.identities) {
      const member = poolMemberIdentity(entry);
      const nested = poolNameOf(member);
      if (nested === undefined) {
        identities.add(member);
      } else {
        walk(nested);
      }
    }
  };
  walk(poolName);
  return [...identities];
}

/** How one refresh ended. */
type AnthropicRefreshOutcome =
  | { readonly status: "refreshed" }
  /** The endpoint answered without plan windows: the account has none to report, which is itself recorded so the question is not asked again for one freshness period. */
  | { readonly status: "unavailable" }
  | { readonly status: "failed"; readonly message: string };

/** Everything the refresher depends on, injected so it runs against fakes. */
export interface AnthropicUsageRefresherDeps {
  /** Fetches the identity's plan windows from the usage endpoint, without any model request. Throws with the reason on failure; resolves undefined when the endpoint reports no plan windows. */
  readonly probe: (identity: string) => Promise<UnifiedRateLimit | undefined>;
  /** Records the fetched rate-limit state in the identity's Anthropic usage. */
  readonly record: (identity: string, rateLimit: RateLimitState) => void;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** The most probes in flight at once: each starts a `claude` process, so the machine's parallelism bounds it. */
  readonly concurrency: number;
}

/** Refreshes the Anthropic rate-limit state of identities whose recorded state has gone stale. */
export interface AnthropicUsageRefresher {
  /** Fetches and records one identity's usage, regardless of its freshness, though never twice at once. */
  readonly refresh: (identity: string) => Promise<AnthropicRefreshOutcome>;
  /** Refreshes, up to the configured concurrency at a time, each of `members` whose usage is stale and that no recent failure suppresses. Never throws: a failure is logged and the member keeps its recorded state. */
  readonly refreshStale: (members: readonly PoolMember[]) => Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds the refresher. One fetch per identity is in flight at a time, and a failure suppresses further automatic attempts for one freshness period, so an endpoint that is down costs one attempt per period. */
export function createAnthropicUsageRefresher(deps: AnthropicUsageRefresherDeps): AnthropicUsageRefresher {
  const inFlight = new Map<string, Promise<AnthropicRefreshOutcome>>();
  const failedAt = new Map<string, number>();

  const fetchNow = async (identity: string): Promise<AnthropicRefreshOutcome> => {
    try {
      const unified = await deps.probe(identity);
      deps.record(identity, { observedAt: new Date(deps.now()).toISOString(), headers: {}, ...(unified === undefined ? {} : { unified }) });
      failedAt.delete(identity);
      return unified === undefined ? { status: "unavailable" } : { status: "refreshed" };
    } catch (error) {
      failedAt.set(identity, deps.now());
      const message = describeError(error);
      deps.log(`usage: refreshing the Anthropic usage of ${identity} failed: ${message}`);
      return { status: "failed", message };
    }
  };

  const refresh = async (identity: string): Promise<AnthropicRefreshOutcome> => {
    const running = inFlight.get(identity);
    if (running !== undefined) {
      return await running;
    }
    const started = fetchNow(identity).finally(() => {
      inFlight.delete(identity);
    });
    inFlight.set(identity, started);
    return await started;
  };

  return {
    refresh,
    refreshStale: async (members) => {
      const nowMs = deps.now();
      const due = members.filter((member) => {
        const failed = failedAt.get(member.identity);
        return isAnthropicUsageStale(member, nowMs) && (failed === undefined || nowMs - failed >= ANTHROPIC_USAGE_FRESHNESS_MS);
      });
      const queue = [...due];
      const workers = Array.from({ length: Math.min(deps.concurrency, queue.length) }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          await refresh(next.identity);
        }
      });
      await Promise.all(workers);
    },
  };
}

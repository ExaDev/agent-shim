import type { Pool } from "../config/schema";
import { poolIdentityNames, type AnthropicUsageRefresher } from "../usage/anthropicUsageRefresh";
import type { PoolMember } from "../usage/pick";

/** What refreshing pools needs, injected so it runs against fakes. */
export interface RefreshStalePoolMembersParams {
  /** The pools to refresh the members of, each with the pools it nests. */
  readonly poolNames: readonly string[];
  readonly pools: Readonly<Record<string, Pool>>;
  /** Loads each named identity's recorded usage as the pool ranking reads it. */
  readonly loadMembers: (identities: readonly string[]) => readonly PoolMember[];
  readonly refresher: AnthropicUsageRefresher;
}

/**
 * Refreshes the Anthropic usage of every member of the named pools (and of the pools they nest) whose recorded state is stale, so a pick ranks on current figures. A launch runs it before `prepareLaunch`, which stays synchronous because it is part of the library surface; the front door runs it on a timer. A member whose fetch fails keeps its recorded state, and nothing here refuses a launch. An identity named by several pools is fetched once.
 */
export async function refreshStalePoolMembers(params: RefreshStalePoolMembersParams): Promise<void> {
  const identities = new Set(params.poolNames.flatMap((name) => poolIdentityNames(params.pools, name)));
  if (identities.size === 0) {
    return;
  }
  await params.refresher.refreshStale(params.loadMembers([...identities]));
}

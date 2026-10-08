import { describe, expect, it, vi } from "vitest";

import type { Pool } from "../config/schema";
import type { AnthropicUsageRefresher } from "../usage/anthropicUsageRefresh";
import type { PoolMember } from "../usage/pick";
import { refreshStalePoolMembers } from "./poolRefresh";

const pools: Record<string, Pool> = {
  subs: { identities: ["a", "b"] },
  extra: { identities: ["b", "c"] },
};

function fakes() {
  const refreshStale = vi.fn<AnthropicUsageRefresher["refreshStale"]>(async () => {
    await Promise.resolve();
  });
  const loadMembers = vi.fn((identities: readonly string[]): readonly PoolMember[] => identities.map((identity) => ({ identity, records: [] })));
  return { refreshStale, loadMembers, refresher: { refresh: vi.fn(), refreshStale } satisfies AnthropicUsageRefresher };
}

describe("refreshStalePoolMembers", () => {
  it("refreshes the members of the named pool", async () => {
    const { refresher, loadMembers, refreshStale } = fakes();

    await refreshStalePoolMembers({ poolNames: ["subs"], pools, loadMembers, refresher });

    expect(loadMembers).toHaveBeenCalledWith(["a", "b"]);
    expect(refreshStale).toHaveBeenCalledWith([{ identity: "a", records: [] }, { identity: "b", records: [] }]);
  });

  it("loads an identity named by several pools once", async () => {
    const { refresher, loadMembers } = fakes();

    await refreshStalePoolMembers({ poolNames: ["subs", "extra"], pools, loadMembers, refresher });

    expect(loadMembers).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("does nothing when no pool was selected", async () => {
    const { refresher, loadMembers, refreshStale } = fakes();

    await refreshStalePoolMembers({ poolNames: [], pools, loadMembers, refresher });

    expect(loadMembers).not.toHaveBeenCalled();
    expect(refreshStale).not.toHaveBeenCalled();
  });
});

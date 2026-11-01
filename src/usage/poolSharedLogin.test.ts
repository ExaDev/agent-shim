import { describe, expect, it } from "vitest";

import type { Pool } from "../config/schema";
import { FAKE_NOW_MS, createFakeFarmFs, paths } from "../test-helpers";
import { rankPoolGraph } from "./poolPick";
import type { AccountMetadata } from "./schema";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const THREE_HOURS_MS = 10_800_000;
const SIX_DAYS_MS = 518_400_000;
const MAX_20X = "default_claude_max_20x";
const U10 = 0.1;
const U50 = 0.5;
const U60 = 0.6;
const FULL = 1;

const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();

const EXAMPLE_LOGIN: AccountMetadata = { accountUuid: "account-alex", organizationUuid: "org-example", emailAddress: "alex@example.com", organizationName: "Example Org", organizationRateLimitTier: MAX_20X };

interface Window {
  readonly utilization: number;
  readonly resetsInMs: number;
  readonly status?: string;
}

interface Recorded {
  readonly window: Window;
  readonly account?: AccountMetadata;
  /** When the snapshot was written, relative to now. */
  readonly updatedAtMs?: number;
}

function snapshotOf(identity: string, recorded: Recorded): string {
  const seen = iso(recorded.updatedAtMs ?? -HOUR_MS);
  const { window } = recorded;
  return JSON.stringify({
    schemaVersion: 1,
    identity,
    updatedAt: seen,
    account: recorded.account ?? { organizationRateLimitTier: MAX_20X },
    providers: {
      anthropic: {
        lastRequestAt: seen,
        lastStatus: 200,
        rateLimit: { observedAt: seen, headers: {}, unified: { sevenDay: { utilization: window.utilization, resetsAt: iso(window.resetsInMs), ...(window.status === undefined ? {} : { status: window.status }) } } },
      },
    },
  });
}

/** Ranks `poolName` over `snapshots` (plus any extra files), every identity present. */
function graph(pools: Readonly<Record<string, Pool>>, poolName: string, snapshots: Readonly<Record<string, Recorded>>, options: Readonly<{ files?: Readonly<Record<string, string>>; sticky?: { identity: string; atMs: number }; resuming?: boolean }> = {}) {
  const files = { ...Object.fromEntries(Object.entries(snapshots).map(([identity, recorded]) => [`${paths.usageSnapshotsDir}/${identity}.json`, snapshotOf(identity, recorded)])), ...options.files };
  return rankPoolGraph({
    fs: createFakeFarmFs(files),
    paths,
    pools,
    poolName,
    nowMs: FAKE_NOW_MS,
    resuming: options.resuming ?? false,
    identityExists: () => true,
    ...(options.sticky === undefined ? {} : { sticky: { identity: options.sticky.identity, at: iso(options.sticky.atMs) } }),
  });
}

describe("rankPoolGraph: members that hold the same login", () => {
  const pools: Record<string, Pool> = { subs: { identities: ["work", "twin", "spare"] } };

  // The twin's stale snapshot would make it the best-scoring member (a nearly unused window resetting soon) if it were its own candidate.
  const WORK: Recorded = { window: { utilization: U60, resetsInMs: SIX_DAYS_MS }, account: EXAMPLE_LOGIN, updatedAtMs: -MINUTE_MS };
  const TWIN: Recorded = { window: { utilization: U10, resetsInMs: HOUR_MS }, account: EXAMPLE_LOGIN, updatedAtMs: -HOUR_MS };
  const SPARE: Recorded = { window: { utilization: U50, resetsInMs: THREE_HOURS_MS }, account: { ...EXAMPLE_LOGIN, accountUuid: "account-sam" } };
  const snapshots: Record<string, Recorded> = { work: WORK, twin: TWIN, spare: SPARE };

  it("ranks the login once, by its freshest snapshot, and reports the twin as the same login", () => {
    const { ranking } = graph(pools, "subs", snapshots);
    expect(ranking.candidates.filter((candidate) => candidate.class !== "ineligible").map((candidate) => candidate.identity).sort()).toEqual(["spare", "work"]);
    const twin = ranking.candidates.find((candidate) => candidate.identity === "twin");
    expect(twin).toMatchObject({ class: "ineligible", reasons: ["same login as work"] });
    expect(twin?.blockedUntilMs).toBeUndefined();
    expect(ranking.pick?.identity).not.toBe("twin");
  });

  it("takes the freshest snapshot as the representative whatever the listed order", () => {
    const { ranking } = graph({ subs: { identities: ["twin", "work", "spare"] } }, "subs", snapshots);
    expect(ranking.candidates.find((candidate) => candidate.identity === "twin")?.reasons).toEqual(["same login as work"]);
    expect(ranking.candidates.find((candidate) => candidate.identity === "work")?.class).not.toBe("ineligible");
  });

  it("keeps the first listed member as the representative when the snapshots are equally fresh", () => {
    const equal = { ...snapshots, twin: { ...TWIN, updatedAtMs: -MINUTE_MS } };
    const { ranking } = graph({ subs: { identities: ["twin", "work"] } }, "subs", equal);
    expect(ranking.candidates.find((candidate) => candidate.identity === "work")?.reasons).toEqual(["same login as twin"]);
  });

  it("prefers a member with a snapshot to one with none, reading the twin's login from its own profile", () => {
    const profile = JSON.stringify({ oauthAccount: { accountUuid: "account-alex", organizationUuid: "org-example" } });
    const { ranking } = graph({ subs: { identities: ["twin", "work"] } }, "subs", { work: WORK }, { files: { [`${paths.identitiesDir}/twin/.claude.json`]: profile } });
    expect(ranking.candidates.find((candidate) => candidate.identity === "twin")?.reasons).toEqual(["same login as work"]);
  });

  it("does not fall over to the twin when the representative is refused, and returns when the representative does", () => {
    const refused = { ...snapshots, work: { ...WORK, window: { utilization: FULL, resetsInMs: THREE_HOURS_MS, status: "rejected" } } };
    const { ranking } = graph({ subs: { identities: ["work", "twin"] } }, "subs", refused);
    expect(ranking.pick).toBeUndefined();
    expect(ranking.earliestReturn).toEqual({ identity: "work", atMs: FAKE_NOW_MS + THREE_HOURS_MS });
  });

  it("treats the same account in different organisations as two logins", () => {
    const { ranking } = graph({ subs: { identities: ["work", "twin"] } }, "subs", { ...snapshots, twin: { ...TWIN, account: { ...EXAMPLE_LOGIN, organizationUuid: "org-other" } } });
    expect(ranking.candidates.map((candidate) => candidate.class)).not.toContain("ineligible");
  });

  it("treats different accounts in one organisation as two logins", () => {
    const { ranking } = graph({ subs: { identities: ["work", "twin"] } }, "subs", { ...snapshots, twin: { ...TWIN, account: { ...EXAMPLE_LOGIN, accountUuid: "account-sam" } } });
    expect(ranking.candidates.map((candidate) => candidate.class)).not.toContain("ineligible");
  });

  it("never groups members without an account uuid", () => {
    const anonymous: AccountMetadata = { organizationUuid: "org-example", organizationRateLimitTier: MAX_20X };
    const { ranking } = graph({ subs: { identities: ["work", "twin"] } }, "subs", { work: { ...WORK, account: anonymous }, twin: { ...TWIN, account: anonymous } });
    expect(ranking.candidates.map((candidate) => candidate.class)).not.toContain("ineligible");
  });

  it("keeps a nested pool's own evaluation when its pick holds the login of a direct member", () => {
    const nesting: Record<string, Pool> = { outer: { identities: ["work", "pool:inner"] }, inner: { identities: ["twin"] } };
    const { ranking } = graph(nesting, "outer", snapshots);
    const nested = ranking.candidates.find((candidate) => candidate.identity === "twin");
    expect(nested?.class).not.toBe("ineligible");
    expect(nested?.reasons[0]).toBe('picked by pool "inner"');
    expect(ranking.candidates.find((candidate) => candidate.identity === "work")?.class).not.toBe("ineligible");
  });

  it("collapses twins inside a nested pool as it does at the top level", () => {
    const nesting: Record<string, Pool> = { outer: { identities: ["pool:inner"] }, inner: { identities: ["work", "twin"] } };
    const { ranking } = graph(nesting, "outer", snapshots);
    expect(ranking.pick?.identity).toBe("work");
    expect(ranking.pick?.reasons[0]).toBe('picked by pool "inner"');
  });

  it("keeps the conversation on the representative when the last pick was its twin", () => {
    const { ranking } = graph({ subs: { identities: ["work", "twin", "spare"] } }, "subs", snapshots, { sticky: { identity: "twin", atMs: -MINUTE_MS }, resuming: true });
    expect(ranking.pick?.identity).toBe("work");
    expect(ranking.movedOff).toBeUndefined();
  });
});

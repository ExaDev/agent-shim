import { describe, expect, it } from "vitest";

import type { Pool } from "../config/schema";
import { FAKE_NOW_MS, createFakeFarmFs, paths } from "../test-helpers";
import { loadPoolMembers, rankPoolGraph, type ProviderOf } from "./poolPick";
import type { AccountMetadata } from "./schema";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const TWO_DAYS_MS = 172_800_000;
const SIX_DAYS_MS = 518_400_000;
const MAX_20X = "default_claude_max_20x";
const U20 = 0.2;
const U60 = 0.6;
const FULL = 1;

const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();
const snapshotPath = (identity: string): string => `${paths.usageSnapshotsDir}/${identity}.json`;

interface Window {
  readonly utilization: number;
  readonly resetsInMs: number;
  readonly status?: string;
}

const windowOf = (window: Readonly<Window>): Record<string, unknown> => ({ utilization: window.utilization, resetsAt: iso(window.resetsInMs), ...(window.status === undefined ? {} : { status: window.status }) });

const sliceOf = (window: Readonly<Window>): Record<string, unknown> => ({ lastRequestAt: iso(-HOUR_MS), lastStatus: 200, rateLimit: { observedAt: iso(-MINUTE_MS), headers: {}, unified: { sevenDay: windowOf(window) } } });

/** One identity's snapshot: its Claude account's week and, when it has one, the week of provider `p`. */
function snapshotOf(identity: string, anthropic: Readonly<Window>, p?: Readonly<Window>, account: Readonly<AccountMetadata> = { organizationRateLimitTier: MAX_20X }): string {
  return JSON.stringify({ schemaVersion: 1, identity, updatedAt: iso(-HOUR_MS), account, providers: { anthropic: sliceOf(anthropic), ...(p === undefined ? {} : { p: sliceOf(p) }) } });
}

const SPENT: Window = { utilization: FULL, resetsInMs: TWO_DAYS_MS, status: "rejected" };
const OPEN: Window = { utilization: U20, resetsInMs: SIX_DAYS_MS };

function recordLine(identity: string, offsetMs: number, provider: string): string {
  return `${JSON.stringify({ schemaVersion: 1, at: iso(offsetMs), identity, provider, route: "r", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed" })}\n`;
}

describe("loadPoolMembers for a provider launch", () => {
  const day = iso(0).slice(0, "YYYY-MM-DD".length);

  it("carries the provider its launch spends and reads that provider's records, not the Claude account's", () => {
    const fs = createFakeFarmFs({ [`${paths.usageLogDir}/${day}.1.jsonl`]: [recordLine("work", -MINUTE_MS, "anthropic"), recordLine("work", -MINUTE_MS - MINUTE_MS, "p")].join("") });
    const [viaP, viaClaude] = [loadPoolMembers(fs, paths, ["work"], FAKE_NOW_MS, (name) => name, () => "p")[0], loadPoolMembers(fs, paths, ["work"], FAKE_NOW_MS, (name) => name)[0]];
    expect(viaP?.provider).toBe("p");
    expect(viaP?.records.map((record) => record.provider)).toEqual(["p"]);
    expect(viaClaude?.provider).toBeUndefined();
    expect(viaClaude?.records.map((record) => record.provider)).toEqual(["anthropic"]);
  });

  it("asks for the provider of each member by its name", () => {
    const asked: string[] = [];
    loadPoolMembers(createFakeFarmFs({}), paths, ["a", "b"], FAKE_NOW_MS, (name) => name, (name) => {
      asked.push(name);
      return undefined;
    });
    expect(asked).toEqual(["a", "b"]);
  });
});

describe("rankPoolGraph for a provider launch", () => {
  function graph(pools: Readonly<Record<string, Pool>>, poolName: string, snapshots: Readonly<Record<string, string>>, providerOf?: ProviderOf) {
    return rankPoolGraph({
      fs: createFakeFarmFs(Object.fromEntries(Object.entries(snapshots).map(([identity, text]) => [snapshotPath(identity), text]))),
      paths,
      pools,
      poolName,
      nowMs: FAKE_NOW_MS,
      resuming: false,
      identityIdOf: (name) => name,
      ...(providerOf === undefined ? {} : { providerOf }),
    });
  }

  const pools: Record<string, Pool> = { subs: { identities: ["a", "b"] } };
  const spentClaude = { a: snapshotOf("a", SPENT, OPEN), b: snapshotOf("b", SPENT, OPEN) };

  it("picks a member of a pool whose every Claude week is spent when the launch resolves a provider with open windows", () => {
    const { ranking } = graph(pools, "subs", spentClaude, () => "p");
    expect(ranking.pick).toBeDefined();
    expect(ranking.candidates.map((candidate) => [candidate.class, candidate.provider])).toEqual([["scored", "p"], ["scored", "p"]]);
  });

  it("refuses the same pool when the launch resolves no provider", () => {
    const { ranking } = graph(pools, "subs", spentClaude);
    expect(ranking.pick).toBeUndefined();
    expect(ranking.earliestReturn?.atMs).toBe(FAKE_NOW_MS + TWO_DAYS_MS);
  });

  it("assesses each member against the provider its own default resolves", () => {
    const { ranking } = graph(pools, "subs", { a: snapshotOf("a", SPENT, OPEN), b: snapshotOf("b", { utilization: U60, resetsInMs: SIX_DAYS_MS }, SPENT) }, (name) => (name === "a" ? "p" : undefined));
    expect(ranking.candidates.find((candidate) => candidate.identity === "a")).toMatchObject({ class: "scored", provider: "p" });
    expect(ranking.candidates.find((candidate) => candidate.identity === "b")).toMatchObject({ class: "scored" });
    expect(ranking.candidates.find((candidate) => candidate.identity === "b")?.provider).toBeUndefined();
  });

  it("ranks a member whose provider could not be read as unknown with the reason, and still picks a healthy member", () => {
    const providerOf: ProviderOf = (name) => (name === "a" ? { named: "p", reason: "provider file p.json is invalid" } : "p");
    const { ranking } = graph(pools, "subs", spentClaude, providerOf);
    const broken = ranking.candidates.find((candidate) => candidate.identity === "a");
    expect(broken).toMatchObject({ class: "unknown", provider: "p" });
    expect(broken?.reasons.join("\n")).toContain("provider file p.json is invalid");
    expect(ranking.pick).toMatchObject({ identity: "b", class: "scored" });
  });

  it("reports a member whose provider could not be read even when nothing names a provider", () => {
    const { ranking } = graph(pools, "subs", spentClaude, (name) => (name === "a" ? { reason: "profile broken.json is invalid" } : undefined));
    const broken = ranking.candidates.find((candidate) => candidate.identity === "a");
    expect(broken?.class).toBe("unknown");
    expect(broken?.reasons.join("\n")).toContain("profile broken.json is invalid");
  });

  it("resolves the provider of a nested pool's members too, at the outer ranking as at the inner", () => {
    const nested: Record<string, Pool> = { outer: { identities: ["pool:fleet"] }, fleet: { identities: ["a", "b"] } };
    const { ranking } = graph(nested, "outer", spentClaude, () => "p");
    expect(ranking.pick).toMatchObject({ class: "scored", provider: "p" });
  });

  it("does not collapse members that hold one Claude login when the launch spends a provider, since the login is not what they draw on", () => {
    const login: AccountMetadata = { accountUuid: "acct", organizationUuid: "org", organizationRateLimitTier: MAX_20X };
    const twins = { a: snapshotOf("a", OPEN, OPEN, login), b: snapshotOf("b", OPEN, OPEN, login) };
    expect(graph(pools, "subs", twins).ranking.candidates.map((candidate) => candidate.class).sort()).toEqual(["ineligible", "scored"]);
    expect(graph(pools, "subs", twins, () => "p").ranking.candidates.map((candidate) => candidate.class)).toEqual(["scored", "scored"]);
  });
});

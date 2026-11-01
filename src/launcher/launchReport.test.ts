import { describe, expect, it } from "vitest";

import type { Candidate } from "../usage/pick";
import type { AccountMetadata, UsageSnapshot } from "../usage/schema";
import { decisionRows, farmRow, noteRow, pinnedVersionRow, routingRows } from "./launchReport";
import type { ReportRow } from "./ports";

const FEW = 1;
const SEVERAL = 2;
const MANY = 3;
const NONE = {
  identity: undefined,
  identitySource: "none",
  pool: undefined,
  ranking: undefined,
  profile: undefined,
  provider: undefined,
  identityCredential: undefined,
  billing: undefined,
  lastRanAs: undefined,
  limitRelaunchFrom: undefined,
} as const;
const NOW_MS = Date.parse("2026-11-01T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const HOURS_PER_DAY = 24;
const DAY_MS = HOURS_PER_DAY * HOUR_MS;
const TWO_HOURS_MS = 2 * HOUR_MS;
const FIVE_HOURS = 5;
const FIVE_HOURS_MS = FIVE_HOURS * HOUR_MS;
const THREE_HOURS = 3;
const THREE_HOURS_MS = THREE_HOURS * HOUR_MS;
const FOUR_DAYS = 4;
const FOUR_DAYS_MS = FOUR_DAYS * DAY_MS;
const FORTY_TWO_PERCENT = 0.42;
const SEVENTEEN_PERCENT = 0.17;
const SEVENTY_PERCENT = 0.7;
const iso = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();
const TEAM_OWNER: AccountMetadata = { emailAddress: "alex@example.com", organizationName: "Example Org", organizationType: "claude_team", organizationRole: "owner", organizationRateLimitTier: "default_claude_max_20x" };
const snapshotOf = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({ schemaVersion: 1, identity: "work", updatedAt: iso(-HOUR_MS), providers: {}, ...overrides });
const anthropicQuota = (): UsageSnapshot =>
  snapshotOf({
    providers: {
      anthropic: {
        rateLimit: {
          observedAt: iso(-TWO_HOURS_MS),
          headers: {},
          unified: { fiveHour: { utilization: FORTY_TWO_PERCENT, resetsAt: iso(THREE_HOURS_MS) }, sevenDay: { utilization: SEVENTEEN_PERCENT, resetsAt: iso(FOUR_DAYS_MS) } },
        },
      },
    },
  });
const billing = (overrides: Partial<{ login: AccountMetadata | undefined; snapshot: UsageSnapshot | undefined; provider: string | undefined }> = {}) => ({ login: undefined, snapshot: undefined, provider: undefined, nowMs: NOW_MS, ...overrides });
const rowLabelled = (rows: readonly ReportRow[], label: string): ReportRow | undefined => rows.find((row) => row.label === label);

describe("decisionRows", () => {
  it("reports the identity and where it was chosen, and nothing about a profile or provider the launch has none of", () => {
    expect(decisionRows({ ...NONE, identity: "work", identitySource: "argv" })).toEqual([{ label: "identity", value: "work", detail: "argv" }]);
  });

  it("names a launch with no identity", () => {
    expect(decisionRows(NONE)).toEqual([{ label: "identity", value: "(none)", detail: "none" }]);
  });

  it("reports the pool with the pick's decisive reason, and leaves the ranking's other reasons out", () => {
    const rows = decisionRows({ ...NONE, identity: "a", pool: { name: "subs", reasons: ["used here 5m ago", "5h reset not scored"] } });
    expect(rows[1]).toEqual({ label: "pool", value: "subs", detail: "used here 5m ago" });
  });

  it("leaves the member a resumed conversation left to the moved notice, so the pool row keeps the pick's reason alone", () => {
    const rows = decisionRows({ ...NONE, identity: "a", pool: { name: "subs", reasons: ["r1", "r2"], movedOff: { identity: "b", reason: "spent" } } });
    expect(rows[1]).toEqual({ label: "pool", value: "subs", detail: "r1" });
  });

  it("reports a pool with no reasons by its name alone", () => {
    expect(decisionRows({ ...NONE, identity: "a", pool: { name: "subs", reasons: [] } })[1]).toEqual({ label: "pool", value: "subs" });
  });

  it("reports the profile, the provider with where its credential comes from, and the identity's own credential", () => {
    const rows = decisionRows({
      ...NONE,
      identity: "a",
      profile: { name: "strict", source: "directory-rule" },
      provider: { name: "z", credential: "bearer from env Z" },
      identityCredential: "oauthToken from op",
    });
    expect(rows.slice(1)).toEqual([
      { label: "profile", value: "strict", detail: "directory-rule" },
      { label: "provider", value: "z", detail: "credential bearer from env Z" },
      { label: "credential", value: "oauthToken from op", detail: "the identity's own" },
    ]);
  });
});

describe("decisionRows account row", () => {
  it("names the email, the organisation with the role in it, and the plan", () => {
    const rows = decisionRows({ ...NONE, identity: "work", billing: billing({ login: TEAM_OWNER }) });
    expect(rowLabelled(rows, "account")).toEqual({ label: "account", value: "alex@example.com, Example Org (owner), 20x" });
  });

  it("leaves a personal plan's organisation out, since its name is only the holder's own", () => {
    const login: AccountMetadata = { emailAddress: "me@example.com", organizationName: "me@example.com's Organization", organizationType: "claude_max", organizationRole: "admin", organizationRateLimitTier: "default_claude_max_5x" };
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", billing: billing({ login }) }), "account")?.value).toBe("me@example.com, 5x");
  });

  it("names a usage-billed seat by how it is billed rather than a multiplier", () => {
    const login: AccountMetadata = { emailAddress: "a@example.com", userRateLimitTier: "default_claude_zero" };
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", billing: billing({ login }) }), "account")?.value).toBe("a@example.com, pay-per-use");
  });

  it("leaves the plan out when its tier is one the plan classification does not recognise", () => {
    const login: AccountMetadata = { emailAddress: "a@example.com", organizationRateLimitTier: "something_new" };
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", billing: billing({ login }) }), "account")?.value).toBe("a@example.com");
  });

  it("falls back to the usage snapshot's account when the identity has no login file, as the pool pick does", () => {
    const rows = decisionRows({ ...NONE, identity: "work", billing: billing({ snapshot: snapshotOf({ account: TEAM_OWNER }) }) });
    expect(rowLabelled(rows, "account")?.value).toBe("alex@example.com, Example Org (owner), 20x");
  });

  it("prefers the login file over the snapshot", () => {
    const rows = decisionRows({ ...NONE, identity: "work", billing: billing({ login: { emailAddress: "new@example.com" }, snapshot: snapshotOf({ account: TEAM_OWNER }) }) });
    expect(rowLabelled(rows, "account")?.value).toBe("new@example.com");
  });

  it("is omitted when no account metadata exists, with no placeholder", () => {
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", billing: billing() }), "account")).toBeUndefined();
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", billing: undefined }), "account")).toBeUndefined();
  });

  it("is omitted for a provider launch whose usage endpoint reported no account, whatever the identity's own login is", () => {
    const rows = decisionRows({ ...NONE, identity: "work", provider: { name: "z", credential: "bearer" }, billing: billing({ login: TEAM_OWNER, provider: "z", snapshot: snapshotOf({ providers: { z: {} } }) }) });
    expect(rowLabelled(rows, "account")).toBeUndefined();
  });

  it("names the provider's own account and level for a provider launch, never the identity's login", () => {
    const quota = { observedAt: iso(-HOUR_MS), source: "z.ai", level: "pro", account: { email: "me@z.example" }, windows: [] };
    const rows = decisionRows({ ...NONE, identity: "work", provider: { name: "z", credential: "bearer" }, billing: billing({ login: TEAM_OWNER, provider: "z", snapshot: snapshotOf({ providers: { z: { quota } } }) }) });
    expect(rowLabelled(rows, "account")).toEqual({ label: "account", value: "me@z.example, pro", detail: "provider z" });
  });
});

describe("decisionRows quota row", () => {
  it("words the five-hour and seven-day windows as the pool pick does, with how old the recording is", () => {
    const rows = decisionRows({ ...NONE, identity: "work", billing: billing({ snapshot: anthropicQuota() }) });
    expect(rowLabelled(rows, "quota")).toEqual({ label: "quota", value: "5h 42% used, resets in 3h; 7d 17% used, resets in 4d", detail: "recorded 2h ago" });
  });

  it("says a window whose reset has passed has reset, since what was recorded describes a window that no longer exists", () => {
    const snapshot = snapshotOf({ providers: { anthropic: { rateLimit: { observedAt: iso(-DAY_MS), headers: {}, unified: { fiveHour: { utilization: 1, resetsAt: iso(-HOUR_MS) }, sevenDay: { utilization: SEVENTEEN_PERCENT, resetsAt: iso(FOUR_DAYS_MS) } } } } } });
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", billing: billing({ snapshot }) }), "quota")?.value).toBe("5h window has reset; 7d 17% used, resets in 4d");
  });

  it("leaves out a window the snapshot holds nothing for", () => {
    const snapshot = snapshotOf({ providers: { anthropic: { rateLimit: { observedAt: iso(-HOUR_MS), headers: {}, unified: { sevenDay: { utilization: SEVENTEEN_PERCENT, resetsAt: iso(FOUR_DAYS_MS) } } } } } });
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", billing: billing({ snapshot }) }), "quota")?.value).toBe("7d 17% used, resets in 4d");
  });

  it("is omitted without a snapshot, without recorded rate limits, and when the recorded windows hold nothing", () => {
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", billing: billing() }), "quota")).toBeUndefined();
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", billing: billing({ snapshot: snapshotOf() }) }), "quota")).toBeUndefined();
    const empty = snapshotOf({ providers: { anthropic: { rateLimit: { observedAt: iso(-HOUR_MS), headers: {}, unified: { fiveHour: {} } } } } });
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", billing: billing({ snapshot: empty }) }), "quota")).toBeUndefined();
  });

  it("reads a provider launch from the provider's own quota windows, not the Anthropic headers", () => {
    const quota = {
      observedAt: iso(-HOUR_MS),
      source: "z.ai",
      windows: [{ measures: "tokens", periodMs: FIVE_HOURS_MS, utilization: SEVENTY_PERCENT, resetsAt: iso(THREE_HOURS_MS) }],
    };
    const snapshot = snapshotOf({ providers: { ...anthropicQuota().providers, z: { quota } } });
    const rows = decisionRows({ ...NONE, identity: "work", provider: { name: "z", credential: "bearer" }, billing: billing({ provider: "z", snapshot }) });
    expect(rowLabelled(rows, "quota")).toEqual({ label: "quota", value: "5h tokens 70% used, resets in 3h", detail: "recorded 1h ago" });
  });

  it("is omitted for a provider launch whose provider reported no quota, even when the identity has Anthropic headers recorded", () => {
    const rows = decisionRows({ ...NONE, identity: "work", provider: { name: "z", credential: "bearer" }, billing: billing({ provider: "z", snapshot: anthropicQuota() }) });
    expect(rowLabelled(rows, "quota")).toBeUndefined();
  });
});

describe("decisionRows moved notice", () => {
  const ONE_HOUR_AGO = { identity: "personal", agoMs: HOUR_MS };

  it("says nothing when the launch runs as the identity the directory last ran as, or has no record of one", () => {
    expect(rowLabelled(decisionRows({ ...NONE, identity: "personal", pool: { name: "subs", reasons: [] }, lastRanAs: ONE_HOUR_AGO }), "moved")).toBeUndefined();
    expect(rowLabelled(decisionRows({ ...NONE, identity: "work", pool: { name: "subs", reasons: [] } }), "moved")).toBeUndefined();
  });

  it("flags a pool pick that changed the account from the one the directory last ran as", () => {
    const rows = decisionRows({ ...NONE, identity: "work", pool: { name: "subs", reasons: ["r"] }, lastRanAs: ONE_HOUR_AGO });
    expect(rowLabelled(rows, "moved")).toEqual({ label: "moved", value: "personal -> work", detail: "this directory last ran as personal 1h ago", notice: true });
  });

  it("names why a resumed conversation could not stay, using the ranking's own reason", () => {
    const rows = decisionRows({ ...NONE, identity: "work", pool: { name: "subs", reasons: ["r"], movedOff: { identity: "personal", reason: "continues as extra usage" } }, lastRanAs: ONE_HOUR_AGO });
    expect(rowLabelled(rows, "moved")).toEqual({ label: "moved", value: "personal -> work", detail: "the resumed conversation could not stay: continues as extra usage", notice: true });
  });

  it("names a resume-on-limit relaunch by the member that ran out, ahead of the sticky record", () => {
    const rows = decisionRows({ ...NONE, identity: "work", pool: { name: "subs", reasons: ["resumed"] }, lastRanAs: { identity: "older", agoMs: DAY_MS }, limitRelaunchFrom: "personal" });
    expect(rowLabelled(rows, "moved")).toEqual({ label: "moved", value: "personal -> work", detail: "personal ran out of quota; the session resumed here", notice: true });
  });

  it("sits directly after the pool row, so the account change reads with the pick that made it", () => {
    const rows = decisionRows({ ...NONE, identity: "work", pool: { name: "subs", reasons: ["r"] }, lastRanAs: ONE_HOUR_AGO, billing: billing({ login: TEAM_OWNER }) });
    expect(rows.map((row) => row.label)).toEqual(["identity", "pool", "moved", "account"]);
  });
});

describe("decisionRows explaining a pool pick", () => {
  const candidate = (identity: string, overrides: Partial<Candidate> = {}): Candidate => ({ identity, class: "scored", score: 0.5, scoreWindow: "sevenDay", feasible: true, plan: { kind: "subscription", capacity: 20, recognised: true }, reasons: [`${identity} reason one`, `${identity} reason two`], ...overrides });

  it("lists every ranked member in order with its heading and reasons, marking the one picked, as notes of the pool row", () => {
    const rows = decisionRows({
      ...NONE,
      identity: "b",
      pool: { name: "subs", reasons: ["b reason one"] },
      ranking: [candidate("a", { class: "ineligible", score: undefined, scoreWindow: undefined }), candidate("b", { feasible: false })],
    });

    expect(rows[1]?.notes).toEqual([
      "1. a [ineligible]",
      "   a reason one; a reason two",
      "2. b [scored score 0.50 by 7d reset] (5h would run dry) (picked)",
      "   b reason one; b reason two",
    ]);
    expect(rows[1]?.detail).toBe("b reason one");
  });

  it("adds no notes when the launch does not ask for the ranking", () => {
    expect(decisionRows({ ...NONE, identity: "a", pool: { name: "subs", reasons: ["r"] } })[1]).not.toHaveProperty("notes");
  });
});

describe("routingRows", () => {
  it("reports nothing for a launch routed through neither the door nor headroom", () => {
    expect(routingRows({ frontDoor: undefined, headroom: undefined, provider: false })).toEqual([]);
  });

  it("says how an OAuth launch reaches the door", () => {
    expect(routingRows({ frontDoor: { port: 4100, connectPort: 4200 }, headroom: undefined, provider: false })).toEqual([
      { label: "routing", value: "front door 127.0.0.1:4100", detail: "OAuth via CONNECT 127.0.0.1:4200" },
    ]);
  });

  it("says nothing about the CONNECT surface for a provider launch, and adds headroom with its project when it is on", () => {
    expect(routingRows({ frontDoor: { port: 4100, connectPort: 4200 }, headroom: { projectId: "/repo" }, provider: true })).toEqual([
      { label: "routing", value: "front door 127.0.0.1:4100" },
      { label: "headroom", value: "on", detail: "project /repo" },
    ]);
  });
});

describe("the other rows", () => {
  it("counts what a resynced farm changed, in the singular where there is one", () => {
    expect(farmRow(MANY, FEW, 0)).toEqual({ label: "farm", value: "resynced", detail: "3 links, 1 built directory" });
    expect(farmRow(FEW, SEVERAL, SEVERAL * SEVERAL)).toEqual({ label: "farm", value: "resynced", detail: "1 link, 2 built directories, 4 adopted" });
  });

  it("says where a pinned Claude Code version came from", () => {
    expect(pinnedVersionRow("2.1.5", "flag")).toEqual({ label: "claude", value: "2.1.5", detail: "pinned by flag" });
  });

  it("carries a note as its own value", () => {
    expect(noteRow("text")).toEqual({ label: "note", value: "text" });
  });
});

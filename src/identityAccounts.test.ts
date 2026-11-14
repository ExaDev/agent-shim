import { describe, expect, it } from "vitest";

import { describeIdentityAccount, groupByLogin, groupSharedLogins, loginKeyOf, readIdentityAccount, summariseIdentityAccount } from "./identityAccounts";
import { createFakeFarmFs, paths } from "./test-helpers";
import { claudeJsonPath } from "./usage/account";

const WORK_PROFILE = claudeJsonPath(paths.identitiesDir, "work");

describe("loginKeyOf", () => {
  it("is shared by accounts with the same account and organisation", () => {
    expect(loginKeyOf({ accountUuid: "a1", organizationUuid: "o1" })).toBe(loginKeyOf({ accountUuid: "a1", organizationUuid: "o1", emailAddress: "me@example.com" }));
  });

  it("differs when either the account or the organisation differs", () => {
    expect(loginKeyOf({ accountUuid: "a1", organizationUuid: "o1" })).not.toBe(loginKeyOf({ accountUuid: "a1", organizationUuid: "o2" }));
    expect(loginKeyOf({ accountUuid: "a1", organizationUuid: "o1" })).not.toBe(loginKeyOf({ accountUuid: "a2", organizationUuid: "o1" }));
  });

  it("treats a missing organisation as one value, so two organisation-less logins of one account match", () => {
    expect(loginKeyOf({ accountUuid: "a1" })).toBe(loginKeyOf({ accountUuid: "a1" }));
    expect(loginKeyOf({ accountUuid: "a1" })).not.toBe(loginKeyOf({ accountUuid: "a1", organizationUuid: "o1" }));
  });

  it("is undefined without an account uuid, since nothing says whose login it is", () => {
    expect(loginKeyOf({ emailAddress: "me@example.com" })).toBeUndefined();
  });
});

describe("groupByLogin", () => {
  const item = (name: string, login: string | undefined) => ({ name, login });
  const names = (items: readonly { readonly name: string }[]) => items.map((entry) => entry.name);

  it("moves identities sharing a login next to the first of them, keeping the rest in order", () => {
    const grouped = groupByLogin([item("a", "x"), item("b", "y"), item("c", "x"), item("d", "y"), item("e", "z")], (entry) => entry.login);
    expect(names(grouped)).toEqual(["a", "c", "b", "d", "e"]);
  });

  it("leaves an identity with no login where it was", () => {
    const grouped = groupByLogin([item("a", "x"), item("b", undefined), item("c", "x"), item("d", undefined)], (entry) => entry.login);
    expect(names(grouped)).toEqual(["a", "c", "b", "d"]);
  });

  it("returns every item exactly once", () => {
    expect(groupByLogin([], () => undefined)).toEqual([]);
    expect(names(groupByLogin([item("a", "x"), item("b", "x")], (entry) => entry.login))).toEqual(["a", "b"]);
  });
});

describe("groupSharedLogins", () => {
  const item = (name: string, login: string | undefined) => ({ name, login });
  const names = (groups: readonly (readonly { readonly name: string }[])[]) => groups.map((group) => group.map((entry) => entry.name));

  it("returns each login held by two or more items, members in given order, groups by first member", () => {
    const groups = groupSharedLogins([item("a", "x"), item("b", "y"), item("c", "x"), item("d", "y"), item("e", "z"), item("f", "x")], (entry) => entry.login);
    expect(names(groups)).toEqual([["a", "c", "f"], ["b", "d"]]);
  });

  it("returns nothing when every login is held once", () => {
    expect(groupSharedLogins([item("a", "x"), item("b", "y")], (entry) => entry.login)).toEqual([]);
  });

  it("never groups items without a login", () => {
    expect(groupSharedLogins([item("a", undefined), item("b", undefined)], (entry) => entry.login)).toEqual([]);
  });
});

describe("summariseIdentityAccount", () => {
  it("keeps the email, organisation, role and plan fields and nothing else", () => {
    expect(
      summariseIdentityAccount({
        accountUuid: "a1",
        organizationUuid: "o1",
        displayName: "Me",
        emailAddress: "me@example.com",
        organizationName: "Example Org",
        organizationType: "claude_team",
        organizationRole: "admin",
        billingType: "stripe_subscription",
        seatTier: "team_standard",
        hasExtraUsageEnabled: true,
      }),
    ).toEqual({
      emailAddress: "me@example.com",
      organizationName: "Example Org",
      organizationType: "claude_team",
      organizationRole: "admin",
      billingType: "stripe_subscription",
      seatTier: "team_standard",
    });
  });

  it("is undefined when the account carries none of them", () => {
    expect(summariseIdentityAccount({ accountUuid: "a1" })).toBeUndefined();
  });
});

describe("describeIdentityAccount", () => {
  it("reads email, organisation, role and plan in that order", () => {
    expect(
      describeIdentityAccount({
        emailAddress: "me@example.com",
        organizationName: "Example Org",
        organizationType: "claude_team",
        organizationRole: "admin",
        billingType: "stripe_subscription",
        seatTier: "team_standard",
      }),
    ).toBe("me@example.com (Example Org, claude_team); role admin; billing stripe_subscription, seat tier team_standard");
  });

  it("omits whatever is absent, with no placeholder", () => {
    expect(describeIdentityAccount({ emailAddress: "me@example.com" })).toBe("me@example.com");
    expect(describeIdentityAccount({ organizationRole: "user" })).toBe("role user");
    expect(describeIdentityAccount({ organizationName: "Example Org", billingType: "apple_subscription" })).toBe("Example Org; billing apple_subscription");
  });
});

describe("readIdentityAccount", () => {
  it("reads the stored login's account metadata", () => {
    const fs = createFakeFarmFs({ [WORK_PROFILE]: JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" } }) });
    expect(readIdentityAccount(fs, paths.identitiesDir, "work")).toEqual({ account: { emailAddress: "me@example.com" } });
  });

  it("is undefined for an identity with no stored login", () => {
    expect(readIdentityAccount(createFakeFarmFs(), paths.identitiesDir, "work")).toBeUndefined();
  });

  it("reports an unreadable profile as a problem instead of throwing", () => {
    const fs = createFakeFarmFs({ [WORK_PROFILE]: "{broken" });
    expect(readIdentityAccount(fs, paths.identitiesDir, "work")).toEqual({ problem: `${WORK_PROFILE}: not valid JSON, so its account metadata cannot be read.` });
  });
});

describe("an identity's .claude.json that cannot be read", () => {
  it("is reported as that identity's own problem by its code, never thrown", () => {
    const unreadable = {
      readFileUtf8: (): string | undefined => {
        const error: Error & { code?: string } = new Error("EISDIR: illegal operation on a directory, read");
        error.code = "EISDIR";
        throw error;
      },
    };
    const read = readIdentityAccount(unreadable, "/state/identities", "work");
    expect(read?.problem).toContain("EISDIR");
    expect(read?.problem).not.toContain("/state/");
  });
});

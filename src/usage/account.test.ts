import { describe, expect, it } from "vitest";

import { createFakeFarmFs, paths, type FakeFarmFs } from "../test-helpers";
import { AccountMetadataError, claudeJsonPath, createAccountReader, isIdentityName, readAccountMetadata } from "./account";

const IDENTITIES_DIR = paths.identitiesDir;
const WORK_PROFILE = claudeJsonPath(IDENTITIES_DIR, "work");

function profile(oauthAccount: unknown): string {
  return JSON.stringify({ numStartups: 12, projects: { "/some/project": { history: ["a private prompt"] } }, oauthAccount });
}

describe("isIdentityName", () => {
  it.each(["work", "joseph.mearman@exadev.io", "a", "team-1_x"])("accepts %s", (name) => {
    expect(isIdentityName(name)).toBe(true);
  });

  it.each(["", ".hidden", "../escape", "a/b", "@work", "has space"])("rejects %j", (name) => {
    expect(isIdentityName(name)).toBe(false);
  });
});

describe("readAccountMetadata", () => {
  it("reads the plan, tier and account fields from an identity's stored login", () => {
    const fs = createFakeFarmFs({
      [WORK_PROFILE]: profile({
        accountUuid: "11111111-2222-3333-4444-555555555555",
        emailAddress: "me@example.com",
        organizationName: "Example Org",
        organizationType: "claude_team",
        billingType: "stripe_subscription",
        seatTier: "team_standard",
        organizationRateLimitTier: "default_claude_max_5x",
        userRateLimitTier: "default_claude_max_20x",
        hasExtraUsageEnabled: true,
      }),
    });

    expect(readAccountMetadata(fs, IDENTITIES_DIR, "work")).toEqual({
      accountUuid: "11111111-2222-3333-4444-555555555555",
      emailAddress: "me@example.com",
      organizationName: "Example Org",
      organizationType: "claude_team",
      billingType: "stripe_subscription",
      seatTier: "team_standard",
      organizationRateLimitTier: "default_claude_max_5x",
      userRateLimitTier: "default_claude_max_20x",
      hasExtraUsageEnabled: true,
    });
  });

  it("copies only the named account fields, never anything else in the profile", () => {
    const fs = createFakeFarmFs({ [WORK_PROFILE]: profile({ emailAddress: "me@example.com", accessToken: "sk-not-a-real-token", unrelated: { nested: true } }) });

    const account = readAccountMetadata(fs, IDENTITIES_DIR, "work");

    expect(account).toEqual({ emailAddress: "me@example.com" });
    expect(JSON.stringify(account)).not.toContain("sk-not-a-real-token");
    expect(JSON.stringify(account)).not.toContain("a private prompt");
  });

  it("treats a null field as absent, which is how Claude Code records a fetched-but-empty value", () => {
    const fs = createFakeFarmFs({ [WORK_PROFILE]: profile({ emailAddress: "me@example.com", seatTier: null, billingType: null }) });

    expect(readAccountMetadata(fs, IDENTITIES_DIR, "work")).toEqual({ emailAddress: "me@example.com" });
  });

  it("reads nothing for an identity with no .claude.json", () => {
    expect(readAccountMetadata(createFakeFarmFs(), IDENTITIES_DIR, "work")).toBeUndefined();
  });

  it("reads nothing for a profile with no oauthAccount, as for a setup-token identity", () => {
    const fs = createFakeFarmFs({ [WORK_PROFILE]: JSON.stringify({ numStartups: 1 }) });

    expect(readAccountMetadata(fs, IDENTITIES_DIR, "work")).toBeUndefined();
  });

  it("reports a profile that is not valid JSON, naming the file", () => {
    const fs = createFakeFarmFs({ [WORK_PROFILE]: "{broken" });

    expect(() => readAccountMetadata(fs, IDENTITIES_DIR, "work")).toThrow(AccountMetadataError);
    expect(() => readAccountMetadata(fs, IDENTITIES_DIR, "work")).toThrow(`${WORK_PROFILE}: not valid JSON, so its account metadata cannot be read.`);
  });

  it("reports a profile that is not a JSON object", () => {
    const fs = createFakeFarmFs({ [WORK_PROFILE]: "[1, 2]" });

    expect(() => readAccountMetadata(fs, IDENTITIES_DIR, "work")).toThrow("not a JSON object");
  });

  it("reports an account field of an unexpected type, naming the field", () => {
    const fs = createFakeFarmFs({ [WORK_PROFILE]: profile({ emailAddress: 42 }) });

    expect(() => readAccountMetadata(fs, IDENTITIES_DIR, "work")).toThrow(/emailAddress/);
  });

  it("refuses an identity name that could name a path outside the identities directory", () => {
    const fs = createFakeFarmFs();

    expect(() => readAccountMetadata(fs, IDENTITIES_DIR, "../escape")).toThrow('"../escape" is not a valid identity name.');
    expect(() => readAccountMetadata(fs, IDENTITIES_DIR, "")).toThrow("is not a valid identity name");
  });
});

describe("createAccountReader", () => {
  function countingReader(fs: FakeFarmFs): { readonly read: ReturnType<typeof createAccountReader>; readonly reads: () => number } {
    let reads = 0;
    const read = createAccountReader(
      {
        lstat: fs.lstat,
        readFileUtf8: (file) => {
          reads += 1;
          return fs.readFileUtf8(file);
        },
      },
      IDENTITIES_DIR,
    );
    return { read, reads: () => reads };
  }

  it("re-reads the profile only when its modification time or size changed", () => {
    const fs = createFakeFarmFs({ [WORK_PROFILE]: profile({ seatTier: "team_standard" }) });
    const { read, reads } = countingReader(fs);

    expect(read("work")).toEqual({ seatTier: "team_standard" });
    expect(read("work")).toEqual({ seatTier: "team_standard" });
    expect(reads()).toBe(1);

    fs.writeFileUtf8(WORK_PROFILE, profile({ seatTier: "team_premium" }));

    expect(read("work")).toEqual({ seatTier: "team_premium" });
    expect(reads()).toBe(2);
  });

  it("caches per identity", () => {
    const fs = createFakeFarmFs({
      [WORK_PROFILE]: profile({ seatTier: "work-tier" }),
      [claudeJsonPath(IDENTITIES_DIR, "personal")]: profile({ seatTier: "personal-tier" }),
    });
    const { read, reads } = countingReader(fs);

    expect(read("work")?.seatTier).toBe("work-tier");
    expect(read("personal")?.seatTier).toBe("personal-tier");
    expect(read("work")?.seatTier).toBe("work-tier");
    expect(reads()).toBe(2);
  });

  it("reports no account for an identity without a profile, and notices the profile appearing later", () => {
    const fs = createFakeFarmFs();
    const { read } = countingReader(fs);

    expect(read("work")).toBeUndefined();

    fs.seed({ [WORK_PROFILE]: profile({ emailAddress: "me@example.com" }) });

    expect(read("work")).toEqual({ emailAddress: "me@example.com" });
  });

  it("surfaces an unreadable profile rather than serving a stale account", () => {
    const fs = createFakeFarmFs({ [WORK_PROFILE]: profile({ seatTier: "team_standard" }) });
    const { read } = countingReader(fs);
    expect(read("work")).toEqual({ seatTier: "team_standard" });

    fs.writeFileUtf8(WORK_PROFILE, "{broken");

    expect(() => read("work")).toThrow(AccountMetadataError);
  });

  it("refuses an invalid identity name", () => {
    const { read } = countingReader(createFakeFarmFs());

    expect(() => read("../escape")).toThrow('"../escape" is not a valid identity name.');
  });
});

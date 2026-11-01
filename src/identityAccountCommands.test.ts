import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addIdentity, setIdentityCredential } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { buildProgram } from "./program";
import { fakeCommandDeps } from "./test-helpers";
import { claudeJsonPath } from "./usage/account";

const TEAM_LOGIN = {
  accountUuid: "11111111-2222-3333-4444-555555555555",
  organizationUuid: "66666666-7777-8888-9999-000000000000",
  emailAddress: "me@example.com",
  organizationName: "Example Org",
  organizationType: "claude_team",
  organizationRole: "admin",
  billingType: "stripe_subscription",
  seatTier: "team_standard",
};

const PERSONAL_LOGIN = {
  accountUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  emailAddress: "other@example.com",
  organizationType: "claude_max",
  organizationRole: "user",
  billingType: "stripe_subscription",
};

const TEAM_TEXT = "me@example.com (Example Org, claude_team); role admin; billing stripe_subscription, seat tier team_standard";

describe("identity list and identity show account details", () => {
  let root: string;
  let paths: LayoutPaths;
  let out: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-account-test-"));
    paths = buildLayoutPaths(root);
    out = [];
    vi.spyOn(console, "log").mockImplementation((...args: readonly unknown[]) => {
      out.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function login(identity: string, oauthAccount: unknown): void {
    addIdentity(paths, identity);
    fs.writeFileSync(claudeJsonPath(paths.identitiesDir, identity), JSON.stringify({ oauthAccount }));
  }

  async function run(...argv: readonly string[]): Promise<string> {
    out = [];
    await buildProgram({ ...fakeCommandDeps(paths), runClaude: vi.fn() }).parseAsync([...argv], { from: "user" });
    return out.join("\n");
  }

  /** The identity names `identity list` printed, in order. */
  async function listedNames(): Promise<string[]> {
    return (await run("identity", "list")).split("\n").map((line) => line.trim().replace(/^\* /, "").split(/\s+/)[0] ?? "");
  }

  describe("identity list", () => {
    it("prints each identity's email, organisation, role and plan after its settings", async () => {
      login("work", TEAM_LOGIN);
      expect(await run("identity", "list")).toBe(`  work  ${TEAM_TEXT}`);
    });

    it("prints nothing for an identity with no stored login", async () => {
      addIdentity(paths, "bare");
      expect(await run("identity", "list")).toBe("  bare");
    });

    it("prints nothing for a token identity, which has no profile", async () => {
      addIdentity(paths, "token");
      setIdentityCredential(paths, "token", { sources: [{ env: "EXAMPLE_TOKEN" }], target: "oauthToken" });
      const text = await run("identity", "list");
      expect(text).toContain("token");
      expect(text).not.toContain("@");
      expect(text).not.toContain("role");
    });

    it("groups identities that share a login, in name order within each group", async () => {
      login("a-work", TEAM_LOGIN);
      login("b-personal", PERSONAL_LOGIN);
      login("c-work", TEAM_LOGIN);
      addIdentity(paths, "d-bare");
      expect(await listedNames()).toEqual(["a-work", "c-work", "b-personal", "d-bare"]);
    });

    it("does not group identities of one account in different organisations", async () => {
      login("a-one", TEAM_LOGIN);
      login("b-two", PERSONAL_LOGIN);
      login("c-three", { ...TEAM_LOGIN, organizationUuid: "ffffffff-0000-0000-0000-000000000000" });
      expect(await listedNames()).toEqual(["a-one", "b-two", "c-three"]);
    });

    it("keeps listing every identity when one profile is unreadable, naming the problem on that line", async () => {
      login("good", TEAM_LOGIN);
      addIdentity(paths, "broken");
      fs.writeFileSync(claudeJsonPath(paths.identitiesDir, "broken"), "{broken");
      const lines = (await run("identity", "list")).split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("broken  [account unreadable:");
      expect(lines[1]).toContain(TEAM_TEXT);
    });

    it("carries the same fields in --json, grouped in the same order, with the shared logins named", async () => {
      login("a-work", TEAM_LOGIN);
      login("b-personal", PERSONAL_LOGIN);
      login("c-work", TEAM_LOGIN);
      addIdentity(paths, "d-bare");
      const views: unknown = JSON.parse(await run("identity", "list", "--json"));
      if (!Array.isArray(views)) {
        throw new Error("expected an array");
      }
      expect(views).toMatchObject([
        {
          name: "a-work",
          account: {
            emailAddress: "me@example.com",
            organizationName: "Example Org",
            organizationType: "claude_team",
            organizationRole: "admin",
            billingType: "stripe_subscription",
            seatTier: "team_standard",
          },
          sharesLoginWith: ["c-work"],
        },
        { name: "c-work", account: { emailAddress: "me@example.com" }, sharesLoginWith: ["a-work"] },
        { name: "b-personal", account: { emailAddress: "other@example.com", organizationRole: "user" } },
        { name: "d-bare" },
      ]);
      expect(views[2]).not.toHaveProperty("sharesLoginWith");
      expect(views[3]).not.toHaveProperty("account");
      expect(views[3]).not.toHaveProperty("sharesLoginWith");
    });

    it("never prints the account or organisation uuids", async () => {
      login("work", TEAM_LOGIN);
      const text = `${await run("identity", "list")}${await run("identity", "list", "--json")}`;
      expect(text).not.toContain(TEAM_LOGIN.accountUuid);
      expect(text).not.toContain(TEAM_LOGIN.organizationUuid);
    });
  });

  describe("identity show", () => {
    it("prints the email, organisation, role and plan on their own lines", async () => {
      login("work", TEAM_LOGIN);
      const lines = (await run("identity", "show", "work")).split("\n");
      expect(lines).toContain("Account: me@example.com (Example Org, claude_team)");
      expect(lines).toContain("Role: admin");
      expect(lines).toContain("Plan: billing stripe_subscription, seat tier team_standard");
    });

    it("prints no account lines for an identity with no stored login", async () => {
      addIdentity(paths, "bare");
      const text = await run("identity", "show", "bare");
      expect(text).not.toContain("Account:");
      expect(text).not.toContain("Role:");
      expect(text).not.toContain("Plan:");
    });

    it("names the other identities sharing the login", async () => {
      login("a-work", TEAM_LOGIN);
      login("c-work", TEAM_LOGIN);
      login("b-personal", PERSONAL_LOGIN);
      expect(await run("identity", "show", "a-work")).toContain("Shares login with: c-work");
      expect(await run("identity", "show", "b-personal")).not.toContain("Shares login with");
    });

    it("carries the same fields in --json", async () => {
      login("a-work", TEAM_LOGIN);
      login("c-work", TEAM_LOGIN);
      const view: unknown = JSON.parse(await run("identity", "show", "a-work", "--json"));
      expect(view).toMatchObject({
        name: "a-work",
        account: { emailAddress: "me@example.com", organizationName: "Example Org", organizationRole: "admin", billingType: "stripe_subscription", seatTier: "team_standard" },
        sharesLoginWith: ["c-work"],
      });
    });

    it("reports an unreadable profile instead of failing", async () => {
      addIdentity(paths, "broken");
      fs.writeFileSync(claudeJsonPath(paths.identitiesDir, "broken"), "{broken");
      expect(await run("identity", "show", "broken")).toContain("Account unreadable:");
    });
  });
});

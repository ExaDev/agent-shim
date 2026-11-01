import { describe, expect, it } from "vitest";
import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor, identity } from "./doctorTestFixtures";

const EXAMPLE_ACCOUNT = { accountUuid: "account-1", organizationUuid: "org-1", emailAddress: "alex@example.com", organizationName: "Example Org" };

/** A doctor run whose global config defines `pools`, over `identities`. */
function run(pools: Readonly<Record<string, { identities: string[] }>>, identities: readonly ReturnType<typeof identity>[]) {
  return runDoctor(baseParams({ identities: [...identities], globalConfig: { path: "/agent-shim/config.json", raw: JSON.stringify({ pools }) } }));
}

const warnings = (report: ReturnType<typeof runDoctor>) => findingsFor(report, "pool").filter((finding) => finding.severity === "warn");

describe("runDoctor: pools listing two members on one login", () => {
  it("warns, never fails, naming the members that share a login", () => {
    const report = run({ subs: { identities: ["first", "second", "third"] } }, [identity("first", { account: EXAMPLE_ACCOUNT }), identity("second", { account: EXAMPLE_ACCOUNT }), identity("third", { account: { ...EXAMPLE_ACCOUNT, accountUuid: "account-2" } })]);
    const found = warnings(report);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('Pool "subs" lists first and second');
    expect(found[0]?.message).toContain("alex@example.com (Example Org)");
    expect(found[0]?.subject).toBe("subs");
    expect(report.ok).toBe(true);
  });

  it("warns for each pool that lists such a pair, and not for a pool that lists one of them", () => {
    const report = run({ a: { identities: ["first", "second"] }, b: { identities: ["first"] } }, [identity("first", { account: EXAMPLE_ACCOUNT }), identity("second", { account: EXAMPLE_ACCOUNT })]);
    expect(warnings(report).map((finding) => finding.subject)).toEqual(["a"]);
  });

  it("does not warn for the same account in different organisations or different accounts in one organisation", () => {
    const report = run({ subs: { identities: ["first", "second", "third"] } }, [
      identity("first", { account: EXAMPLE_ACCOUNT }),
      identity("second", { account: { ...EXAMPLE_ACCOUNT, organizationUuid: "org-2" } }),
      identity("third", { account: { ...EXAMPLE_ACCOUNT, accountUuid: "account-2" } }),
    ]);
    expect(warnings(report)).toEqual([]);
  });

  it("does not warn for members without account metadata", () => {
    expect(warnings(run({ subs: { identities: ["first", "second"] } }, [identity("first"), identity("second")]))).toEqual([]);
  });

  it("does not group a nested pool entry with a direct member", () => {
    const report = run({ outer: { identities: ["first", "pool:inner"] }, inner: { identities: ["second"] } }, [identity("first", { account: EXAMPLE_ACCOUNT }), identity("second", { account: EXAMPLE_ACCOUNT })]);
    expect(warnings(report)).toEqual([]);
  });
});

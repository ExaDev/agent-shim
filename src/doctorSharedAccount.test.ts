import { describe, expect, it } from "vitest";
import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor, identity } from "./doctorTestFixtures";

const EXAMPLE_ACCOUNT = { accountUuid: "account-1", organizationUuid: "org-1", emailAddress: "alex@example.com", organizationName: "Example Org" };

/** Findings of the sign-in section that are about a shared login, as opposed to one identity's own sign-in state. */
function sharedFindings(report: ReturnType<typeof runDoctor>) {
  return findingsFor(report, "sign-in").filter((finding) => finding.subject === undefined);
}

describe("runDoctor: identities sharing a login", () => {
  it("warns, never fails, naming every identity that holds the same account in the same organisation", () => {
    const report = runDoctor(baseParams({ identities: [identity("first", { account: EXAMPLE_ACCOUNT }), identity("second", { account: EXAMPLE_ACCOUNT }), identity("third", { account: EXAMPLE_ACCOUNT })] }));
    const findings = sharedFindings(report);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warn");
    expect(findings[0]?.message).toContain("first, second and third");
    expect(findings[0]?.message).toContain("alex@example.com (Example Org)");
    expect(findings[0]?.message).toContain("agent-shim identity remove <name>");
    expect(report.ok).toBe(true);
  });

  it("reports each shared login once", () => {
    const other = { accountUuid: "account-2", organizationUuid: "org-2" };
    const report = runDoctor(
      baseParams({ identities: [identity("a", { account: EXAMPLE_ACCOUNT }), identity("b", { account: other }), identity("c", { account: EXAMPLE_ACCOUNT }), identity("d", { account: other })] }),
    );
    const findings = sharedFindings(report);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.message).toContain("a and c");
    expect(findings[1]?.message).toContain("b and d");
  });

  it("does not flag the same account in different organisations", () => {
    const report = runDoctor(baseParams({ identities: [identity("personal", { account: EXAMPLE_ACCOUNT }), identity("work", { account: { ...EXAMPLE_ACCOUNT, organizationUuid: "org-2" } })] }));
    expect(sharedFindings(report)).toEqual([]);
  });

  it("does not flag different accounts in the same organisation", () => {
    const report = runDoctor(baseParams({ identities: [identity("alex", { account: EXAMPLE_ACCOUNT }), identity("sam", { account: { ...EXAMPLE_ACCOUNT, accountUuid: "account-2" } })] }));
    expect(sharedFindings(report)).toEqual([]);
  });

  it("does not flag identities without account metadata", () => {
    const report = runDoctor(baseParams({ identities: [identity("first"), identity("second"), identity("third", { account: EXAMPLE_ACCOUNT })] }));
    expect(sharedFindings(report)).toEqual([]);
  });

  it("does not flag an identity that holds no stored login", () => {
    const report = runDoctor(baseParams({ identities: [identity("signed-in", { account: EXAMPLE_ACCOUNT }), identity("signed-out", { account: EXAMPLE_ACCOUNT, credentialsFilePresent: false })] }));
    expect(sharedFindings(report)).toEqual([]);
  });

  it("does not flag an identity that authenticates with its own credential block", () => {
    const withCredential = identity("token", { account: EXAMPLE_ACCOUNT, raw: JSON.stringify({ name: "token", credential: { sources: [{ literal: "placeholder" }] } }) });
    const report = runDoctor(baseParams({ identities: [identity("signed-in", { account: EXAMPLE_ACCOUNT }), withCredential] }));
    expect(sharedFindings(report)).toEqual([]);
  });
});

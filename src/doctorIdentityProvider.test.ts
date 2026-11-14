import { describe, expect, it } from "vitest";
import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor, identity, provider } from "./doctorTestFixtures";

describe("runDoctor: identity provider", () => {
  it("fails when provider names a provider that does not exist", () => {
    const report = runDoctor(
      baseParams({
        identities: [identity("minimax", { raw: JSON.stringify({ name: "minimax", allowAmbientCredential: false, provider: "ghost" }) })],
      }),
    );
    const [finding] = findingsFor(report, "identity");
    expect(finding?.severity).toBe("fail");
    expect(finding?.message).toBe('Identity "minimax" names provider "ghost" as its provider, but no such provider exists.');
  });

  it("passes when provider names a defined provider, or a former name of one", () => {
    const minimax = provider("minimax", { displayName: "MiniMax", baseUrl: "http://127.0.0.1:9", credential: { sources: [{ literal: "placeholder" }] } });
    const named = runDoctor(
      baseParams({
        identities: [identity("minimax", { raw: JSON.stringify({ name: "minimax", allowAmbientCredential: false, provider: "minimax" }) })],
        providers: [minimax],
      }),
    );
    expect(findingsFor(named, "identity")).toEqual([
      { section: "identity", subject: "minimax", severity: "pass", message: 'minimax is valid and authenticates with the credential of provider "minimax".' },
    ]);
    const former = runDoctor(
      baseParams({
        identities: [identity("minimax", { raw: JSON.stringify({ name: "minimax", allowAmbientCredential: false, provider: "mm" }) })],
        providers: [minimax],
        providerAliases: { path: "/state/provider-aliases.json", raw: JSON.stringify({ mm: "minimax" }) },
      }),
    );
    expect(findingsFor(former, "identity")[0]?.severity).toBe("pass");
  });
});

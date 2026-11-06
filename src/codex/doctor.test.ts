import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../doctorReport";
import { baseParams, findingsFor, identity } from "../doctorTestFixtures";
import type { RunPort } from "../launcher/ports";

describe("Codex identities", () => {
  it("validates Codex metadata without probing Claude's Keychain or claiming a Claude login", () => {
    const run = vi.fn<RunPort["run"]>().mockReturnValue({ status: 1, stdout: "", stderr: "" });
    const report = runDoctor(baseParams({ platform: "darwin", run: { run }, identities: [identity("codex-work", { raw: JSON.stringify({ name: "codex-work", agent: "codex" }) })] }));
    expect(findingsFor(report, "identity").some((finding) => finding.message.includes("valid Codex identity"))).toBe(true);
    expect(findingsFor(report, "sign-in")[0]?.message).toContain("run --agent codex @codex-work login status");
    expect(findingsFor(report, "keychain")).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

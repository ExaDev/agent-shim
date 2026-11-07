import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor } from "./doctorTestFixtures";

describe("runDoctor: ambient-credential inside a session another launch started", () => {
  const injected = (token: string): Record<string, string> => ({
    CLAUDE_CODE_OAUTH_TOKEN: token,
    AGENT_SHIM_INJECTED: JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: createHash("sha256").update("oauth-work-token").digest("hex") }),
  });

  it("passes for a credential the parent launcher injected", () => {
    const [finding] = findingsFor(runDoctor(baseParams({ env: injected("oauth-work-token") })), "ambient-credential");
    expect(finding?.severity).toBe("pass");
  });

  it("still warns for a credential the person set in its place", () => {
    const [finding] = findingsFor(runDoctor(baseParams({ env: injected("set-by-the-person") })), "ambient-credential");
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

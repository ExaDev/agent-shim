import { describe, expect, it } from "vitest";

import { identityLaunchArgv } from "./identityClaude";

describe("identityLaunchArgv", () => {
  it("selects the identity and forces its own account ahead of the caller's flags, so no configured provider can receive an unattended run", () => {
    expect(identityLaunchArgv("work", ["--no-headroom", "--track-usage"])).toEqual(["@work", "--no-provider", "--no-headroom", "--track-usage"]);
    expect(identityLaunchArgv("work", [])).toContain("--no-provider");
  });
});

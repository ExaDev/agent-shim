import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentShimHome, resolveLayoutPaths, type LayoutPaths } from "./paths";

/** Every path field of a `LayoutPaths`, listed explicitly rather than via `Object.values` — `LayoutPaths` has no index signature, so `Object.values` on it falls back to `any[]`. */
function layoutPathValues(layout: LayoutPaths): readonly string[] {
  return [
    layout.root,
    layout.identitiesDir,
    layout.configProfilesDir,
    layout.directoryRulesFile,
    layout.activeIdentityFile,
    layout.globalConfigFile,
    layout.categoriesLocalFile,
    layout.claudeShimFile,
  ];
}

// The other tests of this module are cases of the conformance corpus (conformance/function/paths.json). These two read the process environment the test run was started with, which no case can hold.

describe("resolveAgentShimHome", () => {
  it("reads AGENT_SHIM_HOME from the environment", () => {
    // vitest.config.ts sets AGENT_SHIM_HOME globally for every test in this project.
    expect(resolveAgentShimHome()).toBe(process.env.AGENT_SHIM_HOME);
  });
});

describe("resolveLayoutPaths", () => {
  it("resolves every path under the test-scoped AGENT_SHIM_HOME root", () => {
    const layout = resolveLayoutPaths();
    const home = process.env.AGENT_SHIM_HOME;
    if (home === undefined) {
      throw new Error("Expected AGENT_SHIM_HOME to be set by vitest.config.ts's test-scoped setup.");
    }
    expect(layout.root).toBe(home);

    for (const value of layoutPathValues(layout)) {
      expect(path.resolve(value).startsWith(path.resolve(home))).toBe(true);
    }
  });
});

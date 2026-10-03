import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLayoutPaths, resolveAgentShimHome, resolveLayoutPaths, type LayoutPaths } from "./paths";

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

describe("resolveAgentShimHome", () => {
  it("reads AGENT_SHIM_HOME from the environment", () => {
    // vitest.config.ts sets AGENT_SHIM_HOME globally for every test in this project.
    expect(resolveAgentShimHome()).toBe(process.env.AGENT_SHIM_HOME);
  });

  it("prefers AGENT_SHIM_HOME over any directory under the home directory", () => {
    expect(resolveAgentShimHome({ AGENT_SHIM_HOME: "/elsewhere" }, "/home/u", () => true)).toBe("/elsewhere");
  });

  it("treats an empty AGENT_SHIM_HOME as unset", () => {
    expect(resolveAgentShimHome({ AGENT_SHIM_HOME: "" }, "/home/u", () => false)).toBe(path.join("/home/u", ".agent-shim"));
  });

  it("uses ~/.agent-shim on a fresh installation", () => {
    expect(resolveAgentShimHome({}, "/home/u", () => false)).toBe(path.join("/home/u", ".agent-shim"));
  });

  it("adopts an existing ~/.claude-use in place when ~/.agent-shim does not exist", () => {
    const legacy = path.join("/home/u", ".claude-use");
    expect(resolveAgentShimHome({}, "/home/u", (candidate) => candidate === legacy)).toBe(legacy);
  });

  it("prefers ~/.agent-shim when both directories exist", () => {
    expect(resolveAgentShimHome({}, "/home/u", () => true)).toBe(path.join("/home/u", ".agent-shim"));
  });
});

describe("buildLayoutPaths", () => {
  const root = "/tmp/some-throwaway-root";
  const layout = buildLayoutPaths(root);

  it("derives every sub-path under the given root", () => {
    for (const value of layoutPathValues(layout)) {
      expect(path.resolve(value).startsWith(path.resolve(root))).toBe(true);
    }
  });

  it("names the identities directory", () => {
    expect(layout.identitiesDir).toBe(path.join(root, "identities"));
  });

  it("names the config-profiles directory", () => {
    expect(layout.configProfilesDir).toBe(path.join(root, "config-profiles"));
  });

  it("names the directory-rules.json file", () => {
    expect(layout.directoryRulesFile).toBe(path.join(root, "directory-rules.json"));
  });

  it("names the active-identity file", () => {
    expect(layout.activeIdentityFile).toBe(path.join(root, "active-identity"));
  });

  it("names the global config.json file", () => {
    expect(layout.globalConfigFile).toBe(path.join(root, "config.json"));
  });

  it("names the categories.local.json file", () => {
    expect(layout.categoriesLocalFile).toBe(path.join(root, "categories.local.json"));
  });

  it("names the claude-shim.json file", () => {
    expect(layout.claudeShimFile).toBe(path.join(root, "claude-shim.json"));
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

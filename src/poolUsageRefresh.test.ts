import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addDirectoryRule } from "./directoryRulesStore";
import { addIdentity } from "./identityStore";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import { addPool } from "./poolStore";
import { poolSelectedByLaunch, refreshPoolUsage } from "./poolUsageRefresh";
import type { AnthropicUsageRefresher } from "./usage/anthropicUsageRefresh";
import type { PoolMember } from "./usage/pick";

describe("pool usage refresh", () => {
  let root: string;
  let project: string;
  let claudeHome: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-refresh-"));
    project = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-project-"));
    claudeHome = nodeFs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-claude-"));
    vi.stubEnv("AGENT_SHIM_CLAUDE_HOME", claudeHome);
    paths = buildLayoutPaths(root);
    for (const name of ["work", "personal", "extra"]) {
      addIdentity(paths, name);
    }
    addPool(paths, "main", ["work", "personal"]);
    addPool(paths, "outer", ["pool:main", "extra"]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of [root, project, claudeHome]) {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A refresher that records the identities of each batch it is asked to refresh. */
  function recordingRefresher(): { readonly refresher: AnthropicUsageRefresher; readonly batches: string[][] } {
    const batches: string[][] = [];
    const refresher: AnthropicUsageRefresher = {
      refresh: vi.fn(),
      refreshStale: async (members: readonly PoolMember[]) => {
        batches.push(members.map((member) => member.identity));
        await Promise.resolve();
      },
    };
    return { refresher, batches };
  }

  describe("poolSelectedByLaunch", () => {
    const select = (env: Readonly<Record<string, string | undefined>>, argv: readonly string[]): string | undefined => poolSelectedByLaunch({ paths, cwd: project, env, argv });

    it("names the pool the command line, the environment or a directory rule selects, by the launcher's precedence", () => {
      expect(select({}, ["@pool:main", "--print"])).toBe("main");
      expect(select({ AGENT_SHIM_IDENTITY: "pool:outer" }, ["--print"])).toBe("outer");
      addDirectoryRule(paths, project, { identity: "pool:main" });
      expect(select({}, ["--print"])).toBe("main");
      expect(select({ AGENT_SHIM_IDENTITY: "pool:outer" }, ["--print"])).toBe("outer");
      expect(select({ AGENT_SHIM_IDENTITY: "pool:outer" }, ["@pool:main"])).toBe("main");
    });

    it("names none for a launch that selects an identity, none, or the escape hatch", () => {
      addDirectoryRule(paths, project, { identity: "pool:main" });
      expect(select({}, ["@work"])).toBeUndefined();
      expect(select({ CLAUDE_CONFIG_DIR: "/elsewhere" }, ["--print"])).toBeUndefined();
      nodeFs.rmSync(paths.directoryRulesFile);
      expect(select({}, ["--print"])).toBeUndefined();
    });
  });

  describe("refreshPoolUsage", () => {
    it("asks the refresher about every identity of the named pool and of the pools it nests, each once", async () => {
      const { refresher, batches } = recordingRefresher();
      await refreshPoolUsage({ paths, cwd: project, poolNames: ["outer"], refresher });
      expect(batches).toHaveLength(1);
      expect([...(batches[0] ?? [])].sort()).toEqual(["extra", "personal", "work"]);
    });

    it("refreshes nothing, and builds nothing, when no pool is named", async () => {
      const { refresher, batches } = recordingRefresher();
      await refreshPoolUsage({ paths, cwd: project, poolNames: [], refresher });
      expect(batches).toEqual([]);
    });
  });
});

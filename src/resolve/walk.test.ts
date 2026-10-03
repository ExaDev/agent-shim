import { describe, expect, it } from "vitest";

import type { ConfigProfile } from "../config/schema";
import { FAKE_HOME } from "../test-helpers";
import type { ProfileLoader } from "./extends";
import { assembleCascade, walkDirectoryAncestors, type DirectoryLevelSources } from "./walk";

function loader(profiles: Readonly<Record<string, ConfigProfile>>): ProfileLoader {
  return (name) => {
    const profile = profiles[name];
    return profile === undefined ? undefined : { name, profile };
  };
}

describe("walkDirectoryAncestors", () => {
  it("returns the working directory and every ancestor, shallowest-first", () => {
    expect(walkDirectoryAncestors(`${FAKE_HOME}/work/clients/acme`, { home: FAKE_HOME })).toEqual([
      FAKE_HOME,
      `${FAKE_HOME}/work`,
      `${FAKE_HOME}/work/clients`,
      `${FAKE_HOME}/work/clients/acme`,
    ]);
  });

  it("stops at, and includes, the limit directory", () => {
    expect(walkDirectoryAncestors(`${FAKE_HOME}/work/clients`, { home: FAKE_HOME, limit: `${FAKE_HOME}/work` })).toEqual([
      `${FAKE_HOME}/work`,
      `${FAKE_HOME}/work/clients`,
    ]);
  });

  it("returns just the working directory when it is the limit", () => {
    expect(walkDirectoryAncestors(FAKE_HOME, { home: FAKE_HOME })).toEqual([FAKE_HOME]);
  });

  it("stops at the filesystem root when the working directory is not beneath the limit at all", () => {
    const walked = walkDirectoryAncestors("/var/tmp/scratch", { home: FAKE_HOME });
    expect(walked[0]).toBe("/");
    expect(walked.at(-1)).toBe("/var/tmp/scratch");
  });

  it("stops at an unreadable ancestor rather than failing the launch", () => {
    const walked = walkDirectoryAncestors(`${FAKE_HOME}/work/clients/acme`, {
      home: FAKE_HOME,
      isReadable: (dir) => dir !== `${FAKE_HOME}/work`,
    });
    expect(walked).toEqual([`${FAKE_HOME}/work/clients`, `${FAKE_HOME}/work/clients/acme`]);
  });

  it("returns nothing when the working directory itself is unreadable", () => {
    expect(walkDirectoryAncestors(`${FAKE_HOME}/secret`, { home: FAKE_HOME, isReadable: () => false })).toEqual([]);
  });
});

describe("assembleCascade layer ordering", () => {
  const load = loader({ base: {}, work: { extends: ["base"] }, strict: {} });

  it("puts the global config first, the base profile chain next, then directory levels, then CLI overrides", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${FAKE_HOME}/work`, portable: { config: { categories: { history: true } }, filepath: `${FAKE_HOME}/work/.agent-shim.json` } },
    ];
    const assembled = assembleCascade({
      home: FAKE_HOME,
      globalConfig: { config: { categories: { knowledge: true } }, filepath: "/cfg/config.json" },
      baseConfigProfile: "work",
      loadProfile: load,
      levels,
      cliOverride: { categories: { history: false } },
    });
    expect(assembled.layers.map((layer) => layer.kind)).toEqual([
      "global-config",
      "config-profile",
      "config-profile",
      "portable",
      "cli-override",
    ]);
    // Ordinal layer ids, assigned in cascade order: global config, the two-deep base-then-directory config-profile chain, the portable file, then the CLI override.
    const globalLayerId = 0;
    const baseProfileLayerId = 1;
    const directoryProfileLayerId = 2;
    const portableLayerId = 3;
    const cliOverrideLayerId = 4;
    expect(assembled.layers.map((layer) => layer.id)).toEqual([
      globalLayerId,
      baseProfileLayerId,
      directoryProfileLayerId,
      portableLayerId,
      cliOverrideLayerId,
    ]);
  });

  it("folds a level's three sources most-personal-last: committed file, then this user's rules, then the local override", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${FAKE_HOME}/work`,
        portable: { config: {}, filepath: "committed" },
        rules: [{ rule: { path: `${FAKE_HOME}/work` }, filepath: "rules" }],
        portableLocal: { config: {}, filepath: "local" },
      },
    ];
    const assembled = assembleCascade({ home: FAKE_HOME, loadProfile: load, levels });
    expect(assembled.layers.map((layer) => layer.source)).toEqual(["committed", "rules", "local"]);
  });

  it("keeps the whole shallowest-to-deepest walk as one continuous sequence, not gathered per source across the tree", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${FAKE_HOME}/work`, portable: { config: {}, filepath: "shallow-committed" }, portableLocal: { config: {}, filepath: "shallow-local" } },
      { dir: `${FAKE_HOME}/work/acme`, portable: { config: {}, filepath: "deep-committed" } },
    ];
    const assembled = assembleCascade({ home: FAKE_HOME, loadProfile: load, levels });
    expect(assembled.layers.map((layer) => layer.source)).toEqual(["shallow-committed", "shallow-local", "deep-committed"]);
  });

  it("preserves the file order of several rules matching the same directory", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${FAKE_HOME}/work`,
        rules: [
          { rule: { path: `${FAKE_HOME}/work` }, filepath: "rule-1" },
          { rule: { path: `${FAKE_HOME}/work` }, filepath: "rule-2" },
        ],
      },
    ];
    expect(assembleCascade({ home: FAKE_HOME, loadProfile: load, levels }).layers.map((layer) => layer.source)).toEqual([
      "rule-1",
      "rule-2",
    ]);
  });
});

describe("assembleCascade profile composition", () => {
  const load = loader({
    "work-default": { categories: { history: true } },
    "client-strict": { extends: ["work-default"], categories: { history: false } },
  });

  it("composes a level's selected profile in before that level's own inline overrides, rather than swapping it in wholesale", () => {
    const levels: DirectoryLevelSources[] = [
      {
        dir: `${FAKE_HOME}/work`,
        rules: [
          {
            rule: { path: `${FAKE_HOME}/work`, configProfile: "client-strict", entries: { "knowledge/skills/commit": true } },
            filepath: "rules",
          },
        ],
      },
    ];
    const assembled = assembleCascade({ home: FAKE_HOME, loadProfile: load, levels });
    expect(assembled.layers.map((layer) => layer.source)).toEqual(["work-default", "client-strict", "rules"]);
    expect(assembled.layers.at(-1)?.entries).toEqual({ "knowledge/skills/commit": true });
  });

  it("reports a missing profile named by a directory rule", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${FAKE_HOME}/work`, rules: [{ rule: { path: `${FAKE_HOME}/work`, configProfile: "gone" }, filepath: "rules" }] },
    ];
    const assembled = assembleCascade({ home: FAKE_HOME, loadProfile: load, levels });
    expect(assembled.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["MISSING_PROFILE"]);
  });
});

describe("assembleCascade pins", () => {
  const load = loader({});

  it("reports the deepest identity pin, which the launcher uses as a safety net beneath an explicit @name", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${FAKE_HOME}/work`, rules: [{ rule: { path: `${FAKE_HOME}/work`, identity: "work" }, filepath: "a" }] },
      { dir: `${FAKE_HOME}/work/acme`, rules: [{ rule: { path: `${FAKE_HOME}/work/acme`, identity: "acme" }, filepath: "b" }] },
    ];
    expect(assembleCascade({ home: FAKE_HOME, loadProfile: load, levels }).identityPin).toBe("acme");
  });

  it("reports no identity pin when no level sets one", () => {
    expect(assembleCascade({ home: FAKE_HOME, loadProfile: load, levels: [{ dir: FAKE_HOME }] }).identityPin).toBeUndefined();
  });

  it("reports the deepest directory-level profile selection", () => {
    const levels: DirectoryLevelSources[] = [
      { dir: `${FAKE_HOME}/work`, portable: { config: { configProfile: "a" }, filepath: "a" } },
      { dir: `${FAKE_HOME}/work/acme`, portable: { config: { configProfile: "b" }, filepath: "b" } },
    ];
    expect(assembleCascade({ home: FAKE_HOME, loadProfile: loader({ a: {}, b: {} }), levels }).directoryConfigProfile).toBe("b");
  });
});

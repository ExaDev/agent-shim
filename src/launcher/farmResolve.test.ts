import { describe, expect, it } from "vitest";

import { createFakeFarmFs, FAKE_HOME, shippedClassification } from "../test-helpers";
import { resolveFarmConflicts, type FarmConflict, type FarmConflictChoice } from "./farmResolve";

const IDENTITIES_DIR = `${FAKE_HOME}/.agent-shim/identities`;
const FARM = `${IDENTITIES_DIR}/work`;
const PREVIOUS = `${IDENTITIES_DIR}/.work.previous.crashed`;

/** Always answers with the same fixed choice, regardless of which conflict is asked about. */
function fixedAnswer(choice: FarmConflictChoice): (conflict: FarmConflict) => Promise<FarmConflictChoice> {
  return async () => Promise.resolve(choice);
}

describe("resolveFarmConflicts", () => {
  it("reports nothing to resolve when there is no superseded farm at all", async () => {
    const fs = createFakeFarmFs({ [`${FARM}/settings.json`]: "{}" });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("skip"),
    });

    expect(result).toEqual({ resolved: [], autoResolved: [], removed: [], retained: [] });
  });

  it("carries over non-colliding data and removes the superseded farm without asking anything", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${PREVIOUS}/todos.json`]: "old todos",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("skip"),
    });

    expect(result.resolved).toEqual([]);
    expect(result.removed).toEqual([PREVIOUS]);
    expect(result.retained).toEqual([]);
    expect(fs.readFileUtf8(`${FARM}/todos.json`)).toBe("old todos");
    expect(fs.lstat(PREVIOUS)).toBeUndefined();
  });

  it("keeps the current farm's copy and discards the superseded one on keep-new", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${PREVIOUS}/settings.json`]: "old",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("keep-new"),
    });

    expect(result.resolved).toEqual([{ previousRoot: PREVIOUS, farmRoot: FARM, name: "settings.json", choice: "keep-new" }]);
    expect(result.removed).toEqual([PREVIOUS]);
    expect(result.retained).toEqual([]);
    expect(fs.readFileUtf8(`${FARM}/settings.json`)).toBe("new");
    expect(fs.lstat(PREVIOUS)).toBeUndefined();
  });

  it("keeps the superseded farm's copy and replaces the current one on keep-old", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${PREVIOUS}/settings.json`]: "old",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("keep-old"),
    });

    expect(result.resolved).toEqual([{ previousRoot: PREVIOUS, farmRoot: FARM, name: "settings.json", choice: "keep-old" }]);
    expect(result.removed).toEqual([PREVIOUS]);
    expect(fs.readFileUtf8(`${FARM}/settings.json`)).toBe("old");
    expect(fs.lstat(PREVIOUS)).toBeUndefined();
  });

  it("leaves both copies and retains the superseded farm on skip", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${PREVIOUS}/settings.json`]: "old",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("skip"),
    });

    expect(result.resolved).toEqual([{ previousRoot: PREVIOUS, farmRoot: FARM, name: "settings.json", choice: "skip" }]);
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([PREVIOUS]);
    expect(fs.readFileUtf8(`${FARM}/settings.json`)).toBe("new");
    expect(fs.readFileUtf8(`${PREVIOUS}/settings.json`)).toBe("old");
  });

  it("resolves every retained previous farm across multiple prior launches, in sorted order", async () => {
    const previousA = `${IDENTITIES_DIR}/.work.previous.111.a`;
    const previousB = `${IDENTITIES_DIR}/.work.previous.222.b`;
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${previousA}/settings.json`]: "old-a",
      [`${previousB}/settings.json`]: "old-b",
    });

    const seen: string[] = [];
    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: async (conflict) => {
        seen.push(conflict.previousRoot);
        return Promise.resolve("keep-new");
      },
    });

    expect(seen).toEqual([previousA, previousB]);
    expect(result.removed).toEqual([previousA, previousB]);
    expect(result.retained).toEqual([]);
  });

  it("only retains the previous farms with a skipped conflict, removing the rest", async () => {
    const previousA = `${IDENTITIES_DIR}/.work.previous.111.a`;
    const previousB = `${IDENTITIES_DIR}/.work.previous.222.b`;
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new",
      [`${previousA}/settings.json`]: "old-a",
      [`${previousB}/settings.json`]: "old-b",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: async (conflict) => Promise.resolve(conflict.previousRoot === previousA ? "skip" : "keep-new"),
    });

    expect(result.removed).toEqual([previousB]);
    expect(result.retained).toEqual([previousA]);
  });

  it("auto-resolves a runtime-category collision without ever calling decide, and removes the superseded farm once nothing else remains", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/mcp-needs-auth-cache.json`]: "new",
      [`${PREVIOUS}/mcp-needs-auth-cache.json`]: "stale, from a crashed launch",
    });

    let decideCalls = 0;
    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      classification: { defaults: shippedClassification },
      decide: async () => {
        decideCalls += 1;
        return Promise.resolve("skip");
      },
    });

    expect(decideCalls).toBe(0);
    expect(result.resolved).toEqual([]);
    expect(result.autoResolved).toEqual(["mcp-needs-auth-cache.json"]);
    expect(result.removed).toEqual([PREVIOUS]);
    expect(result.retained).toEqual([]);
    expect(fs.readFileUtf8(`${FARM}/mcp-needs-auth-cache.json`)).toBe("new");
  });

  it("auto-resolves a runtime collision but still asks about a genuine one alongside it in the same superseded farm, retaining the directory until that one is decided", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/settings.json`]: "new settings",
      [`${PREVIOUS}/settings.json`]: "old settings",
      [`${FARM}/mcp-needs-auth-cache.json`]: "new",
      [`${PREVIOUS}/mcp-needs-auth-cache.json`]: "stale",
    });

    const seen: string[] = [];
    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      classification: { defaults: shippedClassification },
      decide: async (conflict) => {
        seen.push(conflict.name);
        return Promise.resolve("skip");
      },
    });

    expect(seen).toEqual(["settings.json"]);
    expect(result.autoResolved).toEqual(["mcp-needs-auth-cache.json"]);
    expect(result.resolved).toEqual([{ previousRoot: PREVIOUS, farmRoot: FARM, name: "settings.json", choice: "skip" }]);
    expect(result.retained).toEqual([PREVIOUS]);
    expect(fs.lstat(`${PREVIOUS}/mcp-needs-auth-cache.json`)).toBeUndefined();
    expect(fs.readFileUtf8(`${PREVIOUS}/settings.json`)).toBe("old settings");
  });

  it("falls back to asking about a runtime-category collision when no classification is given at all", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/mcp-needs-auth-cache.json`]: "new",
      [`${PREVIOUS}/mcp-needs-auth-cache.json`]: "stale",
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("keep-new"),
    });

    expect(result.autoResolved).toEqual([]);
    expect(result.resolved).toEqual([{ previousRoot: PREVIOUS, farmRoot: FARM, name: "mcp-needs-auth-cache.json", choice: "keep-new" }]);
  });

  it("never asks about a directory the manifest recorded as materialised by the prior resync", async () => {
    const fs = createFakeFarmFs({
      [`${FARM}/projects`]: { dir: true },
      [`${PREVIOUS}/projects`]: { dir: true },
      [`${PREVIOUS}/.agent-shim-farm.json`]: JSON.stringify({
        version: 1,
        builtAtMs: 1_000,
        identity: "work",
        cwd: `${FAKE_HOME}/work`,
        claudeHome: `${FAKE_HOME}/.claude`,
        materialised: ["projects"],
        links: [],
      }),
    });

    const result = await resolveFarmConflicts({
      fs,
      identitiesDir: IDENTITIES_DIR,
      identity: "work",
      decide: fixedAnswer("skip"),
    });

    expect(result.resolved).toEqual([]);
    expect(result.removed).toEqual([PREVIOUS]);
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFakeFarmFs, fakeSleep, FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, shippedClassification, type FakeFarmFs } from "../test-helpers";
import type { CascadeInput } from "../resolve/walk";
import { FARM_MANIFEST_FILENAME, readFarmManifest, recoveryDiagnostics, resyncFarm, type RecoveryResult, type ResyncFarmParams } from "./farm";
import { IdentityLockBusyError, identityLockPath } from "./lock";

const IDENTITIES_DIR = `${FAKE_HOME}/.claude-use/identities`;
const FARM = `${IDENTITIES_DIR}/work`;

/** A canonical `~/.claude` covering one entry from each category that matters: shared knowledge, shared settings, shared history, and an unshareable secret. */
const CANONICAL = {
  [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit skill",
  [`${FAKE_CLAUDE_HOME}/skills/review/SKILL.md`]: "review skill",
  [`${FAKE_CLAUDE_HOME}/settings.json`]: "{}",
  [`${FAKE_CLAUDE_HOME}/projects/-home-testuser-work/session.jsonl`]: "session",
  [`${FAKE_CLAUDE_HOME}/.credentials.json`]: "a real token",
} as const;

function cascade(override?: CascadeInput["cliOverride"]): CascadeInput {
  return {
    home: FAKE_HOME,
    loadProfile: () => undefined,
    levels: [],
    ...(override === undefined ? {} : { cliOverride: override }),
  };
}

function params(fs: FakeFarmFs, overrides: Partial<ResyncFarmParams> = {}): ResyncFarmParams {
  return {
    fs,
    identitiesDir: IDENTITIES_DIR,
    identity: "work",
    claudeHome: FAKE_CLAUDE_HOME,
    home: FAKE_HOME,
    cwd: `${FAKE_HOME}/work`,
    env: {},
    cascade: cascade(),
    classification: { defaults: shippedClassification },
    now: () => FAKE_NOW_MS,
    uniqueSuffix: "test",
    lock: { pid: 42, isRunning: () => true, sleep: fakeSleep().sleep },
    ...overrides,
  };
}

/** Every mutating operation except the lock file's own create and delete, which happen on every resync by design and are not farm writes. */
function farmWrites(fs: FakeFarmFs): string[] {
  return fs.writes.filter((write) => !write.path.includes(".lock")).map((write) => `${write.op} ${write.path}`);
}

describe("resyncFarm", () => {
  it("builds a farm from nothing, sharing knowledge, settings, and history while omitting secrets", () => {
    const fs = createFakeFarmFs(CANONICAL);

    const result = resyncFarm(params(fs));

    expect(result.noOp).toBe(false);
    expect(fs.linkTarget(`${FARM}/skills`)).toBe(`${FAKE_CLAUDE_HOME}/skills`);
    expect(fs.linkTarget(`${FARM}/settings.json`)).toBe(`${FAKE_CLAUDE_HOME}/settings.json`);
    expect(fs.linkTarget(`${FARM}/projects`)).toBe(`${FAKE_CLAUDE_HOME}/projects`);
    expect(fs.lstat(`${FARM}/.credentials.json`)).toBeUndefined();

    const manifest = readFarmManifest(fs, FARM);
    expect(manifest?.identity).toBe("work");
    expect(manifest?.links.map((link) => link.rel).sort()).toEqual(["projects", "settings.json", "skills"]);
    expect(manifest?.materialised).toEqual([]);
  });

  it("says nothing about a missing manifest on a first launch, where there has never been one to lose", () => {
    const fs = createFakeFarmFs({ ...CANONICAL, [`${FARM}/identity.json`]: '{"name":"work"}' });

    const result = resyncFarm(params(fs));

    expect(result.diagnostics).toEqual([]);
    expect(fs.readFileUtf8(`${FARM}/identity.json`)).toBe('{"name":"work"}');
  });

  it("writes nothing at all when the resolved decision already matches the farm's own manifest", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));

    fs.writes.length = 0;
    const second = resyncFarm(params(fs, { uniqueSuffix: "second", cwd: `${FAKE_HOME}/elsewhere` }));

    expect(second.noOp).toBe(true);
    expect(farmWrites(fs)).toEqual([]);
    // The launch still resolved a full cascade — the no-op is about writes, not about skipping work the launcher needs.
    expect(second.resolved.decisions.get("skills")?.shared).toBe(true);
  });

  it("rebuilds when a category toggle changes which entries are shared", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));

    const result = resyncFarm(
      params(fs, {
        uniqueSuffix: "second",
        cascade: cascade({ categories: { history: true, knowledge: false } }),
      }),
    );

    expect(result.noOp).toBe(false);
    expect(fs.linkTarget(`${FARM}/projects`)).toBe(`${FAKE_CLAUDE_HOME}/projects`);
    expect(fs.lstat(`${FARM}/skills`)).toBeUndefined();
    expect(fs.linkTarget(`${FARM}/settings.json`)).toBe(`${FAKE_CLAUDE_HOME}/settings.json`);
  });

  it("materialises a directory whose subtree decision is split, linking only the entry that was opened up", () => {
    const fs = createFakeFarmFs(CANONICAL);

    resyncFarm(
      params(fs, {
        cascade: cascade({ categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } }),
      }),
    );

    expect(fs.lstat(`${FARM}/skills`)?.kind).toBe("dir");
    expect(fs.linkTarget(`${FARM}/skills/commit`)).toBe(`${FAKE_CLAUDE_HOME}/skills/commit`);
    expect(fs.lstat(`${FARM}/skills/review`)).toBeUndefined();
    expect(readFarmManifest(fs, FARM)?.materialised).toEqual(["skills"]);
  });

  it("collapses a materialised directory back to one symlink once the split that caused it is gone", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(
      params(fs, {
        cascade: cascade({ categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } }),
      }),
    );

    resyncFarm(params(fs, { uniqueSuffix: "second" }));

    expect(fs.linkTarget(`${FARM}/skills`)).toBe(`${FAKE_CLAUDE_HOME}/skills`);
    expect(readFarmManifest(fs, FARM)?.materialised).toEqual([]);
  });

  it("adopts data Claude Code wrote into a materialised directory back into the canonical tree before re-deciding", () => {
    const fs = createFakeFarmFs(CANONICAL);
    const split = cascade({ categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } });
    resyncFarm(params(fs, { cascade: split }));

    // Claude Code creates a new skill inside the materialised directory, where it is invisible to every other identity.
    fs.seed({ [`${FARM}/skills/newthing/SKILL.md`]: "brand new" });

    const result = resyncFarm(params(fs, { uniqueSuffix: "second", cascade: split }));

    expect(result.adopted).toEqual(["skills/newthing/SKILL.md"]);
    expect(fs.readFileUtf8(`${FAKE_CLAUDE_HOME}/skills/newthing/SKILL.md`)).toBe("brand new");
    // Adopted in time to be resolved by this same resync, rather than only becoming visible on the next launch.
    expect(result.resolved.decisions.has("skills/newthing/SKILL.md")).toBe(true);
  });

  it("preserves a farm copy alongside the canonical one when the two differ, overwriting neither", () => {
    const fs = createFakeFarmFs(CANONICAL);
    const split = cascade({ categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } });
    resyncFarm(params(fs, { cascade: split }));
    fs.seed({ [`${FARM}/skills/review/SKILL.md`]: "diverged in the farm" });

    const result = resyncFarm(params(fs, { uniqueSuffix: "second", cascade: split }));

    expect(fs.readFileUtf8(`${FAKE_CLAUDE_HOME}/skills/review/SKILL.md`)).toBe("review skill");
    expect(fs.readFileUtf8(`${FAKE_CLAUDE_HOME}/skills/review/SKILL.md.farm-conflict-${String(FAKE_NOW_MS)}`)).toBe("diverged in the farm");
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "RECONCILE_CONFLICT")).toBe(true);
  });

  it("refuses to adopt a path classified secret, even in conservative mode with no manifest to go on", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    // A farm whose manifest was lost, holding both a secret and ordinary data written into it.
    fs.removeRecursive(`${FARM}/${FARM_MANIFEST_FILENAME}`);
    fs.seed({
      [`${FARM}/backups/leaked.json`]: "another identity's credentials",
      [`${FARM}/todos/local.json`]: "local todo",
    });

    const result = resyncFarm(params(fs, { uniqueSuffix: "second" }));

    expect(fs.lstat(`${FAKE_CLAUDE_HOME}/backups/leaked.json`)).toBeUndefined();
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "RECONCILE_SECRET_BLOCKED")).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "FARM_MANIFEST_MISSING")).toBe(true);
    expect(fs.readFileUtf8(`${FAKE_CLAUDE_HOME}/todos/local.json`)).toBe("local todo");
  });

  it("carries an identity's own locally-written state across the swap rather than replacing the directory wholesale", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    fs.seed({
      [`${FARM}/identity.json`]: '{"name":"work"}',
      [`${FARM}/.claude.json`]: '{"oauth":"local"}',
    });

    resyncFarm(params(fs, { uniqueSuffix: "second", cascade: cascade({ categories: { history: true } }) }));

    expect(fs.readFileUtf8(`${FARM}/identity.json`)).toBe('{"name":"work"}');
    expect(fs.readFileUtf8(`${FARM}/.claude.json`)).toBe('{"oauth":"local"}');
    expect(fs.linkTarget(`${FARM}/projects`)).toBe(`${FAKE_CLAUDE_HOME}/projects`);
    expect(fs.lstat(`${IDENTITIES_DIR}/.work.previous.second`)).toBeUndefined();
  });

  it("restores the farm and clears abandoned scratch trees after a crash between the two renames", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    fs.seed({ [`${FARM}/identity.json`]: '{"name":"work"}' });

    // Exactly what a crash between `rename(farm -> previous)` and `rename(scratch -> farm)` leaves behind: no farm, a complete superseded copy, and a half-built scratch tree from the run before it.
    fs.rename(FARM, `${IDENTITIES_DIR}/.work.previous.crashed`);
    fs.seed({ [`${IDENTITIES_DIR}/.work.scratch.abandoned/skills`]: { symlink: `${FAKE_CLAUDE_HOME}/skills` } });

    const result = resyncFarm(params(fs, { uniqueSuffix: "recovered" }));

    expect(result.recovery.restoredFrom).toBe(".work.previous.crashed");
    expect(result.recovery.removedScratch).toEqual([".work.scratch.abandoned"]);
    expect(fs.lstat(`${IDENTITIES_DIR}/.work.scratch.abandoned`)).toBeUndefined();
    expect(fs.readFileUtf8(`${FARM}/identity.json`)).toBe('{"name":"work"}');
    expect(fs.linkTarget(`${FARM}/skills`)).toBe(`${FAKE_CLAUDE_HOME}/skills`);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "FARM_SWAP_RECOVERED")).toBe(true);
  });

  it("finishes carrying local state out of a superseded farm left behind by a crash after the swap", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    // A crash after `rename(scratch -> farm)` but before carry-over: both directories exist and the identity's own file is still in the old one.
    fs.seed({ [`${IDENTITIES_DIR}/.work.previous.crashed/identity.json`]: '{"name":"work"}' });

    const result = resyncFarm(params(fs, { uniqueSuffix: "recovered" }));

    expect(result.recovery.completed).toEqual([".work.previous.crashed"]);
    expect(fs.readFileUtf8(`${FARM}/identity.json`)).toBe('{"name":"work"}');
    expect(fs.lstat(`${IDENTITIES_DIR}/.work.previous.crashed`)).toBeUndefined();
  });

  it("discards a runtime-category collision automatically rather than retaining the superseded farm for it", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    fs.seed({
      [`${FARM}/mcp-needs-auth-cache.json`]: "current",
      [`${IDENTITIES_DIR}/.work.previous.crashed/mcp-needs-auth-cache.json`]: "stale, from the crashed launch",
    });

    const result = resyncFarm(params(fs, { uniqueSuffix: "recovered" }));

    expect(result.recovery.autoResolved).toEqual(["mcp-needs-auth-cache.json"]);
    expect(result.recovery.retained).toEqual([]);
    expect(fs.lstat(`${IDENTITIES_DIR}/.work.previous.crashed`)).toBeUndefined();
    expect(fs.readFileUtf8(`${FARM}/mcp-needs-auth-cache.json`)).toBe("current");
  });

  it("keeps a superseded farm on disk rather than discarding data the new farm also has an entry for", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    fs.seed({ [`${IDENTITIES_DIR}/.work.previous.crashed/settings.json`]: "a real file, not a link" });

    const result = resyncFarm(params(fs, { uniqueSuffix: "recovered" }));

    expect(result.recovery.retained).toEqual([`${IDENTITIES_DIR}/.work.previous.crashed`]);
    expect(fs.readFileUtf8(`${IDENTITIES_DIR}/.work.previous.crashed/settings.json`)).toBe("a real file, not a link");
    expect(fs.linkTarget(`${FARM}/settings.json`)).toBe(`${FAKE_CLAUDE_HOME}/settings.json`);
  });

  it("serialises against a concurrent resync of the same identity instead of racing it", () => {
    const fs = createFakeFarmFs(CANONICAL);
    // Starts with history explicitly closed, so the toggle to `history: true` below is a real, observable change rather than a no-op against the shared-by-default state.
    resyncFarm(params(fs, { cascade: cascade({ categories: { history: false } }) }));

    // A sibling session holds the lock for the whole of its own resync.
    fs.mkdirp(IDENTITIES_DIR);
    fs.writeFileUtf8(
      identityLockPath(IDENTITIES_DIR, "work"),
      JSON.stringify({ identity: "work", pid: 99, token: "sibling", acquiredAtMs: FAKE_NOW_MS }),
    );
    fs.writes.length = 0;

    expect(() =>
      resyncFarm(
        params(fs, {
          uniqueSuffix: "blocked",
          cascade: cascade({ categories: { history: true } }),
          lock: { pid: 42, isRunning: () => true, sleep: fakeSleep().sleep, maxAttempts: 2 },
        }),
      ),
    ).toThrow(IdentityLockBusyError);
    expect(farmWrites(fs)).toEqual([]);
    expect(fs.lstat(`${FARM}/projects`)).toBeUndefined();

    // Once the sibling releases, the same resync goes through.
    fs.removeRecursive(identityLockPath(IDENTITIES_DIR, "work"));
    const result = resyncFarm(params(fs, { uniqueSuffix: "unblocked", cascade: cascade({ categories: { history: true } }) }));
    expect(result.noOp).toBe(false);
    expect(fs.linkTarget(`${FARM}/projects`)).toBe(`${FAKE_CLAUDE_HOME}/projects`);
  });

  it("releases the lock before returning, so the spawned binary never runs under a held lock", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    expect(fs.lstat(identityLockPath(IDENTITIES_DIR, "work"))).toBeUndefined();
  });

  it("leaves no scratch or superseded directory behind after a clean resync", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    resyncFarm(params(fs, { uniqueSuffix: "second", cascade: cascade({ categories: { history: true } }) }));

    const strays = fs
      .snapshot(IDENTITIES_DIR)
      .filter((entry) => path.basename(entry).startsWith(".work.") && path.dirname(entry) === IDENTITIES_DIR);
    expect(strays).toEqual([]);
  });
});

describe("recoveryDiagnostics", () => {
  const base: RecoveryResult = { removedScratch: [], completed: [], autoResolved: [], retained: [], recovered: false };

  it("reports nothing when recovery found nothing to do", () => {
    expect(recoveryDiagnostics(base, "work")).toEqual([]);
  });

  it("mentions what was auto-resolved, by name, distinctly from what still needs a human", () => {
    const [diagnostic] = recoveryDiagnostics(
      { ...base, recovered: true, autoResolved: ["mcp-needs-auth-cache.json"] },
      "work",
    );
    expect(diagnostic?.message).toContain("discarded 1 superseded runtime entry (mcp-needs-auth-cache.json)");
    expect(diagnostic?.message).not.toContain("identity resolve");
  });

  it("pluralises the count correctly for more than one auto-resolved entry", () => {
    const [diagnostic] = recoveryDiagnostics(
      { ...base, recovered: true, autoResolved: ["mcp-needs-auth-cache.json", ".last-cleanup"] },
      "work",
    );
    expect(diagnostic?.message).toContain("discarded 2 superseded runtime entries");
  });

  it("still points at identity resolve for a genuinely retained collision, alongside a separate auto-resolved one", () => {
    const [diagnostic] = recoveryDiagnostics(
      {
        ...base,
        recovered: true,
        autoResolved: ["mcp-needs-auth-cache.json"],
        retained: [`${IDENTITIES_DIR}/.work.previous.crashed`],
      },
      "work",
    );
    expect(diagnostic?.message).toContain("discarded 1 superseded runtime entry");
    expect(diagnostic?.message).toContain("claude-use identity resolve work");
  });
});

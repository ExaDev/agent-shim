import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFakeFarmFs, fakeSleep, FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, shippedClassification, type FakeFarmFs } from "../test-helpers";
import type { CascadeInput } from "../resolve/walk";
import { danglingFarmLinks, FARM_MANIFEST_FILENAME, IdentityGoneError, readFarmManifest, recoveryDiagnostics, resyncFarm, type RecoveryResult, type ResyncFarmParams } from "./farm";
import { IdentityLockBusyError, identityLockPath } from "./lock";

const IDENTITIES_DIR = `${FAKE_HOME}/.agent-shim/identities`;
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
    uniqueSuffix: "1111.11111111-0000-4000-8000-111111111111",
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
    const second = resyncFarm(params(fs, { uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222", cwd: `${FAKE_HOME}/elsewhere` }));

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
        uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222",
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

    resyncFarm(params(fs, { uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222" }));

    expect(fs.linkTarget(`${FARM}/skills`)).toBe(`${FAKE_CLAUDE_HOME}/skills`);
    expect(readFarmManifest(fs, FARM)?.materialised).toEqual([]);
  });

  it("adopts data Claude Code wrote into a materialised directory back into the canonical tree before re-deciding", () => {
    const fs = createFakeFarmFs(CANONICAL);
    const split = cascade({ categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } });
    resyncFarm(params(fs, { cascade: split }));

    // Claude Code creates a new skill inside the materialised directory, where it is invisible to every other identity.
    fs.seed({ [`${FARM}/skills/newthing/SKILL.md`]: "brand new" });

    const result = resyncFarm(params(fs, { uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222", cascade: split }));

    expect(result.adopted).toEqual(["skills/newthing/SKILL.md"]);
    expect(fs.readFileUtf8(`${FAKE_CLAUDE_HOME}/skills/newthing/SKILL.md`)).toBe("brand new");
    // Adopted in time to be resolved by this same resync, rather than only becoming visible on the next launch. No rule reaches inside the adopted directory, so it is one entry (omitted here, since only skills/commit is shared), not a record per file.
    expect(result.resolved.decisions.get("skills/newthing")?.shared).toBe(false);
    expect(result.resolved.farm.entries).toContainEqual({ kind: "omit", rel: "skills/newthing" });
  });

  it("preserves a farm copy alongside the canonical one when the two differ, overwriting neither", () => {
    const fs = createFakeFarmFs(CANONICAL);
    const split = cascade({ categories: { knowledge: false }, entries: { "knowledge/skills/commit": true } });
    resyncFarm(params(fs, { cascade: split }));
    fs.seed({ [`${FARM}/skills/review/SKILL.md`]: "diverged in the farm" });

    const result = resyncFarm(params(fs, { uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222", cascade: split }));

    expect(fs.readFileUtf8(`${FAKE_CLAUDE_HOME}/skills/review/SKILL.md`)).toBe("review skill");
    expect(fs.readFileUtf8(`${FAKE_CLAUDE_HOME}/skills/review/SKILL.md.farm-conflict-${String(FAKE_NOW_MS)}`)).toBe("diverged in the farm");
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "RECONCILE_CONFLICT")).toBe(true);
  });

  it("reads a manifest written under the former name, writes the current name on resync, and does not carry the former file forward", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    const current = fs.readFileUtf8(`${FARM}/${FARM_MANIFEST_FILENAME}`);
    fs.removeRecursive(`${FARM}/${FARM_MANIFEST_FILENAME}`);
    fs.seed({ [`${FARM}/.claude-use-farm.json`]: current ?? "" });
    expect(readFarmManifest(fs, FARM)?.identity).toBe("work");

    const result = resyncFarm(params(fs, { uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222", cascade: cascade({ categories: { history: false } }) }));

    expect(result.noOp).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "FARM_MANIFEST_MISSING")).toBe(false);
    expect(fs.readFileUtf8(`${FARM}/${FARM_MANIFEST_FILENAME}`)).toBeDefined();
    expect(fs.lstat(`${FARM}/.claude-use-farm.json`)).toBeUndefined();
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

    const result = resyncFarm(params(fs, { uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222" }));

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

    resyncFarm(params(fs, { uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222", cascade: cascade({ categories: { history: true } }) }));

    expect(fs.readFileUtf8(`${FARM}/identity.json`)).toBe('{"name":"work"}');
    expect(fs.readFileUtf8(`${FARM}/.claude.json`)).toBe('{"oauth":"local"}');
    expect(fs.linkTarget(`${FARM}/projects`)).toBe(`${FAKE_CLAUDE_HOME}/projects`);
    expect(fs.lstat(`${IDENTITIES_DIR}/.work.previous.2222.22222222-0000-4000-8000-222222222222`)).toBeUndefined();
  });

  it("restores the farm and clears abandoned scratch trees after a crash between the two renames", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    fs.seed({ [`${FARM}/identity.json`]: '{"name":"work"}' });

    // Exactly what a crash between `rename(farm -> previous)` and `rename(scratch -> farm)` leaves behind: no farm, a complete superseded copy, and a half-built scratch tree from the run before it.
    fs.rename(FARM, `${IDENTITIES_DIR}/.work.previous.4444.44444444-0000-4000-8000-444444444444`);
    fs.seed({ [`${IDENTITIES_DIR}/.work.scratch.5555.55555555-0000-4000-8000-555555555555/skills`]: { symlink: `${FAKE_CLAUDE_HOME}/skills` } });

    const result = resyncFarm(params(fs, { uniqueSuffix: "3333.33333333-0000-4000-8000-333333333333" }));

    expect(result.recovery.restoredFrom).toBe(".work.previous.4444.44444444-0000-4000-8000-444444444444");
    expect(result.recovery.removedScratch).toEqual([".work.scratch.5555.55555555-0000-4000-8000-555555555555"]);
    expect(fs.lstat(`${IDENTITIES_DIR}/.work.scratch.5555.55555555-0000-4000-8000-555555555555`)).toBeUndefined();
    expect(fs.readFileUtf8(`${FARM}/identity.json`)).toBe('{"name":"work"}');
    expect(fs.linkTarget(`${FARM}/skills`)).toBe(`${FAKE_CLAUDE_HOME}/skills`);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "FARM_SWAP_RECOVERED")).toBe(true);
  });

  it("restores the superseded farm that holds identity.json, not an older retained one that sorts first by its pid", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    fs.seed({ [`${FARM}/identity.json`]: '{"name":"work"}' });
    // A farm retained from an earlier swap for its conflicts, whose pid sorts first as text, and the farm the killed swap moved aside.
    fs.seed({ [`${IDENTITIES_DIR}/.work.previous.1.11111111-0000-4000-8000-111111111111/notes.txt`]: "STALE" });
    fs.rename(FARM, `${IDENTITIES_DIR}/.work.previous.9.99999999-0000-4000-8000-999999999999`);

    const result = resyncFarm(params(fs, { uniqueSuffix: "3333.33333333-0000-4000-8000-333333333333" }));

    expect(result.recovery.restoredFrom).toBe(".work.previous.9.99999999-0000-4000-8000-999999999999");
    expect(fs.readFileUtf8(`${FARM}/identity.json`)).toBe('{"name":"work"}');
  });

  it("touches only its own farms, never those of an identity whose id begins with its id and a farm word", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    fs.seed({ [`${FARM}/identity.json`]: '{"name":"work"}' });
    // Identities stored under work.scratch.x and work.previous.y, with their resync locks, which a prefix match would take for work's farms.
    fs.seed({
      [`${IDENTITIES_DIR}/work.scratch.x/identity.json`]: '{"name":"one"}',
      [`${IDENTITIES_DIR}/work.previous.y/identity.json`]: '{"name":"two"}',
      [`${IDENTITIES_DIR}/.work.scratch.x.lock`]: '{"held":true}',
      [`${IDENTITIES_DIR}/.work.previous.y.lock`]: '{"held":true}',
    });
    fs.rename(FARM, `${IDENTITIES_DIR}/.work.previous.9.99999999-0000-4000-8000-999999999999`);

    const result = resyncFarm(params(fs, { uniqueSuffix: "3333.33333333-0000-4000-8000-333333333333" }));

    expect(result.recovery.removedScratch).toEqual([]);
    expect(result.recovery.restoredFrom).toBe(".work.previous.9.99999999-0000-4000-8000-999999999999");
    expect(fs.readFileUtf8(`${IDENTITIES_DIR}/.work.scratch.x.lock`)).toBe('{"held":true}');
    expect(fs.readFileUtf8(`${IDENTITIES_DIR}/.work.previous.y.lock`)).toBe('{"held":true}');
    expect(fs.readFileUtf8(`${IDENTITIES_DIR}/work.previous.y/identity.json`)).toBe('{"name":"two"}');
  });

  it("finishes carrying local state out of a superseded farm left behind by a crash after the swap", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    // A crash after `rename(scratch -> farm)` but before carry-over: both directories exist and the identity's own file is still in the old one.
    fs.seed({ [`${IDENTITIES_DIR}/.work.previous.4444.44444444-0000-4000-8000-444444444444/identity.json`]: '{"name":"work"}' });

    const result = resyncFarm(params(fs, { uniqueSuffix: "3333.33333333-0000-4000-8000-333333333333" }));

    expect(result.recovery.completed).toEqual([".work.previous.4444.44444444-0000-4000-8000-444444444444"]);
    expect(fs.readFileUtf8(`${FARM}/identity.json`)).toBe('{"name":"work"}');
    expect(fs.lstat(`${IDENTITIES_DIR}/.work.previous.4444.44444444-0000-4000-8000-444444444444`)).toBeUndefined();
  });

  it("discards a runtime-category collision automatically rather than retaining the superseded farm for it", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    fs.seed({
      [`${FARM}/mcp-needs-auth-cache.json`]: "current",
      [`${IDENTITIES_DIR}/.work.previous.4444.44444444-0000-4000-8000-444444444444/mcp-needs-auth-cache.json`]: "stale, from the crashed launch",
    });

    const result = resyncFarm(params(fs, { uniqueSuffix: "3333.33333333-0000-4000-8000-333333333333" }));

    expect(result.recovery.autoResolved).toEqual(["mcp-needs-auth-cache.json"]);
    expect(result.recovery.retained).toEqual([]);
    expect(fs.lstat(`${IDENTITIES_DIR}/.work.previous.4444.44444444-0000-4000-8000-444444444444`)).toBeUndefined();
    expect(fs.readFileUtf8(`${FARM}/mcp-needs-auth-cache.json`)).toBe("current");
  });

  it("keeps a superseded farm on disk rather than discarding data the new farm also has an entry for", () => {
    const fs = createFakeFarmFs(CANONICAL);
    resyncFarm(params(fs));
    fs.seed({ [`${IDENTITIES_DIR}/.work.previous.4444.44444444-0000-4000-8000-444444444444/settings.json`]: "a real file, not a link" });

    const result = resyncFarm(params(fs, { uniqueSuffix: "3333.33333333-0000-4000-8000-333333333333" }));

    expect(result.recovery.retained).toEqual([`${IDENTITIES_DIR}/.work.previous.4444.44444444-0000-4000-8000-444444444444`]);
    expect(fs.readFileUtf8(`${IDENTITIES_DIR}/.work.previous.4444.44444444-0000-4000-8000-444444444444/settings.json`)).toBe("a real file, not a link");
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
          uniqueSuffix: "6666.66666666-0000-4000-8000-666666666666",
          cascade: cascade({ categories: { history: true } }),
          lock: { pid: 42, isRunning: () => true, sleep: fakeSleep().sleep, maxAttempts: 2 },
        }),
      ),
    ).toThrow(IdentityLockBusyError);
    expect(farmWrites(fs)).toEqual([]);
    expect(fs.lstat(`${FARM}/projects`)).toBeUndefined();

    // Once the sibling releases, the same resync goes through.
    fs.removeRecursive(identityLockPath(IDENTITIES_DIR, "work"));
    const result = resyncFarm(params(fs, { uniqueSuffix: "7777.77777777-0000-4000-8000-777777777777", cascade: cascade({ categories: { history: true } }) }));
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
    resyncFarm(params(fs, { uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222", cascade: cascade({ categories: { history: true } }) }));

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
    expect(diagnostic?.message).not.toContain("identity resolve-conflicts");
  });

  it("pluralises the count correctly for more than one auto-resolved entry", () => {
    const [diagnostic] = recoveryDiagnostics(
      { ...base, recovered: true, autoResolved: ["mcp-needs-auth-cache.json", ".last-cleanup"] },
      "work",
    );
    expect(diagnostic?.message).toContain("discarded 2 superseded runtime entries");
  });

  it("still points at identity resolve-conflicts for a genuinely retained collision, alongside a separate auto-resolved one", () => {
    const [diagnostic] = recoveryDiagnostics(
      {
        ...base,
        recovered: true,
        autoResolved: ["mcp-needs-auth-cache.json"],
        retained: [`${IDENTITIES_DIR}/.work.previous.4444.44444444-0000-4000-8000-444444444444`],
      },
      "work",
    );
    expect(diagnostic?.message).toContain("discarded 1 superseded runtime entry");
    expect(diagnostic?.message).toContain("agent-shim identity resolve-conflicts work");
  });
});

describe("resyncFarm for an identity that is gone", () => {
  const LOCK = identityLockPath(IDENTITIES_DIR, "work");

  it("refuses, rebuilding nothing and leaving its lock free, when the identity was renamed while the launch waited for the lock", () => {
    const fs = createFakeFarmFs(CANONICAL);
    // A rename holds the identity's lock, and finishes while this launch waits: it releases the lock and the identity is gone.
    fs.seed({ [LOCK]: `${JSON.stringify({ identity: "work", pid: 99, token: "the-rename", acquiredAtMs: FAKE_NOW_MS })}\n` });
    let exists = true;
    const finishRename = (): void => {
      fs.removeRecursive(LOCK);
      exists = false;
    };
    expect(() => resyncFarm(params(fs, { identityExists: () => exists, lock: { pid: 42, isRunning: () => true, sleep: finishRename } }))).toThrow(IdentityGoneError);
    expect(fs.lstat(FARM)).toBeUndefined();
    expect(farmWrites(fs)).toEqual([]);
    expect(fs.lstat(LOCK)).toBeUndefined();
  });

  it("names the directory of the id it resolved, never calling the id a name, and says to launch again by the current name if there is one", () => {
    const fs = createFakeFarmFs(CANONICAL);
    expect(() => resyncFarm(params(fs, { identityExists: () => false }))).toThrow("The identity stored under identities/work no longer exists: its directory was moved with `identity rename --move`, or it was removed, while this launch waited for it. Launch again by the identity's current name, if it has one.");
  });

  it("asks only once the lock is held and a swap a crash interrupted has been recovered, so a farm left mid-swap is not mistaken for a missing identity", () => {
    const fs = createFakeFarmFs({ ...CANONICAL, [`${IDENTITIES_DIR}/.work.previous.4444.44444444-0000-4000-8000-444444444444/identity.json`]: '{"name":"work"}' });
    const seen: boolean[] = [];
    resyncFarm(params(fs, { identityExists: () => (seen.push(fs.lstat(`${FARM}/identity.json`) !== undefined), true) }));
    expect(seen).toEqual([true]);
  });
});

describe("resyncFarm with a shared entry that is a symlink", () => {
  const ELSEWHERE = `${FAKE_HOME}/elsewhere`;

  /** Every farm write that lands in the canonical tree or the place its symlinks lead, which a resync never makes for a shared entry. */
  function writesOutsideFarm(fs: FakeFarmFs): string[] {
    return farmWrites(fs).filter((write) => write.includes(FAKE_CLAUDE_HOME) || write.includes(ELSEWHERE));
  }

  it("leaves out a shared directory entry whose symlink leads nowhere, so Claude Code can write the identity's own, and says why", () => {
    const fs = createFakeFarmFs({ ...CANONICAL, [`${FAKE_CLAUDE_HOME}/sessions`]: { symlink: `${ELSEWHERE}/sessions` } });

    const result = resyncFarm(params(fs));

    expect(fs.lstat(`${FARM}/sessions`)).toBeUndefined();
    expect(result.manifest.links.map((link) => link.rel)).not.toContain("sessions");
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "SHARED_ENTRY_DANGLING").map((diagnostic) => diagnostic.subject)).toEqual(["sessions"]);
    // Nothing is created for it: what the symlink should lead to is not known.
    expect(fs.lstat(`${ELSEWHERE}/sessions`)).toBeUndefined();
    expect(writesOutsideFarm(fs)).toEqual([]);
    fs.mkdirp(`${FARM}/sessions`);
    expect(fs.resolves(`${FARM}/sessions`)).toBe(true);
  });

  it("links a shared file entry whose symlink leads to a file, and a plain shared file, creating nothing for either", () => {
    const fs = createFakeFarmFs({
      ...CANONICAL,
      [`${ELSEWHERE}/history.jsonl`]: "{}\n",
      [`${FAKE_CLAUDE_HOME}/history.jsonl`]: { symlink: `${ELSEWHERE}/history.jsonl` },
      [`${FAKE_CLAUDE_HOME}/CLAUDE.md`]: "instructions",
    });

    const result = resyncFarm(params(fs));

    expect(fs.linkTarget(`${FARM}/history.jsonl`)).toBe(`${FAKE_CLAUDE_HOME}/history.jsonl`);
    expect(fs.resolves(`${FARM}/history.jsonl`)).toBe(true);
    expect(fs.linkTarget(`${FARM}/CLAUDE.md`)).toBe(`${FAKE_CLAUDE_HOME}/CLAUDE.md`);
    expect(fs.readFileUtf8(`${ELSEWHERE}/history.jsonl`)).toBe("{}\n");
    expect(result.diagnostics).toEqual([]);
    expect(writesOutsideFarm(fs)).toEqual([]);
  });

  it("links a shared directory that exists, directly or through a symlink, and leaves its contents untouched", () => {
    const fs = createFakeFarmFs({
      ...CANONICAL,
      [`${FAKE_CLAUDE_HOME}/sessions/123.json`]: "a session record",
      [`${ELSEWHERE}/agents/reviewer.md`]: "an agent",
      [`${FAKE_CLAUDE_HOME}/agents`]: { symlink: `${ELSEWHERE}/agents` },
    });
    const outsideFarm = (): string[] => [...fs.snapshot(FAKE_CLAUDE_HOME), ...fs.snapshot(ELSEWHERE)];
    const before = outsideFarm();

    const result = resyncFarm(params(fs));

    expect(fs.linkTarget(`${FARM}/sessions`)).toBe(`${FAKE_CLAUDE_HOME}/sessions`);
    expect(fs.linkTarget(`${FARM}/agents`)).toBe(`${FAKE_CLAUDE_HOME}/agents`);
    expect(fs.resolves(`${FARM}/agents/reviewer.md`)).toBe(true);
    expect(fs.readFileUtf8(`${FAKE_CLAUDE_HOME}/sessions/123.json`)).toBe("a session record");
    expect(outsideFarm()).toEqual(before);
    expect(result.diagnostics).toEqual([]);
    expect(writesOutsideFarm(fs)).toEqual([]);
  });

  it("writes nothing on a resync while the symlink still leads nowhere, and links the entry on the first resync after it leads somewhere", () => {
    const fs = createFakeFarmFs({ ...CANONICAL, [`${FAKE_CLAUDE_HOME}/sessions`]: { symlink: `${ELSEWHERE}/sessions` } });
    resyncFarm(params(fs));

    fs.writes.length = 0;
    const second = resyncFarm(params(fs, { uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222" }));
    expect(second.noOp).toBe(true);
    expect(farmWrites(fs)).toEqual([]);
    expect(second.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["SHARED_ENTRY_DANGLING"]);

    fs.seed({ [`${ELSEWHERE}/sessions`]: { dir: true } });
    const third = resyncFarm(params(fs, { uniqueSuffix: "3333.33333333-0000-4000-8000-333333333333" }));
    expect(third.noOp).toBe(false);
    expect(fs.linkTarget(`${FARM}/sessions`)).toBe(`${FAKE_CLAUDE_HOME}/sessions`);
    expect(fs.resolves(`${FARM}/sessions`)).toBe(true);
    expect(third.diagnostics).toEqual([]);

    fs.writes.length = 0;
    const fourth = resyncFarm(params(fs, { uniqueSuffix: "4444.44444444-0000-4000-8000-444444444444" }));
    expect(fourth.noOp).toBe(true);
    expect(farmWrites(fs)).toEqual([]);
  });
});

describe("danglingFarmLinks", () => {
  const SHARED_SESSIONS = { ...CANONICAL, [`${FAKE_CLAUDE_HOME}/sessions/123.json`]: "a session record", [`${FARM}/.claude.json`]: "the identity's own state" };

  it("names nothing in a farm whose links all lead somewhere", () => {
    const fs = createFakeFarmFs(SHARED_SESSIONS);
    resyncFarm(params(fs));

    expect(danglingFarmLinks(fs, FARM)).toEqual([]);
  });

  it("names a link whose shared entry was removed after the farm was built, with the target its manifest records", () => {
    const fs = createFakeFarmFs(SHARED_SESSIONS);
    resyncFarm(params(fs));
    fs.removeRecursive(`${FAKE_CLAUDE_HOME}/sessions`);

    expect(danglingFarmLinks(fs, FARM)).toEqual([{ rel: "sessions", target: `${FAKE_CLAUDE_HOME}/sessions` }]);
  });

  it("names a dangling top-level symlink in a farm with no manifest, as an older version left it, without entering the identity's own directories", () => {
    const fs = createFakeFarmFs({
      [`${FARM}/identity.json`]: '{"name":"work"}',
      [`${FARM}/sessions`]: { symlink: `${FAKE_CLAUDE_HOME}/sessions` },
      [`${FARM}/skills`]: { symlink: `${FAKE_CLAUDE_HOME}/skills` },
      [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit skill",
      [`${FARM}/debug/latest`]: { symlink: `${FARM}/debug/gone.txt` },
    });

    expect(danglingFarmLinks(fs, FARM)).toEqual([{ rel: "sessions" }]);
  });

  it("names a dangling link inside a directory the manifest records as materialised, and a manifest link of its own, but nothing in a directory the farm did not build", () => {
    const manifest = {
      version: 1,
      builtAtMs: FAKE_NOW_MS,
      identity: "work",
      cwd: `${FAKE_HOME}/work`,
      claudeHome: FAKE_CLAUDE_HOME,
      materialised: ["projects"],
      links: [{ rel: "projects/-home-testuser-work", target: `${FAKE_CLAUDE_HOME}/projects/-home-testuser-work` }],
    };
    const fs = createFakeFarmFs({
      [`${FARM}/${FARM_MANIFEST_FILENAME}`]: JSON.stringify(manifest),
      [`${FARM}/projects/-home-testuser-work`]: { symlink: `${FAKE_CLAUDE_HOME}/projects/-home-testuser-work` },
      [`${FARM}/projects/-home-testuser-other`]: { symlink: `${FAKE_CLAUDE_HOME}/projects/-home-testuser-other` },
      [`${FARM}/projects/-home-testuser-own/latest`]: { symlink: `${FARM}/nowhere` },
    });

    expect(danglingFarmLinks(fs, FARM)).toEqual([
      { rel: "projects/-home-testuser-other" },
      { rel: "projects/-home-testuser-work", target: `${FAKE_CLAUDE_HOME}/projects/-home-testuser-work` },
    ]);
  });

  it("is left with nothing to name once a resync removes the stale link, which keeps the identity's own entries and reports the link the previous manifest had", () => {
    const fs = createFakeFarmFs(SHARED_SESSIONS);
    resyncFarm(params(fs));
    fs.removeRecursive(`${FAKE_CLAUDE_HOME}/sessions`);

    const result = resyncFarm(params(fs, { uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222" }));

    expect(result.noOp).toBe(false);
    expect(result.previousManifest?.links.map((link) => link.rel)).toContain("sessions");
    expect(result.manifest.links.map((link) => link.rel)).not.toContain("sessions");
    expect(fs.lstat(`${FARM}/sessions`)).toBeUndefined();
    expect(fs.readFileUtf8(`${FARM}/.claude.json`)).toBe("the identity's own state");
    expect(danglingFarmLinks(fs, FARM)).toEqual([]);
  });
});

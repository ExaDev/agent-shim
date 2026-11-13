import { describe, expect, it } from "vitest";

import { IdentityNotFoundError } from "./identityStore";
import { formatIdentityResync, resyncIdentityFarm, type ResyncIdentityFarmParams } from "./identityResync";
import { danglingFarmLinks } from "./launcher/farm";
import { IdentityLockBusyError, identityLockPath } from "./launcher/lock";
import { createFakeFarmFs, FAKE_CLAUDE_HOME, FAKE_NOW_MS, fakeFarm, fakeFs, paths, type FakeFarmFs } from "./test-helpers";
import { UsageError } from "./cliError";

const FARM = `${paths.identitiesDir}/work`;
const LOCK = identityLockPath(paths.identitiesDir, "work");

/** A `~/.claude` that shares a `sessions` directory, and an identity that already holds state of its own. */
const SEEDED = {
  [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit skill",
  [`${FAKE_CLAUDE_HOME}/sessions/123.json`]: "a session record",
  [`${FARM}/.claude.json`]: "the identity's own state",
} as const;

function params(farmFs: FakeFarmFs, overrides: Partial<ResyncIdentityFarmParams> = {}): ResyncIdentityFarmParams & { readonly warnings: string[] } {
  const warnings: string[] = [];
  return {
    paths,
    fs: fakeFs({}),
    farm: fakeFarm(farmFs),
    name: "work",
    env: {},
    namesLock: { fs: createFakeFarmFs(), nowMs: () => FAKE_NOW_MS, pid: 42, isRunning: () => true, sleep: () => undefined },
    warn: (line) => {
      warnings.push(line);
    },
    warnings,
    ...overrides,
  };
}

/** Every farm write except the resync lock's own create and remove. */
function farmWrites(fs: FakeFarmFs): string[] {
  return fs.writes.filter((write) => write.path !== LOCK).map((write) => `${write.op} ${write.path}`);
}

describe("resyncIdentityFarm", () => {
  it("removes a link left stale by a shared entry removed after the farm was built, keeping the identity's own entries, and says so", () => {
    const fs = createFakeFarmFs(SEEDED);
    const first = resyncIdentityFarm(params(fs));
    expect(first.linked).toContain("sessions");
    fs.removeRecursive(`${FAKE_CLAUDE_HOME}/sessions`);
    expect(danglingFarmLinks(fs, FARM).map((link) => link.rel)).toEqual(["sessions"]);

    const report = resyncIdentityFarm(params(fs, { farm: { ...fakeFarm(fs), uniqueSuffix: "2222.22222222-0000-4000-8000-222222222222" } }));

    expect(report).toMatchObject({ identity: "work", id: "work", farmRoot: FARM, changed: true, unlinked: ["sessions"], leftOut: [] });
    expect(report.linked).not.toContain("sessions");
    expect(fs.lstat(`${FARM}/sessions`)).toBeUndefined();
    expect(fs.readFileUtf8(`${FARM}/.claude.json`)).toBe("the identity's own state");
    expect(danglingFarmLinks(fs, FARM)).toEqual([]);
    expect(formatIdentityResync(report)).toEqual([`Resynced the farm of identity "work" for ${fakeFarm(fs).cwd}: 1 link, 0 built directories.`, "  No longer linked: sessions."]);
  });

  it("writes nothing when run again, and says the farm already matches", () => {
    const fs = createFakeFarmFs(SEEDED);
    resyncIdentityFarm(params(fs));
    fs.writes.length = 0;

    const again = resyncIdentityFarm(params(fs));

    expect(again.changed).toBe(false);
    expect(again.unlinked).toEqual([]);
    expect(farmWrites(fs)).toEqual([]);
    expect(formatIdentityResync(again)[0]).toBe(`The farm of identity "work" already matches what a launch in ${fakeFarm(fs).cwd} builds (2 links, 0 built directories); nothing was written.`);
  });

  it("takes the identity's resync lock, so it is serialised with every launch, and the names lock, so no rename moves the identity part way", () => {
    const fs = createFakeFarmFs(SEEDED);
    const namesFs = createFakeFarmFs();
    resyncIdentityFarm(params(fs, { namesLock: { fs: namesFs, nowMs: () => FAKE_NOW_MS, pid: 42, isRunning: () => true, sleep: () => undefined } }));

    expect(fs.writes.filter((write) => write.path === LOCK).map((write) => write.op)).toEqual(["write", "remove", "write", "remove"]);
    expect(namesFs.writes.map((write) => write.op)).toContain("write");
    expect(fs.lstat(LOCK)).toBeUndefined();
  });

  it("refuses while a launch holds the identity's lock, changing nothing in the farm", () => {
    const fs = createFakeFarmFs(SEEDED);
    resyncIdentityFarm(params(fs));
    fs.removeRecursive(`${FAKE_CLAUDE_HOME}/sessions`);
    fs.writeFileUtf8(LOCK, JSON.stringify({ identity: "work", pid: 99, token: "a launch", acquiredAtMs: FAKE_NOW_MS }));
    fs.writes.length = 0;

    expect(() => resyncIdentityFarm(params(fs, { farm: { ...fakeFarm(fs), lock: { ...fakeFarm(fs).lock, maxAttempts: 1 } } }))).toThrow(IdentityLockBusyError);
    expect(farmWrites(fs)).toEqual([]);
    expect(danglingFarmLinks(fs, FARM).map((link) => link.rel)).toEqual(["sessions"]);
  });

  it("refuses a name no identity has, and a Codex identity, without touching a farm", () => {
    const fs = createFakeFarmFs(SEEDED);
    expect(() => resyncIdentityFarm(params(fs, { name: "nobody" }))).toThrow(IdentityNotFoundError);
    const codex = fakeFs({ [`${paths.identitiesDir}/work/identity.json`]: { name: "work", allowAmbientCredential: false, agent: "codex" } });
    expect(() => resyncIdentityFarm(params(fs, { fs: codex }))).toThrow(UsageError);
    expect(fs.writes).toEqual([]);
  });

  it("refuses a configuration profile that does not exist", () => {
    const fs = createFakeFarmFs(SEEDED);
    expect(() => resyncIdentityFarm(params(fs, { cliFlagConfigProfile: "missing" }))).toThrow(/No configuration profile named "missing"/);
    expect(fs.lstat(`${FARM}/sessions`)).toBeUndefined();
  });

  it("names a shared entry left out because its ~/.claude symlink leads nowhere, and passes the launch's warning on", () => {
    const fs = createFakeFarmFs({ ...SEEDED, [`${FAKE_CLAUDE_HOME}/history.jsonl`]: { symlink: `${FAKE_CLAUDE_HOME}/../elsewhere/history.jsonl` } });
    const run = params(fs);

    const report = resyncIdentityFarm(run);

    expect(report.leftOut).toEqual(["history.jsonl"]);
    expect(run.warnings.some((line) => line.startsWith("agent-shim: SHARED_ENTRY_DANGLING: "))).toBe(true);
    expect(formatIdentityResync(report)).toContain("  Left out, since its ~/.claude entry is a symlink that leads nowhere: history.jsonl.");
  });
});

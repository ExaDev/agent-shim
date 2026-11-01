import { describe, expect, it } from "vitest";

import type { FsPort } from "./launcher/ports";
import { createFakeFarmFs, discovered, fakeFarm, fakeFs, fakeLog, fakeProc, fakeSpawn, runAndCaptureExit, FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, paths } from "./test-helpers";

describe("runLauncher for an identity renamed while the launch waited", () => {
  it("refuses, naming the identity and spawning nothing, instead of rebuilding the directory the rename moved", () => {
    const identitiesDir = `${FAKE_HOME}/.agent-shim/identities`;
    const lock = `${identitiesDir}/.work.lock`;
    const fs = createFakeFarmFs({ [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit" });
    const base = fakeFs({});
    let renameStarted = false;
    let renamed = false;
    // The launch has decided on `work` when a rename starts: it takes the identity's lock, and finishes while the launch waits to resync.
    const fsPort: FsPort = {
      ...base,
      readConfigFile: (filePath) => {
        if (filePath !== `${identitiesDir}/work/identity.json`) {
          return base.readConfigFile(filePath);
        }
        if (!renameStarted) {
          renameStarted = true;
          fs.seed({ [lock]: `${JSON.stringify({ identity: "work", pid: 99, token: "the-rename", acquiredAtMs: FAKE_NOW_MS })}\n` });
          return base.readConfigFile(filePath);
        }
        return renamed ? undefined : base.readConfigFile(filePath);
      },
    };
    const finishRename = (): void => {
      renamed = true;
      fs.removeRecursive(lock);
    };
    const farm = { ...fakeFarm(fs), lock: { pid: 42, isRunning: () => true, maxAttempts: 2, sleep: finishRename } };
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = runAndCaptureExit({ paths, fs: fsPort, spawn, proc: fakeProc({}, ["@work"]), log, resolveClaudeBinary: () => discovered, farm });

    expect(code).toBe(1);
    expect(log.errors[0]).toContain('Identity "work" no longer exists');
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(fs.lstat(`${identitiesDir}/work`)).toBeUndefined();
  });
});

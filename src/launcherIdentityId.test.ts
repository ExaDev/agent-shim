import { describe, expect, it } from "vitest";
import { discovered, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv } from "./test-helpers";

/** The fake configuration of an identity renamed without `--move` from `work` to `client`: its identity.json says `client`, in the directory it was created in. */
const RENAMED = { [`${paths.identitiesDir}/work/identity.json`]: { name: "client", allowAmbientCredential: false } };

describe("a launch of an identity whose directory is not named after it", () => {
  it("runs in the directory of its id and carries that id in its identity header, so the session keeps both across a rename", () => {
    const spawn = fakeSpawn();
    expect(runAndCaptureExit({ paths, fs: fakeFs(RENAMED), spawn, proc: fakeProc({}, ["@client", "--track-usage", "--print"]), log: fakeLog(), resolveClaudeBinary: () => discovered })).toBe(0);
    const env = spawnedEnv(spawn);
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/work`);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain("x-agent-shim-identity: work");
  });

  it("refuses the identity's former name, which no identity has any more", () => {
    const log = fakeLog();
    expect(runAndCaptureExit({ paths, fs: fakeFs(RENAMED), spawn: fakeSpawn(), proc: fakeProc({}, ["@work", "--print"]), log, resolveClaudeBinary: () => discovered })).toBe(1);
    expect(log.errors.join("\n")).toContain('no identity named "work"');
  });
});

describe("agent identity boundary", () => {
  it("refuses a Codex identity without spawning Claude", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();
    const fs = fakeFs({ [`${paths.identitiesDir}/work/identity.json`]: { name: "work", agent: "codex", allowAmbientCredential: false } });
    expect(runAndCaptureExit({ paths, fs, spawn, proc: fakeProc({}, ["@work"]), log, resolveClaudeBinary: () => discovered })).toBe(1);
    expect(log.errors.join("\n")).toContain("belongs to Codex");
    expect(spawn.spawnSync).not.toHaveBeenCalled();
  });
});

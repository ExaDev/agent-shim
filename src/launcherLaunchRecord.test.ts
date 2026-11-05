import { describe, expect, it } from "vitest";

import { prepareLaunch } from "./launcher";
import type { FrontDoorPort } from "./launcher/ports";
import { createFakeFarmFs, discovered, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, paths } from "./test-helpers";

function prepared(options: { readonly env?: Record<string, string>; readonly frontdoor?: FrontDoorPort } = {}) {
  const fs = createFakeFarmFs({});
  const plan = prepareLaunch({
    paths,
    fs: fakeFs({}),
    proc: fakeProc(options.env ?? {}, ["@work"]),
    log: fakeLog(),
    resolveClaudeBinary: () => discovered,
    farm: fakeFarm(fs),
    frontdoor: options.frontdoor ?? fakeFrontDoorPort(),
  });
  return { fs, plan };
}

describe("a launch's record", () => {
  it("is written before the identity's farm is resynced, so a rename that looks between the resync and the spawn finds the launch", () => {
    const { fs } = prepared();
    const writes = fs.writes.map((write) => write.path);
    const recorded = writes.findIndex((target) => target.startsWith(paths.launchesDir));
    // Crash recovery takes the identity's lock before the launch has decided anything; the resync is what builds the scratch farm.
    const resynced = writes.findIndex((target) => target.includes(".work.scratch."));
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(resynced).toBeGreaterThan(recorded);
    expect(JSON.parse(fs.readFileUtf8(`${paths.launchesDir}/${String(fs.readdir(paths.launchesDir)[0])}`) ?? "")).toMatchObject({ pid: 42, identity: "work" });
  });

  it("stays while the child could still be starting or running, and goes when the plan is released", () => {
    const { fs, plan } = prepared();
    expect(fs.readdir(paths.launchesDir)).toHaveLength(1);
    plan.release();
    expect(fs.readdir(paths.launchesDir)).toHaveLength(0);
    plan.release();
    expect(fs.readdir(paths.launchesDir)).toHaveLength(0);
  });

  it("goes when the launch fails after it was written, so a library host that outlives the failure does not block a rename for ever", () => {
    const fs = createFakeFarmFs({});
    const failing: FrontDoorPort = {
      ensure: () => {
        throw new Error("the front door is down");
      },
      release: () => undefined,
    };
    expect(() =>
      prepareLaunch({ paths, fs: fakeFs({}), proc: fakeProc({}, ["@work"]), log: fakeLog(), resolveClaudeBinary: () => discovered, farm: fakeFarm(fs), frontdoor: failing }),
    ).toThrow("the front door is down");
    expect(fs.readdir(paths.launchesDir)).toHaveLength(0);
  });

  it("is not written for a launch that resyncs no farm", () => {
    const fs = createFakeFarmFs({});
    prepareLaunch({ paths, fs: fakeFs({}), proc: fakeProc({ CLAUDE_CONFIG_DIR: "/home/testuser/elsewhere" }, ["--print", "hello"]), log: fakeLog(), resolveClaudeBinary: () => discovered, farm: fakeFarm(fs), frontdoor: fakeFrontDoorPort() });
    expect(fs.lstat(paths.launchesDir)).toBeUndefined();
  });
});

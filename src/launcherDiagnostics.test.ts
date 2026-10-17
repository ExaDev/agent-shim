import { describe, expect, it } from "vitest";

import {
  createFakeFarmFs, discovered, FAKE_CLAUDE_HOME, fakeFarm, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit,
} from "./test-helpers";

describe("runLauncher farm output", () => {
  /** One launch of `@work` over `fs`, returning what it logged. */
  function launchOver(fs: ReturnType<typeof createFakeFarmFs>): ReturnType<typeof fakeLog> {
    const log = fakeLog();
    runAndCaptureExit({ paths, fs: fakeFs({}), spawn: fakeSpawn(), proc: fakeProc({}, ["@work"]), log, resolveClaudeBinary: () => discovered, farm: fakeFarm(fs) });
    return log;
  }

  it("says the farm was resynced when a launch changed it, and nothing about it when the next launch finds it unchanged", () => {
    const fs = createFakeFarmFs({ [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit" });

    const first = launchOver(fs);
    const second = launchOver(fs);

    expect(first.infos.some((line) => line.includes("resynced"))).toBe(true);
    expect(second.infos.some((line) => line.includes("farm at"))).toBe(false);
  });

  it("reports every unclassified entry in one warning that says the fix once", () => {
    const fs = createFakeFarmFs({
      [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit",
      [`${FAKE_CLAUDE_HOME}/unknown-one`]: "1",
      [`${FAKE_CLAUDE_HOME}/unknown-two`]: "2",
      [`${FAKE_CLAUDE_HOME}/unknown-three`]: "3",
    });

    const log = launchOver(fs);

    const unclassified = log.warns.filter((line) => line.includes("UNCLASSIFIED_ENTRY"));
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0]).toContain("3 entries are not in the category map");
    for (const name of ["unknown-one", "unknown-two", "unknown-three"]) {
      expect(unclassified[0]).toContain(`"${name}"`);
    }
    expect(unclassified[0]?.match(/agent-shim configure/g)).toHaveLength(1);
  });
});

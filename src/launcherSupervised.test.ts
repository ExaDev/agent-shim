import { expect, it } from "vitest";

import { prepareLaunch } from "./launcher";
import { discovered, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, paths } from "./test-helpers";

it("passes the private composed settings file without putting its contents in the child arguments", () => {
  const plan = prepareLaunch({
    paths,
    fs: fakeFs({ "/caller/settings.json": '{"env":{"TOKEN":"fixture-secret"}}' }),
    proc: fakeProc({}, ["--settings", "/caller/settings.json"]),
    log: fakeLog(),
    resolveClaudeBinary: () => discovered,
    frontdoor: fakeFrontDoorPort(),
    supervised: { sessionId: "session", conversation: "start", settingsFile: "/private/composed.json" },
  });
  expect(plan.args).toContain("/private/composed.json");
  expect(plan.args).not.toContain("/caller/settings.json");
  expect(JSON.stringify(plan.args)).not.toContain("fixture-secret");
});

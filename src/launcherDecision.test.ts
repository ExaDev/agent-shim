import { describe, expect, it } from "vitest";

import { prepareLaunch } from "./launcher";
import { discovered, fakeFs, fakeLog, fakeProc, paths } from "./test-helpers";

describe("prepareLaunch decision", () => {
  const plan = (env: Readonly<Record<string, string>>, argv: readonly string[], files: Readonly<Record<string, unknown>> = {}): ReturnType<typeof prepareLaunch> =>
    prepareLaunch({ paths, fs: fakeFs(files), proc: fakeProc(env, argv), log: fakeLog(), resolveClaudeBinary: () => discovered });

  it("reports the identity a launch runs as, how it was selected and the configuration directory the child gets", () => {
    const { decision } = plan({}, ["@work", "--print"]);
    expect(decision).toEqual({
      identity: "work",
      identitySource: "argv",
      configDirEscapeHatch: false,
      configDir: `${paths.identitiesDir}/work`,
      configProfileSource: "none",
    });
  });

  it("reports an identity named by the environment with its own source", () => {
    expect(plan({ AGENT_SHIM_IDENTITY: "personal" }, ["--print"]).decision).toMatchObject({ identity: "personal", identitySource: "env" });
  });

  it("reports the escape hatch, with the directory the caller named and no identity", () => {
    const { decision } = plan({ CLAUDE_CONFIG_DIR: "/somewhere/else" }, ["--print"]);
    expect(decision).toMatchObject({ identitySource: "config-dir-escape-hatch", configDirEscapeHatch: true, configDir: "/somewhere/else" });
    expect(decision.identity).toBeUndefined();
  });

  it("reports the configuration profile that applied and how it was selected", () => {
    const { decision } = plan({}, ["@work", "--config-profile", "strict", "--print"], { [`${paths.configProfilesDir}/strict.json`]: {} });
    expect(decision).toMatchObject({ configProfile: "strict", configProfileSource: "cli-flag" });
  });
});

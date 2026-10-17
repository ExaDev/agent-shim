import { describe, expect, it } from "vitest";

import { FAKE_HOME, createFakeFarmFs, discovered, fakeCredentials, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv } from "./test-helpers";

describe("the models block a launch resolves", () => {
  const providers = { [`${FAKE_HOME}/.agent-shim/providers/z.json`]: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }] }, env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3" } } };
  /** A farm whose cascade is what the real loader assembles: the global config's block as the shallowest layer, then the committed file's block when there is one. */
  const withCascade = (fs: ReturnType<typeof createFakeFarmFs>, globalModels: unknown, committed: unknown): ReturnType<typeof fakeFarm> => ({
    ...fakeFarm(fs),
    loadCascade: () => ({
      home: FAKE_HOME,
      loadProfile: () => undefined,
      globalConfig: { config: { models: globalModels as never }, filepath: `${FAKE_HOME}/.agent-shim/config.json` },
      levels: committed === undefined ? [] : [{ dir: `${FAKE_HOME}/work`, portable: { config: { models: committed as never }, filepath: `${FAKE_HOME}/work/.agent-shim.json` } }],
    }),
  });
  const launch = (models: unknown, farmModels: unknown): { readonly spawn: ReturnType<typeof fakeSpawn>; readonly frontdoor: ReturnType<typeof fakeFrontDoorPort> } => {
    const spawn = fakeSpawn();
    const frontdoor = fakeFrontDoorPort();
    const fs = createFakeFarmFs({});
    runAndCaptureExit({
      paths,
      fs: fakeFs({ ...providers, [`${FAKE_HOME}/.agent-shim/config.json`]: { models } }),
      farm: withCascade(fs, models, farmModels),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z" }, ["--route-by-name", "--provider", "z"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor,
      credentials: fakeCredentials(),
    });
    return { spawn, frontdoor };
  };
  const globalOnly = { virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] } } };

  it("carries definitions a committed file adds into the /model rows, the tier setting and the door's record of the session", () => {
    const { spawn, frontdoor } = launch(globalOnly, { virtual: { committed: { mode: "ordered", members: ["z/glm-5.3"] } }, tiers: { opus: "committed" } });
    const args = spawn.spawnSync.mock.calls[0]?.[1] ?? [];
    const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}") as { modelPicker: { options: { model: string }[] } };
    expect(settings.modelPicker.options.map((row) => row.model)).toContain("committed");
    expect(settings.modelPicker.options.map((row) => row.model)).toContain("fast");
    expect(spawnedEnv(spawn).ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("committed");
    const session = frontdoor.sessions()[0];
    expect(session?.models).toEqual({ virtual: { fast: { mode: "ordered", members: ["z/glm-5.3"] }, committed: { mode: "ordered", members: ["z/glm-5.3"] } }, tiers: { opus: "committed" } });
    expect(spawnedEnv(spawn).ANTHROPIC_CUSTOM_HEADERS).toContain(`x-agent-shim-session: ${session?.sessionId ?? "missing"}`);
  });

  it("leaves the door to follow the global block live when no deeper layer adds anything", () => {
    const { frontdoor } = launch(globalOnly, undefined);
    expect(frontdoor.sessions()[0]?.models).toBeUndefined();
    expect(frontdoor.sessions()[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("tells the door a deeper layer removed everything as an empty block rather than leaving it on the global one", () => {
    const { frontdoor } = launch(globalOnly, { virtual: { fast: null } });
    expect(frontdoor.sessions()[0]?.models).toEqual({});
  });
});

import { describe, expect, it } from "vitest";

import { createFakeFarmFs, discovered, FAKE_HOME, fakeCredentials, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv } from "./test-helpers";

const WORK_TOKEN = "oauth-work-token";

/** Identity `work` with an `oauthToken` credential, so a launch as it exports a credential variable. */
const workWithCredential = {
  [`${paths.identitiesDir}/work/identity.json`]: {
    name: "work",
    allowAmbientCredential: false,
    credential: { sources: [{ op: "op://vault/claude-work/token" }], target: "oauthToken" },
  },
};

const providerZ = {
  displayName: "GLM",
  baseUrl: "https://api.z.ai/api/anthropic",
  credential: { sources: [{ env: "Z_API_TOKEN" }] },
  env: { ANTHROPIC_MODEL: "glm-4.6", ANTHROPIC_CUSTOM_HEADERS: "x-provider-entry: 1" },
};

const FILES = { ...workWithCredential, [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ };

/** One launch of the launcher over `env` and `argv`: its exit code, what it logged and the environment its child was spawned with. */
function launch(env: Readonly<Record<string, string | undefined>>, argv: readonly string[], hasStoredLogin?: boolean) {
  const spawn = fakeSpawn();
  const log = fakeLog();
  const code = runAndCaptureExit({
    paths,
    fs: fakeFs(FILES),
    spawn,
    proc: fakeProc(env, argv),
    log,
    resolveClaudeBinary: () => discovered,
    credentials: fakeCredentials({ command: { stdout: WORK_TOKEN } }),
    frontdoor: fakeFrontDoorPort(),
    farm: fakeFarm(createFakeFarmFs({})),
    ...(hasStoredLogin === undefined ? {} : { hasStoredLogin: () => hasStoredLogin }),
  });
  return { code, log, env: code === 0 ? spawnedEnv(spawn) : {} };
}

describe("a launch started from inside a session another launch started", () => {
  describe("whose launcher injected an identity credential", () => {
    const parent = (): Record<string, string | undefined> => launch({}, ["@work", "--print"]).env;

    it("starts as another identity without the parent's credential, which the person did not set", () => {
      const inherited = parent();
      expect(inherited.CLAUDE_CODE_OAUTH_TOKEN).toBe(WORK_TOKEN);
      const child = launch(inherited, ["@personal", "--print"]);
      expect(child.code).toBe(0);
      expect(child.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(child.env.CLAUDE_CONFIG_DIR).toBe(`${paths.identitiesDir}/personal`);
    });

    it("still refuses a credential variable the person set to something else", () => {
      const child = launch({ ...parent(), CLAUDE_CODE_OAUTH_TOKEN: "tok-set-by-the-person" }, ["@personal", "--print"]);
      expect(child.code).toBe(1);
      expect(child.log.errors.join("\n")).toContain("CLAUDE_CODE_OAUTH_TOKEN is set in the environment");
    });

    it("still refuses a credential variable the parent did not inject", () => {
      const child = launch({ ...parent(), ANTHROPIC_API_KEY: "sk-set-by-the-person" }, ["@personal", "--print"]);
      expect(child.code).toBe(1);
      expect(child.log.errors.join("\n")).toContain("ANTHROPIC_API_KEY is set in the environment");
    });
  });

  describe("whose launcher injected a provider's placeholder credential", () => {
    const parent = (): Record<string, string | undefined> => launch({ Z_API_TOKEN: "tok-z" }, ["@work", "--provider", "z", "--print"]).env;

    it("starts as another identity without the placeholder", () => {
      const inherited = parent();
      expect(inherited.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
      const child = launch(inherited, ["@personal", "--no-provider", "--print"]);
      expect(child.code).toBe(0);
      expect(child.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    it("still refuses an auth token the person set in its place", () => {
      const child = launch({ ...parent(), ANTHROPIC_AUTH_TOKEN: "tok-set-by-the-person" }, ["@personal", "--no-provider", "--print"]);
      expect(child.code).toBe(1);
      expect(child.log.errors.join("\n")).toContain("ANTHROPIC_AUTH_TOKEN is set in the environment");
    });
  });

  it("refuses an ambient credential under a named identity when only CLAUDE_CONFIG_DIR is inherited, as it does for any launch", () => {
    const child = launch({ CLAUDE_CONFIG_DIR: "/somewhere/explicit", ANTHROPIC_API_KEY: "sk-set-by-the-person" }, ["@personal", "--print"]);
    expect(child.code).toBe(1);
    expect(child.log.errors.join("\n")).toContain("ANTHROPIC_API_KEY is set in the environment");
  });

  describe("whose launcher routed it through a provider with Remote Control on", () => {
    const parent = (): Record<string, string | undefined> =>
      launch({ Z_API_TOKEN: "tok-z", ANTHROPIC_CUSTOM_HEADERS: "x-user-header: keep" }, ["@work", "--provider", "z", "--remote-control", "--print"], true).env;

    it("sets the provider's routing in the parent, so the next test is about something", () => {
      const inherited = parent();
      expect(inherited.AGENT_SHIM_PROVIDER).toBe("GLM");
      expect(inherited.ANTHROPIC_MODEL).toBe("glm-4.6");
      expect(inherited.ANTHROPIC_CUSTOM_HEADERS).toContain("x-agent-shim-provider: z");
    });

    it("drops the provider's routing from a child on another identity with the front door engaged and no provider", () => {
      const child = launch(parent(), ["@personal", "--no-provider", "--track-usage", "--print"]);
      expect(child.code).toBe(0);
      expect(child.env.AGENT_SHIM_PROVIDER).toBeUndefined();
      expect(child.env.ANTHROPIC_MODEL).toBeUndefined();
      const headers = child.env.ANTHROPIC_CUSTOM_HEADERS ?? "";
      expect(headers).not.toContain("x-agent-shim-provider");
      expect(headers).not.toContain("x-provider-entry");
      expect(headers).toContain("x-agent-shim-identity: personal");
      expect(headers).toContain("x-user-header: keep");
    });

    it("leaves a child that engages no front door with none of the parent's routing", () => {
      const child = launch(parent(), ["@personal", "--no-provider", "--no-track-usage", "--print"]);
      expect(child.code).toBe(0);
      for (const name of ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "AGENT_SHIM_PROVIDER", "ANTHROPIC_MODEL", "AGENT_SHIM_INJECTED"]) {
        expect(child.env[name], name).toBeUndefined();
      }
      expect(child.env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-user-header: keep");
    });
  });
});

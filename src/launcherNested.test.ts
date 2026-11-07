import { describe, expect, it } from "vitest";

import { CREDENTIAL_UNAVAILABLE_EXIT } from "./credential";
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

/** Identity `reader` takes its credential from the very variable a launch of `work` exports. */
const readerFromEnvironment = {
  [`${paths.identitiesDir}/reader/identity.json`]: {
    name: "reader",
    allowAmbientCredential: false,
    credential: { sources: [{ env: "CLAUDE_CODE_OAUTH_TOKEN" }], target: "oauthToken" },
  },
};

const FILES = { ...workWithCredential, ...readerFromEnvironment, [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ };

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

/** The variables (not headers or hosts) an environment's marker records, with their digests: what a launch that keeps its parent's session must keep recording. */
function recordedVariables(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const marker = JSON.parse(env.AGENT_SHIM_INJECTED ?? "{}") as Record<string, string>;
  return Object.fromEntries(Object.entries(marker).filter(([key]) => !key.includes(":") && !key.includes(",")));
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

  it("fails an identity whose credential reads the variable the parent injected, since that value is the parent's account", () => {
    const parent = launch({}, ["@work", "--print"]).env;
    const child = launch(parent, ["@reader", "--print"]);
    expect(child.code).toBe(CREDENTIAL_UNAVAILABLE_EXIT);
    expect(child.log.errors.join("\n")).toContain("identity reader");
  });

  describe("under the escape hatch, where the child is the parent's session", () => {
    it("keeps the parent's routing, headers and marker for a bare launch", () => {
      const parent = launch({ Z_API_TOKEN: "tok-z", ANTHROPIC_CUSTOM_HEADERS: "x-user-header: keep" }, ["@work", "--provider", "z", "--remote-control", "--print"], true).env;
      const child = launch(parent, ["--print"]);
      expect(child.code).toBe(0);
      expect(child.env.CLAUDE_CONFIG_DIR).toBe(parent.CLAUDE_CONFIG_DIR);
      expect(child.env.AGENT_SHIM_PROVIDER).toBe("GLM");
      expect(recordedVariables(child.env)).toEqual(expect.objectContaining(recordedVariables(parent)));
      expect(child.env.ANTHROPIC_CUSTOM_HEADERS).toContain("x-agent-shim-provider: z");
      expect(child.env.ANTHROPIC_CUSTOM_HEADERS).toContain("x-user-header: keep");
    });

    it("keeps the parent's credential when the person opts in to it, and still refuses it otherwise", () => {
      const parent = launch({}, ["@work", "--print"]).env;
      expect(launch(parent, ["--print"]).code).toBe(1);
      const child = launch({ ...parent, AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL: "1" }, ["--print"]);
      expect(child.code).toBe(0);
      expect(child.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(WORK_TOKEN);
      expect(recordedVariables(child.env)).toEqual(expect.objectContaining(recordedVariables(parent)));
    });
  });
});

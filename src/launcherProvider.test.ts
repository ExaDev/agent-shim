import { describe, expect, it } from "vitest";

import { CREDENTIAL_UNAVAILABLE_EXIT } from "./credential";
import { prepareLaunch, type RunLauncherParams } from "./launcher";
import type { SupervisedLaunch } from "./launcher/claudeSession";
import {
  createFakeFarmFs, discovered, FAKE_HOME, fakeCredentials, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv,
  reportedRow,
} from "./test-helpers";

/** `runAndCaptureExit` with a fake credential port and a fake front door wired unless the test supplies its own, since every provider launch resolves a credential block and routes through the door. */
function launch(params: Omit<RunLauncherParams, "credentials" | "frontdoor"> & Partial<Pick<RunLauncherParams, "credentials" | "frontdoor">>): number {
  return runAndCaptureExit({ credentials: fakeCredentials(), frontdoor: fakeFrontDoorPort(), ...params });
}

describe("runLauncher provider selection", () => {
  const providerZ = {
    displayName: "GLM",
    baseUrl: "https://api.z.ai/api/anthropic",
    credential: { sources: [{ env: "Z_API_TOKEN" }] },
    env: { ANTHROPIC_MODEL: "glm-4.6" },
  };
  const providerO = {
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credential: { sources: [{ env: "OPENROUTER_API_KEY" }] },
  };

  it("reports the provider a launch routes through on the plan's decision, and none when it routes through none", () => {
    const decide = (argv: readonly string[]): ReturnType<typeof prepareLaunch>["decision"] =>
      prepareLaunch({
        paths,
        fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ }),
        proc: fakeProc({ Z_API_TOKEN: "tok-z" }, argv),
        log: fakeLog(),
        resolveClaudeBinary: () => discovered,
        credentials: fakeCredentials(),
        frontdoor: fakeFrontDoorPort(),
      }).decision;
    expect(decide(["--provider", "z", "--print"]).provider).toBe("z");
    expect(decide(["--print"]).provider).toBeUndefined();
  });

  it("launches through a provider selected by the --provider flag", () => {
    const spawn = fakeSpawn();

    launch({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z" }, ["--provider", "z", "--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync).toHaveBeenCalledTimes(1);
    const call = spawn.spawnSync.mock.calls[0];
    expect(call?.[0]).toBe(discovered.path);
    expect(call?.[1]).toEqual(["--print"]);
    expect(call?.[2]?.stdio).toBe("inherit");
    const env = call?.[2]?.env;
    expect(env).toMatchObject({
      Z_API_TOKEN: "tok-z",
      ANTHROPIC_MODEL: "glm-4.6",
      AGENT_SHIM_PROVIDER: "GLM",
    });
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env?.ANTHROPIC_CUSTOM_HEADERS).toMatch(/^x-agent-shim-session: [0-9a-f-]{36}\nx-agent-shim-auth: launch-token-for-tests\nx-agent-shim-provider: z$/);
  });

  it("refuses with exit 1 and names the known providers when the provider is unknown", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = launch({
      paths,
      fs: fakeFs({
        [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ,
        [`${FAKE_HOME}/.agent-shim/providers/o.json`]: providerO,
      }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z" }, ["--provider", "missing", "--print"]),
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain('no provider named "missing"');
    expect(log.errors[0]).toContain("o, z");
  });

  it("refuses with exit 64 when the provider's only source, an environment variable, is unset or empty", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = launch({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "" }, ["--provider", "z"]),
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(CREDENTIAL_UNAVAILABLE_EXIT);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors).toEqual(["agent-shim: provider z has no usable credential: env Z_API_TOKEN is unset or empty"]);
  });

  it("launches a local-proxy provider with a literal placeholder credential and nothing in the environment", () => {
    const spawn = fakeSpawn();

    launch({
      paths,
      fs: fakeFs({
        [`${FAKE_HOME}/.agent-shim/providers/codex.json`]: {
          displayName: "Codex",
          baseUrl: "http://127.0.0.1:18789",
          credential: { sources: [{ literal: "codex-subscription-local" }] },
        },
      }),
      spawn,
      proc: fakeProc({}, ["--provider", "codex", "--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });

    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
    expect(env.AGENT_SHIM_PROVIDER).toBe("Codex");
  });

  it("resolves a provider pinned by a cascade layer when no flag was given", () => {
    const fs = createFakeFarmFs({});
    const spawn = fakeSpawn();

    launch({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/o.json`]: providerO }),
      spawn,
      proc: fakeProc({ OPENROUTER_API_KEY: "tok-o" }, ["@work"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs, { launch: { provider: "o" } }),
    });

    const env = spawnedEnv(spawn);
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${FAKE_HOME}/.agent-shim/identities/work`);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
    expect(env.AGENT_SHIM_PROVIDER).toBe("OpenRouter");
  });

  it("launches --identity plus --provider: the identity's own farm directory and the provider's endpoint, with no credential handed to the child", () => {
    const spawn = fakeSpawn();

    launch({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z" }, ["--identity", "work", "--provider", "z", "-p", "say hi"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync.mock.calls[0]?.[1]).toEqual(["-p", "say hi"]);
    const env = spawnedEnv(spawn);
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${FAKE_HOME}/.agent-shim/identities/work`);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
  });

  it("lets --no-provider opt one launch out of the cascade's provider selection", () => {
    const fs = createFakeFarmFs({});
    const spawn = fakeSpawn();

    launch({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/o.json`]: providerO }),
      spawn,
      proc: fakeProc({}, ["@work", "--no-provider"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs, { launch: { provider: "o" } }),
    });

    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.AGENT_SHIM_PROVIDER).toBeUndefined();
  });

  it("lets a --provider flag beat the cascade's own provider selection", () => {
    const fs = createFakeFarmFs({});
    const spawn = fakeSpawn();

    launch({
      paths,
      fs: fakeFs({
        [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ,
        [`${FAKE_HOME}/.agent-shim/providers/o.json`]: providerO,
      }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z", OPENROUTER_API_KEY: "tok-o" }, ["@work", "--provider", "z"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs, { launch: { provider: "o" } }),
    });

    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
  });

  it("does not trip the ambient-credential guard when a provider is selected, and leaves none of the ambient credential in the child", () => {
    const spawn = fakeSpawn();

    const code = launch({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z", ANTHROPIC_AUTH_TOKEN: "sk-leftover-from-old-wrapper" }, ["--provider", "z"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(0);
    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  describe("command sources and target apiKey", () => {
    const providerAnthropic = {
      displayName: "Anthropic API",
      baseUrl: "https://api.anthropic.com",
      credential: { sources: [{ op: "op://vault/item/field" }], target: "apiKey" },
    };

    it("launches with the command's token resolved (so the launch log names it) but held by nobody: the door attaches it, and ambient credentials reach no child", () => {
      const spawn = fakeSpawn();
      const credentials = fakeCredentials({ command: { stdout: "sk-ant-REDACTED\n" } });
      const log = fakeLog();

      const code = launch({
        paths,
        fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/anthropic-api.json`]: providerAnthropic }),
        spawn,
        proc: fakeProc({ ANTHROPIC_API_KEY: "sk-ambient-key", ANTHROPIC_AUTH_TOKEN: "sk-ambient-bearer" }, ["--provider", "anthropic-api", "--print"]),
        log,
        resolveClaudeBinary: () => discovered,
        credentials,
      });

      expect(code).toBe(0);
      expect(credentials.runCommand).toHaveBeenCalledOnce();
      expect(credentials.runCommand.mock.calls[0]?.[0]).toEqual(["op", "read", "op://vault/item/field"]);
      expect(spawn.spawnSync.mock.calls[0]?.[1]).toEqual(["--print"]);
      const env = spawnedEnv(spawn);
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
      expect([...log.infos, ...log.warns, ...log.errors].join("\n")).not.toContain("sk-ant-REDACTED");
      expect(reportedRow(log, "provider")).toEqual({ label: "provider", value: "anthropic-api", detail: "credential apiKey from op op://vault/item/field" });
    });

    it("resolves a bearer provider's command output for the launch log while the child still carries no credential variable", () => {
      const spawn = fakeSpawn();

      launch({
        paths,
        fs: fakeFs({
          [`${FAKE_HOME}/.agent-shim/providers/z.json`]: {
            displayName: "GLM",
            baseUrl: "https://api.z.ai/api/anthropic",
            credential: { sources: [{ command: ["pass", "show", "z"] }] },
          },
        }),
        spawn,
        proc: fakeProc({}, ["--provider", "z"]),
        log: fakeLog(),
        resolveClaudeBinary: () => discovered,
        credentials: fakeCredentials({ command: { stdout: "tok-z\n" } }),
      });

      const env = spawnedEnv(spawn);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("refuses with exit 64 before spawning when the command fails, without logging its output", () => {
      const spawn = fakeSpawn();
      const log = fakeLog();

      const code = launch({
        paths,
        fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/anthropic-api.json`]: providerAnthropic }),
        spawn,
        proc: fakeProc({}, ["--provider", "anthropic-api"]),
        log,
        resolveClaudeBinary: () => discovered,
        credentials: fakeCredentials({ command: { status: 1, stdout: "sk-ant-REDACTED" } }),
      });

      expect(code).toBe(CREDENTIAL_UNAVAILABLE_EXIT);
      expect(spawn.spawnSync).not.toHaveBeenCalled();
      expect(log.errors).toEqual(["agent-shim: provider anthropic-api has no usable credential: op op://vault/item/field exited with status 1"]);
    });

    it("refuses with exit 64, naming the source, when an interactive source is left and nobody is present to approve it", () => {
      const spawn = fakeSpawn();
      const log = fakeLog();
      const credentials = fakeCredentials({ personPresent: false });

      const code = launch({
        paths,
        fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/anthropic-api.json`]: providerAnthropic }),
        spawn,
        proc: fakeProc({}, ["--provider", "anthropic-api"]),
        log,
        resolveClaudeBinary: () => discovered,
        credentials,
      });

      expect(code).toBe(CREDENTIAL_UNAVAILABLE_EXIT);
      expect(credentials.runCommand).not.toHaveBeenCalled();
      expect(log.errors[0]).toContain("op op://vault/item/field needs a person to approve it");
    });

    it("refuses with exit 1 rather than launching without a credential when no credential port is wired", () => {
      const spawn = fakeSpawn();

      const code = runAndCaptureExit({
        paths,
        fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/anthropic-api.json`]: providerAnthropic }),
        spawn,
        proc: fakeProc({}, ["--provider", "anthropic-api"]),
        log: fakeLog(),
        resolveClaudeBinary: () => discovered,
      });

      expect(code).toBe(1);
      expect(spawn.spawnSync).not.toHaveBeenCalled();
    });

    it("still refuses an ambient ANTHROPIC_API_KEY when no provider is selected", () => {
      const spawn = fakeSpawn();
      const log = fakeLog();

      const code = launch({
        paths,
        fs: fakeFs({}),
        spawn,
        proc: fakeProc({ ANTHROPIC_API_KEY: "sk-ambient-key" }, ["--print"]),
        log,
        resolveClaudeBinary: () => discovered,
      });

      expect(code).toBe(1);
      expect(log.errors[0]).toContain("ANTHROPIC_API_KEY");
    });
  });

  it("still refuses an ambient ANTHROPIC_AUTH_TOKEN when no provider is selected", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = launch({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ ANTHROPIC_AUTH_TOKEN: "sk-ambient" }, ["--print"]),
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  describe("Remote Control on a provider launch", () => {
    /** A provider launch under a `--remote-control` request, as the plan the launcher builds, with `hasStoredLogin` wired to `login` (or left unwired). */
    function plan(login: boolean | undefined, extra: readonly string[] = []) {
      const log = fakeLog();
      const built = prepareLaunch({
        paths,
        fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ }),
        proc: fakeProc({ Z_API_TOKEN: "tok-z" }, ["@work", "--provider", "z", "--remote-control", ...extra, "--print"]),
        log,
        resolveClaudeBinary: () => discovered,
        credentials: fakeCredentials(),
        frontdoor: fakeFrontDoorPort(),
        farm: fakeFarm(createFakeFarmFs({})),
        ...(login === undefined ? {} : { hasStoredLogin: () => login }),
      });
      return { built, log };
    }

    it("keeps Remote Control, and presents no credential, when the identity has a stored login", () => {
      const { built, log } = plan(true);
      expect(built.args).toContain("--remote-control=");
      expect(built.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(log.infos.join("\n")).not.toContain("no stored login");
    });

    it("turns Remote Control off and presents the placeholder, saying so, when the identity has no stored login", () => {
      const { built, log } = plan(false);
      expect(built.args).not.toContain("--remote-control=");
      expect(built.env.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
      expect(reportedRow(log, "note")?.value).toBe("work has no stored login, so Remote Control is off; provider z runs without it");
    });

    it("assumes a login when the caller cannot ask, so a launch is never changed on a guess", () => {
      const { built } = plan(undefined);
      expect(built.args).toContain("--remote-control=");
      expect(built.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    it("says nothing when Remote Control was not asked for, however the login stands", () => {
      const log = fakeLog();
      const built = prepareLaunch({
        paths,
        fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/z.json`]: providerZ }),
        proc: fakeProc({ Z_API_TOKEN: "tok-z" }, ["@work", "--provider", "z", "--print"]),
        log,
        resolveClaudeBinary: () => discovered,
        credentials: fakeCredentials(),
        frontdoor: fakeFrontDoorPort(),
        farm: fakeFarm(createFakeFarmFs({})),
        hasStoredLogin: () => false,
      });
      expect(built.env.ANTHROPIC_AUTH_TOKEN).toBe("agent-shim-provider-session");
      expect(log.infos.join("\n")).not.toContain("no stored login");
    });

    it("leaves a launch with no provider alone: Remote Control stays on without a stored login", () => {
      const built = prepareLaunch({
        paths,
        fs: fakeFs({}),
        proc: fakeProc({}, ["@work", "--remote-control", "--print"]),
        log: fakeLog(),
        resolveClaudeBinary: () => discovered,
        frontdoor: fakeFrontDoorPort(),
        farm: fakeFarm(createFakeFarmFs({})),
        hasStoredLogin: () => false,
      });
      expect(built.args).toContain("--remote-control=");
    });
  });
});

describe("runLauncher /model picker", () => {
  const codexProvider = {
    kind: "codex",
    displayName: "Codex",
    credential: { sources: [{ env: "CODEX_TOKEN" }] },
    codex: { models: { fable: "big", opus: "big", sonnet: "mid", haiku: "small" } },
  };
  const plainProvider = {
    displayName: "GLM",
    baseUrl: "https://api.z.ai/api/anthropic",
    credential: { sources: [{ env: "Z_API_TOKEN" }] },
  };

  /** The arguments claude is spawned with, and what the launcher logged, for a launch through `provider` with `argv`. */
  function spawnedWith(provider: object, argv: readonly string[], supervised?: SupervisedLaunch, extraFiles: Record<string, unknown> = {}): { readonly args: readonly string[] | undefined; readonly infos: readonly string[] } {
    const spawn = fakeSpawn();
    const log = fakeLog();
    launch({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.agent-shim/providers/p.json`]: provider, ...extraFiles }),
      spawn,
      proc: fakeProc({ CODEX_TOKEN: "tok", Z_API_TOKEN: "tok" }, ["--provider", "p", ...argv]),
      log,
      resolveClaudeBinary: () => discovered,
      ...(supervised === undefined ? {} : { supervised }),
    });
    return { args: spawn.spawnSync.mock.calls[0]?.[1], infos: log.infos };
  }

  /** The `--settings` value in `args`, parsed. */
  function settingsIn(args: readonly string[] | undefined): unknown {
    const index = args?.indexOf("--settings") ?? -1;
    return index === -1 ? undefined : JSON.parse(args?.[index + 1] ?? "");
  }

  it("lists the provider's real models in /model through the launch's one --settings value", () => {
    const { args } = spawnedWith(codexProvider, ["--print"]);

    expect(args?.filter((token) => token === "--settings")).toHaveLength(1);
    expect(settingsIn(args)).toMatchObject({ modelPicker: { replaceBuiltInOptions: true, options: [{ model: "p/big" }, { model: "p/mid" }, { model: "p/small" }] } });
  });

  it("carries a supervised launch's hooks and the picker in the same --settings value", () => {
    const { args } = spawnedWith(codexProvider, ["--print"], { sessionId: "11111111-1111-4111-8111-111111111111", conversation: "start", settings: '{"hooks":{"Stop":[]}}' });

    expect(args?.filter((token) => token === "--settings")).toHaveLength(1);
    expect(settingsIn(args)).toMatchObject({ hooks: { Stop: [] }, modelPicker: { replaceBuiltInOptions: true } });
  });

  describe("a provider's fetched catalogue", () => {
    const catalogued = { ...plainProvider, catalogue: { tier: "sonnet", exclude: ["*air"] } };
    const cacheFile = `${FAKE_HOME}/.agent-shim/catalogues/p.json`;
    const cache = JSON.stringify({ fetchedAt: 1, url: "https://api.z.ai/api/anthropic/v1/models", models: [{ id: "glm-5" }, { id: "glm-air" }, { id: "glm-4" }] });

    it("lists the models the door last fetched, after the provider's own filters", () => {
      const { args } = spawnedWith(catalogued, ["--print"], undefined, { [cacheFile]: cache });

      expect(settingsIn(args)).toMatchObject({ modelPicker: { replaceBuiltInOptions: true, options: [{ model: "p/glm-4" }, { model: "p/glm-5" }] } });
    });

    it("keeps Claude Code's own picker until a catalogue has been fetched", () => {
      expect(spawnedWith(catalogued, ["--print"]).args).toEqual(["--print"]);
    });

    it("keeps it when the cache file is not a catalogue", () => {
      expect(spawnedWith(catalogued, ["--print"], undefined, { [cacheFile]: "{}" }).args).toEqual(["--print"]);
    });

    it("lists nothing from a cache for a provider that did not opt in", () => {
      expect(spawnedWith(plainProvider, ["--print"], undefined, { [cacheFile]: cache }).args).toEqual(["--print"]);
    });
  });

  it("places the settings before a -- terminator", () => {
    const { args } = spawnedWith(codexProvider, ["--print", "--", "mcp"]);

    expect(args?.indexOf("--settings")).toBeLessThan(args?.indexOf("--") ?? -1);
    expect(args?.slice(args.indexOf("--"))).toEqual(["--", "mcp"]);
  });

  it("adds nothing for a provider that names no model of its own", () => {
    expect(spawnedWith(plainProvider, ["--print"]).args).toEqual(["--print"]);
  });

  it("leaves a caller's own --settings alone and says /model keeps Claude Code's names", () => {
    const { args, infos } = spawnedWith(codexProvider, ["--settings", "mine.json", "--print"]);

    expect(args).toEqual(["--settings", "mine.json", "--print"]);
    expect(infos.some((line) => line.includes("--settings was passed"))).toBe(true);
  });
});

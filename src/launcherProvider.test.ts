import { describe, expect, it } from "vitest";

import { PROVIDER_MISSING_TOKEN_EXIT } from "./providers";
import {
  createFakeFarmFs, discovered, FAKE_HOME, fakeFarm, fakeFs, fakeLog, fakeProc, fakeRun, fakeSpawn, paths, runAndCaptureExit, spawnedEnv,
} from "./test-helpers";

describe("runLauncher provider selection", () => {
  const providerZ = {
    displayName: "GLM",
    baseUrl: "https://api.z.ai/api/anthropic",
    tokenEnv: "Z_API_TOKEN",
    env: { ANTHROPIC_MODEL: "glm-4.6" },
  };
  const providerO = {
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    tokenEnv: "OPENROUTER_API_KEY",
  };

  it("launches through a provider selected by the --provider flag", () => {
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/z.json`]: providerZ }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z" }, ["--provider", "z", "--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync).toHaveBeenCalledWith(discovered.path, ["--print"], {
      stdio: "inherit",
      env: {
        Z_API_TOKEN: "tok-z",
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "tok-z",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: "glm-4.6",
        CLAUDE_USE_PROVIDER: "GLM",
      },
    });
  });

  it("refuses with exit 1 and names the known providers when the provider is unknown", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({
        [`${FAKE_HOME}/.claude-use/providers/z.json`]: providerZ,
        [`${FAKE_HOME}/.claude-use/providers/o.json`]: providerO,
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

  it("refuses with exit 64 when the provider's token environment variable is unset or empty", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/z.json`]: providerZ }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "" }, ["--provider", "z"]),
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(PROVIDER_MISSING_TOKEN_EXIT);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors).toEqual(["claude-use: provider z needs Z_API_TOKEN set in your environment"]);
  });

  it("launches a fixed-credential provider without tokenEnv, passing the guard and setting the token from its env", () => {
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({
        [`${FAKE_HOME}/.claude-use/providers/codex.json`]: {
          displayName: "Codex",
          baseUrl: "http://127.0.0.1:18789",
          env: { ANTHROPIC_AUTH_TOKEN: "codex-subscription-local", ANTHROPIC_API_KEY: "" },
        },
      }),
      spawn,
      proc: fakeProc({}, ["--provider", "codex", "--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });

    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:18789");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("codex-subscription-local");
    expect(env.CLAUDE_USE_PROVIDER).toBe("Codex");
  });

  it("resolves a provider pinned by a cascade layer when no flag was given", () => {
    const fs = createFakeFarmFs({});
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/o.json`]: providerO }),
      spawn,
      proc: fakeProc({ OPENROUTER_API_KEY: "tok-o" }, ["@work"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs, { launch: { provider: "o" } }),
    });

    const env = spawnedEnv(spawn);
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${FAKE_HOME}/.claude-use/identities/work`);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-o");
    expect(env.CLAUDE_USE_PROVIDER).toBe("OpenRouter");
  });

  it("launches --identity plus --provider: the identity's own farm directory, the provider's endpoint and token", () => {
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/z.json`]: providerZ }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z" }, ["--identity", "work", "--provider", "z", "-p", "say hi"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync.mock.calls[0]?.[1]).toEqual(["-p", "say hi"]);
    const env = spawnedEnv(spawn);
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${FAKE_HOME}/.claude-use/identities/work`);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-z");
  });

  it("lets --no-provider opt one launch out of the cascade's provider selection", () => {
    const fs = createFakeFarmFs({});
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/o.json`]: providerO }),
      spawn,
      proc: fakeProc({}, ["@work", "--no-provider"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs, { launch: { provider: "o" } }),
    });

    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_USE_PROVIDER).toBeUndefined();
  });

  it("lets a --provider flag beat the cascade's own provider selection", () => {
    const fs = createFakeFarmFs({});
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({
        [`${FAKE_HOME}/.claude-use/providers/z.json`]: providerZ,
        [`${FAKE_HOME}/.claude-use/providers/o.json`]: providerO,
      }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z", OPENROUTER_API_KEY: "tok-o" }, ["@work", "--provider", "z"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs, { launch: { provider: "o" } }),
    });

    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-z");
  });

  it("does not trip the ambient-credential guard when a provider supplies the child's token", () => {
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/z.json`]: providerZ }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z", ANTHROPIC_AUTH_TOKEN: "sk-leftover-from-old-wrapper" }, ["--provider", "z"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(0);
    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-z");
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  describe("tokenCommand and authScheme", () => {
    const providerAnthropic = {
      displayName: "Anthropic API",
      baseUrl: "https://api.anthropic.com",
      tokenCommand: ["op", "read", "op://vault/item/field"],
      authScheme: "apiKey",
    };

    it("launches with the command's token as ANTHROPIC_API_KEY and only the child holding it, despite ambient credentials", () => {
      const spawn = fakeSpawn();
      const run = fakeRun("sk-ant-REDACTED\n");

      const code = runAndCaptureExit({
        paths,
        fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/anthropic-api.json`]: providerAnthropic }),
        spawn,
        proc: fakeProc({ ANTHROPIC_API_KEY: "sk-ambient-key", ANTHROPIC_AUTH_TOKEN: "sk-ambient-bearer" }, ["--provider", "anthropic-api", "--print"]),
        log: fakeLog(),
        resolveClaudeBinary: () => discovered,
        run,
      });

      expect(code).toBe(0);
      expect(run.run).toHaveBeenCalledExactlyOnceWith("op", ["read", "op://vault/item/field"]);
      const env = spawnedEnv(spawn);
      expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-REDACTED");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("");
    });

    it("keeps a bearer provider's token command output in ANTHROPIC_AUTH_TOKEN", () => {
      const spawn = fakeSpawn();

      runAndCaptureExit({
        paths,
        fs: fakeFs({
          [`${FAKE_HOME}/.claude-use/providers/z.json`]: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", tokenCommand: ["op", "read", "ref"] },
        }),
        spawn,
        proc: fakeProc({}, ["--provider", "z"]),
        log: fakeLog(),
        resolveClaudeBinary: () => discovered,
        run: fakeRun("tok-z\n"),
      });

      const env = spawnedEnv(spawn);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-z");
      expect(env.ANTHROPIC_API_KEY).toBe("");
    });

    it("refuses with exit 64 before spawning when the token command fails, without logging its output", () => {
      const spawn = fakeSpawn();
      const log = fakeLog();

      const code = runAndCaptureExit({
        paths,
        fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/anthropic-api.json`]: providerAnthropic }),
        spawn,
        proc: fakeProc({}, ["--provider", "anthropic-api"]),
        log,
        resolveClaudeBinary: () => discovered,
        run: fakeRun("sk-ant-REDACTED", 1),
      });

      expect(code).toBe(PROVIDER_MISSING_TOKEN_EXIT);
      expect(spawn.spawnSync).not.toHaveBeenCalled();
      expect(log.errors).toEqual(["claude-use: provider anthropic-api: token command op exited with status 1"]);
    });

    it("refuses with exit 64 when the token command prints nothing", () => {
      const spawn = fakeSpawn();

      const code = runAndCaptureExit({
        paths,
        fs: fakeFs({ [`${FAKE_HOME}/.claude-use/providers/anthropic-api.json`]: providerAnthropic }),
        spawn,
        proc: fakeProc({}, ["--provider", "anthropic-api"]),
        log: fakeLog(),
        resolveClaudeBinary: () => discovered,
        run: fakeRun("\n"),
      });

      expect(code).toBe(PROVIDER_MISSING_TOKEN_EXIT);
      expect(spawn.spawnSync).not.toHaveBeenCalled();
    });

    it("still refuses an ambient ANTHROPIC_API_KEY when no provider is selected", () => {
      const spawn = fakeSpawn();
      const log = fakeLog();

      const code = runAndCaptureExit({
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

    const code = runAndCaptureExit({
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
});

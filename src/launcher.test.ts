import { describe, expect, it, vi, type Mock } from "vitest";

import { runLauncher, type FarmRuntime, type RunLauncherParams } from "./launcher";
import { identityLockPath } from "./launcher/lock";
import { PROVIDER_MISSING_TOKEN_EXIT } from "./providers";
import type { FsPort, HeadroomPort, LogPort, ProcPort, SpawnPort, SpawnResult } from "./launcher/ports";
import { buildLayoutPaths } from "./paths";
import type { CascadeInput } from "./resolve/walk";
import { createFakeFarmFs, fakeSleep, FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, shippedClassification, type FakeFarmFs } from "./test-helpers";
import type { DiscoveredClaudeBinary } from "./versionDiscovery";

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process would exit with code ${String(code)}`);
  }
}

const paths = buildLayoutPaths("/home/testuser/.claude-use");

function fakeProc(env: Readonly<Record<string, string | undefined>>, argv: readonly string[]): ProcPort {
  return {
    env,
    argv,
    exit: (code: number): never => {
      throw new ExitCalled(code);
    },
  };
}

function fakeFs(files: Record<string, unknown>): FsPort {
  return {
    readFileUtf8: (filePath) => {
      const value = files[filePath];
      return typeof value === "string" ? value : undefined;
    },
    readConfigFile: (filePath) => {
      const value = files[filePath];
      return value === undefined || typeof value === "string" ? undefined : value;
    },
    readdir: (dir) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => file.slice(dir.length + 1).split("/")[0] ?? "")
        .filter((name) => name !== ""),
  };
}

function fakeLog(): LogPort & { infos: string[]; warns: string[]; errors: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warns,
    errors,
    info: (message) => { infos.push(message); },
    warn: (message) => { warns.push(message); },
    error: (message) => { errors.push(message); },
  };
}

function fakeSpawn(result: SpawnResult = { status: 0, signal: null }): SpawnPort & { spawnSync: Mock<SpawnPort["spawnSync"]> } {
  return { spawnSync: vi.fn<SpawnPort["spawnSync"]>().mockReturnValue(result) };
}

/** The env the child was spawned with, from the first spawn call: for tests that assert a few specific keys of an otherwise large environment. */
function spawnedEnv(spawn: ReturnType<typeof fakeSpawn>): Record<string, string | undefined> {
  const call = spawn.spawnSync.mock.calls[0];
  if (call === undefined) {
    throw new Error("expected spawnSync to have been called");
  }
  const options = call[2];
  return options.env;
}

const discovered: DiscoveredClaudeBinary = { path: "/home/testuser/.local/share/claude/versions/2.1.0", source: "versions-dir", version: "2.1.0" };

/** The loopback port the fake headroom daemon pretends to listen on. */
const HEADROOM_PORT = 8123;
const HEADROOM_MITM_PORT = 8124;
/** A second port, so one test can prove the daemon in use is the one ensure() reported. */
const OTHER_HEADROOM_PORT = 9999;

function runAndCaptureExit(params: RunLauncherParams): number {
  try {
    runLauncher(params);
  } catch (error) {
    if (error instanceof ExitCalled) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected runLauncher to reach spawnClaude's proc.exit");
}

describe("runLauncher", () => {
  it("refuses to launch and never spawns when the ambient-credential guard fails", () => {
    const proc = fakeProc({ ANTHROPIC_API_KEY: "sk-real-key" }, []);
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toContain("ANTHROPIC_API_KEY");
  });

  it("spawns with the real claude binary and default-off flags on a bare launch with no identity", () => {
    const proc = fakeProc({}, ["--print", "hello"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(0);
    expect(spawn.spawnSync).toHaveBeenCalledWith(discovered.path, ["--print", "hello"], {
      stdio: "inherit",
      env: {},
    });
  });

  it("strips a leading @name identity token and sets CLAUDE_CONFIG_DIR to that identity's own directory", () => {
    const proc = fakeProc({}, ["@work", "--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync).toHaveBeenCalledWith(
      discovered.path,
      ["--print"],
      { stdio: "inherit", env: { CLAUDE_CONFIG_DIR: "/home/testuser/.claude-use/identities/work" } },
    );
  });

  it("leaves CLAUDE_CONFIG_DIR untouched and still runs the ambient-credential guard when the escape hatch applies", () => {
    const proc = fakeProc(
      { CLAUDE_CONFIG_DIR: "/somewhere/explicit", ANTHROPIC_API_KEY: "sk-real-key" },
      ["@work", "--print"],
    );
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    // The guard still fires even though CLAUDE_CONFIG_DIR is already set — it's a credential-isolation check, not an identity/config-dir selection check, so it is not bypassed by the escape hatch.
    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
  });

  it("spawns with the already-set CLAUDE_CONFIG_DIR untouched once the guard passes under the escape hatch", () => {
    const proc = fakeProc({ CLAUDE_CONFIG_DIR: "/somewhere/explicit" }, ["@work", "--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync).toHaveBeenCalledWith(discovered.path, ["--print"], {
      stdio: "inherit",
      env: { CLAUDE_CONFIG_DIR: "/somewhere/explicit" },
    });
  });

  it("allows an ambient credential through when the loaded identity's own allowAmbientCredential is true", () => {
    const proc = fakeProc({ ANTHROPIC_API_KEY: "sk-real-key" }, ["@work", "--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({
        "/home/testuser/.claude-use/identities/work/identity.json": {
          name: "work",
          allowAmbientCredential: true,
        },
      }),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(0);
    expect(spawn.spawnSync).toHaveBeenCalled();
  });

  it("warns but proceeds when the resolved identity has no identity.json on disk yet", () => {
    const proc = fakeProc({}, ["@ghost", "--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(0);
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toContain("ghost");
    expect(spawn.spawnSync).toHaveBeenCalled();
  });

  it("falls back to the persisted active-identity file when no argv/env/directory-pin identity applies", () => {
    const proc = fakeProc({}, ["--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({ "/home/testuser/.claude-use/active-identity": "personal\n" }),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync).toHaveBeenCalledWith(discovered.path, ["--print"], {
      stdio: "inherit",
      env: { CLAUDE_CONFIG_DIR: "/home/testuser/.claude-use/identities/personal" },
    });
  });

  it("builds the final argv as toolFlags, then extraFlags, then passthrough, honouring both env-var flag escape hatches", () => {
    const proc = fakeProc(
      { CLAUDE_USE_SKIP_PERMISSIONS: "1", CLAUDE_USE_REMOTE_CONTROL: "1", CLAUDE_EXTRA_FLAGS: "--continue continue" },
      ["--verbose"],
    );
    const log = fakeLog();
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    const call = vi.mocked(spawn.spawnSync).mock.calls[0];
    if (call === undefined) {
      throw new Error("expected spawnSync to have been called");
    }
    const [command, args, options] = call;
    expect(command).toBe(discovered.path);
    expect(args).toEqual(["--dangerously-skip-permissions", "--remote-control=", "--continue", "continue", "--verbose"]);
    expect(options.stdio).toBe("inherit");
    expect(options.env).toMatchObject({ CLAUDE_EXTRA_FLAGS: "--continue continue" });
  });

  it("propagates the real binary's own exit code when spawning succeeds but the child exits non-zero", () => {
    const proc = fakeProc({}, []);
    const log = fakeLog();
    const spawn = fakeSpawn({ status: 2, signal: null });

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(2);
  });
});

function fakeFarm(fs: FakeFarmFs, cliOverride?: CascadeInput["cliOverride"]): FarmRuntime {
  return {
    fs,
    claudeHome: FAKE_CLAUDE_HOME,
    home: FAKE_HOME,
    cwd: `${FAKE_HOME}/work`,
    classification: { defaults: shippedClassification },
    loadCascade: () => ({
      home: FAKE_HOME,
      loadProfile: () => undefined,
      levels: [],
      ...(cliOverride === undefined ? {} : { cliOverride }),
    }),
    now: () => FAKE_NOW_MS,
    uniqueSuffix: "launcher-test",
    lock: { pid: 42, isRunning: () => true, sleep: fakeSleep().sleep, maxAttempts: 2 },
  };
}

describe("runLauncher headroom routing", () => {
  function fakeHeadroomPort(
    port = HEADROOM_PORT,
    projectId = "/home/testuser/work/repo",
    mitmPort = HEADROOM_MITM_PORT,
  ): HeadroomPort & { readonly ensures: number; readonly releases: number } {
    let ensures = 0;
    let releases = 0;
    return {
      get ensures() {
        return ensures;
      },
      get releases() {
        return releases;
      },
      ensure: () => {
        ensures += 1;
        return { port, mitmPort, caCertPath: "/home/testuser/.claude-use/headroom/ca/ca.pem", projectId };
      },
      release: () => {
        releases += 1;
      },
    };
  }

  it("brings the daemon up via the injected port and wires an OAuth launch to the MITM proxy when CLAUDE_USE_HEADROOM=1", () => {
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ CLAUDE_USE_HEADROOM: "1" }, ["--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      headroom,
    });

    expect(headroom.ensures).toBe(1);
    const env = spawnedEnv(spawn);
    // No provider resolved, so this is an OAuth launch: the base URL stays unset (Remote Control requires the real API) and routing happens at the HTTPS_PROXY layer.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8124");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/home/testuser/.claude-use/headroom/ca/ca.pem");
    expect(env.HEADROOM_PROXY_URL).toBe("http://127.0.0.1:8123");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-headroom-project-id: /home/testuser/work/repo");
    expect(headroom.releases).toBeGreaterThan(0);
  });

  it("resolves headroom through the cascade like any other launch flag", () => {
    const fs = createFakeFarmFs({});
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort(OTHER_HEADROOM_PORT, "/repo");

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({}, ["@work"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs, { launch: { headroom: true } }),
      headroom,
    });

    expect(headroom.ensures).toBe(1);
    expect(spawnedEnv(spawn).HEADROOM_PROXY_URL).toBe("http://127.0.0.1:9999");
  });

  it("resolves headroom from the cascade on an escape-hatch launch, where no farm resync runs", () => {
    const fs = createFakeFarmFs({});
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ CLAUDE_CONFIG_DIR: "/somewhere/explicit" }, ["--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs, { launch: { headroom: true } }),
      headroom,
    });

    // No identity resolved under the escape hatch, so no farm resync happens; the launch flags still come from the cascade, the same way provider selection does. With no provider selected this is an OAuth launch, so routing shows up as HTTPS_PROXY rather than a base-URL override.
    expect(headroom.ensures).toBe(1);
    expect(spawnedEnv(spawn).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(spawnedEnv(spawn).HTTPS_PROXY).toBe("http://127.0.0.1:8124");
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe("/somewhere/explicit");
  });

  it("routes a provider through headroom: proxy base URL, provider upstream in the per-request header, token from the provider", () => {
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort();

    runAndCaptureExit({
      paths,
      fs: fakeFs({
        [`${FAKE_HOME}/.claude-use/providers/z.json`]: {
          displayName: "GLM",
          baseUrl: "https://api.z.ai/api/anthropic",
          tokenEnv: "Z_API_TOKEN",
        },
      }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z", CLAUDE_USE_HEADROOM: "1" }, ["--provider", "z"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      headroom,
    });

    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8123");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-z");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-headroom-project-id: /home/testuser/work/repo\nx-headroom-base-url: https://api.z.ai/api/anthropic",
    );
  });

  it("refuses loudly when headroom resolved on but no headroom port was wired", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ CLAUDE_USE_HEADROOM: "1" }, ["--print"]),
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain("no headroom port");
  });

  it("never touches the headroom port when headroom resolved off", () => {
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({}, ["--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      headroom,
    });

    expect(headroom.ensures).toBe(0);
    expect(headroom.releases).toBe(0);
    expect(spawnedEnv(spawn).ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

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

describe("runLauncher farm resync", () => {
  it("resyncs the identity's farm before spawning, and applies the cascade's own launch flags", () => {
    const fs = createFakeFarmFs({
      [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit",
      [`${FAKE_CLAUDE_HOME}/.credentials.json`]: "a real token",
    });
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({}, ["@work"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs, { launch: { skipPermissions: true } }),
    });

    expect(fs.linkTarget(`${FAKE_HOME}/.claude-use/identities/work/skills`)).toBe(`${FAKE_CLAUDE_HOME}/skills`);
    expect(fs.lstat(`${FAKE_HOME}/.claude-use/identities/work/.credentials.json`)).toBeUndefined();
    expect(spawn.spawnSync).toHaveBeenCalledWith(discovered.path, ["--dangerously-skip-permissions"], {
      stdio: "inherit",
      env: { CLAUDE_CONFIG_DIR: `${FAKE_HOME}/.claude-use/identities/work` },
    });
  });

  it("threads --category/--share/--hide argv flags and --config-profile into the farm's loadCascade call", () => {
    const fs = createFakeFarmFs({});
    const loadCascade = vi.fn((baseConfigProfile: string | undefined) => ({
      home: FAKE_HOME,
      loadProfile: () => undefined,
      levels: [],
      ...(baseConfigProfile === undefined ? {} : { baseConfigProfile }),
    }));
    const farm: FarmRuntime = { ...fakeFarm(fs), loadCascade };

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn: fakeSpawn(),
      proc: fakeProc(
        {},
        ["@work", "--config-profile", "strict", "--category", "history=true,knowledge=false", "--share", "knowledge/skills/commit", "--hide", "history/projects/x"],
      ),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm,
    });

    expect(loadCascade).toHaveBeenCalledWith("strict", {
      categories: { history: true, knowledge: false },
      entries: { "knowledge/skills/commit": true, "history/projects/x": false },
    });
  });

  it("merges CLAUDE_USE_CATEGORY_OVERRIDE/CLAUDE_USE_ENTRY_OVERRIDE env vars with any --category/--share/--hide flags, flags winning", () => {
    const fs = createFakeFarmFs({});
    const loadCascade = vi.fn((baseConfigProfile: string | undefined) => ({
      home: FAKE_HOME,
      loadProfile: () => undefined,
      levels: [],
      ...(baseConfigProfile === undefined ? {} : { baseConfigProfile }),
    }));
    const farm: FarmRuntime = { ...fakeFarm(fs), loadCascade };

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn: fakeSpawn(),
      proc: fakeProc(
        { CLAUDE_USE_CATEGORY_OVERRIDE: "history=false", CLAUDE_USE_ENTRY_OVERRIDE: "knowledge/skills/commit=false" },
        ["@work", "--category", "history=true"],
      ),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm,
    });

    expect(loadCascade).toHaveBeenCalledWith(undefined, {
      categories: { history: true },
      entries: { "knowledge/skills/commit": false },
    });
  });

  it("does not touch any farm when the CLAUDE_CONFIG_DIR escape hatch applies", () => {
    const fs = createFakeFarmFs({ [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit" });
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ CLAUDE_CONFIG_DIR: "/somewhere/explicit" }, ["@work"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs),
    });

    expect(fs.writes).toEqual([]);
    expect(spawn.spawnSync).toHaveBeenCalled();
  });

  it("does not build a farm for a bare launch that resolved no identity at all", () => {
    const fs = createFakeFarmFs({ [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit" });

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn: fakeSpawn(),
      proc: fakeProc({}, []),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs),
    });

    expect(fs.writes).toEqual([]);
  });

  it("refuses to launch rather than racing a concurrent resync of the same identity", () => {
    const fs = createFakeFarmFs({ [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit" });
    fs.mkdirp(`${FAKE_HOME}/.claude-use/identities`);
    fs.writeFileUtf8(
      identityLockPath(`${FAKE_HOME}/.claude-use/identities`, "work"),
      JSON.stringify({ identity: "work", pid: 99, token: "sibling", acquiredAtMs: FAKE_NOW_MS }),
    );
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({}, ["@work"]),
      log,
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs),
    });

    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain("already running for identity");
  });
});

describe("runLauncher crash recovery ordering", () => {
  it("restores a farm left mid-swap before reading the identity.json that lives inside it", () => {
    const identitiesDir = `${FAKE_HOME}/.claude-use/identities`;
    const fs = createFakeFarmFs({
      [`${FAKE_CLAUDE_HOME}/skills/commit/SKILL.md`]: "commit",
      // Exactly what a crash between the swap's two renames leaves: no farm, and everything in a superseded copy.
      [`${identitiesDir}/.work.previous.crashed/identity.json`]: '{"name":"work"}',
    });

    let identityWasReadableWhenLoaded: boolean | undefined;
    const fsPort: FsPort = {
      readFileUtf8: () => undefined,
      readConfigFile: (filePath) => {
        if (filePath === `${identitiesDir}/work/identity.json`) {
          identityWasReadableWhenLoaded = fs.lstat(filePath) !== undefined;
        }
        return undefined;
      },
      readdir: () => [],
    };

    runAndCaptureExit({
      paths,
      fs: fsPort,
      spawn: fakeSpawn(),
      proc: fakeProc({}, ["@work"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs),
    });

    expect(identityWasReadableWhenLoaded).toBe(true);
    expect(fs.readFileUtf8(`${identitiesDir}/work/identity.json`)).toBe('{"name":"work"}');
  });
});

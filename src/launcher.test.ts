import { describe, expect, it, vi } from "vitest";

import type { FarmRuntime } from "./launcher";
import { ConflictingIdentityError } from "./launcher/argv";
import { InvalidClaudeVersionError } from "./launcher/claudeVersion";
import { ClaudeVersionNotInstalledError, type ClaudeBinaryResolver } from "./versionDiscovery";
import { identityLockPath } from "./launcher/lock";
import type { FsPort, HeadroomPort } from "./launcher/ports";
import { prepareLaunch, runLauncher } from "./launcher";
import { FAKE_CLAUDE_HOME, FAKE_HOME, FAKE_NOW_MS, createFakeFarmFs, discovered, fakeCredentials, fakeFarm, fakeFrontDoorPort, fakeFs, fakeLog, fakeProc, fakeSpawn, paths, runAndCaptureExit, spawnedEnv } from "./test-helpers";

/** The unix socket the fake headroom daemon pretends to serve on. */
const HEADROOM_SOCKET = "/home/testuser/.agent-shim/headroom/run/8123.sock";
/** A second socket, so one test can prove the daemon in use is the one ensure() reported. */
const OTHER_HEADROOM_SOCKET = "/home/testuser/.agent-shim/headroom/run/9999.sock";

describe("prepareLaunch", () => {
  it("returns the binary, arguments and environment to spawn without spawning anything", () => {
    const spawn = fakeSpawn();
    const plan = prepareLaunch({
      paths,
      fs: fakeFs({}),
      proc: fakeProc({ HOME: "/home/testuser" }, ["--print", "hello"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });
    expect(plan.bin).toBe(discovered.path);
    expect(plan.args).toEqual(["--print", "hello"]);
    expect(plan.env).toMatchObject({ HOME: "/home/testuser" });
    expect(spawn.spawnSync).not.toHaveBeenCalled();
  });

  it("returns a release that is safe to call more than once, including when the launch registered with no daemon", () => {
    const plan = prepareLaunch({
      paths,
      fs: fakeFs({}),
      proc: fakeProc({}, ["--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });
    plan.release();
    expect(() => {
      plan.release();
    }).not.toThrow();
  });
});

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
      { stdio: "inherit", env: { CLAUDE_CONFIG_DIR: "/home/testuser/.agent-shim/identities/work" } },
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
        "/home/testuser/.agent-shim/identities/work/identity.json": {
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

  it.each([
    ["a leading @name", {}, ["@ghost", "--print"]],
    ["--identity", {}, ["--identity", "ghost", "--print"]],
    ["AGENT_SHIM_IDENTITY", { AGENT_SHIM_IDENTITY: "ghost" }, ["--print"]],
  ])("refuses, naming it, an identity selected by %s that has no identity.json, rather than creating a new login", (_how, env, argv) => {
    const log = fakeLog();
    const spawn = fakeSpawn();

    const code = runAndCaptureExit({ paths, fs: fakeFs({}), spawn, proc: fakeProc(env, argv), log, resolveClaudeBinary: () => discovered });

    expect(code).toBe(1);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toContain('no identity named "ghost"');
    expect(log.errors[0]).toContain("agent-shim identity add ghost");
    expect(spawn.spawnSync).not.toHaveBeenCalled();
  });

  it("refuses a selected configuration profile that has no file, unless the terminal user chose to launch without it", () => {
    const run = (allowMissingConfigProfile: boolean): { code: number; log: ReturnType<typeof fakeLog> } => {
      const log = fakeLog();
      const code = runAndCaptureExit({
        paths,
        fs: fakeFs({}),
        spawn: fakeSpawn(),
        proc: fakeProc({}, ["--config-profile", "missing", "--print"]),
        log,
        resolveClaudeBinary: () => discovered,
        allowMissingConfigProfile,
      });
      return { code, log };
    };

    const refused = run(false);
    expect(refused.code).toBe(1);
    expect(refused.log.errors[0]).toContain('no configuration profile named "missing" (selected via cli-flag)');
    expect(run(true).code).toBe(0);
  });

  it("takes --identity as the explicit form of @name, and refuses two different names", () => {
    const spawn = fakeSpawn();
    runAndCaptureExit({ paths, fs: fakeFs({}), spawn, proc: fakeProc({}, ["--identity", "work", "--print"]), log: fakeLog(), resolveClaudeBinary: () => discovered });
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe("/home/testuser/.agent-shim/identities/work");

    expect(() => {
      runLauncher({ paths, fs: fakeFs({}), spawn: fakeSpawn(), proc: fakeProc({}, ["@work", "--identity", "personal"]), log: fakeLog(), resolveClaudeBinary: () => discovered });
    }).toThrow(ConflictingIdentityError);
  });

  it("forwards launch flags after a double-dash terminator to claude untouched", () => {
    const spawn = fakeSpawn();
    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({}, ["mcp", "add", "n", "--", "cmd", "--provider", "x", "--identity", "y"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });
    expect(spawn.spawnSync.mock.calls[0]?.[1]).toEqual(["mcp", "add", "n", "--", "cmd", "--provider", "x", "--identity", "y"]);
  });

  it("applies --skip-permissions and --remote-control flags, which outrank their env variables", () => {
    const spawn = fakeSpawn();
    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ AGENT_SHIM_SKIP_PERMISSIONS: "0" }, ["--skip-permissions", "--remote-control", "--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
    });
    expect(spawn.spawnSync.mock.calls[0]?.[1]).toEqual(["--dangerously-skip-permissions", "--remote-control=", "--print"]);
  });

  it("falls back to the persisted active-identity file when no argv/env/directory-pin identity applies", () => {
    const proc = fakeProc({}, ["--print"]);
    const log = fakeLog();
    const spawn = fakeSpawn();

    runAndCaptureExit({
      paths,
      fs: fakeFs({ "/home/testuser/.agent-shim/active-identity": "personal\n" }),
      spawn,
      proc,
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(spawn.spawnSync).toHaveBeenCalledWith(discovered.path, ["--print"], {
      stdio: "inherit",
      env: { CLAUDE_CONFIG_DIR: "/home/testuser/.agent-shim/identities/personal" },
    });
  });

  it("builds the final argv as toolFlags, then extraFlags, then passthrough, honouring both env-var flag escape hatches", () => {
    const proc = fakeProc(
      { AGENT_SHIM_SKIP_PERMISSIONS: "1", AGENT_SHIM_REMOTE_CONTROL: "1", CLAUDE_EXTRA_FLAGS: "--continue continue" },
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

describe("runLauncher headroom routing", () => {
  function fakeHeadroomPort(socketPath = HEADROOM_SOCKET, projectId = "/home/testuser/work/repo"): HeadroomPort & { readonly ensures: number; readonly releases: number; readonly routesProvider: readonly boolean[] } {
    let ensures = 0;
    let releases = 0;
    const routesProvider: boolean[] = [];
    return {
      get ensures() {
        return ensures;
      },
      get routesProvider() {
        return routesProvider;
      },
      get releases() {
        return releases;
      },
      ensure: (options) => {
        ensures += 1;
        routesProvider.push(options.routesProvider);
        return { socketPath, projectId };
      },
      release: () => {
        releases += 1;
      },
    };
  }

  /** The session headers a headroom launch injects, with the random session id matched rather than known: identity-less here, so the session line leads. */
  function injectedSessionHeaders(env: Readonly<Record<string, string | undefined>>): string[] {
    const lines = env.ANTHROPIC_CUSTOM_HEADERS?.split("\n") ?? [];
    expect(lines[0]).toMatch(/^x-agent-shim-session: [0-9a-f-]{36}$/);
    return lines.slice(1);
  }

  it("brings the door and the daemon up via their injected ports and wires an OAuth launch to the door's CONNECT surface when AGENT_SHIM_HEADROOM=1", () => {
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort();
    const frontdoor = fakeFrontDoorPort();
    const log = fakeLog();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ AGENT_SHIM_HEADROOM: "1" }, ["--print"]),
      log,
      resolveClaudeBinary: () => discovered,
      frontdoor,
      headroom,
    });

    expect(headroom.ensures).toBe(1);
    const env = spawnedEnv(spawn);
    // No provider resolved, so this is an OAuth launch: the base URL stays unset (Remote Control requires the real API) and routing happens at the HTTPS_PROXY layer, pointing at the door's CONNECT surface.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://agent-shim:launch-token-for-tests@127.0.0.1:4200");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/home/testuser/.agent-shim/frontdoor/ca/ca.pem");
    // The daemon serves only on its unix socket, which the door's hop dials: nothing in the child's environment names it.
    expect(Object.keys(env).filter((name) => name.startsWith("HEADROOM_"))).toEqual([]);
    expect(log.infos.join("\n")).toContain(`with headroom on unix socket ${HEADROOM_SOCKET}`);
    expect(injectedSessionHeaders(env)).toEqual(["x-agent-shim-auth: launch-token-for-tests", "x-agent-shim-headroom: 1", "x-headroom-project-id: /home/testuser/work/repo"]);
    expect(headroom.releases).toBeGreaterThan(0);
    expect(frontdoor.releases()).toBeGreaterThan(0);
  });

  it("resolves headroom through the cascade like any other launch flag", () => {
    const fs = createFakeFarmFs({});
    const spawn = fakeSpawn();
    const log = fakeLog();
    const headroom = fakeHeadroomPort(OTHER_HEADROOM_SOCKET, "/repo");

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({}, ["@work"]),
      log,
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(fs, { launch: { headroom: true } }),
      frontdoor: fakeFrontDoorPort(),
      headroom,
    });

    expect(headroom.ensures).toBe(1);
    expect(log.infos.join("\n")).toContain(`with headroom on unix socket ${OTHER_HEADROOM_SOCKET} (OAuth via the door's CONNECT surface on 127.0.0.1:4200, project /repo)`);
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
      frontdoor: fakeFrontDoorPort(),
      headroom,
    });

    // No identity resolved under the escape hatch, so no farm resync happens; the launch flags still come from the cascade, the same way provider selection does. With no provider selected this is an OAuth launch, so routing shows up as HTTPS_PROXY rather than a base-URL override.
    expect(headroom.ensures).toBe(1);
    expect(spawnedEnv(spawn).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(spawnedEnv(spawn).HTTPS_PROXY).toBe("http://agent-shim:launch-token-for-tests@127.0.0.1:4200");
    expect(spawnedEnv(spawn).CLAUDE_CONFIG_DIR).toBe("/somewhere/explicit");
  });

  it("routes a provider through the door with headroom: the door is the base URL, the session headers carry the project identity, and the token comes from the provider", () => {
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort();

    runAndCaptureExit({
      paths,
      fs: fakeFs({
        [`${FAKE_HOME}/.agent-shim/providers/z.json`]: {
          displayName: "GLM",
          baseUrl: "https://api.z.ai/api/anthropic",
          credential: { sources: [{ env: "Z_API_TOKEN" }] },
        },
      }),
      spawn,
      proc: fakeProc({ Z_API_TOKEN: "tok-z", AGENT_SHIM_HEADROOM: "1" }, ["--provider", "z"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor: fakeFrontDoorPort(),
      headroom,
      credentials: fakeCredentials(),
    });

    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://127.0.0.1:4100/providers/z");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-z");
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(injectedSessionHeaders(env)).toEqual(["x-agent-shim-auth: launch-token-for-tests", "x-agent-shim-headroom: 1", "x-headroom-project-id: /home/testuser/work/repo"]);
    // The daemon has to admit the door's address for this launch's requests to be accepted, so the ensure step is told a provider is routed.
    expect(headroom.routesProvider).toEqual([true]);
  });

  it("tells the headroom ensure step an OAuth launch routes no provider, since every daemon admits Claude Code's own API", () => {
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort();
    runAndCaptureExit({ paths, fs: fakeFs({}), spawn, proc: fakeProc({ AGENT_SHIM_HEADROOM: "1" }, ["--print"]), log: fakeLog(), resolveClaudeBinary: () => discovered, frontdoor: fakeFrontDoorPort(), headroom });
    expect(headroom.routesProvider).toEqual([false]);
  });

  it("routes an apiKey provider on api.anthropic.com through the door with headroom: the token becomes the API key and the door is the base URL", () => {
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort();

    runAndCaptureExit({
      paths,
      fs: fakeFs({
        [`${FAKE_HOME}/.agent-shim/providers/anthropic-api.json`]: {
          displayName: "Anthropic API",
          baseUrl: "https://api.anthropic.com",
          credential: { sources: [{ command: ["pass", "show", "anthropic"] }], target: "apiKey" },
        },
      }),
      spawn,
      proc: fakeProc({ AGENT_SHIM_HEADROOM: "1" }, ["--provider", "anthropic-api"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor: fakeFrontDoorPort(),
      headroom,
      credentials: fakeCredentials({ command: { stdout: "sk-ant-REDACTED\n" } }),
    });

    const env = spawnedEnv(spawn);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://127.0.0.1:4100/providers/anthropic-api");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-REDACTED");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(injectedSessionHeaders(env)).toEqual(["x-agent-shim-auth: launch-token-for-tests", "x-agent-shim-headroom: 1", "x-headroom-project-id: /home/testuser/work/repo"]);
  });

  it("refuses loudly when headroom resolved on but no front-door port was wired", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ AGENT_SHIM_HEADROOM: "1" }, ["--print"]),
      log,
      resolveClaudeBinary: () => discovered,
    });

    expect(code).toBe(1);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
    expect(log.errors[0]).toContain("no front-door port");
  });

  it("refuses loudly when headroom resolved on, the door is wired, but no headroom port was", () => {
    const spawn = fakeSpawn();
    const log = fakeLog();

    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ AGENT_SHIM_HEADROOM: "1" }, ["--print"]),
      log,
      resolveClaudeBinary: () => discovered,
      frontdoor: fakeFrontDoorPort(),
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

  it("a --no-headroom flag beats the env escape hatch and the cascade", () => {
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({ AGENT_SHIM_HEADROOM: "1" }, ["--no-headroom", "--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      headroom,
    });

    expect(headroom.ensures).toBe(0);
    expect(spawnedEnv(spawn).ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("a --headroom flag turns routing on without the env escape hatch or a cascade setting", () => {
    const spawn = fakeSpawn();
    const headroom = fakeHeadroomPort();

    runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn,
      proc: fakeProc({}, ["--headroom", "--print"]),
      log: fakeLog(),
      resolveClaudeBinary: () => discovered,
      frontdoor: fakeFrontDoorPort(),
      headroom,
    });

    expect(headroom.ensures).toBe(1);
    expect(spawnedEnv(spawn).HTTPS_PROXY).toBe("http://agent-shim:launch-token-for-tests@127.0.0.1:4200");
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

    expect(fs.linkTarget(`${FAKE_HOME}/.agent-shim/identities/work/skills`)).toBe(`${FAKE_CLAUDE_HOME}/skills`);
    expect(fs.lstat(`${FAKE_HOME}/.agent-shim/identities/work/.credentials.json`)).toBeUndefined();
    expect(spawn.spawnSync).toHaveBeenCalledWith(discovered.path, ["--dangerously-skip-permissions"], {
      stdio: "inherit",
      env: { CLAUDE_CONFIG_DIR: `${FAKE_HOME}/.agent-shim/identities/work` },
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
      fs: fakeFs({ [`${paths.configProfilesDir}/strict.json`]: {} }),
      spawn: fakeSpawn(),
      proc: fakeProc(
        {},
        [
          "@work",
          "--config-profile",
          "strict",
          "--category",
          "history=true",
          "--category",
          "knowledge=false",
          "--share",
          "knowledge/skills/commit",
          "--hide",
          "history/projects/x",
        ],
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

  it("merges AGENT_SHIM_CATEGORY_OVERRIDE/AGENT_SHIM_ENTRY_OVERRIDE env vars with any --category/--share/--hide flags, flags winning", () => {
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
        { AGENT_SHIM_CATEGORY_OVERRIDE: "history=false", AGENT_SHIM_ENTRY_OVERRIDE: "knowledge/skills/commit=false" },
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
    fs.mkdirp(`${FAKE_HOME}/.agent-shim/identities`);
    fs.writeFileUtf8(
      identityLockPath(`${FAKE_HOME}/.agent-shim/identities`, "work"),
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
    const identitiesDir = `${FAKE_HOME}/.agent-shim/identities`;
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

describe("runLauncher quota warning", () => {
  const snapshotPath = `${paths.usageSnapshotsDir}/work.json`;
  const HOUR_MS = 3_600_000;
  const lastSeen = new Date(FAKE_NOW_MS - HOUR_MS).toISOString();
  const resetsAt = new Date(FAKE_NOW_MS + HOUR_MS).toISOString();
  const snapshotOf = (status: string): string =>
    JSON.stringify({
      schemaVersion: 1,
      identity: "work",
      updatedAt: lastSeen,
      providers: { anthropic: { lastRequestAt: lastSeen, lastStatus: 200, rateLimit: { observedAt: lastSeen, headers: {}, unified: { sevenDay: { status, resetsAt } } } } },
    });

  function launch(seed: Readonly<Record<string, string>>): { readonly log: ReturnType<typeof fakeLog>; readonly code: number } {
    const log = fakeLog();
    const code = runAndCaptureExit({
      paths,
      fs: fakeFs({}),
      spawn: fakeSpawn(),
      proc: fakeProc({}, ["@work"]),
      log,
      resolveClaudeBinary: () => discovered,
      farm: fakeFarm(createFakeFarmFs(seed)),
    });
    return { log, code };
  }

  it("warns, and still launches, when the identity's last recorded seven-day window was marked exhausted", () => {
    const { log, code } = launch({ [snapshotPath]: snapshotOf("rejected") });
    expect(code).toBe(0);
    expect(log.warns.join("\n")).toContain("identity work: the seven-day quota is exhausted");
  });

  it("stays quiet when the recorded window is allowed", () => {
    const { log, code } = launch({ [snapshotPath]: snapshotOf("allowed") });
    expect(code).toBe(0);
    expect(log.warns.join("\n")).not.toContain("quota");
  });

  it("stays quiet for an identity that has no snapshot yet", () => {
    expect(launch({}).log.warns.join("\n")).not.toContain("quota");
  });

  it("reports an unreadable snapshot instead of treating it as no usage, and still launches", () => {
    const { log, code } = launch({ [snapshotPath]: "{ not json" });
    expect(code).toBe(0);
    expect(log.warns.join("\n")).toContain("not a usage snapshot this agent-shim can read");
  });
});


describe("runLauncher Claude Code version pin", () => {
  const PINNED = "2.1.5";

  function launch(options: { readonly argv?: readonly string[]; readonly env?: Record<string, string>; readonly cascadeVersion?: string; readonly resolver?: ClaudeBinaryResolver }): {
    readonly requests: (Parameters<ClaudeBinaryResolver>[0])[];
    readonly log: ReturnType<typeof fakeLog>;
    readonly spawn: ReturnType<typeof fakeSpawn>;
    readonly run: () => number;
  } {
    const requests: (Parameters<ClaudeBinaryResolver>[0])[] = [];
    const log = fakeLog();
    const spawn = fakeSpawn();
    const resolver: ClaudeBinaryResolver = options.resolver ?? (() => discovered);
    const run = (): number =>
      runAndCaptureExit({
        paths,
        fs: fakeFs({}),
        spawn,
        proc: fakeProc(options.env ?? {}, options.argv ?? ["--print"]),
        log,
        resolveClaudeBinary: (request) => {
          requests.push(request);
          return resolver(request);
        },
        farm: fakeFarm(createFakeFarmFs({}), options.cascadeVersion === undefined ? undefined : { launch: { claudeVersion: options.cascadeVersion } }),
      });
    return { requests, log, spawn, run };
  }

  it("asks discovery for no particular version when nothing pins one", () => {
    const { requests, run, log } = launch({});
    expect(run()).toBe(0);
    expect(requests).toEqual([undefined]);
    expect(log.infos.join("\n")).not.toContain("pinned");
  });

  it.each([
    ["the --claude-version flag", { argv: ["--claude-version", PINNED, "--print"] }, "flag"],
    ["AGENT_SHIM_CLAUDE_VERSION", { env: { AGENT_SHIM_CLAUDE_VERSION: PINNED } }, "environment"],
    ["the cascade's launch.claudeVersion", { cascadeVersion: PINNED }, "cascade"],
  ] as const)("runs the pinned version and says where the pin came from, for %s", (_name, options, source) => {
    const { requests, run, log } = launch(options);
    expect(run()).toBe(0);
    expect(requests).toEqual([{ version: PINNED }]);
    expect(log.infos.join("\n")).toContain(`Claude Code ${PINNED} (pinned by ${source})`);
  });

  it("lets the flag outrank the environment, and the environment outrank the cascade", () => {
    const flag = launch({ argv: ["--claude-version", "2.1.1"], env: { AGENT_SHIM_CLAUDE_VERSION: "2.1.2" }, cascadeVersion: "2.1.3" });
    flag.run();
    expect(flag.requests).toEqual([{ version: "2.1.1" }]);
    const env = launch({ env: { AGENT_SHIM_CLAUDE_VERSION: "2.1.2" }, cascadeVersion: "2.1.3" });
    env.run();
    expect(env.requests).toEqual([{ version: "2.1.2" }]);
  });

  it("refuses a launch whose pin is not installed, spawning nothing", () => {
    const { spawn, run } = launch({
      cascadeVersion: PINNED,
      resolver: () => {
        throw new ClaudeVersionNotInstalledError(PINNED, "/versions", ["2.1.9"]);
      },
    });
    expect(run).toThrow(ClaudeVersionNotInstalledError);
    expect(spawn.spawnSync).not.toHaveBeenCalled();
  });

  it("refuses a malformed environment pin before discovery runs", () => {
    const { requests, run } = launch({ env: { AGENT_SHIM_CLAUDE_VERSION: "latest" } });
    expect(run).toThrow(InvalidClaudeVersionError);
    expect(requests).toEqual([]);
  });
});

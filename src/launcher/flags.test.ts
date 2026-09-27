import { describe, expect, it } from "vitest";

import { buildArgv, buildEnv, buildFlagArgs, resolveLaunchFlags } from "./flags";

describe("resolveLaunchFlags", () => {
  it("defaults both flags to off when nothing sets them — a deliberate change from the legacy always-on script", () => {
    expect(resolveLaunchFlags({ env: {} })).toEqual({ skipPermissions: false, remoteControl: false, headroom: false });
  });

  it("turns skipPermissions on via the CLAUDE_USE_SKIP_PERMISSIONS=1 escape hatch", () => {
    expect(resolveLaunchFlags({ env: { CLAUDE_USE_SKIP_PERMISSIONS: "1" } })).toEqual({
      skipPermissions: true,
      remoteControl: false,
      headroom: false,
    });
  });

  it("turns remoteControl on via the CLAUDE_USE_REMOTE_CONTROL=1 escape hatch", () => {
    expect(resolveLaunchFlags({ env: { CLAUDE_USE_REMOTE_CONTROL: "1" } })).toEqual({
      skipPermissions: false,
      remoteControl: true,
      headroom: false,
    });
  });

  it("does not treat any value other than the literal string '1' as set", () => {
    expect(
      resolveLaunchFlags({ env: { CLAUDE_USE_SKIP_PERMISSIONS: "true", CLAUDE_USE_REMOTE_CONTROL: "0" } }),
    ).toEqual({ skipPermissions: false, remoteControl: false, headroom: false });
  });

  it("honours a cascade value once one is supplied, independent of the env escape hatch", () => {
    expect(resolveLaunchFlags({ env: {}, cascade: { skipPermissions: true, remoteControl: true } })).toEqual({
      skipPermissions: true,
      remoteControl: true,
      headroom: false,
    });
  });

  it("ORs the cascade value with the env escape hatch rather than one overriding the other", () => {
    expect(
      resolveLaunchFlags({ env: { CLAUDE_USE_REMOTE_CONTROL: "1" }, cascade: { skipPermissions: true } }),
    ).toEqual({ skipPermissions: true, remoteControl: true, headroom: false });
  });

  it("turns headroom on via the CLAUDE_USE_HEADROOM=1 escape hatch", () => {
    expect(resolveLaunchFlags({ env: { CLAUDE_USE_HEADROOM: "1" } })).toEqual({
      skipPermissions: false,
      remoteControl: false,
      headroom: true,
    });
  });

  it("resolves headroom from a cascade value and ORs it with the escape hatch", () => {
    expect(resolveLaunchFlags({ env: {}, cascade: { headroom: true } }).headroom).toBe(true);
    expect(resolveLaunchFlags({ env: { CLAUDE_USE_HEADROOM: "0" }, cascade: { headroom: false } }).headroom).toBe(false);
    expect(resolveLaunchFlags({ env: { CLAUDE_USE_HEADROOM: "1" }, cascade: { headroom: false } }).headroom).toBe(true);
  });
});

describe("buildFlagArgs", () => {
  it("emits nothing when both flags are off", () => {
    expect(buildFlagArgs({ skipPermissions: false, remoteControl: false, headroom: false })).toEqual([]);
  });

  it("emits --dangerously-skip-permissions when skipPermissions is on", () => {
    expect(buildFlagArgs({ skipPermissions: true, remoteControl: false, headroom: false })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  it("emits --remote-control= with a literal trailing equals and empty value, never bare --remote-control", () => {
    const args = buildFlagArgs({ skipPermissions: false, remoteControl: true, headroom: false });
    expect(args).toEqual(["--remote-control="]);
    expect(args).not.toContain("--remote-control");
  });

  it("emits both flags, skip-permissions before remote-control, matching the legacy script's own order", () => {
    expect(buildFlagArgs({ skipPermissions: true, remoteControl: true, headroom: false })).toEqual([
      "--dangerously-skip-permissions",
      "--remote-control=",
    ]);
  });
});

describe("buildArgv", () => {
  it("orders tool flags, then extra flags, then passthrough args", () => {
    expect(
      buildArgv({
        toolFlags: ["--dangerously-skip-permissions", "--remote-control="],
        extraFlags: ["--continue", "continue"],
        passthrough: ["--verbose"],
      }),
    ).toEqual(["--dangerously-skip-permissions", "--remote-control=", "--continue", "continue", "--verbose"]);
  });

  it("puts extra flags before a positional passthrough prompt — the cpl/mp/zpl shape (--print then a trailing prompt)", () => {
    expect(
      buildArgv({ toolFlags: [], extraFlags: ["--print"], passthrough: ["/loop continue"] }),
    ).toEqual(["--print", "/loop continue"]);
  });

  it("returns an empty argv when nothing is present anywhere", () => {
    expect(buildArgv({ toolFlags: [], extraFlags: [], passthrough: [] })).toEqual([]);
  });
});

describe("buildEnv", () => {
  const baseEnv = { PATH: "/usr/bin", HOME: "/home/testuser" };

  it("leaves the environment unchanged when the CLAUDE_CONFIG_DIR escape hatch applied", () => {
    const env = buildEnv({
      baseEnv: { ...baseEnv, CLAUDE_CONFIG_DIR: "/somewhere/else" },
      configDirEscapeHatch: true,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/somewhere/else");
  });

  it("leaves the environment unchanged when no identity was resolved at all", () => {
    const env = buildEnv({
      baseEnv,
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env).toEqual(baseEnv);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("sets CLAUDE_CONFIG_DIR to the resolved identity's own directory otherwise", () => {
    const env = buildEnv({
      baseEnv,
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/testuser/.claude-use/identities/work");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("never strips CLAUDE_EXTRA_FLAGS from the child environment", () => {
    const env = buildEnv({
      baseEnv: { ...baseEnv, CLAUDE_EXTRA_FLAGS: "--continue continue" },
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env.CLAUDE_EXTRA_FLAGS).toBe("--continue continue");
  });

  it("applies a resolved provider on top of the identity's CLAUDE_CONFIG_DIR", () => {
    const env = buildEnv({
      baseEnv,
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
      provider: {
        name: "z",
        definition: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", tokenEnv: "Z_API_TOKEN" },
        token: "tok-from-z",
      },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/testuser/.claude-use/identities/work");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-from-z");
    expect(env.CLAUDE_USE_PROVIDER).toBe("GLM");
  });

  it("applies a resolved provider even when no identity was resolved, since it selects an endpoint, not a login", () => {
    const env = buildEnv({
      baseEnv,
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
      provider: {
        name: "z",
        definition: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", tokenEnv: "Z_API_TOKEN" },
        token: "tok-from-z",
      },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-from-z");
  });

  it("clears an ambient ANTHROPIC_API_KEY so the provider's token takes effect, unless the provider's own env names a value", () => {
    const base = { ...baseEnv, ANTHROPIC_API_KEY: "sk-ambient" };
    const cleared = buildEnv({
      baseEnv: base,
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
      provider: {
        name: "z",
        definition: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", tokenEnv: "Z_API_TOKEN" },
        token: "tok-from-z",
      },
    });
    expect(cleared.ANTHROPIC_API_KEY).toBe("");
    const named = buildEnv({
      baseEnv: base,
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
      provider: {
        name: "o",
        definition: {
          displayName: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          tokenEnv: "OPENROUTER_API_KEY",
          env: { ANTHROPIC_API_KEY: "" },
        },
        token: "tok-from-o",
      },
    });
    expect(named.ANTHROPIC_API_KEY).toBe("");
    expect(named.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("lands every entry of the provider's own env verbatim in the child environment", () => {
    const env = buildEnv({
      baseEnv,
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
      provider: {
        name: "z",
        definition: {
          displayName: "GLM",
          baseUrl: "https://api.z.ai/api/anthropic",
          tokenEnv: "Z_API_TOKEN",
          env: { ANTHROPIC_MODEL: "glm-4.6", API_TIMEOUT_MS: "600000" },
        },
        token: "tok-from-z",
      },
    });
    expect(env.ANTHROPIC_MODEL).toBe("glm-4.6");
    expect(env.API_TIMEOUT_MS).toBe("600000");
  });

  it("routes through headroom on top of a provider: the proxy becomes the base URL and the provider's upstream moves into a per-request header", () => {
    const env = buildEnv({
      baseEnv,
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
      provider: {
        name: "z",
        definition: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", tokenEnv: "Z_API_TOKEN" },
        token: "tok-from-z",
      },
      headroom: { port: 8123, mitmPort: 8124, caCertPath: "/home/testuser/.claude-use/headroom/ca/ca.pem", projectId: "/home/testuser/work/repo" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8123");
    expect(env.HEADROOM_PROXY_URL).toBe("http://127.0.0.1:8123");
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-from-z");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-headroom-project-id: /home/testuser/work/repo\nx-headroom-base-url: https://api.z.ai/api/anthropic");
  });

  it("routes an OAuth launch (no provider) through the MITM proxy: HTTPS_PROXY and the CA are set, ANTHROPIC_BASE_URL stays unset so Remote Control keeps working", () => {
    const env = buildEnv({
      baseEnv,
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
      headroom: { port: 8123, mitmPort: 8124, caCertPath: "/home/testuser/.claude-use/headroom/ca/ca.pem", projectId: "/home/testuser/work/repo" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8124");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/home/testuser/.claude-use/headroom/ca/ca.pem");
    expect(env.HEADROOM_PROXY_URL).toBe("http://127.0.0.1:8123");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-headroom-project-id: /home/testuser/work/repo");
  });

  it("leaves a parent-set ANTHROPIC_BASE_URL untouched in the OAuth mode rather than clearing it", () => {
    const env = buildEnv({
      baseEnv: { ...baseEnv, ANTHROPIC_BASE_URL: "https://custom-gateway.example" },
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
      headroom: { port: 8123, mitmPort: 8124, caCertPath: "/home/testuser/.claude-use/headroom/ca/ca.pem", projectId: "/repo" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://custom-gateway.example");
  });

  it("merges a provider's own ANTHROPIC_CUSTOM_HEADERS with headroom's entries", () => {
    const env = buildEnv({
      baseEnv: { ...baseEnv, ANTHROPIC_CUSTOM_HEADERS: "x-from-parent: yes" },
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
      provider: {
        name: "o",
        definition: {
          displayName: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          tokenEnv: "OPENROUTER_API_KEY",
          env: { ANTHROPIC_CUSTOM_HEADERS: "x-from-provider: indeed" },
        },
        token: "tok-from-o",
      },
      headroom: { port: 8123, mitmPort: 8124, caCertPath: "/home/testuser/.claude-use/headroom/ca/ca.pem", projectId: "/repo" },
    });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-from-parent: yes\nx-from-provider: indeed\nx-headroom-project-id: /repo\nx-headroom-base-url: https://openrouter.ai/api/v1",
    );
  });
});

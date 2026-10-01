import { describe, expect, it } from "vitest";

import { InvalidEnvBoolError } from "../cli/parsers";
import { buildArgv, buildEnv, buildFlagArgs, resolveLaunchFlags, type RoutedProvider } from "./flags";

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

  it("treats an empty env value as unset", () => {
    expect(
      resolveLaunchFlags({ env: { CLAUDE_USE_SKIP_PERMISSIONS: "", CLAUDE_USE_REMOTE_CONTROL: "0" } }),
    ).toEqual({ skipPermissions: false, remoteControl: false, headroom: false });
  });

  it("honours a cascade value once one is supplied, independent of the env escape hatch", () => {
    expect(resolveLaunchFlags({ env: {}, cascade: { skipPermissions: true, remoteControl: true } })).toEqual({
      skipPermissions: true,
      remoteControl: true,
      headroom: false,
    });
  });

  it("combines settings from different sources independently, each setting decided on its own", () => {
    expect(
      resolveLaunchFlags({ env: { CLAUDE_USE_REMOTE_CONTROL: "1" }, cascade: { skipPermissions: true } }),
    ).toEqual({ skipPermissions: true, remoteControl: true, headroom: false });
  });

  it.each(["skipPermissions", "remoteControl", "headroom"] as const)(
    "lets the %s flag outrank both its env variable and the cascade",
    (key) => {
      const variable = { skipPermissions: "CLAUDE_USE_SKIP_PERMISSIONS", remoteControl: "CLAUDE_USE_REMOTE_CONTROL", headroom: "CLAUDE_USE_HEADROOM" }[key];
      expect(resolveLaunchFlags({ env: { [variable]: "1" }, flags: { [key]: false } })[key]).toBe(false);
      expect(resolveLaunchFlags({ env: {}, cascade: { [key]: true }, flags: { [key]: false } })[key]).toBe(false);
      expect(resolveLaunchFlags({ env: {}, cascade: { [key]: false }, flags: { [key]: true } })[key]).toBe(true);
      expect(resolveLaunchFlags({ env: { [variable]: "0" }, flags: { [key]: true } })[key]).toBe(true);
    },
  );

  it.each(["skipPermissions", "remoteControl", "headroom"] as const)(
    "lets the %s env variable outrank the cascade in both directions",
    (key) => {
      const variable = { skipPermissions: "CLAUDE_USE_SKIP_PERMISSIONS", remoteControl: "CLAUDE_USE_REMOTE_CONTROL", headroom: "CLAUDE_USE_HEADROOM" }[key];
      expect(resolveLaunchFlags({ env: { [variable]: "0" }, cascade: { [key]: true } })[key]).toBe(false);
      expect(resolveLaunchFlags({ env: { [variable]: "false" }, cascade: { [key]: true } })[key]).toBe(false);
      expect(resolveLaunchFlags({ env: { [variable]: "true" }, cascade: { [key]: false } })[key]).toBe(true);
    },
  );

  it("parses env booleans like CLI booleans and refuses anything else", () => {
    expect(resolveLaunchFlags({ env: { CLAUDE_USE_SKIP_PERMISSIONS: "true" } }).skipPermissions).toBe(true);
    expect(() => resolveLaunchFlags({ env: { CLAUDE_USE_SKIP_PERMISSIONS: "yes" } })).toThrow(InvalidEnvBoolError);
  });

  it("keeps the env escape hatch over the cascade for headroom when no flag was given", () => {
    expect(resolveLaunchFlags({ env: { CLAUDE_USE_HEADROOM: "1" }, cascade: { headroom: false } }).headroom).toBe(true);
    expect(resolveLaunchFlags({ env: {}, cascade: { headroom: true } }).headroom).toBe(true);
    expect(resolveLaunchFlags({ env: {}, cascade: { headroom: false } }).headroom).toBe(false);
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
    const env = buildEnv({ sessionId: "session-test",
      baseEnv: { ...baseEnv, CLAUDE_CONFIG_DIR: "/somewhere/else" },
      configDirEscapeHatch: true,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/somewhere/else");
  });

  it("leaves the environment unchanged when no identity was resolved at all", () => {
    const env = buildEnv({ sessionId: "session-test",
      baseEnv,
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env).toEqual(baseEnv);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("sets CLAUDE_CONFIG_DIR to the resolved identity's own directory otherwise", () => {
    const env = buildEnv({ sessionId: "session-test",
      baseEnv,
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/testuser/.claude-use/identities/work");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("never strips CLAUDE_EXTRA_FLAGS from the child environment", () => {
    const env = buildEnv({ sessionId: "session-test",
      baseEnv: { ...baseEnv, CLAUDE_EXTRA_FLAGS: "--continue continue" },
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
    });
    expect(env.CLAUDE_EXTRA_FLAGS).toBe("--continue continue");
  });

  const identitiesDir = "/home/testuser/.claude-use/identities";

  /** A resolved provider as the launcher hands it to buildEnv: its definition, the base URL it routes to, and a credential resolved to `token` under `target`. */
  function resolvedProvider(
    overrides: Readonly<{ name?: string; displayName?: string; baseUrl?: string; env?: Record<string, string>; target?: "bearer" | "apiKey"; token?: string }> = {},
  ): RoutedProvider {
    const target = overrides.target ?? "bearer";
    const baseUrl = overrides.baseUrl ?? "https://api.z.ai/api/anthropic";
    return {
      name: overrides.name ?? "z",
      baseUrl,
      definition: {
        displayName: overrides.displayName ?? "GLM",
        baseUrl,
        credential: { sources: [{ env: "Z_API_TOKEN" }], target },
        ...(overrides.env === undefined ? {} : { env: overrides.env }),
      },
      credential: { target, token: overrides.token ?? "tok-from-z", source: { env: "Z_API_TOKEN" }, warnings: [] },
    };
  }

  it("applies a resolved provider on top of the identity's CLAUDE_CONFIG_DIR", () => {
    const env = buildEnv({ sessionId: "session-test", baseEnv, configDirEscapeHatch: false, resolvedIdentityName: "work", identitiesDir, provider: resolvedProvider() });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/testuser/.claude-use/identities/work");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-from-z");
    expect(env.CLAUDE_USE_PROVIDER).toBe("GLM");
  });

  it("applies a resolved provider even when no identity was resolved, since it selects an endpoint, not a login", () => {
    const env = buildEnv({ sessionId: "session-test", baseEnv, configDirEscapeHatch: false, identitiesDir, provider: resolvedProvider() });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-from-z");
  });

  it("removes every ambient credential variable other than the bearer target, so the provider's token takes effect", () => {
    const env = buildEnv({ sessionId: "session-test",
      baseEnv: { ...baseEnv, ANTHROPIC_API_KEY: "sk-ambient", CLAUDE_CODE_OAUTH_TOKEN: "oauth-ambient" },
      configDirEscapeHatch: false,
      identitiesDir,
      provider: resolvedProvider(),
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-from-z");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("exports the token as ANTHROPIC_API_KEY and removes an ambient ANTHROPIC_AUTH_TOKEN under target apiKey", () => {
    const env = buildEnv({ sessionId: "session-test",
      baseEnv: { ...baseEnv, ANTHROPIC_AUTH_TOKEN: "sk-ambient-bearer", ANTHROPIC_API_KEY: "sk-ambient-key" },
      configDirEscapeHatch: false,
      identitiesDir,
      provider: resolvedProvider({ baseUrl: "https://api.anthropic.com", target: "apiKey", token: "sk-ant-REDACTED" }),
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-REDACTED");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });

  it("exports an identity's own credential as its target when no provider was selected", () => {
    const env = buildEnv({ sessionId: "session-test",
      baseEnv: { ...baseEnv, ANTHROPIC_API_KEY: "sk-ambient" },
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir,
      identityCredential: { target: "oauthToken", token: "oauth-work", source: { op: "op://v/work/token" }, warnings: [] },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-work");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("never applies an identity's credential alongside a provider's, whose credential authenticates against its endpoint", () => {
    const env = buildEnv({ sessionId: "session-test",
      baseEnv,
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir,
      provider: resolvedProvider(),
      identityCredential: { target: "oauthToken", token: "oauth-work", source: { op: "op://v/work/token" }, warnings: [] },
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-from-z");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("lands every entry of the provider's own env verbatim in the child environment", () => {
    const env = buildEnv({ sessionId: "session-test",
      baseEnv,
      configDirEscapeHatch: false,
      identitiesDir,
      provider: resolvedProvider({ env: { ANTHROPIC_MODEL: "glm-4.6", API_TIMEOUT_MS: "600000" } }),
    });
    expect(env.ANTHROPIC_MODEL).toBe("glm-4.6");
    expect(env.API_TIMEOUT_MS).toBe("600000");
  });

  it("routes a provider session through the front door over TLS: the child's base URL is the door's HTTPS provider path, it trusts the door's CA bundle, and the session headers are injected", () => {
    const env = buildEnv({
      sessionId: "session-test",
      baseEnv,
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
      provider: resolvedProvider({ baseUrl: "https://127.0.0.1:4100/providers/z" }),
      frontdoor: { port: 4100, connectPort: 4200, trustBundlePath: "/home/testuser/.claude-use/frontdoor/ca/bundles/0123abcd.pem", sessionToken: "launch-token-for-tests" },
      headroom: { port: 8123, projectId: "/home/testuser/work/repo" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://127.0.0.1:4100/providers/z");
    expect(env.HEADROOM_PROXY_URL).toBe("http://127.0.0.1:8123");
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/home/testuser/.claude-use/frontdoor/ca/bundles/0123abcd.pem");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-from-z");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-claude-use-identity: work\nx-claude-use-session: session-test\nx-claude-use-auth: launch-token-for-tests\nx-claude-use-headroom: 1\nx-headroom-project-id: /home/testuser/work/repo");
  });

  it("injects only the identity and session headers when the door is engaged without headroom", () => {
    const env = buildEnv({
      sessionId: "session-test",
      baseEnv,
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir,
      provider: resolvedProvider({ baseUrl: "https://127.0.0.1:4100/providers/z" }),
      frontdoor: { port: 4100, connectPort: 4200, trustBundlePath: "/ca.pem", sessionToken: "launch-token-for-tests" },
    });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-claude-use-identity: work\nx-claude-use-session: session-test\nx-claude-use-auth: launch-token-for-tests");
    expect(env.HEADROOM_PROXY_URL).toBeUndefined();
  });

  it("routes an OAuth launch (no provider) through the door's CONNECT surface: HTTPS_PROXY (carrying the launch's capability as its proxy credential) and the CA are set, ANTHROPIC_BASE_URL stays unset so Remote Control keeps working", () => {
    const env = buildEnv({
      sessionId: "session-test",
      baseEnv,
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir: "/home/testuser/.claude-use/identities",
      frontdoor: { port: 4100, connectPort: 4200, trustBundlePath: "/home/testuser/.claude-use/frontdoor/ca/ca.pem", sessionToken: "launch-token-for-tests" },
      headroom: { port: 8123, projectId: "/home/testuser/work/repo" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://claude-use:launch-token-for-tests@127.0.0.1:4200");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/home/testuser/.claude-use/frontdoor/ca/ca.pem");
    expect(env.HEADROOM_PROXY_URL).toBe("http://127.0.0.1:8123");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-claude-use-identity: work\nx-claude-use-session: session-test\nx-claude-use-auth: launch-token-for-tests\nx-claude-use-headroom: 1\nx-headroom-project-id: /home/testuser/work/repo");
  });

  it("leaves a parent-set ANTHROPIC_BASE_URL untouched in the OAuth shape rather than clearing it", () => {
    const env = buildEnv({
      sessionId: "session-test",
      baseEnv: { ...baseEnv, ANTHROPIC_BASE_URL: "https://custom-gateway.example" },
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
      frontdoor: { port: 4100, connectPort: 4200, trustBundlePath: "/ca.pem", sessionToken: "launch-token-for-tests" },
      headroom: { port: 8123, projectId: "/repo" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://custom-gateway.example");
  });

  it("merges a parent's and a provider's own ANTHROPIC_CUSTOM_HEADERS with the session headers", () => {
    const env = buildEnv({
      sessionId: "session-test",
      baseEnv: { ...baseEnv, ANTHROPIC_CUSTOM_HEADERS: "x-from-parent: yes" },
      configDirEscapeHatch: false,
      identitiesDir: "/home/testuser/.claude-use/identities",
      provider: resolvedProvider({ name: "o", displayName: "OpenRouter", baseUrl: "https://127.0.0.1:4100/providers/o", env: { ANTHROPIC_CUSTOM_HEADERS: "x-from-provider: indeed" } }),
      frontdoor: { port: 4100, connectPort: 4200, trustBundlePath: "/ca.pem", sessionToken: "launch-token-for-tests" },
    });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-from-parent: yes\nx-from-provider: indeed\nx-claude-use-session: session-test\nx-claude-use-auth: launch-token-for-tests");
  });

  it("sets no session headers and no proxy when no front door is engaged", () => {
    const env = buildEnv({
      sessionId: "session-test",
      baseEnv,
      configDirEscapeHatch: false,
      resolvedIdentityName: "work",
      identitiesDir,
    });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.HEADROOM_PROXY_URL).toBeUndefined();
  });
});

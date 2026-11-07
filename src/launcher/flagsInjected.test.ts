import { describe, expect, it } from "vitest";

import { INJECTED_ENV } from "./injected";
import { buildEnv, type ResolvedProvider } from "./flags";

const identitiesDir = "/home/testuser/.agent-shim/identities";
const door = { port: 4100, connectPort: 4200, trustBundlePath: "/ca.pem", sessionToken: "launch-token-for-tests" };

/** A resolved provider as the launcher hands it to buildEnv, with `env` entries that set a credential variable the launch then withholds. */
function provider(env: Readonly<Record<string, string>>): ResolvedProvider {
  return {
    name: "z",
    definition: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }], target: "bearer" }, env },
    credential: { target: "bearer", token: "tok-from-z", source: { env: "Z_API_TOKEN" }, warnings: [] },
  };
}

/** The digests `env` records, by marker key. */
function recorded(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const raw = env[INJECTED_ENV];
  return raw === undefined ? {} : (JSON.parse(raw) as Record<string, string>);
}

describe("buildEnv records what it injects", () => {
  const baseEnv = { PATH: "/bin", ANTHROPIC_CUSTOM_HEADERS: "x-user: keep", NO_PROXY: "corp.example" };
  const params = { sessionId: "session-test", configDirEscapeHatch: false, identityId: "work", identitiesDir, frontdoor: door, proxyBypass: ["mcp.example.com"], baseEnv } as const;

  it("leaves no fingerprint of a credential variable the launch withholds, even one the provider's own env set", () => {
    const env = buildEnv({ ...params, remoteControl: true, provider: provider({ ANTHROPIC_API_KEY: "sk-provider-env", CLAUDE_CODE_OAUTH_TOKEN: "oauth-provider-env", ANTHROPIC_AUTH_TOKEN: "tok-provider-env" }) });
    for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) {
      expect(env[name], name).toBeUndefined();
      expect(recorded(env), name).not.toHaveProperty(name);
    }
  });

  /** Whether the marker names `name`: as a variable, one of its custom headers or one of its appended hosts. */
  const named = (marker: Readonly<Record<string, string>>, name: string): boolean => Object.keys(marker).some((key) => key === name || key.startsWith(`${name}:`) || key.startsWith(`${name},`));

  it.each([
    ["an identity with a credential", { identityCredential: { target: "oauthToken", token: "oauth-work-token", source: { env: "X" }, warnings: [] } }],
    ["a provider session", { provider: provider({ ANTHROPIC_MODEL: "glm-4.6", ANTHROPIC_CUSTOM_HEADERS: "x-provider-entry: 1" }) }],
    ["a provider session with Remote Control on", { provider: provider({ ANTHROPIC_MODEL: "glm-4.6" }), remoteControl: true }],
    ["headroom, tier models and the statusline", { headroom: { socketPath: "/s", projectId: "p" }, tierModels: { opus: "family:glm-5-1" }, statusline: {} }],
  ] as const)("records every key it changes for %s, bar the named exceptions", (_label, extra) => {
    const env = buildEnv({ remoteControl: false, ...params, ...extra });
    // The directory is the child's own and replaced by every launch; the marker is the record itself; a key it unset holds no value to record.
    const exceptions = new Set(["CLAUDE_CONFIG_DIR", INJECTED_ENV]);
    const marker = recorded(env);
    const changed = Object.keys(env).filter((name) => env[name] !== undefined && env[name] !== (baseEnv as Record<string, string | undefined>)[name] && !exceptions.has(name));
    expect(changed.length).toBeGreaterThan(0);
    for (const name of changed) {
      expect(named(marker, name), name).toBe(true);
    }
  });

  it("records the bypass hosts it appended and not the parent's own", () => {
    const marker = recorded(buildEnv({ remoteControl: false, ...params }));
    expect(Object.keys(marker).filter((key) => key.startsWith("NO_PROXY,")).sort()).toEqual(["NO_PROXY,127.0.0.1", "NO_PROXY,::1", "NO_PROXY,localhost", "NO_PROXY,mcp.example.com"]);
  });
});

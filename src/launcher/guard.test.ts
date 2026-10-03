import { describe, expect, it } from "vitest";

import {
  AMBIENT_CREDENTIAL_VARS,
  detectAmbientCredential,
  evaluateAmbientCredentialGuard,
  formatAmbientCredentialGuardMessage,
} from "./guard";

describe("detectAmbientCredential", () => {
  it("finds nothing when none of the guarded variables are set", () => {
    expect(detectAmbientCredential({})).toBeUndefined();
  });

  it("detects a set variable", () => {
    expect(detectAmbientCredential({ ANTHROPIC_API_KEY: "sk-real-key" })).toEqual({
      variable: "ANTHROPIC_API_KEY",
    });
  });

  it("treats an empty string as unset, not set — confirmed load-bearing against the real 'o' wrapper script's export ANTHROPIC_API_KEY=\"\"", () => {
    expect(detectAmbientCredential({ ANTHROPIC_API_KEY: "" })).toBeUndefined();
  });

  it("still detects a different guarded variable when one is cleared by an empty string", () => {
    // Mirrors the real `o` wrapper: ANTHROPIC_API_KEY="" clears the key so ANTHROPIC_AUTH_TOKEN takes effect instead.
    expect(
      detectAmbientCredential({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "or-real-token" }),
    ).toEqual({ variable: "ANTHROPIC_AUTH_TOKEN" });
  });

  it("reports the first guarded variable found, in declared order, when several are set", () => {
    expect(
      detectAmbientCredential({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "sk-real-key" }),
    ).toEqual({ variable: "ANTHROPIC_API_KEY" });
  });

  it("covers every one of the six documented variables", () => {
    for (const variable of AMBIENT_CREDENTIAL_VARS) {
      expect(detectAmbientCredential({ [variable]: "set" })).toEqual({ variable });
    }
  });
});

describe("formatAmbientCredentialGuardMessage", () => {
  it("names the offending variable and a generic <name> placeholder when no identity is known", () => {
    const message = formatAmbientCredentialGuardMessage("ANTHROPIC_API_KEY");
    expect(message).toContain("ANTHROPIC_API_KEY is set in the environment");
    expect(message).toContain("AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL=1");
    expect(message).toContain("agent-shim identity set <name> --allow-ambient-credential");
  });

  it("names the real identity in the persistent opt-in command when one is known", () => {
    const message = formatAmbientCredentialGuardMessage("ANTHROPIC_AUTH_TOKEN", "work");
    expect(message).toContain("agent-shim identity set work --allow-ambient-credential");
  });
});

describe("evaluateAmbientCredentialGuard", () => {
  it("allows launch when nothing is set", () => {
    const result = evaluateAmbientCredentialGuard({
      env: {},
      allowAmbientCredential: false,
      allowAmbientCredentialOverride: false,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses launch when a guarded variable is set and neither opt-in applies", () => {
    const result = evaluateAmbientCredentialGuard({
      env: { ANTHROPIC_API_KEY: "sk-real-key" },
      allowAmbientCredential: false,
      allowAmbientCredentialOverride: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.variable).toBe("ANTHROPIC_API_KEY");
      expect(result.message).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("allows launch when the active identity opted in via allowAmbientCredential", () => {
    const result = evaluateAmbientCredentialGuard({
      env: { ANTHROPIC_API_KEY: "sk-real-key" },
      allowAmbientCredential: true,
      allowAmbientCredentialOverride: false,
    });
    expect(result.ok).toBe(true);
  });

  it("allows launch when AGENT_SHIM_ALLOW_AMBIENT_CREDENTIAL=1 opts in for this one invocation", () => {
    const result = evaluateAmbientCredentialGuard({
      env: { ANTHROPIC_API_KEY: "sk-real-key" },
      allowAmbientCredential: false,
      allowAmbientCredentialOverride: true,
    });
    expect(result.ok).toBe(true);
  });

  it("never trips on an ANTHROPIC_API_KEY cleared to an empty string, even with a real ANTHROPIC_AUTH_TOKEN alongside it", () => {
    const result = evaluateAmbientCredentialGuard({
      env: { ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "https://openrouter.ai/api" },
      allowAmbientCredential: false,
      allowAmbientCredentialOverride: false,
    });
    expect(result.ok).toBe(true);
  });

  it("still refuses when the cleared variable's sibling (ANTHROPIC_AUTH_TOKEN) is genuinely set", () => {
    const result = evaluateAmbientCredentialGuard({
      env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "or-real-token" },
      allowAmbientCredential: false,
      allowAmbientCredentialOverride: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.variable).toBe("ANTHROPIC_AUTH_TOKEN");
    }
  });
});

describe("the launching identity's own injected credential", () => {
  const injected = { variable: "CLAUDE_CODE_OAUTH_TOKEN", token: "oauth-work" } as const;

  it("is not ambient when its variable holds exactly the token this launch injects", () => {
    expect(detectAmbientCredential({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-work" }, injected)).toBeUndefined();
    expect(
      evaluateAmbientCredentialGuard({
        env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-work" },
        allowAmbientCredential: false,
        allowAmbientCredentialOverride: false,
        injectedCredential: injected,
      }).ok,
    ).toBe(true);
  });

  it("is still ambient when the same variable holds a different token, or another variable is set", () => {
    expect(detectAmbientCredential({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-other" }, injected)).toEqual({ variable: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(detectAmbientCredential({ ANTHROPIC_AUTH_TOKEN: "oauth-work" }, injected)).toEqual({ variable: "ANTHROPIC_AUTH_TOKEN" });
    expect(detectAmbientCredential({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-work", ANTHROPIC_API_KEY: "sk" }, injected)).toEqual({ variable: "ANTHROPIC_API_KEY" });
  });
});

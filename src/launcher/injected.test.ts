import { describe, expect, it } from "vitest";

import { INJECTED_ENV, recordInjections, withoutInjected } from "./injected";

describe("recordInjections and withoutInjected", () => {
  function injectedEnvironment(base: Readonly<Record<string, string | undefined>> = {}): Record<string, string | undefined> {
    const injections = recordInjections(base);
    const { env } = injections;
    injections.set("CLAUDE_CODE_OAUTH_TOKEN", "tok-parent");
    injections.set("AGENT_SHIM_PROVIDER", "GLM");
    env.ANTHROPIC_CUSTOM_HEADERS = [base.ANTHROPIC_CUSTOM_HEADERS, "x-agent-shim-provider: z", "x-agent-shim-auth: cap"].filter((line) => line !== undefined).join("\n");
    injections.recordHeaders(["x-agent-shim-provider", "x-agent-shim-auth"]);
    injections.finish();
    return env;
  }

  it("drops each variable and header the parent wrote, and the marker itself", () => {
    const cleaned = withoutInjected(injectedEnvironment({ PATH: "/bin", ANTHROPIC_CUSTOM_HEADERS: "x-user: keep" }));
    expect(cleaned).toEqual({ PATH: "/bin", ANTHROPIC_CUSTOM_HEADERS: "x-user: keep" });
  });

  it("keeps a variable the person set to anything but the value the parent wrote", () => {
    const env = injectedEnvironment();
    env.CLAUDE_CODE_OAUTH_TOKEN = "tok-user";
    expect(withoutInjected(env)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok-user" });
  });

  it("keeps a header the person set to anything but the value the parent wrote", () => {
    const env = injectedEnvironment();
    env.ANTHROPIC_CUSTOM_HEADERS = "x-agent-shim-provider: mine\nx-agent-shim-auth: cap";
    expect(withoutInjected(env).ANTHROPIC_CUSTOM_HEADERS).toBe("x-agent-shim-provider: mine");
  });

  it("removes the custom headers variable once nothing but injected entries was in it", () => {
    expect("ANTHROPIC_CUSTOM_HEADERS" in withoutInjected(injectedEnvironment())).toBe(false);
  });

  it("leaves an environment without a marker exactly as it is, headers included", () => {
    const env = { ANTHROPIC_API_KEY: "sk-user", ANTHROPIC_CUSTOM_HEADERS: "x-a:   1\n\nx-b: 2" };
    expect(withoutInjected(env)).toEqual(env);
  });

  it("ignores a marker that is not the object a launcher writes, still removing it", () => {
    expect(withoutInjected({ [INJECTED_ENV]: "not json", ANTHROPIC_API_KEY: "sk-user" })).toEqual({ ANTHROPIC_API_KEY: "sk-user" });
    expect(withoutInjected({ [INJECTED_ENV]: JSON.stringify(["a"]), ANTHROPIC_API_KEY: "sk-user" })).toEqual({ ANTHROPIC_API_KEY: "sk-user" });
  });

  it("carries what an earlier launcher recorded forward, so a launch that kept its parent's environment still names it", () => {
    const first = injectedEnvironment();
    const injections = recordInjections(first);
    injections.set("ANTHROPIC_DEFAULT_OPUS_MODEL", "glm-5");
    injections.finish();
    expect(withoutInjected(injections.env)).toEqual({});
  });

  it("writes no marker when nothing was recorded", () => {
    const injections = recordInjections({});
    injections.finish();
    expect(injections.env).toEqual({});
  });

  it("leaves no record of a variable the launcher unset after setting it", () => {
    const injections = recordInjections({});
    injections.set("ANTHROPIC_API_KEY", "sk-provider-env");
    injections.unset("ANTHROPIC_API_KEY");
    injections.finish();
    expect(injections.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(injections.env[INJECTED_ENV]).toBeUndefined();
  });

  it("drops the bypass hosts the parent appended and keeps the person's own, case-insensitively, in their original spelling and order", () => {
    const injections = recordInjections({ NO_PROXY: "Corp.example,MCP.example.com" });
    injections.recordBypassHosts("NO_PROXY", ["127.0.0.1", "::1"]);
    injections.env.NO_PROXY = "Corp.example,MCP.example.com,127.0.0.1,::1";
    injections.finish();
    expect(withoutInjected(injections.env).NO_PROXY).toBe("Corp.example,MCP.example.com");
  });

  it("removes a bypass list the parent alone filled", () => {
    const injections = recordInjections({});
    injections.recordBypassHosts("no_proxy", ["127.0.0.1", "localhost"]);
    injections.env.no_proxy = "127.0.0.1,localhost";
    injections.finish();
    expect("no_proxy" in withoutInjected(injections.env)).toBe(false);
  });

  it("matches a recorded header by name without regard to case, and leaves a block it removes nothing from exactly as written", () => {
    const injections = recordInjections({});
    injections.env.ANTHROPIC_CUSTOM_HEADERS = "X-Agent-Shim-Provider: z";
    injections.recordHeaders(["X-Agent-Shim-Provider"]);
    injections.finish();
    expect("ANTHROPIC_CUSTOM_HEADERS" in withoutInjected({ ...injections.env, ANTHROPIC_CUSTOM_HEADERS: "x-agent-shim-provider: z" })).toBe(false);
    const untouched = "x-user:   spaced\n\nnot a header line\nx-other: 1";
    expect(withoutInjected({ ...injections.env, ANTHROPIC_CUSTOM_HEADERS: untouched }).ANTHROPIC_CUSTOM_HEADERS).toBe(untouched);
  });

  it("keeps the person's lines exactly as written when it removes an injected one beside them", () => {
    const injections = recordInjections({});
    injections.env.ANTHROPIC_CUSTOM_HEADERS = "x-agent-shim-provider: z";
    injections.recordHeaders(["x-agent-shim-provider"]);
    injections.finish();
    const mixed = "x-user:   spaced\nx-agent-shim-provider: z\nnot a header line";
    expect(withoutInjected({ ...injections.env, ANTHROPIC_CUSTOM_HEADERS: mixed }).ANTHROPIC_CUSTOM_HEADERS).toBe("x-user:   spaced\nnot a header line");
  });

  it("drops the NO_PROXY a provider's own env set, with the hosts the launcher appended to it", () => {
    const injections = recordInjections({ NO_PROXY: "corp.example" });
    injections.recordBypassHosts("NO_PROXY", ["internal.glm.example"]);
    injections.env.NO_PROXY = "internal.glm.example";
    injections.recordBypassHosts("NO_PROXY", ["127.0.0.1", "localhost"]);
    injections.env.NO_PROXY = "internal.glm.example,127.0.0.1,localhost";
    injections.finish();
    expect("NO_PROXY" in withoutInjected(injections.env)).toBe(false);
  });

  it("leaves an environment with no marker exactly as it is, an empty value the person set included", () => {
    const env = { NO_PROXY: "", no_proxy: " , ", ANTHROPIC_CUSTOM_HEADERS: "" };
    expect(withoutInjected(env)).toEqual(env);
  });

  it("keeps an emptied value the person set when the marker removed nothing from it", () => {
    const injections = recordInjections({});
    injections.set("AGENT_SHIM_PROVIDER", "GLM");
    injections.finish();
    expect(withoutInjected({ ...injections.env, NO_PROXY: "", ANTHROPIC_CUSTOM_HEADERS: "" })).toEqual({ NO_PROXY: "", ANTHROPIC_CUSTOM_HEADERS: "" });
  });
});

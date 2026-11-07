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
});

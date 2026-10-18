import { describe, expect, it } from "vitest";

import { HEADROOM_FLAG_HEADER, IDENTITY_HEADER, INTERNAL_HEADER_NAMES, PROJECT_ID_HEADER, PROVIDER_HEADER, SESSION_HEADER, identifyRequest, parseProviderPath } from "./route";

describe("identifyRequest", () => {
  it("splits the session out of the headers and removes exactly the internal ones", () => {
    const identified = identifyRequest({
      [IDENTITY_HEADER]: "work",
      [SESSION_HEADER]: "session-1",
      [PROVIDER_HEADER]: "z",
      [HEADROOM_FLAG_HEADER]: "1",
      [PROJECT_ID_HEADER]: "/repo",
      authorization: "Bearer token",
      "user-agent": "claude/1",
    });
    expect(identified.session).toEqual({ identity: "work", sessionId: "session-1", provider: "z", headroom: true, projectId: "/repo" });
    expect(identified.forwardableHeaders).toEqual({ authorization: "Bearer token", "user-agent": "claude/1" });
  });

  it("reads internal header names case-insensitively, as the transport normalises them", () => {
    const identified = identifyRequest({ "X-Agent-Shim-Identity": "work", "X-AGENT-SHIM-SESSION": "session-2" });
    expect(identified.session).toEqual({ identity: "work", sessionId: "session-2", provider: undefined, headroom: false, projectId: undefined });
    expect(identified.forwardableHeaders).toEqual({});
  });

  it("joins a repeated internal header instead of dropping all but the first", () => {
    const identified = identifyRequest({ [IDENTITY_HEADER]: ["work", "personal"] });
    expect(identified.session.identity).toBe("work, personal");
  });

  it("treats a session with no injected headers as headroom-less and anonymous", () => {
    const identified = identifyRequest({ authorization: "Bearer token" });
    expect(identified.session).toEqual({ identity: undefined, sessionId: undefined, provider: undefined, headroom: false, projectId: undefined });
  });

  it("names exactly the internal headers, so a new one cannot be added without widening the strip", () => {
    expect(INTERNAL_HEADER_NAMES).toEqual(["x-agent-shim-identity", "x-agent-shim-session", "x-agent-shim-headroom", "x-agent-shim-auth", "x-agent-shim-provider", "x-agent-shim-hop", "x-agent-shim-hop-id", "x-headroom-project-id", "x-headroom-session-id", "x-headroom-base-url"]);
  });
});

describe("provider paths", () => {
  it("splits a provider-scoped path into its name and the rest", () => {
    expect(parseProviderPath("/providers/codex/v1/messages")).toEqual({ provider: "codex", rest: "/v1/messages" });
    expect(parseProviderPath("/providers/work%20codex/v1/messages/count_tokens")).toEqual({ provider: "work codex", rest: "/v1/messages/count_tokens" });
  });

  it("refuses any path that names no provider", () => {
    expect(parseProviderPath("/v1/messages")).toBeUndefined();
    expect(parseProviderPath("/providers")).toBeUndefined();
    expect(parseProviderPath("/providers/")).toBeUndefined();
    expect(parseProviderPath("/providers/codex")).toBeUndefined();
  });
});

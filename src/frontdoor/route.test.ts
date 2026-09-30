import { describe, expect, it } from "vitest";

import { HEADROOM_FLAG_HEADER, IDENTITY_HEADER, INTERNAL_HEADER_NAMES, PROJECT_ID_HEADER, SESSION_HEADER, identifyRequest, parseProviderPath, providerBaseUrl } from "./route";

describe("identifyRequest", () => {
  it("splits the session out of the headers and removes exactly the internal ones", () => {
    const identified = identifyRequest({
      [IDENTITY_HEADER]: "work",
      [SESSION_HEADER]: "session-1",
      [HEADROOM_FLAG_HEADER]: "1",
      [PROJECT_ID_HEADER]: "/repo",
      authorization: "Bearer token",
      "user-agent": "claude/1",
    });
    expect(identified.session).toEqual({ identity: "work", sessionId: "session-1", headroom: true, projectId: "/repo" });
    expect(identified.forwardableHeaders).toEqual({ authorization: "Bearer token", "user-agent": "claude/1" });
  });

  it("reads internal header names case-insensitively, as the transport normalises them", () => {
    const identified = identifyRequest({ "X-Claude-Use-Identity": "work", "X-CLAUDE-USE-SESSION": "session-2" });
    expect(identified.session).toEqual({ identity: "work", sessionId: "session-2", headroom: false, projectId: undefined });
    expect(identified.forwardableHeaders).toEqual({});
  });

  it("joins a repeated internal header instead of dropping all but the first", () => {
    const identified = identifyRequest({ [IDENTITY_HEADER]: ["work", "personal"] });
    expect(identified.session.identity).toBe("work, personal");
  });

  it("treats a session with no injected headers as headroom-less and anonymous", () => {
    const identified = identifyRequest({ authorization: "Bearer token" });
    expect(identified.session).toEqual({ identity: undefined, sessionId: undefined, headroom: false, projectId: undefined });
  });

  it("names exactly the internal headers, so a new one cannot be added without widening the strip", () => {
    expect(INTERNAL_HEADER_NAMES).toEqual(["x-claude-use-identity", "x-claude-use-session", "x-claude-use-headroom", "x-claude-use-auth", "x-claude-use-hop", "x-headroom-project-id", "x-headroom-base-url"]);
  });
});

const PORT = 4100;

describe("provider paths", () => {
  it("builds a provider's base URL from the front door's port", () => {
    expect(providerBaseUrl(PORT, "codex")).toBe(`http://127.0.0.1:${String(PORT)}/providers/codex`);
    expect(providerBaseUrl(PORT, "work codex")).toBe(`http://127.0.0.1:${String(PORT)}/providers/work%20codex`);
  });

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

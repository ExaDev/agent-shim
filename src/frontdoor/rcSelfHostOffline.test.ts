import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { isRcSessionFamilyPath, rcSelfHostOfflineAnswer } from "./rcSelfHostOffline";

describe("the Remote Control session family", () => {
  it("is the session and compatibility families and nothing beside them", () => {
    for (const path of ["/v1/code/sessions", "/v1/code/sessions/cse_1/events", "/v1/sessions", "/v1/sessions/session_1"]) {
      expect(isRcSessionFamilyPath(path), path).toBe(true);
    }
    for (const path of ["/v1/code/sessionsx", "/v1/sessionsx", "/v1/mcp_servers", "/v1/messages"]) {
      expect(isRcSessionFamilyPath(path), path).toBe(false);
    }
  });
});

describe("the self-hosted mode's local answers to non-Remote-Control calls", () => {
  it("answers each feature's off state where the client parses one", () => {
    expect(rcSelfHostOfflineAnswer("/api/claude_cli/bootstrap")).toEqual({ status: HTTP_STATUS.ok, body: {} });
    expect(rcSelfHostOfflineAnswer("/api/claude_code_penguin_mode")).toEqual({ status: HTTP_STATUS.ok, body: { enabled: false, disabled_reason: "preference" } });
    expect(rcSelfHostOfflineAnswer("/api/oauth/organizations/11111111-1111-4111-8111-111111111111/sync/github/auth")).toEqual({ status: HTTP_STATUS.ok, body: { is_authenticated: false } });
    expect(rcSelfHostOfflineAnswer("/v1/mcp_servers")).toEqual({ status: HTTP_STATUS.ok, body: { data: [], next_page: null } });
    expect(rcSelfHostOfflineAnswer("/mcp-registry/v0/servers")).toEqual({ status: HTTP_STATUS.ok, body: { servers: [], metadata: { count: 0 } } });
  });

  it("answers every other path with a 404 naming the mode, never the 401 that drives the client's refresh-and-retry", () => {
    for (const pathname of ["/api/claude_code_grove", "/api/frame/contract/latest", "/api/artifacts/mcp", "/api/oauth/organizations/11111111-1111-4111-8111-111111111111/referral/eligibility", "/v1/messages", "/anything/else"]) {
      const answer = rcSelfHostOfflineAnswer(pathname);
      expect(answer.status).toBe(HTTP_STATUS.notFound);
      expect(answer.body).toMatchObject({ type: "error", error: { type: "not_found_error" } });
      expect(JSON.stringify(answer.body)).toContain(pathname);
    }
  });
});

import { describe, expect, it } from "vitest";

import { HTTP_STATUS } from "../codex/http";
import { rcSelfHostOfflineAnswer, rcSelfHostOwnsPresentation } from "./rcSelfHostOffline";

/** A short fake bearer of the OAuth kind (kept short of the redaction filter's eight-character suffix on purpose). */
const MINTED = "sk-ant-oat1";

describe("which requests the self-hosted mode owns", () => {
  it("owns the minted bearer whatever the scheme word's case, and a request presenting no credential at all", () => {
    expect(rcSelfHostOwnsPresentation({ authorization: `Bearer ${MINTED}` }, MINTED)).toBe(true);
    expect(rcSelfHostOwnsPresentation({ authorization: `bearer ${MINTED}` }, MINTED)).toBe(true);
    expect(rcSelfHostOwnsPresentation({}, MINTED)).toBe(true);
    expect(rcSelfHostOwnsPresentation({}, undefined)).toBe(true);
  });

  it("leaves every other credential to its native session: another bearer, another scheme, an API key, and any bearer while nothing is minted", () => {
    expect(rcSelfHostOwnsPresentation({ authorization: "Bearer sk-ant-oat2" }, MINTED)).toBe(false);
    expect(rcSelfHostOwnsPresentation({ authorization: `Basic ${MINTED}` }, MINTED)).toBe(false);
    expect(rcSelfHostOwnsPresentation({ "x-api-key": "sk-ant-api" }, MINTED)).toBe(false);
    expect(rcSelfHostOwnsPresentation({ authorization: `Bearer ${MINTED}` }, undefined)).toBe(false);
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

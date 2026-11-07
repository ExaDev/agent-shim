import type { IncomingMessage, ServerResponse } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { CONTROL_BODY_CAP_BYTES } from "./rcControl";
import type { RcSelfHostCredentialRecord } from "./rcSelfHost";
import { isRcSessionFamilyPath, rcSelfHostOfflineAnswer } from "./rcSelfHostOffline";
import { PROVIDER_HEADER, internalHeaderValue } from "./route";

/**
 * The local answers of the self-hosted Remote Control service: the non-`/v1/` calls the CLI makes around activation (the feature eval, the profile, the token validation, the telemetry no-ops) and the control-plane host's OAuth refresh, served straight onto the connect surface's plain responses because they ride no routed pipeline. Split out of `rcSelfHost.ts` so each file stays a readable size, exactly as the client channels, the compatibility family and the conversation family were split out before it; the surface hands this module's product straight back as its own `local` surface.
 *
 * Every answer here exists so a self-hosted session needs no claude.ai behind it, and each names where its shape came from in its own comment. The handlers are pure functions of an explicit context (the injected clock, the minted credential accessor and the bounded body reader), so this module imports no runtime value from the surface it serves (the scope list lives here, re-exported by the surface for the library surface it already published) and the two modules cannot cycle.
 */

/** The control-plane host whose OAuth refresh this surface answers locally; when the mode is on, its terminated session is parsed as HTTP (it is normally byte-tapped) so the refresh can be served. */
const RC_SELF_HOST_OAUTH_HOST = "platform.claude.com";

/** The email address the minted account block and the local profile name: a `.invalid` domain, so nothing about it can be mistaken for a reachable identity. Lives here beside the profile that answers it, and the minting imports it, so the two never disagree. */
export const RC_SELF_HOST_EMAIL = "selfhost@agent-shim.invalid";

/**
 * The full scope list the minting writes and the local refresh echoes: the CLI's own claude.ai login scope set (`CLAUDE_AI_OAUTH_SCOPES` in its source), whose `user:inference` and `user:profile` members are exactly the two the Remote Control gate demands. Lives here, beside the refresh that echoes it, and is re-exported by the surface so the library surface it already published is unchanged.
 */
export const RC_SELF_HOST_SCOPE_LIST: readonly string[] = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];

/**
 * The expiry the local OAuth refresh names, in seconds. One hour is the convention the real token endpoint's answers establish; the value only positions the CLI's next scheduled refresh, which lands back here whatever it says, because the minted pair never changes.
 */
const RC_SELF_HOST_OAUTH_TOKEN_TTL_SECONDS = 3_600;

/** Milliseconds per second, so every second-denominated conversion reads as the seconds it names. */
const MS_PER_SECOND = 1_000;

/** The status every authenticated call answers while the mode is on but its minting never ran: the surface exists, its credential does not. */
const HTTP_SERVICE_UNAVAILABLE = 503;

/** The guard every parsed-body narrowing goes through, per the codebase's `unknown` discipline. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses JSON, yielding undefined for anything that is not one JSON object. */
function parseJsonObject(body: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** The feature payload the local eval answers: exactly the gates the Remote Control activation path reads (the GrowthBook check in `getBridgeDisabledReason`, and the env-less v2 bridge selector), each at the value that enables the feature, and nothing else, so every unrelated flag keeps evaluating to its default as though the eval had never run. */
function growthBookFeatures(): Record<string, unknown> {
  return {
    tengu_ccr_bridge: { defaultValue: true },
    tengu_bridge_repl_v2: { defaultValue: true },
    tengu_bridge_repl_v2_cse_shim_enabled: { defaultValue: true },
    tengu_bridge_min_version: { defaultValue: { minVersion: "0.0.0" } },
  };
}

/** Everything the local answers need, injected so they run against fakes in unit tests. */
export interface RcSelfHostLocalDeps {
  readonly now: () => number;
  /** The minted credential the profile and validation answers name back, read fresh so a re-mint takes effect without restarting the door; undefined while none was ever minted, in which case the credential-bearing answers refuse. */
  readonly credentialRecord: () => RcSelfHostCredentialRecord | undefined;
  /** Reads one request's whole body as text, refusing a body past the shared control cap by rejecting. */
  readonly readBody: (request: IncomingMessage, capBytes: number) => Promise<string>;
  /** Whether the launch holding a tunnel's capability is a self-hosted session's (see `rcSelfHostLaunches.ts`): handed to the connect surface, which decides by it which requests reach this surface at all. */
  readonly ownsLaunch: (capability: string) => boolean;
  /** The same decision for a redirected connection, by the local port of its client end (see `rcSelfHostLaunches.ts`). */
  readonly ownsPeer: (port: number) => Promise<boolean>;
  /** Where the surface writes one line per call it answers in place of a real host, and per refusal it makes; absent, nothing is logged. */
  readonly log?: (line: string) => void;
}

/** The local surface the self-hosted service hands to the connect surface: which sessions are the mode's, and the requests it answers itself. */
export interface RcSelfHostLocal {
  /** Whether the launch holding a tunnel's capability is a self-hosted session's. */
  readonly ownsLaunch: (capability: string) => boolean;
  /** Whether the redirected connection whose client end is on local port `port` is a self-hosted session's, attributed by its peer process. */
  readonly ownsPeer: (port: number) => Promise<boolean>;
  /** The identity the credential is minted into, which every ownership decision rests on: `none` while nothing is minted, `every` for a mint that names none. */
  readonly mintGeneration: () => string;
  /**
   * Serves one request of a self-hosted session (the connect surface calls it for no other): everything except what the routed pipeline must serve, which resolves false so routing continues unchanged. That is the Remote Control session family on the API host, and every `/v1/` path of a provider session (it carries its provider's internal header), whose inference the resolver sends to that provider; every other path on either host is answered here, so nothing of a self-hosted session reaches a real host.
   */
  readonly serve: (host: string, request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
}

/** Answers one JSON body on the connect surface's plain response shape; the local answers ride no pipeline. */
const answerServerJson = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text, "utf8")) });
  response.end(text);
};

/** Builds the local answers. One per self-hosted surface; everything they read is injected. */
export function createRcSelfHostLocal(deps: RcSelfHostLocalDeps): RcSelfHostLocal {
  /** Answers one of the mode's calls that no named answer above serves, from the offline table, discarding its body unread: nothing here needs it, and draining it keeps the terminated session usable for the client's next request. */
  const answerOffline = (method: string, pathname: string, request: IncomingMessage, response: ServerResponse): void => {
    request.resume();
    const offline = rcSelfHostOfflineAnswer(pathname);
    deps.log?.(`rc selfhost: answered ${method} ${pathname} locally with ${String(offline.status)}; a self-hosted session's calls never leave the door`);
    answerServerJson(response, offline.status, offline.body);
  };
  return {
    ownsLaunch: deps.ownsLaunch,
    ownsPeer: deps.ownsPeer,
    mintGeneration: () => {
      const minted = deps.credentialRecord();
      return minted === undefined ? "none" : (minted.identityId === undefined ? "every" : `identity:${minted.identityId}`);
    },
    serve: async (host: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
      const method = (request.method ?? "").toUpperCase();
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const minted = deps.credentialRecord();
      if (minted !== undefined && minted.identityId === undefined) {
        // A mint from before the identity's id was recorded attributes every launch to the mode (see `rcSelfHostLaunches.ts`), so nothing is served until the identity is minted again.
        request.resume();
        deps.log?.(`rc selfhost: refused ${method} ${pathname}: the minted credential names no identity; mint it again`);
        answerServerJson(response, HTTP_SERVICE_UNAVAILABLE, { type: "error", error: { type: "api_error", message: "the front door's self-hosted Remote Control credential was minted before the door recorded its identity, so no launch can be told apart from it; run agent-shim frontdoor rc selfhost mint <identity> again" } });
        return true;
      }
      if (host === RC_SELF_HOST_OAUTH_HOST) {
        if (method === "POST" && pathname === "/v1/oauth/token") {
          const body = parseJsonObject(await deps.readBody(request, CONTROL_BODY_CAP_BYTES));
          const record = deps.credentialRecord();
          if (record === undefined) {
            answerServerJson(response, HTTP_SERVICE_UNAVAILABLE, { error: "the front door's self-hosted Remote Control surface is on but no credential has been minted for it" });
            return true;
          }
          if (body?.grant_type !== undefined && body.grant_type !== "refresh_token") {
            answerServerJson(response, HTTP_STATUS.badRequest, { error: "unsupported_grant_type" });
            return true;
          }
          // The refresh this surface always answers: the minted pair itself, unchanged. The minting sets no expiry, so nothing schedules a refresh; a forced one (a 401 from elsewhere) lands here, is answered with the same pair, and the session carries on exactly as it stood.
          answerServerJson(response, HTTP_STATUS.ok, { access_token: record.accessToken, refresh_token: record.refreshToken, expires_in: RC_SELF_HOST_OAUTH_TOKEN_TTL_SECONDS, scope: RC_SELF_HOST_SCOPE_LIST.join(" ") });
          return true;
        }
        if (method === "GET" && pathname === "/v1/oauth/hello") {
          answerServerJson(response, HTTP_STATUS.ok, {});
          return true;
        }
        answerOffline(method, pathname, request, response);
        return true;
      }
      // The API host's activation neighbours: exactly the calls the gate and the session's own bookkeeping make around Remote Control, answered so a self-hosted session needs no claude.ai behind it.
      if (method === "POST" && pathname.startsWith("/api/eval/")) {
        await deps.readBody(request, CONTROL_BODY_CAP_BYTES);
        answerServerJson(response, HTTP_STATUS.ok, { features: growthBookFeatures(), dateUpdated: Math.floor(deps.now() / MS_PER_SECOND) });
        return true;
      }
      if (method === "GET" && pathname === "/api/oauth/profile") {
        const record = deps.credentialRecord();
        if (record === undefined) {
          answerServerJson(response, HTTP_SERVICE_UNAVAILABLE, { error: "the front door's self-hosted Remote Control surface is on but no credential has been minted for it" });
          return true;
        }
        answerServerJson(response, HTTP_STATUS.ok, {
          // The email is required: the client's profile schema rejects an answer without `account.email`, discarding the whole profile.
          account: { uuid: record.accountUuid, email: RC_SELF_HOST_EMAIL, display_name: "agent-shim self-hosted", created_at: new Date(0).toISOString() },
          organization: { uuid: record.organizationUuid, organization_type: "claude_max" },
        });
        return true;
      }
      if (method === "GET" && pathname === "/api/claude_code/policy_limits") {
        answerServerJson(response, HTTP_STATUS.ok, {});
        return true;
      }
      if (method === "POST" && pathname === "/api/oauth/validate") {
        // The startup check the CLI makes of its stored token (the live rig showed its 401 tipping a freshly minted session straight into the login flow). The answer names the token's scopes and account facts back, which is exactly what the check reads: the scopes gate accepts any of the mint's members, and a null expiry is the never-expiring form the mint itself wrote.
        await deps.readBody(request, CONTROL_BODY_CAP_BYTES);
        const record = deps.credentialRecord();
        if (record === undefined) {
          answerServerJson(response, HTTP_SERVICE_UNAVAILABLE, { error: "the front door's self-hosted Remote Control surface is on but no credential has been minted for it" });
          return true;
        }
        answerServerJson(response, HTTP_STATUS.ok, { scopes: [...RC_SELF_HOST_SCOPE_LIST], expiresAt: null, subscriptionType: "max", account_uuid: record.accountUuid, organization_uuid: record.organizationUuid });
        return true;
      }
      if (method === "POST" && (pathname === "/api/event_logging/v2/batch" || pathname === "/api/claude_code/metrics" || pathname === "/api/claude_cli_feedback")) {
        await deps.readBody(request, CONTROL_BODY_CAP_BYTES);
        answerServerJson(response, HTTP_STATUS.ok, {});
        return true;
      }
      if (method === "GET" && pathname === "/api/hello") {
        answerServerJson(response, HTTP_STATUS.ok, {});
        return true;
      }
      if (pathname.startsWith("/v1/") && (isRcSessionFamilyPath(pathname) || internalHeaderValue(request.headers, PROVIDER_HEADER) !== undefined)) {
        return false;
      }
      answerOffline(method, pathname, request, response);
      return true;
    },
  };
}

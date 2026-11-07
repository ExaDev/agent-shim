import type { IncomingHttpHeaders } from "node:http";

import { HTTP_STATUS } from "../codex/http";
import { isLiveCapability } from "./capability";

/**
 * The self-hosted Remote Control mode's guarantee that a self-hosted session never reaches the Anthropic hosts (ExaDev/agent-shim#731): every call such a session makes on an intercepted host that no other part of the surface serves is answered here, on this machine, instead of being forwarded with the minted credential to a host that only refuses it.
 *
 * Which calls belong to the mode is decided by the credential they present, because that is the one fact every arrival path carries: a request through a launch's CONNECT tunnel and one through the transparent surface's redirect look the same once terminated, and only the Authorization header says whose they are. A request presenting the minted bearer is a self-hosted session's; so is one presenting no credential at all, since nothing attributes it to any login and forwarding it would reach Anthropic for a session whose contract is not to; a request presenting any other credential (a native OAuth bearer, an API key) is a native session's and is forwarded exactly as it would be with the mode off.
 *
 * The answers are what a Claude Code 2.1.319 session was observed to accept in an isolated lab (a throwaway home, the loopback mock provider, and every upstream dial of the lab door pointed at a loopback sink), run three ways over the same paths: the real hosts' 401, a 404, and an empty 200. All three left Remote Control activating and a provider turn completing, so none of these calls is needed for either; what differed is the side effects. A 401 is the one answer never to give: the CLI treats it as a stale login, forces an OAuth refresh and retries (the bootstrap and fast-mode reads twice, the artifacts MCP connection three more times with backoff), so every 401 multiplies the traffic and walks the client's dead-token handling. A 404 is a single clean failure everywhere it was tried. Where the feature's own off state has a trivial shape the client parses, that shape is answered instead, so the client records "nothing here" rather than logging a failed fetch: each such entry names what the lab showed it parse to.
 */

/** One local answer: the status and JSON body the CLI is given in place of the real host's. */
export interface RcSelfHostOfflineAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** One entry of the answer table: the paths it covers, and the off-state answer the client parses for them. */
interface OfflineEntry {
  readonly matches: (pathname: string) => boolean;
  readonly answer: RcSelfHostOfflineAnswer;
}

/** The organisation-scoped GitHub token-sync check, addressed by the organisation's uuid. */
const GITHUB_SYNC_PATH = /^\/api\/oauth\/organizations\/[^/]+\/sync\/github\/auth$/;

/**
 * The off-state answers, each the shape the client reads as "this feature has nothing for you" rather than as a failure:
 *
 * - the bootstrap read: every field of the client's bootstrap schema is optional, so an empty object parses ("Fetch ok" in the lab) and caches no models, settings or notices;
 * - the fast-mode organisation status: disabled, which the client reads as the organisation's preference rather than a network fault;
 * - the GitHub token-sync check: not authenticated, the answer the client's own check reads as "not synced";
 * - the claude.ai connector list and the connector directory: empty lists, in the paged shapes their readers walk, so no connector is offered and no directory page is fetched.
 */
const OFF_STATE_ENTRIES: readonly OfflineEntry[] = [
  { matches: (pathname) => pathname === "/api/claude_cli/bootstrap", answer: { status: HTTP_STATUS.ok, body: {} } },
  { matches: (pathname) => pathname === "/api/claude_code_penguin_mode", answer: { status: HTTP_STATUS.ok, body: { enabled: false, disabled_reason: "preference" } } },
  { matches: (pathname) => GITHUB_SYNC_PATH.test(pathname), answer: { status: HTTP_STATUS.ok, body: { is_authenticated: false } } },
  { matches: (pathname) => pathname === "/v1/mcp_servers", answer: { status: HTTP_STATUS.ok, body: { data: [], next_page: null } } },
  { matches: (pathname) => pathname === "/mcp-registry/v0/servers", answer: { status: HTTP_STATUS.ok, body: { servers: [], metadata: { count: 0 } } } },
];

/**
 * The answer to a self-hosted session's call on an intercepted host that nothing else on the surface serves: its off-state answer when the table names one, and otherwise a 404 naming the mode. The 404 is deliberate for everything else (the grove notice, the referral offer, the artifacts contract and MCP server, the plugin directory, and inference itself for a session with no provider): each is a feature only the Anthropic hosts provide, the lab showed the client treating the 404 as one clean failure with no retry and no refresh, and the message says why, so a caller reading it learns the mode rather than suspecting the door.
 */
export function rcSelfHostOfflineAnswer(pathname: string): RcSelfHostOfflineAnswer {
  const entry = OFF_STATE_ENTRIES.find((candidate) => candidate.matches(pathname));
  if (entry !== undefined) {
    return entry.answer;
  }
  return {
    status: HTTP_STATUS.notFound,
    body: { type: "error", error: { type: "not_found_error", message: `the front door's self-hosted Remote Control mode serves nothing at ${pathname}: a self-hosted session's calls are answered on this machine and never forwarded to the Anthropic hosts` } },
  };
}

/** One header's single value, or undefined when absent or an unusable repeat. */
function singleHeader(headers: Readonly<IncomingHttpHeaders>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/** The scheme word an Authorization header carries a bearer under, matched without regard to case as the rest of the surface matches it. */
const BEARER_PREFIX = "bearer ";

/**
 * Whether one request belongs to the self-hosted mode, by the credential it presents: the minted bearer, or no credential at all (neither an Authorization header nor an API key), are the mode's; any other credential is a native session's and is never answered in its place. The comparison is constant time, like every capability check the door makes, and a missing mint means only credential-less requests are the mode's, since no bearer can match nothing.
 */
export function rcSelfHostOwnsPresentation(headers: Readonly<IncomingHttpHeaders>, mintedAccessToken: string | undefined): boolean {
  const authorization = singleHeader(headers, "authorization");
  if (authorization === undefined) {
    return headers["x-api-key"] === undefined;
  }
  if (mintedAccessToken === undefined || authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return false;
  }
  return isLiveCapability(authorization.slice(BEARER_PREFIX.length), [mintedAccessToken]);
}

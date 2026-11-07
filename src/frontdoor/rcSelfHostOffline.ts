import { HTTP_STATUS } from "../codex/http";

/**
 * The self-hosted Remote Control mode's guarantee that a self-hosted session never reaches the Anthropic hosts (ExaDev/agent-shim#731): every call such a session makes on an intercepted host that no other part of the surface serves is answered here, on this machine, instead of being forwarded with the minted credential to a host that only refuses it.
 *
 * Which requests are the mode's is decided by the connect surface from the launch a tunnel belongs to, never from what a request presents (see `rcSelfHostLaunches.ts`); this module only says what the mode answers. Two rules shape every answer: none of these calls is needed for Remote Control to activate or for a provider turn to complete, so each gets the feature's off state where the client parses one ("nothing here" rather than a failed fetch) and a 404 naming the mode otherwise; and none is ever a 401, which the client reads as a stale login and answers with a forced OAuth refresh and retries.
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
 * - the bootstrap read: every field of the client's bootstrap schema is optional, so an empty object parses and caches no models, settings or notices;
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
 * The answer to a self-hosted session's call on an intercepted host that nothing else on the surface serves: its off-state answer when the table names one, and otherwise a 404 naming the mode. The 404 is deliberate for everything else (the grove notice, the referral offer, the artifacts contract and MCP server, the plugin directory, and inference itself for a session with no provider): each is a feature only the Anthropic hosts provide, a 404 is a plain failure the client does not retry as a stale login, and the message says why, so a caller reading it learns the mode rather than suspecting the door.
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

/** Whether one path belongs to the Remote Control session family the self-hosted route serves: `/v1/code/sessions...` and the `/v1/sessions...` compatibility family. The route resolver and the local surface both decide by this one predicate, over a path already in the connect surface's canonical form. */
export function isRcSessionFamilyPath(pathname: string): boolean {
  return pathname === "/v1/code/sessions" || pathname.startsWith("/v1/code/sessions/") || pathname === "/v1/sessions" || pathname.startsWith("/v1/sessions/");
}

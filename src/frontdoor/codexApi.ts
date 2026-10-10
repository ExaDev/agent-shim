import { openapi } from "@orpc/openapi";
import type { RouterClient } from "@orpc/server";

import type { CodexStatus } from "../codex/commands";
import type { SiwcLogoutResult } from "../codex/siwcLogin";
import { CodexLogoutOutputSchema, CodexStatusOutputSchema } from "./controlSchemas";
import { doorApiAuth } from "./rcApi";

/**
 * The door's Codex sign-in as a typed oRPC API, behind the same per-generation control token as every other procedure on the mount: `codex.status` reports what `agent-shim codex status` reports about the sign-in and the codex providers, and `codex.logout` revokes the Sign in with ChatGPT login and removes it from this machine.
 *
 * `codex login` is deliberately not a procedure: the sign-in redirects to a fixed loopback port on the door's host, so a browser on another machine cannot complete it, and a same-host caller has the CLI.
 */

/** Everything the Codex procedures need, injected so they serve against fakes in tests exactly as the door's real wiring serves against this machine. */
export interface CodexApiDeps {
  /** This generation's control token: the same value every other router on the mount checks. */
  readonly expectedToken: string;
  /** The codex translation's read-only status, as `collectCodexStatus` collects it. */
  readonly codexStatus: () => CodexStatus;
  /** Signs out as `agent-shim codex logout` does: revokes the refresh token at the issuer and removes the grant. */
  readonly codexLogout: () => Promise<SiwcLogoutResult>;
}

const CODEX_API_TAG = "codex";

/** Builds the Codex router: `codex.status` and `codex.logout`, every one behind the control-token middleware. */
export function createCodexApiRouter(deps: CodexApiDeps) {
  const authed = doorApiAuth(deps.expectedToken);
  return {
    codex: {
      status: authed
        .meta(openapi({ method: "GET", path: "/rest/codex/status", summary: "Read the Codex sign-in and the codex providers", tags: [CODEX_API_TAG] }))
        .output(CodexStatusOutputSchema)
        .handler(() => {
          const status = deps.codexStatus();
          return { signIn: status.signIn, codexProviders: status.codexProviders };
        }),
      logout: authed
        .meta(openapi({ method: "POST", path: "/rest/codex/logout", summary: "Revoke the Sign in with ChatGPT login and remove it", tags: [CODEX_API_TAG] }))
        .output(CodexLogoutOutputSchema)
        .handler(async () => await deps.codexLogout()),
    },
  };
}

/** The Codex router, as the merged mount's and the client's own types are derived from it. */
export type CodexApiRouter = ReturnType<typeof createCodexApiRouter>;

/** The Codex procedures alone as a client sees them. */
export type CodexApiClient = RouterClient<CodexApiRouter>;

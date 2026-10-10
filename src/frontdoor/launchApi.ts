import { ORPCError } from "@orpc/client";
import { openapi } from "@orpc/openapi";

import { CliError } from "../cliError";
import type { LaunchResolution } from "../launcher";
import { LaunchResolveInputSchema, LaunchResolveOutputSchema } from "./launchSchemas";
import { doorApiAuth, READ_ONLY_OPERATION_EXTENSION } from "./rcApi";

/**
 * The door's launch resolution as a typed oRPC API: what a launch from one directory would resolve to, as data, so a consumer that picks identities and spawns sessions elsewhere can ask the door for the decision without running the launcher.
 *
 * `launch.resolve` is the launcher's own decision (identity, pool pick, configuration profile, provider, launch flags, pinned version, binary and arguments) with its effects left out: nothing is spawned, the farm is not touched, no daemon is started or session registered, no pool pick is recorded, and no credential is resolved, so the answer names a credential by its block and never carries a token. It spawns nothing by design: a procedure that starts a process on the door's host with caller-chosen arguments is remote command execution, so the consumer spawns from the answer on its own host.
 */

/** Everything the launch procedures need, injected so they serve against fakes in tests exactly as the door's real wiring serves against this machine. */
export interface LaunchApiDeps {
  /** This generation's control token: the same value every router on the mount checks. */
  readonly expectedToken: string;
  /** Resolves one launch from a directory without performing it, returning the resolution and the warnings it raised. A refusal is thrown as the launcher raises it (a `CliError`). */
  readonly resolveLaunch: (request: { readonly path: string; readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>> }) => { readonly resolution: LaunchResolution; readonly warnings: readonly string[] };
}

/** The OpenAPI tag the launch routers group under in the document. */
const LAUNCH_API_TAG = "launch";

/** Builds the launch router: one read, behind the control-token middleware. */
export function createLaunchApiRouter(deps: LaunchApiDeps) {
  const authed = doorApiAuth(deps.expectedToken);
  return {
    launch: {
      resolve: authed
        .meta(
          openapi({
            method: "POST",
            path: "/rest/launch/resolve",
            summary: "Resolve what a launch from one directory would do, without performing it",
            tags: [LAUNCH_API_TAG],
            // A POST because the launch's environment and arguments are a body, but the answer changes nothing.
            spec: (current) => ({ ...current, [READ_ONLY_OPERATION_EXTENSION]: true }),
          }),
        )
        .input(LaunchResolveInputSchema)
        .output(LaunchResolveOutputSchema)
        .handler(({ input }) => {
          try {
            const { resolution, warnings } = deps.resolveLaunch({ path: input.path, argv: input.argv ?? [], env: input.env ?? {} });
            return { ...resolution, warnings };
          } catch (error: unknown) {
            // A launch the launcher refuses (no such identity, a missing profile, an ambient credential, a usage error in the arguments) is the caller's described launch being impossible, answered with the launcher's own message; anything else is a bug and stays one.
            if (error instanceof CliError) {
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            }
            throw error;
          }
        }),
    },
  };
}

/** The launch router, as the merged mount's and the client's own types are derived from it. */
export type LaunchApiRouter = ReturnType<typeof createLaunchApiRouter>;

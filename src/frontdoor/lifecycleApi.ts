import { ORPCError } from "@orpc/client";
import { openapi } from "@orpc/openapi";
import type { RouterClient } from "@orpc/server";

import { UpdateChannelError, UpdateConflictError, UpdateDownloadError, type UpdateReport } from "../update/update";
import { FrontDoorRestartOutputSchema, UpdateCheckOutputSchema } from "./controlSchemas";
import { doorApiAuth } from "./rcApi";

/**
 * The door's lifecycle operations as a typed oRPC API, behind the same per-generation control token as every other procedure on the mount: `frontdoor.restart` replaces the serving door in place, and `update.check` reports whether a newer release exists, the report `agent-shim update --check` prints.
 *
 * Applying an update is deliberately not a procedure: `update --mode auto` already installs releases on launch and restarts the door on every automatic update, so a network trigger would add the most dangerous call in the API (replacing the running program) for a case the mode covers.
 */

/** Everything the lifecycle procedures need, injected so they serve against fakes in tests exactly as the door's real wiring serves against this machine. */
export interface LifecycleApiDeps {
  /** This generation's control token: the same value every other router on the mount checks. */
  readonly expectedToken: string;
  /** The pid of the door process serving the call, which is the generation a restart replaces. */
  readonly doorPid: number;
  /** Replaces the serving door in place. The replacement ends the process answering the call, so the procedure runs this only once its own answer has been written. */
  readonly restartDoor: () => void;
  /** The update check as `agent-shim update --check` makes it: nothing is downloaded or changed. */
  readonly checkForUpdate: () => Promise<UpdateReport>;
}

const FRONTDOOR_API_TAG = "frontdoor";
const UPDATE_API_TAG = "update";

/** Builds the lifecycle routers: `frontdoor.restart` and `update.check`, every one behind the control-token middleware. */
export function createLifecycleApiRouter(deps: LifecycleApiDeps) {
  const authed = doorApiAuth(deps.expectedToken);
  return {
    frontdoor: {
      restart: authed
        .meta(openapi({ method: "POST", path: "/rest/frontdoor/restart", summary: "Replace the serving front door in place", description: "Answers with the pid of the door being replaced, then replaces it. The replacement is a new generation with its own control token: the caller reopens its client from the state root once the door's supervisor pid differs from the one returned.", tags: [FRONTDOOR_API_TAG] }))
        .output(FrontDoorRestartOutputSchema)
        .handler(({ context }) => {
          context.afterResponse(deps.restartDoor);
          return { action: "restarting" as const, previousPid: deps.doorPid };
        }),
    },
    update: {
      check: authed
        .meta(openapi({ method: "GET", path: "/rest/update/check", summary: "Check whether a newer release exists", tags: [UPDATE_API_TAG] }))
        .output(UpdateCheckOutputSchema)
        .handler(async () => {
          try {
            return await deps.checkForUpdate();
          } catch (error: unknown) {
            // The three refusals the update path names itself carry a message written for the person running it: a channel that updates through its package manager, a concurrent update, a release that could not be fetched.
            if (error instanceof UpdateChannelError) {
              throw new ORPCError("PRECONDITION_FAILED", { message: error.message });
            }
            if (error instanceof UpdateConflictError) {
              throw new ORPCError("CONFLICT", { message: error.message });
            }
            if (error instanceof UpdateDownloadError) {
              throw new ORPCError("BAD_GATEWAY", { message: error.message });
            }
            throw error;
          }
        }),
    },
  };
}

/** The lifecycle routers, as the merged mount's and the client's own types are derived from them. */
export type LifecycleApiRouter = ReturnType<typeof createLifecycleApiRouter>;

/** The lifecycle procedures alone as a client sees them. */
export type LifecycleApiClient = RouterClient<LifecycleApiRouter>;

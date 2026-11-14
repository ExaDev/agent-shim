import { CliError } from "../cliError";
import { HTTP_STATUS } from "../codex/http";
import { configFaultOf } from "../config/load";
import { isSystemReadError } from "../readableConfig";
import { UsageSnapshotError } from "../usage/read";
import type { RouteResolution } from "./pipeline";
import type { RoutedRequest } from "./route";

/** Whether `error` says a file of the person's local state could not be used: one the system would not read (a code such as `EACCES`, `EISDIR`, `ENOTDIR`, `ELOOP`), one that is no valid file of its kind (every expected failure of this program is a `CliError`), or a usage snapshot of another shape. Anything else is a defect. */
function isLocalStateFault(error: unknown): boolean {
  return isSystemReadError(error) || error instanceof CliError || error instanceof UsageSnapshotError;
}

/**
 * `resolve`, with a request whose routing reads a file of the person's local state that cannot be used refused with a 400 that names the fault (`configFaultOf`: its class or code, or the keys a file got wrong) and `agent-shim doctor`, never the error's own message, which names the file's path. Every port the request path reads local state through (identity names, route overrides, the models block, provider targets, usage snapshots, account moves, selector state, provider files) is behind this one boundary, so a port added later is too. A defect still rejects, as it should. The fault is logged with the same text.
 */
export function refusingLocalStateFaults(resolve: (request: RoutedRequest) => Promise<RouteResolution>, log: (line: string) => void): (request: RoutedRequest) => Promise<RouteResolution> {
  return async (request) => {
    try {
      return await resolve(request);
    } catch (error) {
      if (!isLocalStateFault(error)) {
        throw error;
      }
      const fault = configFaultOf(error);
      log(`front door: a request could not be routed because a local file could not be used (${fault})`);
      return { ok: false, status: HTTP_STATUS.badRequest, message: `the front door could not read the local configuration this request is routed by (${fault}): agent-shim doctor says what is wrong` };
    }
  };
}

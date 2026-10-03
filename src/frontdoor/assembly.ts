import { restoreCredentials, type CredentialCustody } from "./custody";
import type { PipelineDeps, ResponseObserver, RouteResolution } from "./pipeline";
import { AUTH_HEADER, HOP_ID_HEADER, HOP_SECRET_HEADER, parseProviderPath, type RoutedRequest } from "./route";

/** Everything the two listeners' pipelines are assembled from. */
export interface DoorPipelineDeps {
  readonly resolveRoute: (request: RoutedRequest) => Promise<RouteResolution>;
  /** Whether a presented capability belongs to a live registered launch, read fresh on every request since launches come and go. */
  readonly isLiveToken: (token: string) => boolean;
  /** The headroom daemon's port as it stands right now, undefined while it is down. */
  readonly headroomPort: () => number | undefined;
  /** This generation's hop secret: held only in this process's memory, set on what the hop sends headroom and demanded back on the direct listener. */
  readonly hopSecret: string;
  /** Where the hop parks a provider session's real credentials while its request crosses headroom. */
  readonly custody: CredentialCustody;
  /** The response middleware the client-facing pipeline runs at every response head: usage tracking registers here. */
  readonly responseObservers: readonly ResponseObserver[];
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/** One header's single value: a repeated internal header is malformed, and admission refuses rather than guessing which copy counts. */
function singleValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The client-facing listeners' admission: the request must present a live launch's capability, and is routed with its headers unchanged. */
function admitLaunch(isLiveToken: (token: string) => boolean): PipelineDeps["admit"] {
  return (request) => {
    const token = singleValue(request.headers[AUTH_HEADER]);
    return token !== undefined && isLiveToken(token)
      ? { ok: true, headers: { ...request.forwardable } }
      : { ok: false, message: "agent-shim front door: this request carries no capability from a live agent-shim launch" };
  };
}

/**
 * The direct listener's admission: only what this door's own headroom hop sent back gets through. The request must carry this generation's hop secret and a custody id that is live for the provider its path names; the hop's placeholder credentials are then swapped for the real ones the client sent. Anything else (a forged or stale id, an id for another provider, a missing secret) is refused before any route sees it, so nothing that reaches this plain-HTTP port can spend a credential it was never handed.
 */
function admitHop(hopSecret: string, custody: CredentialCustody): PipelineDeps["admit"] {
  return (request) => {
    if (singleValue(request.headers[HOP_SECRET_HEADER]) !== hopSecret) {
      return { ok: false, message: "agent-shim front door: the direct listener serves only this door's own headroom hop" };
    }
    const hopId = singleValue(request.headers[HOP_ID_HEADER]);
    const provider = parseProviderPath(new URL(request.url, "http://127.0.0.1").pathname)?.provider;
    const credentials = hopId === undefined || provider === undefined ? undefined : custody.redeem(hopId, provider);
    if (credentials === undefined) {
      return { ok: false, message: "agent-shim front door: this request names no live headroom hop for its provider" };
    }
    return { ok: true, headers: restoreCredentials(request.forwardable, credentials) };
  };
}

/**
 * Assembles the pipelines the door's listeners serve: the client-facing one (the provider listener and the CONNECT surface's routed paths), which applies the headroom hop and admits live launches; and the direct one headroom forwards back to, which never hops again and admits only the hop's own requests. Both production and the end-to-end tests build their door from this, so the tests exercise the same admission and custody wiring the daemon runs.
 */
export function createDoorPipelines(deps: DoorPipelineDeps): { readonly clientFacing: PipelineDeps; readonly direct: PipelineDeps } {
  return {
    clientFacing: {
      resolveRoute: deps.resolveRoute,
      // The response middleware hook point, where usage tracking registers. The direct listener registers none, because its responses are consumed by headroom, not by the client: the entry the client sees is where observation belongs, and observing both would record every hopped request twice.
      responseObservers: deps.responseObservers,
      admit: admitLaunch(deps.isLiveToken),
      headroom: { headroomPort: deps.headroomPort, hopSecret: deps.hopSecret, custody: deps.custody, log: deps.log },
      now: deps.now,
      log: deps.log,
    },
    direct: {
      resolveRoute: deps.resolveRoute,
      responseObservers: [],
      admit: admitHop(deps.hopSecret, deps.custody),
      now: deps.now,
      log: deps.log,
    },
  };
}

import type { LayoutPaths } from "../paths";
import { realIsProcessAlive } from "../realPorts";
import type { RcCredentialStore } from "./rcCredentialStore";
import type { RcSelfHostSurface } from "./rcSelfHost";
import { createRcSessionRegistryReader, rcRegistryIdentitiesOf } from "./rcSessionRegistry";
import { realRcSessionRegistryFs } from "./rcSessionRegistryFs";
import type { RcSessionTracker } from "./rcSessions";
import { createRcStatusResolver, type RcStatusResolver } from "./rcStatus";
import { readRcWorkerState, type RcEventDial } from "./rcWrites";

/** What the door hands its Remote Control status read: its state paths, its tracker and persisted credentials, the dial its writes ride, and, only when it serves Remote Control itself, the self-hosted surface. */
export interface DoorRcStatusDeps {
  readonly paths: LayoutPaths;
  readonly tracker: Pick<RcSessionTracker, "statusOf" | "noteReadWorkerState" | "credentialOf">;
  readonly credentialStore: Pick<RcCredentialStore, "read">;
  /** The dial the door's client-half writes ride, which chooses between the self-hosted service and the real one per call (`perSessionRcEventDial`). */
  readonly dial: RcEventDial;
  /** Present only in the self-hosted mode. */
  readonly selfHostSurface: Pick<RcSelfHostSurface, "ownsSession" | "readWorkerState"> | undefined;
  /** The current name of the identity whose directory id a tracked session's requests carried. */
  readonly identityNameOf: (id: string) => string | undefined;
}

/**
 * The status the door's control routes and typed API serve, over the real machine: the tracker's, with the worker state of any session that has none read from the backend that owns the session, and every session registered on this machine that the tracker holds no record of. The registry is searched across every identity's registry on each read, so an identity added after the door started is covered; it enriches every tracked status and names the registered sessions from the same read. A session the door's own self-hosted service owns (it holds it, or the credential is the one it minted) is read from it in process, since a dial to the door's own surface would be observed as the session's traffic, and any other is read from the real service with its OAuth credential, which the per-call dial sends to the real API host.
 */
export function createDoorRcStatus(deps: DoorRcStatusDeps): RcStatusResolver {
  const { selfHostSurface } = deps;
  return createRcStatusResolver({
    statusOf: deps.tracker.statusOf,
    noteReadWorkerState: deps.tracker.noteReadWorkerState,
    credentialOf: deps.tracker.credentialOf,
    registry: createRcSessionRegistryReader({ fs: realRcSessionRegistryFs, identities: () => rcRegistryIdentitiesOf(deps.paths), isRunning: realIsProcessAlive }),
    identityNameOf: deps.identityNameOf,
    persistedCredentialOf: deps.credentialStore.read,
    backends: {
      ...(selfHostSurface === undefined ? {} : { selfHosted: { owns: selfHostSurface.ownsSession, read: selfHostSurface.readWorkerState } }),
      service: async (sessionId, credentialOf) => await readRcWorkerState({ credentialOf, dial: deps.dial }, sessionId),
    },
    now: () => Date.now(),
  });
}

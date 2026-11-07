import { launchIdentitiesOf } from "../launcher/launchRecords";
import { isLiveCapability } from "./capability";
import { isSessionRecordName, readFrontDoorSessionRecord } from "./state";
import type { HeadroomFs } from "../headroom/state";
import type { RcSelfHostCredentialRecord } from "./rcSelfHost";

/**
 * Which CONNECT tunnels belong to a self-hosted Remote Control session (ExaDev/agent-shim#731): the launch whose capability the tunnel presented runs the identity the door's credential was minted into. A blind tunnel from such a launch is refused, because the hosts the CLI dials that way are Anthropic's and other third parties' (its updater and plugin marketplace) and the mode's contract is that a self-hosted session reaches none of them; a tunnel from any other launch (a native login, a provider session on another identity) is untouched.
 *
 * A mint recorded before the identity's id was (a record with no `identityId`) cannot be attributed to any launch, so it fails closed: every launch counts as the mode's, and the local surface refuses each of their calls with the instruction to mint again (see `rcSelfHostLocal.ts`), rather than letting the minted identity's traffic pass as native.
 *
 * The decision is read from files the door and the launcher already keep, fresh on every call, because launches come and go: the session registry names the launcher pid behind each capability, the launch records name the id of the identity that pid launches (the directory the launcher resolved, which a rename leaves alone), and the minted record names the id of the identity it was minted into. The two ids are compared directly, never through a name, so a rename, a suffixed id, or another identity named like the minted id changes nothing.
 */

/** Everything the check reads, injected so it runs against an in-memory filesystem in unit tests. */
export interface RcSelfHostLaunchDeps {
  readonly fs: Pick<HeadroomFs, "readFileUtf8" | "readdir">;
  readonly sessionsDir: string;
  readonly launchesDir: string;
  /** The door's minted record, read fresh on every call: undefined while nothing is minted (then no launch is self-hosted), and a record without an identity id (a mint from before ids were recorded) attributing every launch to the mode, since one it cannot attribute might be the minted identity's. */
  readonly mintedRecord: () => RcSelfHostCredentialRecord | undefined;
}

/** Builds the check: whether the launch presenting `capability` runs the identity the door's credential was minted into. */
export function createRcSelfHostLaunchCheck(deps: RcSelfHostLaunchDeps): (capability: string) => boolean {
  return (capability) => {
    const mint = deps.mintedRecord();
    if (mint === undefined) {
      return false;
    }
    const minted = mint.identityId;
    if (minted === undefined) {
      return true;
    }
    const launch = deps.fs
      .readdir(deps.sessionsDir)
      .filter(isSessionRecordName)
      .map((name) => readFrontDoorSessionRecord(deps.fs, deps.sessionsDir, name))
      .find((record) => record !== undefined && isLiveCapability(capability, [record.token]));
    if (launch === undefined) {
      return false;
    }
    return launchIdentitiesOf(deps.fs, deps.launchesDir, launch.pid).some((identityId) => identityId === minted);
  };
}

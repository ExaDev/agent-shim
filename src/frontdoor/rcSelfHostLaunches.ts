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

/** The process facts a redirected connection's attribution reads, injected so it runs against fakes in unit tests (`peerProcess.ts` in production). */
export interface RcSelfHostPeerDeps {
  /** The pid of the local process whose socket has `port` as its local port, or undefined when it cannot be read. */
  readonly peerProcessOf: (port: number) => Promise<number | undefined>;
  /** Every process's parent, or undefined when the table cannot be read. */
  readonly parentTable: () => Promise<ReadonlyMap<number, number> | undefined>;
  /** This door's own pid: its own client half dials the transparent surface, and is never a self-hosted session. */
  readonly doorPid: number;
}

/** Both decisions the mode is keyed on: a CONNECT tunnel's launch by its capability, and a redirected connection by its peer process. */
export interface RcSelfHostLaunchCheck {
  readonly ownsLaunch: (capability: string) => boolean;
  readonly ownsPeer: (port: number) => Promise<boolean>;
}

/**
 * Builds the checks. `ownsLaunch` is whether the launch presenting `capability` runs the identity the door's credential was minted into. `ownsPeer` attributes a redirected connection the same way by its peer: the process holding the connection's client end, then its ancestors up to the launcher, whose launch record names the identity. A peer that is this door, or a process no launcher started (a client run outside agent-shim, with no minted credential of the door's), is not the mode's; a connection whose peer or parentage cannot be read is, so an unattributable connection fails closed.
 */
export function createRcSelfHostLaunchCheck(deps: RcSelfHostLaunchDeps & RcSelfHostPeerDeps): RcSelfHostLaunchCheck {
  /** What the current mint attributes: nothing while there is no mint, every launch for a mint that names no identity, and otherwise the minted identity's id. */
  const mintedId = (): { readonly kind: "none" } | { readonly kind: "every" } | { readonly kind: "identity"; readonly id: string } => {
    const mint = deps.mintedRecord();
    if (mint === undefined) {
      return { kind: "none" };
    }
    return mint.identityId === undefined ? { kind: "every" } : { kind: "identity", id: mint.identityId };
  };
  const launcherRunsMinted = (pid: number, minted: string): boolean => launchIdentitiesOf(deps.fs, deps.launchesDir, pid).some((identityId) => identityId === minted);
  return {
    ownsLaunch: (capability) => {
      const minted = mintedId();
      if (minted.kind !== "identity") {
        return minted.kind === "every";
      }
      const launch = deps.fs
        .readdir(deps.sessionsDir)
        .filter(isSessionRecordName)
        .map((name) => readFrontDoorSessionRecord(deps.fs, deps.sessionsDir, name))
        .find((record) => record !== undefined && isLiveCapability(capability, [record.token]));
      return launch !== undefined && launcherRunsMinted(launch.pid, minted.id);
    },
    ownsPeer: async (port) => {
      const minted = mintedId();
      if (minted.kind !== "identity") {
        return minted.kind === "every";
      }
      const peer = await deps.peerProcessOf(port);
      const parents = peer === undefined ? undefined : await deps.parentTable();
      if (peer === undefined || parents === undefined) {
        return true;
      }
      // Walks from the peer towards the root: the first ancestor with a launch record is the launch the connection belongs to. The walk stops at a pid already seen, so a parent table read mid-change cannot loop it.
      const seen = new Set<number>();
      for (let pid: number | undefined = peer; pid !== undefined && pid > 0 && !seen.has(pid); pid = parents.get(pid)) {
        seen.add(pid);
        if (pid === deps.doorPid) {
          return false;
        }
        if (launchIdentitiesOf(deps.fs, deps.launchesDir, pid).length > 0) {
          return launcherRunsMinted(pid, minted.id);
        }
      }
      return false;
    },
  };
}

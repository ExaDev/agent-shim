import { randomBytes, randomUUID } from "node:crypto";

import { realFarmFs } from "../realPorts";
import type { LayoutPaths } from "../paths";
import { parentTable, peerProcessOf } from "./peerProcess";
import { MINTED_TOKEN_RANDOM_BYTES } from "./rcCommands";
import { createRcSelfHostSurface } from "./rcSelfHost";
import { createRcSelfHostLaunchCheck, type RcSelfHostLaunchCheck } from "./rcSelfHostLaunches";
import { backfillRcSelfHostIdentity, readRcSelfHostRecord } from "./rcSelfHostMint";
import { rcWebFetchAllowsPrivateFromEnv, realRcWebFetch } from "./rcWebFetch";

/**
 * The door's real wiring of the self-hosted mode's ownership decisions: the launch check over the door's own files and the process table, for the door process `doorPid`. The minted record is read fresh on every call, so a re-mint applies without a restart.
 */
function realRcSelfHostLaunchCheck(paths: LayoutPaths, doorPid: number): RcSelfHostLaunchCheck {
  return createRcSelfHostLaunchCheck({ fs: realFarmFs, sessionsDir: paths.frontdoorSessionsDir, launchesDir: paths.launchesDir, identitiesDir: paths.identitiesDir, mintedRecord: () => readRcSelfHostRecord(realFarmFs, paths.frontdoorDir), peerProcessOf, parentTable, doorPid });
}

/**
 * Attributes a mint from before the record named its identity to the identity holding its credential, so existing users keep their native sessions, and logs what it did through `log`. Only a mint no single identity holds is left, which makes the door refuse every launch's calls on the intercepted hosts until the identity is minted again.
 */
export function attributeRcSelfHostMint(paths: LayoutPaths, log: (line: string) => void): void {
  const backfill = backfillRcSelfHostIdentity(realFarmFs, paths.identitiesDir, paths.frontdoorDir);
  if (backfill.kind === "backfilled") {
    log(`self-hosted Remote Control surface: recorded the minted credential's identity (${backfill.identityId}), which the mint predated recording`);
  } else if (backfill.kind === "unmatched") {
    log(`self-hosted Remote Control surface: the minted credential names no identity and ${String(backfill.holders)} identities hold it, so no launch can be told apart from it and every launch's calls on the intercepted hosts are refused until the identity is minted again (agent-shim frontdoor rc selfhost mint <identity>)`);
  }
}

/**
 * The served self-hosted Remote Control surface of one door process, in memory only, with the real launch check its ownership decisions rest on. Its route rides the route resolver (so its exchanges are observed by the tracker exactly as the real host's are), and its local answers ride the connect surface's config.
 */
export function createRealRcSelfHostSurface(paths: LayoutPaths, doorPid: number, env: Readonly<Record<string, string | undefined>>, log: (line: string) => void): ReturnType<typeof createRcSelfHostSurface> {
  const ownership = realRcSelfHostLaunchCheck(paths, doorPid);
  return createRcSelfHostSurface({
    now: () => Date.now(),
    newUuid: randomUUID,
    randomToken: () => randomBytes(MINTED_TOKEN_RANDOM_BYTES).toString("base64url"),
    credentialRecord: () => readRcSelfHostRecord(realFarmFs, paths.frontdoorDir),
    webFetch: realRcWebFetch({ allowPrivate: rcWebFetchAllowsPrivateFromEnv(env) }),
    ownsLaunch: ownership.ownsLaunch,
    ownsPeer: ownership.ownsPeer,
    log,
  });
}

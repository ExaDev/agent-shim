import type { HeadroomFs } from "../headroom/state";
import type { LayoutPaths } from "../paths";
import { readFrontDoorCodexRecord, readFrontDoorState } from "./state";
import { readCatalogueFailure, readCatalogueStatus } from "./catalogueState";

/** What the door recorded of a refresh that met a redirect: why, and whether the redirect carried no `Location`, so no address is known to advise. */
export interface CatalogueRedirect {
  readonly reason: string;
  readonly unlocated: boolean;
}

/**
 * The providers (each with the reason its refresh recorded: from the door's worker it is the worker's failure in the door's own words, the error's class name and no URL or message, and the detail is what `agent-shim provider models <name> --refresh` prints from a shell) whose last catalogue refresh, as the serving front door recorded it, failed on a redirect it does not follow, and whose settings (`settingsOf`, the fingerprint of each provider as it is now) are the ones that refresh failed under: a status of the door's current generation that says `failed` while its failure file says it was a redirect (a field of its own, so the cut of a long reason cannot hide it). None are named when no door serves or the door recorded nothing, since a recorded failure belongs to the door that made it and a stale one proves nothing about the base URL now.
 */
export function providersWithRedirectedCatalogue(fs: Pick<HeadroomFs, "readFileUtf8">, paths: LayoutPaths, settingsOf: ReadonlyMap<string, string | undefined>): ReadonlyMap<string, CatalogueRedirect> {
  const supervisorPid = readFrontDoorState(fs, paths.frontdoorStateFile)?.supervisorPid;
  const generation = supervisorPid === undefined ? undefined : readFrontDoorCodexRecord(fs, paths.frontdoorDir, supervisorPid)?.generation;
  if (supervisorPid === undefined || generation === undefined) {
    return new Map();
  }
  const found = new Map<string, CatalogueRedirect>();
  for (const [name, settings] of settingsOf) {
    if (readCatalogueStatus(fs, paths, supervisorPid, generation, name)?.status !== "failed") {
      continue;
    }
    const failure = readCatalogueFailure(fs, paths, supervisorPid, generation, name);
    // A redirect met by the provider as it was says nothing about the provider as it is edited now: the warning is dropped until a refresh fails again.
    if (settings !== undefined && failure?.redirected === true && failure.settings === settings) {
      found.set(name, { reason: failure.reason, unlocated: failure.unlocated });
    }
  }
  return found;
}

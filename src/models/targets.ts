import os from "node:os";

import { savedCatalogueFingerprint } from "../codex/catalogueCredential";
import { readFrontDoorCodexRecord, readFrontDoorState } from "../frontdoor/state";
import { providerModelRows } from "../launcher/modelPicker";
import type { LayoutPaths } from "../paths";
import { catalogueCachePath, parseCatalogueCache } from "../providerCatalogue";
import { listProviders } from "../providersStore";
import { realFarmFs, realFsPort, realIsProcessAlive } from "../realPorts";

/** One model a provider offers, as `model match` names it. */
export interface ProviderModel {
  readonly provider: string;
  readonly model: string;
}

/** Every model the defined providers offer, from the same rows a launch's /model list is built from: tier models, aliases, declared picker models and the fetched catalogues. */
export function providerModels(paths: Parameters<typeof listProviders>[0]): readonly ProviderModel[] {
  const door = readFrontDoorState(realFarmFs, paths.frontdoorStateFile);
  const recordedPid = door?.port === undefined ? undefined : door.supervisorPid;
  const supervisorPid = recordedPid !== undefined && realIsProcessAlive(recordedPid) ? recordedPid : undefined;
  const doorRecord = supervisorPid === undefined ? undefined : readFrontDoorCodexRecord(realFarmFs, paths.frontdoorDir, supervisorPid);
  const doorHome = doorRecord?.codexHome;
  return listProviders(paths).flatMap((entry) => {
    if (entry.provider.kind === "codex" && supervisorPid !== undefined && doorRecord === undefined) return [];
    const catalogue = parseCatalogueCache(realFsPort.readFileUtf8(entry.provider.kind === "codex" ? catalogueCachePath(paths, entry.name, supervisorPid, doorRecord?.generation) : catalogueCachePath(paths, entry.name)));
    if (entry.provider.kind === "codex") {
      if (catalogue !== undefined && catalogue.supervisorPid !== supervisorPid) return [];
      const env = doorHome === undefined ? process.env : { ...process.env, CODEX_HOME: doorHome };
      const fingerprint = savedCatalogueFingerprint(entry.provider, paths, env, os.homedir(), realFsPort.readFileUtf8);
      if (fingerprint === undefined || catalogue?.credentialFingerprint !== fingerprint) return [];
    }
    return providerModelRows(entry.provider, catalogue?.models).map((row) => ({ provider: entry.name, model: row.model }));
  });
}

/** Every target the defined providers offer, as the `<provider>/<model>` refs a virtual model's members and a family's targets are written in. */
export function targetRefs(paths: LayoutPaths): readonly string[] {
  return providerModels(paths).map((entry) => `${entry.provider}/${entry.model}`);
}

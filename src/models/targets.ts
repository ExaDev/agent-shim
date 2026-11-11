import os from "node:os";

import { savedCatalogueFingerprint } from "../codex/catalogueCredential";
import { readFrontDoorCodexRecord, readFrontDoorState } from "../frontdoor/state";
import { providerModelRows } from "../launcher/modelPicker";
import type { LayoutPaths } from "../paths";
import { isHttpProvider } from "../config/schema";
import { catalogueMatchesSettings, parseCatalogueCache, parseCatalogueSettings } from "../providerCatalogue";
import { StoredCatalogue, TolerantReader, skipUnreadableCatalogue } from "../storedCatalogue";
import { listProviders } from "../providersStore";
import { realFarmFs, realFsPort, realIsProcessAlive } from "../realPorts";

/** One model a provider offers, as `model match` names it. */
export interface ProviderModel {
  readonly provider: string;
  readonly model: string;
}

/** Every model the defined providers offer, from the same rows a launch's /model list is built from: tier models, aliases, declared picker models and the fetched catalogues. A provider whose stored catalogue files cannot be read lists the models its own settings name and none from a catalogue, and no other provider is affected. */
export function providerModels(paths: Parameters<typeof listProviders>[0]): readonly ProviderModel[] {
  const door = readFrontDoorState(realFarmFs, paths.frontdoorStateFile);
  const recordedPid = door?.port === undefined ? undefined : door.supervisorPid;
  const supervisorPid = recordedPid !== undefined && realIsProcessAlive(recordedPid) ? recordedPid : undefined;
  const doorRecord = supervisorPid === undefined ? undefined : readFrontDoorCodexRecord(realFarmFs, paths.frontdoorDir, supervisorPid);
  const doorHome = doorRecord?.codexHome;
  const reader = new TolerantReader((file) => realFsPort.readFileUtf8(file), skipUnreadableCatalogue);
  const files = new StoredCatalogue(paths, reader);
  return listProviders(paths).flatMap((entry) => {
    if (entry.provider.kind === "codex" && supervisorPid !== undefined && doorRecord === undefined) return [];
    const owner = supervisorPid === undefined || doorRecord === undefined ? undefined : { pid: supervisorPid, generation: doorRecord.generation };
    const stored = parseCatalogueCache(files.cacheText(entry.name, entry.provider.kind === "codex" ? owner : undefined));
    // A list fetched under settings other than the provider's current ones (another base URL, catalogue URL or credential) lists the models of another server.
    const catalogue = stored !== undefined && isHttpProvider(entry.provider) && !catalogueMatchesSettings(parseCatalogueSettings(files.digestText(entry.name)), stored, entry.provider) ? undefined : stored;
    if (entry.provider.kind === "codex") {
      if (catalogue !== undefined && catalogue.supervisorPid !== supervisorPid) return [];
      const env = doorHome === undefined ? process.env : { ...process.env, CODEX_HOME: doorHome };
      const fingerprint = savedCatalogueFingerprint(entry.provider, paths, env, os.homedir(), reader);
      if (fingerprint === undefined || catalogue?.credentialFingerprint !== fingerprint) return [];
    }
    return providerModelRows(entry.provider, catalogue?.models).map((row) => ({ provider: entry.name, model: row.model }));
  });
}

/** Every target the defined providers offer, as the `<provider>/<model>` refs a virtual model's members and a family's targets are written in. */
export function targetRefs(paths: LayoutPaths): readonly string[] {
  return providerModels(paths).map((entry) => `${entry.provider}/${entry.model}`);
}

import { providerModelRows } from "../launcher/modelPicker";
import type { LayoutPaths } from "../paths";
import { catalogueCachePath, parseCatalogueCache } from "../providerCatalogue";
import { listProviders } from "../providersStore";
import { realFsPort } from "../realPorts";

/** One model a provider offers, as `model match` names it. */
export interface ProviderModel {
  readonly provider: string;
  readonly model: string;
}

/** Every model the defined providers offer, from the same rows a launch's /model list is built from: tier models, aliases, declared picker models and the fetched catalogues. */
export function providerModels(paths: Parameters<typeof listProviders>[0]): readonly ProviderModel[] {
  return listProviders(paths).flatMap((entry) => {
    const catalogue = parseCatalogueCache(realFsPort.readFileUtf8(catalogueCachePath(paths, entry.name)));
    return providerModelRows(entry.provider, catalogue?.models).map((row) => ({ provider: entry.name, model: row.model }));
  });
}

/** Every target the defined providers offer, as the `<provider>/<model>` refs a virtual model's members and a family's targets are written in. */
export function targetRefs(paths: LayoutPaths): readonly string[] {
  return providerModels(paths).map((entry) => `${entry.provider}/${entry.model}`);
}

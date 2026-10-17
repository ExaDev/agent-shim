import type { Command } from "commander";

import { printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { listProviders } from "./providersStore";
import { providerModelRows } from "./launcher/modelPicker";
import { catalogueCachePath, parseCatalogueCache } from "./providerCatalogue";
import { realFsPort } from "./realPorts";
import { relateModels } from "./models/identity";

/** One model a provider offers, as `model match` names it. */
export interface ProviderModel {
  readonly provider: string;
  readonly model: string;
}

/** Every model the defined providers offer, from the same rows a launch's /model list is built from: tier models, aliases, declared picker models and the fetched catalogues. */
function providerModels(paths: Parameters<typeof listProviders>[0]): readonly ProviderModel[] {
  return listProviders(paths).flatMap((entry) => {
    const catalogue = parseCatalogueCache(realFsPort.readFileUtf8(catalogueCachePath(paths, entry.name)));
    return providerModelRows(entry.provider, catalogue?.models).map((row) => ({ provider: entry.name, model: row.model }));
  });
}

/** Groups the models whose names are the same model, and lists the pairs that are merely similar, across every provider given. */
export function matchModels(models: readonly ProviderModel[]): { readonly same: readonly (readonly ProviderModel[])[]; readonly similar: readonly [ProviderModel, ProviderModel][] } {
  const same: ProviderModel[][] = [];
  for (const model of models) {
    const group = same.find((candidates) => candidates.some((other) => relateModels(other.model, model.model) === "same" && other.provider !== model.provider));
    if (group === undefined) {
      same.push([model]);
    } else {
      group.push(model);
    }
  }
  const similar: [ProviderModel, ProviderModel][] = [];
  for (let outer = 0; outer < models.length; outer += 1) {
    for (let inner = outer + 1; inner < models.length; inner += 1) {
      const left = models[outer];
      const right = models[inner];
      if (left === undefined || right === undefined || left.provider === right.provider) {
        continue;
      }
      if (relateModels(left.model, right.model) === "similar" && !same.some((group) => group.includes(left) && group.includes(right))) {
        similar.push([left, right]);
      }
    }
  }
  return { same: same.filter((group) => group.length > 1), similar };
}

/** Registers the `agent-shim model` subcommand tree. */
export function registerModelsCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const modelsCommand = program.command("model").description("Inspect the models the defined providers offer: which names are the same model across providers, and which only look alike.");
  withExamples(modelsCommand, ["agent-shim model match"]);
  withExamples(
    modelsCommand.command("match").description("List every model every provider offers, grouped into the ones that are the same model across providers, with the pairs that are merely similar named beside them.").option("--json", "Print the match as JSON."),
    ["agent-shim model match"],
  )
    .action((options: Readonly<{ json?: boolean }>) => {
      const models = providerModels(paths);
      const { same, similar } = matchModels(models);
      if (options.json === true) {
        printJson({ models, same, similar });
        return;
      }
      console.log(`Models of ${String(models.length)} across the defined providers:`);
      if (same.length === 0 && similar.length === 0) {
        console.log("  no two names are the same model, and none look alike");
        return;
      }
      for (const group of same) {
        console.log(`  same: ${group.map((entry) => `${entry.provider}/${entry.model}`).join(" = ")}`);
      }
      for (const [left, right] of similar) {
        console.log(`  similar: ${left.provider}/${left.model} ~ ${right.provider}/${right.model}`);
      }
    });
}

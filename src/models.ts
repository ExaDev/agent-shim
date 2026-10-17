import type { Command } from "commander";

import { printJson, reportMutation, withExamples, confirmRemoval, type CommandDeps } from "./cli/commandDeps";
import { collectRepeated } from "./cli/parsers";
import { providerModels, type ProviderModel } from "./models/targets";
import { CLAUDE_TIERS, SELECTION_MODES, type ModelsConfig, type SelectionModeName } from "./config/schema";
import { UsageError } from "./cliError";
import { buildFamilies } from "./models/families";
import { relateModels } from "./models/identity";
import { addDistinctPair, addSameGroup, expandMembers, readModels, removeAssertionsNaming, removeVirtualModel, setFamily, setPrice, setTier, setVirtualModel, VirtualModelNotFoundError } from "./modelsStore";
import { realFarmFs } from "./realPorts";
import { readUsageSnapshot } from "./usage/read";
import { quotaFactsOf } from "./usage/quotaFacts";
import { createTargetObservationStore } from "./selection/targetStore";
import { candidateOf, type CandidateWindowFacts } from "./selection/candidates";
import type { LayoutPaths } from "./paths";
import type { UsageSnapshot } from "./usage/schema";
import { selectMember } from "./selection/engine";

/** The quota facts for one provider, from the newest snapshot of any identity that records it: the identities this machine actually uses, each contributing what it last saw. */
function providerQuotaOf(paths: LayoutPaths): (provider: string) => Readonly<Partial<Record<"fiveHour" | "sevenDay" | "extraUsage", CandidateWindowFacts>>> {
  const newest = new Map<string, UsageSnapshot>();
  for (const name of realFarmFs.readdir(paths.usageSnapshotsDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const identity = name.slice(0, -".json".length);
    const snapshot = readUsageSnapshot(realFarmFs, paths.usageSnapshotsDir, identity);
    if (snapshot === undefined) {
      continue;
    }
    for (const provider of Object.keys(snapshot.providers)) {
      const known = newest.get(provider);
      if (known === undefined || snapshot.updatedAt.localeCompare(known.updatedAt) > 0) {
        newest.set(provider, snapshot);
      }
    }
  }
  return (provider) => {
    const snapshot = newest.get(provider);
    return snapshot === undefined ? {} : quotaFactsOf(snapshot.providers[provider]?.rateLimit?.unified, Date.now());
  };
}

/** What `explain` says of the members the door does not choose by quota: an account member is served by relaunching the session under its identity, so no signal ranks it, and a family member is resolved from the live catalogues, which the door does not read yet. A member is listed with how it is served so an account-only model never reads as spent. */
export function describeUnroutedMembers(members: readonly string[]): readonly string[] {
  return members.flatMap((member) => {
    if (member.startsWith("acct:")) {
      const [identity] = member.slice("acct:".length).split("/");
      return [`${member} is served by relaunching the session under identity "${identity ?? ""}", so no quota signal ranks it`];
    }
    return member.startsWith("family:") ? [`${member} is resolved from the live catalogues, which the door does not read yet, so it is not a candidate`] : [];
  });
}

/** Explains one virtual model's choice: the member its mode picks over the live signals, and why each candidate stands where it does. */
function explainVirtualModel(paths: LayoutPaths, name: string): void {
  const models = readModels(paths);
  const definition = models?.virtual?.[name];
  if (definition === undefined) {
    throw new UsageError(`No virtual model named "${name}".`);
  }
  const quotaOf = providerQuotaOf(paths);
  const observations = createTargetObservationStore(realFarmFs, paths);
  const members = expandMembers(name, models);
  const candidates = members
    .filter((member) => !member.startsWith("acct:") && !member.startsWith("family:"))
    .map((ref, order) => {
      const [provider] = ref.split("/");
      return candidateOf(ref, order, { quota: quotaOf(provider ?? ""), ...(observations.observation(ref) === undefined ? {} : { observation: observations.observation(ref) }), ...(models?.prices?.[ref] === undefined ? {} : { price: models.prices[ref] }) }, false);
    });
  const evaluated = candidates.map((candidate) => ({ candidate, capabilities: { vision: true, tools: true, thinking: true } }));
  const selection = selectMember(definition.mode, evaluated, {});
  const unrouted = describeUnroutedMembers(members);
  console.log(`${name} (${definition.mode}) chooses ${selection.ref ?? (candidates.length === 0 ? "nothing by quota" : "nothing")}:`);
  // With no routable candidate the engine's own reasons describe an empty set (it reads as every member being spent), so only what the members are is said.
  for (const line of candidates.length === 0 ? unrouted : [...selection.reasons, ...unrouted]) {
    console.log(`  ${line}`);
  }
}

/** Groups the models whose names are the same model across providers (a family, with the user's assertions applied), and lists the pairs that are merely similar, across every provider given. */
export function matchModels(models: readonly ProviderModel[], config?: ModelsConfig): { readonly same: readonly (readonly ProviderModel[])[]; readonly similar: readonly [ProviderModel, ProviderModel][] } {
  const refOf = (model: ProviderModel): string => `${model.provider}/${model.model}`;
  const byRef = new Map(models.map((model) => [refOf(model), model]));
  const families = buildFamilies(models.map(refOf), config);
  const familyOf = new Map(families.flatMap((family) => family.refs.map((ref) => [ref, family] as const)));
  const same = families
    .map((family) => family.refs.flatMap((ref) => byRef.get(ref) ?? []))
    .filter((group) => new Set(group.map((entry) => entry.provider)).size > 1);
  const distinct = config?.distinct ?? [];
  const similar: [ProviderModel, ProviderModel][] = [];
  for (let outer = 0; outer < models.length; outer += 1) {
    for (let inner = outer + 1; inner < models.length; inner += 1) {
      const left = models[outer];
      const right = models[inner];
      if (left === undefined || right === undefined || left.provider === right.provider) {
        continue;
      }
      const asserted = distinct.some(([a, b]) => (a === refOf(left) && b === refOf(right)) || (a === refOf(right) && b === refOf(left)));
      if (!asserted && familyOf.get(refOf(left)) !== familyOf.get(refOf(right)) && relateModels(left.model, right.model) === "similar") {
        similar.push([left, right]);
      }
    }
  }
  return { same, similar };
}

/** Registers the `agent-shim model` subcommand tree. */
export function registerModelsCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const modelsCommand = program
    .command("model")
    .description("Define and inspect the models the providers offer and the virtual models chosen among them.");
  withExamples(
    modelsCommand
      .command("explain <name>")
      .description("Show which member a virtual model's mode picks over the live signals, and why each candidate stands where it does.")
      .action((name: string) => {
        explainVirtualModel(paths, name);
      }),
    ["agent-shim model explain fast"],
  );
  withExamples(modelsCommand, ["agent-shim model match", "agent-shim model add fast --mode soonest-reset --member z/glm-5.3 --member m/MiniMax-M3"]);
  withExamples(
    modelsCommand.command("match").description("List every model every provider offers, grouped into the ones that are the same model across providers, with the pairs that are merely similar named beside them.").option("--json", "Print the match as JSON."),
    ["agent-shim model match"],
  ).action((options: Readonly<{ json?: boolean }>) => {
    const models = providerModels(paths);
    const { same, similar } = matchModels(models, readModels(paths));
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
  withExamples(
    modelsCommand
      .command("add <name>")
      .description("Define a virtual model: a named choice over members, taken by its mode.")
      .requiredOption("--mode <mode>", "How the virtual model chooses its member.", (value: string) => asMode(value))
      .option("--member <ref>", "One member it chooses among: a provider model (z/glm-5.3), an account model (acct:work/opus), another virtual model, or a family (family:<canonical>). Repeatable; order is the preference where the mode reads it.", collectRepeated),
    ["agent-shim model add fast --mode soonest-reset --member z/glm-5.3 --member m/MiniMax-M3"],
  ).action((name: string, options: { mode: SelectionModeName; member?: string[] }) => {
    if (options.member === undefined || options.member.length === 0) {
      throw new UsageError("A virtual model needs at least one member: pass --member <ref> (repeatable).");
    }
    setVirtualModel(paths, name, { mode: options.mode, members: options.member });
    console.log(`Defined virtual model "${name}" (${options.mode}): ${options.member.join(", ")}`);
  });
  withExamples(
    modelsCommand
      .command("set <name>")
      .description("Change a virtual model's mode or replace its member list; members not named are kept.")
      .option("--mode <mode>", "The new mode.", (value: string) => asMode(value))
      .option("--member <ref>", "Add or replace one member (repeatable).", collectRepeated),
    ["agent-shim model set fast --mode most-allowance"],
  ).action((name: string, options: { mode?: SelectionModeName; member?: string[] }) => {
    const existing = readModels(paths)?.virtual?.[name];
    if (existing === undefined) {
      throw new VirtualModelNotFoundError(name);
    }
    if (options.mode === undefined && options.member === undefined) {
      throw new UsageError("Nothing to change: pass --mode or --member.");
    }
    const members = options.member === undefined ? existing.members : [...new Set([...existing.members, ...options.member])];
    setVirtualModel(paths, name, { mode: options.mode ?? existing.mode, members });
    console.log(`Updated virtual model "${name}" (${options.mode ?? existing.mode}): ${members.join(", ")}`);
  });
  withExamples(
    modelsCommand.command("remove <name>").description("Remove a virtual model definition.").option("--yes", "Remove without asking for confirmation.").option("--json", "Print the result as JSON."),
    ["agent-shim model remove fast --yes"],
  ).action(async (name: string, options: Readonly<{ yes?: boolean; json?: boolean }>) => {
    await confirmRemoval(deps, options.yes, `virtual model "${name}"`);
    removeVirtualModel(paths, name);
    reportMutation(options.json, { action: "removed", kind: "model", name, value: undefined }, () => {
      console.log(`Removed virtual model "${name}".`);
    });
  });
  withExamples(
    modelsCommand
      .command("tier <tier>")
      .description("Point one Claude tier (fable, opus, sonnet, haiku) at a model ref: a concrete target, an account model, a virtual model, or a family.")
      .option("--ref <ref>", "The model ref the tier points at. Omit with --clear to reset the tier to its per-provider behaviour.")
      .option("--clear", "Reset the tier to its per-provider behaviour."),
    ["agent-shim model tier opus --ref fast", "agent-shim model tier opus --clear"],
  ).action((tier: string, options: Readonly<{ ref?: string; clear?: boolean }>) => {
    const which = asTier(tier);
    if (options.clear === true) {
      setTier(paths, which, undefined);
      console.log(`Tier ${which} reset to its per-provider behaviour.`);
      return;
    }
    if (options.ref === undefined) {
      throw new UsageError("Pass --ref <ref>, or --clear to reset the tier.");
    }
    setTier(paths, which, options.ref);
    console.log(`Tier ${which} points at ${options.ref}.`);
  });
  withExamples(
    modelsCommand
      .command("price <ref>")
      .description("Set a model ref's prices, in USD per million tokens, for the cheapest mode.")
      .option("--input <usd>", "The input price per million tokens.", (value: string) => asPrice(value))
      .option("--output <usd>", "The output price per million tokens.", (value: string) => asPrice(value))
      .option("--clear", "Remove the ref's prices instead."),
    ["agent-shim model price z/glm-5.3 --input 0.6 --output 2.2"],
  ).action((ref: string, options: Readonly<{ input?: number; output?: number; clear?: boolean }>) => {
    if (options.clear !== true && (options.input === undefined || options.output === undefined)) {
      throw new UsageError("Pass both --input and --output, or --clear to remove the ref's prices.");
    }
    setPrice(paths, ref, options.clear === true ? undefined : { input: options.input ?? 0, output: options.output ?? 0 });
    console.log(options.clear === true ? `Removed prices for ${ref}.` : `Prices for ${ref}: ${String(options.input)} in, ${String(options.output)} out per million tokens.`);
  });
  withExamples(
    modelsCommand.command("same <ref> <ref...>").description("Assert that these refs are one model under several names, which makes them one family a mode can route across."),
    ["agent-shim model same z/glm-5.1 o/zai-glm-51"],
  ).action((first: string, rest: readonly string[]) => {
    addSameGroup(paths, [first, ...rest]);
    console.log(`Asserted one model: ${[first, ...rest].join(" = ")}`);
  });
  withExamples(
    modelsCommand.command("distinct <left> <right>").description("Assert that two refs are two models, however alike their names look, so they are never put in one family."),
    ["agent-shim model distinct z/glm-5.1 s/hf:zai-org/GLM-5.1"],
  ).action((left: string, right: string) => {
    addDistinctPair(paths, left, right);
    console.log(`Asserted two models: ${left} / ${right}`);
  });
  withExamples(
    modelsCommand.command("unassert <ref>").description("Remove every identity assertion that names this ref."),
    ["agent-shim model unassert z/glm-5.1"],
  ).action((ref: string) => {
    const removed = removeAssertionsNaming(paths, ref);
    console.log(removed === 0 ? `No assertion names ${ref}.` : `Removed ${String(removed)} assertion${removed === 1 ? "" : "s"} naming ${ref}.`);
  });
  withExamples(
    modelsCommand
      .command("family <key>")
      .description("Set one family's own settings: how a row that selects the whole family chooses, the names the normaliser cannot know, and what every target of it can do.")
      .option("--mode <mode>", "How a row selecting the whole family chooses among its targets.", (value: string) => asMode(value))
      .option("--name <ref>", "Pin a ref or bare model name into the family (repeatable).", collectRepeated)
      .option("--context <tokens>", "The family's context window, in tokens.", (value: string) => asPositiveInteger(value))
      .option("--vision", "Every target of the family accepts images.")
      .option("--no-vision", "No target of the family accepts images.")
      .option("--tools", "Every target of the family accepts tools.")
      .option("--no-tools", "No target of the family accepts tools.")
      .option("--thinking", "Every target of the family thinks.")
      .option("--no-thinking", "No target of the family thinks.")
      .option("--clear", "Remove the family's settings instead."),
    ["agent-shim model family glm-5-1 --mode cheapest --no-vision", "agent-shim model family claude-opus-5-5 --name o/opus-latest"],
  ).action((key: string, options: Readonly<{ mode?: SelectionModeName; name?: string[]; context?: number; vision?: boolean; tools?: boolean; thinking?: boolean; clear?: boolean }>) => {
    if (options.clear === true) {
      setFamily(paths, key, undefined);
      console.log(`Removed the settings of family ${key}.`);
      return;
    }
    const existing = readModels(paths)?.families?.[key] ?? {};
    const settings = {
      ...existing,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.name === undefined ? {} : { names: [...new Set([...(existing.names ?? []), ...options.name])] }),
      ...(options.context === undefined ? {} : { context: options.context }),
      ...(options.vision === undefined ? {} : { vision: options.vision }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    };
    if (Object.keys(settings).length === 0) {
      throw new UsageError("Nothing to set: pass --mode, --name, --context, a capability flag, or --clear.");
    }
    setFamily(paths, key, settings);
    console.log(`Family ${key}: ${JSON.stringify(settings)}`);
  });
  withExamples(
    modelsCommand.command("list").description("List the defined virtual models, the tier pointers, the visibility filter, the identity assertions and the family settings.").option("--json", "Print the models block as JSON."),
    ["agent-shim model list"],
  ).action((options: Readonly<{ json?: boolean }>) => {
    const found = readModels(paths);
    if (options.json === true) {
      printJson(found ?? null);
      return;
    }
    if (found === undefined) {
      console.log("No models block is configured.");
      return;
    }
    for (const [name, model] of Object.entries(found.virtual ?? {})) {
      console.log(`${name} (${model.mode}): ${model.members.join(", ")}`);
    }
    for (const [tier, ref] of Object.entries(found.tiers ?? {})) {
      console.log(`tier ${tier} -> ${ref}`);
    }
    if (found.hide !== undefined) {
      console.log(`hidden: ${found.hide.join(", ")}`);
    }
    if (found.show !== undefined) {
      console.log(`visible only: ${found.show.join(", ")}`);
    }
    for (const group of found.same ?? []) {
      console.log(`same: ${group.join(" = ")}`);
    }
    for (const [left, right] of found.distinct ?? []) {
      console.log(`distinct: ${left} / ${right}`);
    }
    for (const [key, settings] of Object.entries(found.families ?? {})) {
      console.log(`family ${key}: ${JSON.stringify(settings)}`);
    }
  });
}

/** Parses a count of tokens, refusing anything that is not a positive whole number. */
function asPositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`"${value}" is not a token count: pass a positive whole number.`);
  }
  return parsed;
}

/** Parses a mode name, refusing an unknown one with the known names. */
function asMode(value: string): SelectionModeName {
  const mode = SELECTION_MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new UsageError(`Unknown mode "${value}". Known modes: ${SELECTION_MODES.join(", ")}.`);
  }
  return mode;
}

/** Parses a tier name, refusing an unknown one. */
/** Parses a price, refusing anything that is not a positive number of dollars. */
function asPrice(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`"${value}" is not a price: pass a positive number of US dollars.`);
  }
  return parsed;
}

function asTier(value: string): "fable" | "opus" | "sonnet" | "haiku" {
  const tier = CLAUDE_TIERS.find((candidate) => candidate === value);
  if (tier === undefined) {
    throw new UsageError(`Unknown tier "${value}". Known tiers: ${CLAUDE_TIERS.join(", ")}.`);
  }
  return tier;
}


import fs from "node:fs";
import path from "node:path";
import { ConfigProfileSchema, GlobalConfigSchema, ProviderSchema, isHttpProvider, isRouterProvider, type LaunchFlags, type ModelsConfig, type ModelsLayer } from "./config/schema";
import { applyPatch, writeJsonAtomic } from "./config/store";
import { ConfigValidationError } from "./config/load";
import { UsageError } from "./cliError";
import { listProfiles, readGlobalConfig } from "./configProfilesStore";
import { effectiveStore, type CredentialCachePort } from "./credentialCache";
import type { FarmFs } from "./launcher/ports";
import { catalogueCachePath } from "./providerCatalogue";
import { UsageSnapshotSchema } from "./usage/schema";
import { listUsageSnapshots, snapshotPath, type UsageReadFs } from "./usage/read";
import { readDirectoryRules, writeDirectoryRules } from "./directoryRulesStore";
import { requireNewProviderName } from "./config/names";
import type { LayoutPaths } from "./paths";
import { aliasesAfterRename, readProviderAliases, writeProviderAliases } from "./providerAliases";
import { ProviderAlreadyExistsError, ProviderNotFoundError, listProviders, providerExists, providerJsonPath, readProvider } from "./providersStore";

/** A model ref with a leading `<from>/` provider qualifier rewritten to `<to>/`. Refs that name no provider (`acct:work/opus`, `family:glm-5-1`, a virtual model's name) never start with a provider's name followed by a slash, because `:` is outside the provider alphabet. */
function renameRef(ref: string, from: string, to: string): string {
  return ref.startsWith(`${from}/`) ? `${to}${ref.slice(from.length)}` : ref;
}

/**
 * The `models` block with every ref qualified by provider `from` requalified by `to`: virtual models' members, tier pointers, prices, the visibility lists, the same and distinct assertions, and the names pinned into families. Anything else is returned as it was. A cascade layer's `null` (a removal) is kept as it is.
 */
export function renameModelRefs(models: ModelsConfig, from: string, to: string): ModelsConfig;
export function renameModelRefs(models: ModelsLayer, from: string, to: string): ModelsLayer;
export function renameModelRefs(models: ModelsLayer, from: string, to: string): ModelsLayer {
  const rename = (ref: string): string => renameRef(ref, from, to);
  const renamed: ModelsLayer = { ...models };
  if (models.virtual !== undefined) {
    renamed.virtual = Object.fromEntries(Object.entries(models.virtual).map(([name, definition]) => [name, definition === null ? null : { ...definition, members: definition.members.map(rename) }]));
  }
  if (models.tiers !== undefined) {
    renamed.tiers = Object.fromEntries(Object.entries(models.tiers).map(([tier, ref]) => [tier, typeof ref === "string" ? rename(ref) : ref]));
  }
  if (models.prices !== undefined) {
    renamed.prices = Object.fromEntries(Object.entries(models.prices).map(([ref, price]) => [rename(ref), price]));
  }
  if (models.hide !== undefined) {
    renamed.hide = models.hide.map(rename);
  }
  if (models.show !== undefined) {
    renamed.show = models.show.map(rename);
  }
  if (models.same !== undefined) {
    renamed.same = models.same.map((group) => group.map(rename));
  }
  if (models.distinct !== undefined) {
    renamed.distinct = models.distinct.map(([left, right]) => [rename(left), rename(right)]);
  }
  if (models.families !== undefined) {
    renamed.families = Object.fromEntries(Object.entries(models.families).map(([key, settings]) => [key, settings?.names === undefined ? settings : { ...settings, names: settings.names.map(rename) }]));
  }
  return renamed;
}

/** The launch flags with `provider` renamed, or undefined when they do not select `from`. */
function renamedLaunch(launch: LaunchFlags | undefined, from: string, to: string): LaunchFlags | undefined {
  return launch?.provider === from ? { ...launch, provider: to } : undefined;
}

/** The renamed `models` block, or undefined when no ref in it was qualified by `from`. */
function renamedModels(models: ModelsConfig, from: string, to: string): ModelsConfig | undefined;
function renamedModels(models: ModelsLayer, from: string, to: string): ModelsLayer | undefined;
function renamedModels(models: ModelsLayer, from: string, to: string): ModelsLayer | undefined {
  const renamed = renameModelRefs(models, from, to);
  return JSON.stringify(renamed) === JSON.stringify(models) ? undefined : renamed;
}

/** What `renameProvider` reaches beyond the configuration files: the usage snapshots and the credential cache. Injected so a test renames against fakes and the library never imports a real filesystem or the Keychain. */
export interface ProviderRenamePorts {
  readonly fs: UsageReadFs & Pick<FarmFs, "writeFilePrivate">;
  readonly credentialCache: { readonly port: CredentialCachePort; readonly platform: NodeJS.Platform };
}

/** What `renameProvider` did, for the command to report. */
export interface ProviderRenameReport {
  readonly from: string;
  readonly to: string;
  /** Everything that named the provider and now names its new name or holds its state under it: `config.json`, `profile <name>`, `rule <path>`, `provider <name> routes`, `usage <identity>`, `catalogue` and `credential cache`. */
  readonly updated: readonly string[];
}

/**
 * Renames provider `from` to `to` without cutting off anything that still uses the old name. The old name is recorded as an alias first, so a session launched under it is served throughout; then the provider file moves, every place this installation's own configuration names the provider is rewritten (the global file's `launch.provider` and `models` block, each profile's and directory rule's, and the `routes` of other providers), and the state kept under the old name moves with it (the provider's slice in each usage snapshot, its fetched catalogue, its cached credential).
 *
 * Throws `ProviderNotFoundError` when `from` has no file, `ProviderAlreadyExistsError` when `to` has one, `InvalidProviderNameError` when `to` breaks the naming rule and `UsageError` when the names are equal. A committed `.agent-shim.json` in a project is not reachable from here: a `launch.provider` in one keeps working through the alias, and a `models` ref in one is the project's to update. The usage log keeps its records under the name they were written with.
 */
export function renameProvider(paths: LayoutPaths, from: string, to: string, ports: ProviderRenamePorts): ProviderRenameReport {
  if (from === to) {
    throw new UsageError(`"${from}" is already the provider's name.`);
  }
  requireNewProviderName(to);
  if (!providerExists(paths, from)) {
    throw new ProviderNotFoundError(from);
  }
  if (providerExists(paths, to)) {
    throw new ProviderAlreadyExistsError(to);
  }
  const previousAliases = readProviderAliases(paths);
  writeProviderAliases(paths, aliasesAfterRename(previousAliases, from, to));
  try {
    fs.renameSync(providerJsonPath(paths, from), providerJsonPath(paths, to));
  } catch (error) {
    writeProviderAliases(paths, previousAliases);
    throw error;
  }
  return { from, to, updated: [...rewriteReferences(paths, from, to), ...moveState(paths, from, to, ports)] };
}

/** Moves the state kept under the old provider name to the new one: its slice in each usage snapshot (unless the new name already has one, which is newer), its fetched catalogue, and its cached credential. */
function moveState(paths: LayoutPaths, from: string, to: string, ports: ProviderRenamePorts): readonly string[] {
  const moved: string[] = [];
  for (const snapshot of listUsageSnapshots(ports.fs, paths.usageSnapshotsDir)) {
    const slice = snapshot.providers[from];
    if (slice === undefined) {
      continue;
    }
    const others = Object.entries(snapshot.providers).filter(([name]) => name !== from);
    const providers = Object.fromEntries(snapshot.providers[to] === undefined ? [...others, [to, slice]] : others);
    ports.fs.writeFilePrivate(snapshotPath(paths.usageSnapshotsDir, snapshot.identity), `${JSON.stringify(UsageSnapshotSchema.parse({ ...snapshot, providers }), null, 2)}\n`);
    moved.push(`usage ${snapshot.identity}`);
  }
  if (fs.existsSync(catalogueCachePath(paths, from))) {
    fs.renameSync(catalogueCachePath(paths, from), catalogueCachePath(paths, to));
    moved.push("catalogue");
  }
  const renamed = readProvider(paths, to);
  const cache = renamed === undefined || isRouterProvider(renamed) ? undefined : renamed.credential.cache;
  if (cache !== undefined) {
    const store = effectiveStore(cache, ports.credentialCache.platform);
    const entry = ports.credentialCache.port.read(store, `provider ${from}`);
    if (entry !== undefined) {
      ports.credentialCache.port.write(store, `provider ${to}`, entry);
      ports.credentialCache.port.remove(store, `provider ${from}`);
      moved.push("credential cache");
    }
  }
  return moved;
}

/** Rewrites every reference to provider `from` in the configuration this installation owns, returning where it found one. */
function rewriteReferences(paths: LayoutPaths, from: string, to: string): readonly string[] {
  const rewritten: string[] = [];
  const global = readGlobalConfig(paths);
  if (global !== undefined) {
    const launch = renamedLaunch(global.launch, from, to);
    const models = global.models === undefined ? undefined : renamedModels(global.models, from, to);
    if (launch !== undefined || models !== undefined) {
      applyPatch(paths.globalConfigFile, GlobalConfigSchema, { ...(launch === undefined ? {} : { launch }), ...(models === undefined ? {} : { models }) });
      rewritten.push("config.json");
    }
  }
  for (const { name, profile } of listProfiles(paths)) {
    const launch = renamedLaunch(profile.launch, from, to);
    const models = profile.models === undefined ? undefined : renamedModels(profile.models, from, to);
    if (launch !== undefined || models !== undefined) {
      applyPatch(path.join(paths.configProfilesDir, `${name}.json`), ConfigProfileSchema, { ...(launch === undefined ? {} : { launch }), ...(models === undefined ? {} : { models }) });
      rewritten.push(`profile ${name}`);
    }
  }
  const rules = readDirectoryRules(paths);
  const renamedRules = rules.rules.map((rule) => {
    const launch = renamedLaunch(rule.launch, from, to);
    const models = rule.models === undefined ? undefined : renamedModels(rule.models, from, to);
    if (launch === undefined && models === undefined) {
      return rule;
    }
    rewritten.push(`rule ${rule.path}`);
    return { ...rule, ...(launch === undefined ? {} : { launch }), ...(models === undefined ? {} : { models }) };
  });
  if (renamedRules.some((rule, index) => rule !== rules.rules[index])) {
    writeDirectoryRules(paths, { ...rules, rules: renamedRules });
  }
  for (const { name, provider } of listProviders(paths)) {
    if (isHttpProvider(provider) && provider.routes?.some((route) => route.provider === from) === true) {
      const next = ProviderSchema.safeParse({ ...provider, routes: provider.routes.map((route) => (route.provider === from ? { ...route, provider: to } : route)) });
      if (!next.success) {
        throw new ConfigValidationError(providerJsonPath(paths, name), next.error.issues);
      }
      writeJsonAtomic(providerJsonPath(paths, name), next.data);
      rewritten.push(`provider ${name} routes`);
    }
  }
  return rewritten;
}

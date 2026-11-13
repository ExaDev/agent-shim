import { AUTO_ALIAS } from "../antigravity/translate";
import { resolveCodexConfig } from "../codex/translate";
import { providerFilePath } from "../config/names";
import { OTHER_MODEL_ENV_VARIABLES, TIER_MODEL_ENV_VARIABLES, isAntigravityProvider, isCodexProvider, isHttpProvider, isRouterProvider, type HttpProvider, type ModelsConfig, type Provider } from "../config/schema";
import { describeCredential } from "../credential";
import { providerModelRows } from "../launcher/modelPicker";
import type { FsPort } from "../launcher/ports";
import { withoutContextMarker } from "../models/identity";
import { AUTO_MODEL } from "../models/reservedModelNames";
import { TIER_ENV_VARIABLES, claudeNameTier } from "../models/tiers";
import type { CatalogueModel } from "../providerCatalogue";
import { listProviderNames, loadProvider } from "../providersStore";
import { catalogueReadFault } from "../storedCatalogue";
import type { SelectorTarget } from "../models/selectors";
import type { MappedModel } from "./mainLoopRoute";

/**
 * Whether `model` is one of the models a provider serves itself, from the lists of its served models in the order they are asked: its `env` first (a lookup by revision, no listing), then the wider ones (the targets of every provider, or the provider's own rows with its catalogue), which are asked only when the earlier ones did not say. The one test of what a provider serves, shared by the resolver and by the tier mapping of a Claude name. A model compares without its context-window marker, on either side.
 */
export function servesName(model: string, ...lists: readonly (() => readonly string[])[]): boolean {
  const bare = withoutContextMarker(model);
  return lists.some((listed) => listed().some((named) => withoutContextMarker(named) === bare));
}

/** The variables whose value is the model a bare provider name selects on an `http` provider, in order: `ANTHROPIC_MODEL`, the model Claude Code runs a session on when it is set and so the provider's own default, then the tiers (`TIER_MODEL_ENV_VARIABLES`). */
const DEFAULT_MODEL_VARIABLES: readonly string[] = ["ANTHROPIC_MODEL", ...TIER_MODEL_ENV_VARIABLES];

/** A name that selects a provider the provider cannot serve: the request is answered with this reason (a 400) instead of reaching any route. */
export interface RoutedRefusal {
  readonly refusal: string;
}

/** The model a bare provider name selects on that provider, or why it selects none. */
export type ProviderDefault = { readonly model: string } | RoutedRefusal;

/** What a provider's file is: absent, found and valid, or listed and invalid (the reason names the file). */
type ProviderLookup = { readonly kind: "absent" } | { readonly kind: "found"; readonly definition: Provider } | { readonly kind: "invalid"; readonly reason: string };

/** What `createProviderReads` reads: the providers directory through the launcher's file system port, the models block a session resolves its names against, and each provider's stored catalogue. */
export interface ProviderReadsDeps {
  readonly fs: FsPort;
  readonly providersDir: string;
  readonly models?: (session: Readonly<{ readonly sessionId?: string }>) => ModelsConfig | undefined;
  readonly catalogueModelsOf?: (name: string, provider: HttpProvider) => readonly CatalogueModel[];
}

/** The reads of the providers directory that the route resolver and the selector expansion share, each read by file revision (see `createProviderReads`). */
export interface ProviderReads {
  /** The provider file of `name`, parsed, or undefined when the directory lists no such name; throws the file's own error when it is listed and invalid. */
  readonly providerOf: (name: string) => Provider | undefined;
  readonly lookupProvider: (name: string) => ProviderLookup;
  /** Why the provider file of `name` cannot be used when it is listed and invalid, else `undefined`. */
  readonly providerFaultOf: (name: string) => string | undefined;
  /** Whether a provider file defines this name: an absent file and an unparseable one both answer no. */
  readonly definesProvider: (name: string) => boolean;
  /** The model names a provider's own `env` gives, which that provider serves for a session launched on it. */
  readonly envModelsOf: (name: string) => readonly string[];
  /** The models `definition`'s stored catalogue lists, or why they cannot be read (the class and code of the failure, never its message, which names a path). */
  readonly catalogueModels: (name: string, definition: HttpProvider) => { readonly models: readonly CatalogueModel[]; readonly fault?: string };
  /** The model a bare provider name selects on a found provider. */
  readonly defaultModelFor: (name: string, definition: Provider) => ProviderDefault;
  /** What a bare provider name selects: the provider's default model, a refusal when its file is invalid or it has no default, or `undefined` when no provider file has that name. */
  readonly defaultModelOf: (name: string) => ProviderDefault | undefined;
  /** What `provider` does with a bare Claude model name a session on it asks for, and the credential it uses, named never valued (see `followingMainLoop`). */
  readonly providerMapping: (provider: string, session: Readonly<{ readonly sessionId?: string }>, requested: string) => { readonly model: MappedModel; readonly credential: string | undefined };
  /** The name a selector that resolved to `provider` is routed by (see `SelectorPorts.providerTarget`). */
  readonly selectorTarget: (provider: string, target: SelectorTarget, session: Readonly<{ readonly sessionId?: string }>) => { readonly name: string } | RoutedRefusal;
}

/**
 * Builds the reads of the providers directory: each provider file is parsed once per revision and kept until its revision changes, and the directory's listing likewise, so a request naming an existing provider costs a stat of the directory and one of the file. A revision is kept only when the one taken after the read equals the one before it, so a write that lands during a read is not kept under the earlier revision.
 */
export function createProviderReads(deps: Readonly<ProviderReadsDeps>): ProviderReads {
  // A provider file by name, valid or not as `loadProvider` finds it. Where the file system port can name a file's revision without reading it, the parsed provider is kept until the revision changes; a file with no revision (absent, or a port that cannot say) is read, as the route's own loads do. One entry for each provider name the door has parsed, replaced when its file's revision changes and never evicted: bounded by the provider files a person keeps, since only a name the providers directory lists is ever parsed.
  const loaded = new Map<string, { readonly revision: string; readonly provider: Provider }>();
  // The names the providers directory lists, kept until the directory's revision changes where the file system port can name one (a file added, removed or renamed changes it); a port that cannot lists it each time.
  let listed: { readonly revision: string; readonly names: ReadonlySet<string> } | undefined;
  // A revision the file system cannot name (a stat that fails with EACCES or ELOOP) is no revision: the file or directory is then read on every call, and the read's own failure is the one reported, as when no port names revisions at all.
  const revisionOf = (file: string): string | undefined => {
    try {
      return deps.fs.fileRevision?.(file);
    } catch {
      return undefined;
    }
  };
  const providerNamesListed = (): ReadonlySet<string> => {
    const revision = revisionOf(deps.providersDir);
    if (revision !== undefined && listed?.revision === revision) {
      return listed.names;
    }
    const names = new Set(listProviderNames(deps.fs.readdir, deps.providersDir));
    if (revision !== undefined && revisionOf(deps.providersDir) === revision) {
      listed = { revision, names };
    }
    return names;
  };
  const providerOf = (name: string): Provider | undefined => {
    // Provider names are case-sensitive: a file system that ignores case answers `Spark` with `spark.json`, which would make a second provider of that file with its own pool, served-model cache, drop log and route-context key. Only a name the directory lists exactly is a provider of that name, as on a file system that keeps case. A name that is no file name (a model id of any length or spelling) is never listed, so it never reaches a read.
    if (!providerNamesListed().has(name)) {
      return undefined;
    }
    const revision = revisionOf(providerFilePath(deps.providersDir, name));
    const kept = loaded.get(name);
    if (revision !== undefined && kept?.revision === revision) {
      return kept.provider;
    }
    const provider = loadProvider(deps.providersDir, name, deps.fs);
    // Kept only when the revision after the read equals the one before it, so a write that lands while the file is read is not kept under the earlier revision.
    if (revision !== undefined && provider !== undefined && revisionOf(providerFilePath(deps.providersDir, name)) === revision) {
      loaded.set(name, { revision, provider });
    }
    return provider;
  };
  // Only a name the directory lists reaches a read, so a failing read is the file's own fault.
  const lookupProvider = (name: string): ProviderLookup => {
    try {
      const definition = providerOf(name);
      return definition === undefined ? { kind: "absent" } : { kind: "found", definition };
    } catch (error) {
      return { kind: "invalid", reason: `provider "${name}" cannot be used because its file is invalid: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const providerFaultOf = (name: string): string | undefined => {
    const found = lookupProvider(name);
    return found.kind === "invalid" ? found.reason : undefined;
  };
  // An absent file and an unparseable one both answer no, exactly as the routing loop treats an unparseable file as no routes rather than a fault.
  const definesProvider = (name: string): boolean => {
    try {
      return providerOf(name) !== undefined;
    } catch {
      return false;
    }
  };
  const envModelsOf = (name: string): readonly string[] => {
    try {
      const definition = providerOf(name);
      const env = definition === undefined || isRouterProvider(definition) ? undefined : definition.env;
      return [...TIER_MODEL_ENV_VARIABLES, ...OTHER_MODEL_ENV_VARIABLES].flatMap((variable) => env?.[variable] ?? []);
    } catch {
      return [];
    }
  };
  // A file the door cannot read is a fault of that provider's request, not of the door.
  const catalogueModels = (name: string, definition: HttpProvider): { readonly models: readonly CatalogueModel[]; readonly fault?: string } => {
    try {
      return { models: deps.catalogueModelsOf?.(name, definition) ?? [] };
    } catch (error) {
      return { models: [], fault: catalogueReadFault(error) };
    }
  };
  /** The model a bare provider name selects, per provider kind: the provider's own configured default (codex and antigravity always have one), else for an http provider the model its env gives (`ANTHROPIC_MODEL`, then the Sonnet, Opus and Haiku tiers), else the first model of its cached catalogue, else a refusal naming the provider. A router has none of its own. */
  const defaultModelFor = (name: string, definition: Provider): ProviderDefault => {
    if (isCodexProvider(definition)) {
      return { model: resolveCodexConfig(definition.codex).defaultModel };
    }
    if (isAntigravityProvider(definition)) {
      return { model: definition.antigravity?.defaultModel ?? AUTO_ALIAS };
    }
    if (isRouterProvider(definition)) {
      return { refusal: `provider "${name}" is a router and has no default model of its own: name a model, as ${name}/<model>` };
    }
    const mainTier = DEFAULT_MODEL_VARIABLES.map((variable) => definition.env?.[variable]).find((value) => value !== undefined && value !== "");
    const catalogue = mainTier === undefined ? catalogueModels(name, definition) : undefined;
    if (catalogue?.fault !== undefined) {
      return { refusal: `provider "${name}" has no default model: its stored catalogue cannot be read (${catalogue.fault}); fix the file's permissions or run \`agent-shim provider models ${name} --refresh\`` };
    }
    const model = mainTier ?? catalogue?.models.find((entry) => entry.id !== AUTO_MODEL)?.id;
    return model === undefined ? { refusal: `provider "${name}" has no default model: give its env ${TIER_MODEL_ENV_VARIABLES[0]}, or opt it into a catalogue with \`agent-shim provider set ${name} --catalogue-tier <tier>\`, or name a model as ${name}/<model> (${name}/auto is the model its server serves)` } : { model };
  };
  const defaultModelOf = (name: string): ProviderDefault | undefined => {
    const found = lookupProvider(name);
    if (found.kind === "invalid") {
      return { refusal: found.reason };
    }
    return found.kind === "absent" ? undefined : defaultModelFor(name, found.definition);
  };
  /**
   * What `provider` does with a bare Claude model name a session on it asks for (the main loop's or a helper's), through its own tier mapping, and the credential it uses, from its file read once for this request: an `http` provider's tier environment variable (or, when its env names none for the tier, the model its bare name selects, if it has one) or a router's `models.tiers` pointer names the model it is sent under, and a router with no pointer for the tier refuses the request with the reason, since nothing downstream of a router serves a Claude name. A name that is qualified or selects no tier, and a provider whose translator maps by tier itself (codex, antigravity), are served as asked. The credential is named by `describeCredential` (a variable name, a path, a program, a reference, a Keychain service, a source kind), never a value: a `literal` source renders as a placeholder.
   */
  const providerMapping = (provider: string, session: Readonly<{ readonly sessionId?: string }>, requested: string): { readonly model: MappedModel; readonly credential: string | undefined } => {
    const asIs: MappedModel = { kind: "as-is" };
    let definition;
    try {
      definition = providerOf(provider);
    } catch {
      // An invalid provider file is the routing loop's own refusal to report, with its reason, when the request reaches it.
      return { model: asIs, credential: undefined };
    }
    if (definition === undefined) {
      return { model: asIs, credential: undefined };
    }
    const credential = isRouterProvider(definition) ? undefined : describeCredential(definition.credential);
    const tier = requested.includes("/") ? undefined : claudeNameTier(requested);
    if (tier === undefined) {
      return { model: asIs, credential };
    }
    if (isHttpProvider(definition)) {
      const model = definition.env?.[TIER_ENV_VARIABLES[tier]];
      // The variable may carry the `[1m]` context marker Claude Code reads, which is no part of the model's name.
      if (model !== undefined && model !== "") {
        return { model: { kind: "mapped", model: withoutContextMarker(model) }, credential };
      }
      // A tier the provider's env does not name is served by the model a bare provider name selects, so a session sent to the provider by `/model <provider>` never sends it a Claude name it has no model for. A name the provider serves itself (its catalogue lists it, or its env maps a model to it) and a provider with no default model leave the name as it is.
      if (servesName(requested, () => envModelsOf(provider), () => providerModelRows(definition, catalogueModels(provider, definition).models).map((row) => row.model))) {
        return { model: asIs, credential };
      }
      const fallback = defaultModelFor(provider, definition);
      return { model: "model" in fallback ? { kind: "mapped", model: withoutContextMarker(fallback.model) } : asIs, credential };
    }
    if (!isRouterProvider(definition)) {
      return { model: asIs, credential };
    }
    const pointer = deps.models?.(session)?.tiers?.[tier];
    return { model: pointer === undefined ? { kind: "refused", message: `provider "${provider}" routes by model name and the models block has no ${tier} tier pointer, so this ${tier}-tier request of the session cannot be routed; set models.tiers.${tier}` } : { kind: "mapped", model: pointer }, credential };
  };
  /**
   * The name a selector that resolved to `provider` is routed by, through the same default and tier mapping a bare provider name and a helper's Claude name get on it: no target is its default model (`<provider>/<model>`), a class is the model its tier mapping names (a router's tier pointer is a ref of its own and is routed as itself; a provider that maps by tier in its own translator, or names no model for the tier, is sent the tier name), and an exact model is that model on the provider.
   */
  const selectorTarget = (provider: string, target: SelectorTarget, session: Readonly<{ readonly sessionId?: string }>): { readonly name: string } | RoutedRefusal => {
    const found = lookupProvider(provider);
    if (found.kind === "invalid") {
      return { refusal: found.reason };
    }
    if (found.kind === "absent") {
      return { refusal: `no provider named "${provider}"` };
    }
    if (target.kind === "model") {
      return { name: `${provider}/${target.model}` };
    }
    if (target.kind === "none") {
      const selected = defaultModelFor(provider, found.definition);
      return "refusal" in selected ? selected : { name: `${provider}/${withoutContextMarker(selected.model)}` };
    }
    const mapped = providerMapping(provider, session, target.tier).model;
    if (mapped.kind === "refused") {
      return { refusal: mapped.message };
    }
    if (mapped.kind === "as-is") {
      return { name: `${provider}/${target.tier}` };
    }
    return isRouterProvider(found.definition) ? { name: mapped.model } : { name: `${provider}/${mapped.model}` };
  };
  return { providerOf, lookupProvider, providerFaultOf, definesProvider, envModelsOf, catalogueModels, defaultModelFor, defaultModelOf, providerMapping, selectorTarget };
}

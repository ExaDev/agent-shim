import { Option, type Command } from "commander";
import { confirmRemoval, printJson, reportMutation, withExamples, type CommandDeps } from "./cli/commandDeps";
import { addCredentialCacheOptions, cacheChange, collectCredentialSource, CREDENTIAL_SOURCE_SYNTAX, type CredentialCacheOptions } from "./cli/credentialOption";
import { collectRepeated, collectStringPair } from "./cli/parsers";
import { resolveCodexConfig } from "./codex/translate";
import { resolveAntigravityConfig } from "./antigravity/translate";
import {
  ANTIGRAVITY_EFFORTS,
  ANTIGRAVITY_MODES,
  CLAUDE_TIERS,
  AntigravityProviderConfigSchema,
  CODEX_EFFORTS,
  CODEX_LOGINS,
  CodexProviderConfigSchema,
  isAntigravityProvider,
  isCodexProvider,
  PROVIDER_CREDENTIAL_TARGETS,
  PROVIDER_KINDS,
  type AntigravityEffort,
  type AntigravityMode,
  type AntigravityProviderConfig,
  type CodexEffort,
  type CodexLogin,
  type CodexProviderConfig,
  type CredentialSource,
  PickerModelSchema,
  ProviderCatalogueSchema,
  type PickerModel,
  type ProviderCatalogue,
  type Provider,
  isRouterProvider,
} from "./config/schema";
import { UsageError } from "./cliError";
import { catalogueCachePath, filterCatalogue, parseCatalogueCache } from "./providerCatalogue";
import { refreshCatalogueForReal } from "./realCatalogueRefresh";
import fs from "node:fs";
import { describeCredential, summariseCredential } from "./credential";
import { aliasesOf, readProviderAliases, removeProviderAlias } from "./providerAliases";
import { renameProvider } from "./providerRename";
import { realCredentialCacheEnv } from "./realCredentialCache";
import { realFarmFs } from "./realPorts";
import { ProviderNotFoundError, providerExists, readProvider, listProviders, type ProviderCredentialTarget, type ProviderKind, describeProviderEndpoint, addProvider, updateProvider, removeProvider } from "./providersStore";

/** One provider as `provider show --json` and `provider list --json` print it: its name, the file's own fields (less its editor-only `$schema` pointer), and its credential block summarised, so no `literal` source's value is printed. */
function toProviderView(name: string, provider: Provider, formerNames: readonly string[]): Record<string, unknown> {
  return {
    name,
    ...(formerNames.length === 0 ? {} : { formerNames }),
    kind: provider.kind ?? "http",
    displayName: provider.displayName,
    ...(isCodexProvider(provider)
      ? (provider.codex === undefined ? {} : { codex: provider.codex })
      : isAntigravityProvider(provider)
      ? (provider.antigravity === undefined ? {} : { antigravity: provider.antigravity })
      : isRouterProvider(provider)
      ? {}
      : { baseUrl: provider.baseUrl }),
    ...(isRouterProvider(provider) ? {} : { credential: summariseCredential(provider.credential) }),
    ...(!isRouterProvider(provider) && provider.env !== undefined ? { env: provider.env } : {}),
    ...(!isRouterProvider(provider) && provider.pickerModels !== undefined ? { pickerModels: provider.pickerModels } : {}),
    ...(isCodexProvider(provider) || isAntigravityProvider(provider) || isRouterProvider(provider) || provider.catalogue === undefined ? {} : { catalogue: provider.catalogue }),
  };
}

/** The antigravity settings options `provider add` and `provider set` share. */
interface AntigravityOptions {
  readonly antigravityMode?: AntigravityMode;
  readonly antigravityDefaultModel?: string;
  readonly antigravityModel?: Record<string, string>;
  readonly antigravityEffort?: AntigravityEffort;
  readonly antigravityDegradeDownTiers?: boolean;
  readonly antigravityEndpoint?: string;
  readonly antigravityProjectId?: string;
  readonly antigravityLocation?: string;
  readonly antigravityCommand?: string[];
  readonly antigravitySocket?: string;
}

/** The antigravity settings block the antigravity options describe, or undefined when none was given. */
function antigravityConfigFromOptions(options: AntigravityOptions): AntigravityProviderConfig | undefined {
  if (
    options.antigravityMode === undefined &&
    options.antigravityDefaultModel === undefined &&
    options.antigravityModel === undefined &&
    options.antigravityEffort === undefined &&
    options.antigravityDegradeDownTiers === undefined &&
    options.antigravityEndpoint === undefined &&
    options.antigravityProjectId === undefined &&
    options.antigravityLocation === undefined &&
    options.antigravityCommand === undefined &&
    options.antigravitySocket === undefined
  ) {
    return undefined;
  }
  const cloud =
    options.antigravityEndpoint !== undefined || options.antigravityProjectId !== undefined || options.antigravityLocation !== undefined
      ? {
          ...(options.antigravityEndpoint === undefined ? {} : { endpoint: options.antigravityEndpoint }),
          ...(options.antigravityProjectId === undefined ? {} : { projectId: options.antigravityProjectId }),
          ...(options.antigravityLocation === undefined ? {} : { location: options.antigravityLocation }),
        }
      : undefined;
  const local =
    options.antigravityCommand !== undefined || options.antigravitySocket !== undefined
      ? {
          ...(options.antigravityCommand === undefined ? {} : { command: options.antigravityCommand }),
          ...(options.antigravitySocket === undefined ? {} : { socketPath: options.antigravitySocket }),
        }
      : undefined;
  const candidate = {
    ...(options.antigravityMode === undefined ? {} : { mode: options.antigravityMode }),
    ...(options.antigravityDefaultModel === undefined ? {} : { defaultModel: options.antigravityDefaultModel }),
    ...(options.antigravityModel === undefined ? {} : { models: Object.fromEntries(Object.entries(options.antigravityModel).map(([name, target]) => [name, target.includes(",") ? target.split(",") : target])) }),
    ...(options.antigravityEffort === undefined ? {} : { effort: options.antigravityEffort }),
    ...(options.antigravityDegradeDownTiers === undefined ? {} : { degradeDownTiers: options.antigravityDegradeDownTiers }),
    ...(cloud === undefined ? {} : { cloud }),
    ...(local === undefined ? {} : { local }),
  };
  const parsed = AntigravityProviderConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new UsageError(`Invalid antigravity settings: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** The picker entries `--picker-model <model=tier>` describes. A tier that is not one of the four is refused by the schema, which names it. */
function pickerModelsFromOption(option: Readonly<Record<string, string>>): readonly PickerModel[] {
  return Object.entries(option).map(([model, tier]) => {
    const parsed = PickerModelSchema.safeParse({ model, tier });
    if (!parsed.success) {
      throw new UsageError(`Invalid --picker-model ${model}=${tier}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    return parsed.data;
  });
}

/** The catalogue options `provider add` and `provider set` share. */
interface CatalogueOptions {
  readonly catalogueTier?: ProviderCatalogue["tier"];
  readonly catalogueInclude?: readonly string[];
  readonly catalogueExclude?: readonly string[];
  readonly catalogueUrl?: string;
}

/** Whether any catalogue option was given. */
function hasCatalogueOptions(options: CatalogueOptions): boolean {
  return options.catalogueTier !== undefined || options.catalogueInclude !== undefined || options.catalogueExclude !== undefined || options.catalogueUrl !== undefined;
}

/**
 * The catalogue setting the options describe laid over `existing` (the provider's current one, when it has one): a field given replaces that field, and the lists replace whole. `undefined` when no catalogue option was given. The schema refuses a result with no tier, naming it.
 */
function catalogueFromOptions(options: CatalogueOptions, existing: ProviderCatalogue | undefined): ProviderCatalogue | undefined {
  if (!hasCatalogueOptions(options)) {
    return undefined;
  }
  const candidate = {
    ...existing,
    ...(options.catalogueTier === undefined ? {} : { tier: options.catalogueTier }),
    ...(options.catalogueInclude === undefined ? {} : { include: options.catalogueInclude }),
    ...(options.catalogueExclude === undefined ? {} : { exclude: options.catalogueExclude }),
    ...(options.catalogueUrl === undefined ? {} : { url: options.catalogueUrl }),
  };
  const parsed = ProviderCatalogueSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new UsageError(`Invalid catalogue settings: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}. Name the Claude tier its models borrow with --catalogue-tier.`);
  }
  return parsed.data;
}

/** Options `provider add` accepts. */
interface ProviderAddOptions extends CodexOptions, AntigravityOptions, CatalogueOptions {
  readonly json?: boolean;
  readonly kind?: ProviderKind;
  readonly displayName: string;
  readonly baseUrl?: string;
  readonly credential: CredentialSource[];
  readonly credentialTarget?: ProviderCredentialTarget;
  readonly env?: Record<string, string>;
  readonly pickerModel?: Record<string, string>;
}

/** The codex settings options `provider add` and `provider set` share. */
interface CodexOptions {
  readonly codexDefaultModel?: string;
  readonly codexModel?: Record<string, string>;
  readonly codexEffort?: CodexEffort;
  readonly codexLogin?: CodexLogin;
}

/** The codex settings block the codex options describe, or undefined when none was given. Tier names are validated by the schema, which names any unknown one. */
function codexConfigFromOptions(options: CodexOptions): CodexProviderConfig | undefined {
  if (options.codexDefaultModel === undefined && options.codexModel === undefined && options.codexEffort === undefined && options.codexLogin === undefined) {
    return undefined;
  }
  const candidate = {
    ...(options.codexDefaultModel === undefined ? {} : { defaultModel: options.codexDefaultModel }),
    ...(options.codexModel === undefined ? {} : { models: options.codexModel }),
    ...(options.codexEffort === undefined ? {} : { effort: options.codexEffort }),
    ...(options.codexLogin === undefined ? {} : { login: options.codexLogin }),
  };
  const parsed = CodexProviderConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new UsageError(`Invalid codex settings: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Options `provider set` accepts. */
interface ProviderSetOptions extends CodexOptions, AntigravityOptions, CatalogueOptions, CredentialCacheOptions {
  readonly json?: boolean;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credential?: CredentialSource[];
  readonly credentialTarget?: ProviderCredentialTarget;
  readonly env?: Record<string, string>;
  readonly unsetEnv?: readonly string[];
  readonly pickerModel?: Record<string, string>;
  readonly unsetPickerModel?: readonly string[];
  readonly unsetCatalogue?: boolean;
}

/** Registers the `agent-shim provider` subcommand tree onto `program`. */
export function registerProviderCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const provider = withExamples(
    program.command("provider").description("Manage API providers: Anthropic-compatible endpoints a launch can route through with --provider."),
    ["agent-shim provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --credential env:Z_API_TOKEN", "agent-shim provider list"],
  );

  withExamples(
    provider
      .command("add <name>")
      .description("Create a new API provider definition. Fails if one with this name already exists.")
      .addOption(new Option("--kind <kind>", "http (default): an Anthropic-compatible endpoint at --base-url; codex: ChatGPT's Codex backend through the front-door daemon.").choices(PROVIDER_KINDS))
      .requiredOption("--display-name <name>", "Human-readable name, exported to the child as AGENT_SHIM_PROVIDER.")
      .option("--base-url <url>", "Anthropic-compatible base URL the child's requests are sent to (http providers only, and required for them).")
      .requiredOption(
        "--credential <source>",
        `Where the provider's token comes from (repeatable; tried in the order given until one yields a token): ${CREDENTIAL_SOURCE_SYNTAX}. Never the token itself.`,
        collectCredentialSource,
      )
      .addOption(
        new Option("--credential-target <target>", "Where the token goes: bearer sets ANTHROPIC_AUTH_TOKEN (default), apiKey sets ANTHROPIC_API_KEY.").choices(
          PROVIDER_CREDENTIAL_TARGETS,
        ),
      )
      .option("--env <KEY=VALUE>", "Extra environment entry for the child (repeatable).", collectStringPair)
      .option("--picker-model <model=tier>", "A model /model lists beside the ones the tier settings name, with the Claude tier (fable, opus, sonnet or haiku) whose handling it borrows (repeatable).", collectStringPair)
      .addOption(new Option("--catalogue-tier <tier>", "http providers: list the models the provider's own catalogue reports in /model, each borrowing the handling of this Claude tier.").choices(CLAUDE_TIERS))
      .option("--catalogue-include <glob>", "http providers: list only catalogue models whose id matches this glob (repeatable).", collectRepeated)
      .option("--catalogue-exclude <glob>", "http providers: leave out catalogue models whose id matches this glob (repeatable; wins over --catalogue-include).", collectRepeated)
      .option("--catalogue-url <url>", "http providers: the catalogue endpoint, when it is not /v1/models under the base URL or under its host.")
      .option("--codex-default-model <model>", "Codex providers: the codex model a request maps to when no tier matches.")
      .option("--codex-model <tier=model>", "Codex providers: the codex model one tier (fable, opus, sonnet or haiku) maps to (repeatable).", collectStringPair)
      .addOption(new Option("--codex-effort <effort>", "Codex providers: the reasoning effort when a request asks for none the backend accepts.").choices(CODEX_EFFORTS))
      .addOption(new Option("--codex-login <login>", "Codex providers: which login the upstream call uses, the Codex CLI's own login or a Sign in with ChatGPT grant from `agent-shim codex login`.").choices(CODEX_LOGINS))
      .addOption(new Option("--antigravity-mode <mode>", "Antigravity providers: cloud (direct Gemini/Vertex) or local (ACP daemon).").choices(ANTIGRAVITY_MODES))
      .option("--antigravity-default-model <model>", "Antigravity providers: the model a request maps to when no tier matches.")
      .option("--antigravity-model <tier=model>", "Antigravity providers: the model a tier (fable, opus, sonnet or haiku, matched by substring) or an alias (any other name, matched whole, selectable with /model) maps to; a comma-separated list routes by available quota, first unspent first (repeatable).", collectStringPair)
      .addOption(new Option("--antigravity-effort <effort>", "Antigravity providers: reasoning effort.").choices(ANTIGRAVITY_EFFORTS))
      .option("--antigravity-degrade-down-tiers", "Antigravity providers: when every candidate of a tier has no quota left, serve the request from the tiers below it instead of failing.")
      .option("--no-antigravity-degrade-down-tiers", "Antigravity providers: fail with the quota limit when a tier has no quota left (the default).")
      .option("--antigravity-endpoint <url>", "Antigravity cloud providers: custom API endpoint URL.")
      .option("--antigravity-project-id <id>", "Antigravity cloud providers: Google Cloud project ID (for Vertex AI).")
      .option("--antigravity-location <loc>", "Antigravity cloud providers: Google Cloud location (for Vertex AI).")
      .option("--antigravity-command <cmd...>", "Antigravity local providers: command to spawn ACP server.", collectRepeated)
      .option("--antigravity-socket <path>", "Antigravity local providers: path to existing Unix domain socket.")
      .option("--json", "Print the result as JSON.")
      .action((name: string, options: ProviderAddOptions) => {
        const codex = codexConfigFromOptions(options);
        const antigravity = antigravityConfigFromOptions(options);
        const catalogue = catalogueFromOptions(options, undefined);
        const created = addProvider(paths, name, {
          ...(options.kind === undefined ? {} : { kind: options.kind }),
          displayName: options.displayName,
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          sources: options.credential,
          ...(options.credentialTarget === undefined ? {} : { target: options.credentialTarget }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.pickerModel === undefined ? {} : { pickerModels: pickerModelsFromOption(options.pickerModel) }),
          ...(catalogue === undefined ? {} : { catalogue }),
          ...(codex === undefined ? {} : { codex }),
          ...(antigravity === undefined ? {} : { antigravity }),
        });
        reportMutation(options.json, { action: "created", kind: "provider", name, value: created }, () => {
          console.log(`Created provider "${name}" (${describeProviderEndpoint(created)}${isRouterProvider(created) ? "" : `, credential ${describeCredential(created.credential)}`}).`);
        });
      }),
    [
      "agent-shim provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --credential env:Z_API_TOKEN",
      "agent-shim provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --credential env:Z_API_TOKEN --credential op:op://vault/z/credential",
      "agent-shim provider add anthropic-api --display-name Anthropic --base-url https://api.anthropic.com --credential-target apiKey --credential keychain:anthropic-api-key",
      "agent-shim provider add local --display-name Local --base-url http://127.0.0.1:4000 --credential literal:dummy",
      "agent-shim provider add codex --kind codex --display-name Codex --credential literal:codex",
      "agent-shim provider add codex --kind codex --display-name Codex --credential literal:codex --codex-model sonnet=gpt-5.6-sol --codex-effort medium",
      "agent-shim provider add agy-cloud --kind antigravity --display-name Antigravity --credential env:GEMINI_API_KEY",
      "agent-shim provider add agy-local --kind antigravity --display-name Antigravity --antigravity-mode local --credential literal:placeholder",
    ],
  );

  const providerSet = provider
      .command("set <name>")
      .description("Update an existing API provider definition.")
      .option("--display-name <name>", "Replace the human-readable name.")
      .option("--base-url <url>", "Replace the base URL (http providers only).")
      .option(
        "--credential <source>",
        `Replace the credential's sources with these (repeatable, in the order tried): ${CREDENTIAL_SOURCE_SYNTAX}.`,
        collectCredentialSource,
      )
      .addOption(
        new Option("--credential-target <target>", "Where the token goes: bearer sets ANTHROPIC_AUTH_TOKEN, apiKey sets ANTHROPIC_API_KEY.").choices(
          PROVIDER_CREDENTIAL_TARGETS,
        ),
      )
      .option("--env <KEY=VALUE>", "Add or replace an environment entry for the child (repeatable).", collectStringPair)
      .option("--unset-env <KEY>", "Remove an environment entry (repeatable).", collectRepeated)
      .option("--picker-model <model=tier>", "Add or replace a model /model lists beside the ones the tier settings name, with the Claude tier (fable, opus, sonnet or haiku) whose handling it borrows (repeatable).", collectStringPair)
      .option("--unset-picker-model <model>", "Remove a model from the /model list (repeatable).", collectRepeated)
      .addOption(new Option("--catalogue-tier <tier>", "http providers: list the models the provider's own catalogue reports in /model, each borrowing the handling of this Claude tier.").choices(CLAUDE_TIERS))
      .option("--catalogue-include <glob>", "http providers: list only catalogue models whose id matches this glob (repeatable).", collectRepeated)
      .option("--catalogue-exclude <glob>", "http providers: leave out catalogue models whose id matches this glob (repeatable; wins over --catalogue-include).", collectRepeated)
      .option("--catalogue-url <url>", "http providers: the catalogue endpoint, when it is not /v1/models under the base URL or under its host.")
      .option("--unset-catalogue", "http providers: stop listing the provider's catalogue in /model.")
      .option("--codex-default-model <model>", "Codex providers: replace the model a request maps to when no tier matches.")
      .option("--codex-model <tier=model>", "Codex providers: set the codex model one tier maps to (repeatable; other tiers are kept).", collectStringPair)
      .addOption(new Option("--codex-effort <effort>", "Codex providers: replace the default reasoning effort.").choices(CODEX_EFFORTS))
      .addOption(new Option("--codex-login <login>", "Codex providers: replace which login the upstream call uses.").choices(CODEX_LOGINS))
      .addOption(new Option("--antigravity-mode <mode>", "Antigravity providers: cloud (direct Gemini/Vertex) or local (ACP daemon).").choices(ANTIGRAVITY_MODES))
      .option("--antigravity-default-model <model>", "Antigravity providers: the model a request maps to when no tier matches.")
      .option("--antigravity-model <tier=model>", "Antigravity providers: set the model one tier maps to (repeatable; other tiers are kept).", collectStringPair)
      .addOption(new Option("--antigravity-effort <effort>", "Antigravity providers: reasoning effort.").choices(ANTIGRAVITY_EFFORTS))
      .option("--antigravity-degrade-down-tiers", "Antigravity providers: when every candidate of a tier has no quota left, serve the request from the tiers below it instead of failing.")
      .option("--no-antigravity-degrade-down-tiers", "Antigravity providers: fail with the quota limit when a tier has no quota left (the default).")
      .option("--antigravity-endpoint <url>", "Antigravity cloud providers: custom API endpoint URL.")
      .option("--antigravity-project-id <id>", "Antigravity cloud providers: Google Cloud project ID (for Vertex AI).")
      .option("--antigravity-location <loc>", "Antigravity cloud providers: Google Cloud location (for Vertex AI).")
      .option("--antigravity-command <cmd...>", "Antigravity local providers: command to spawn ACP server.", collectRepeated)
      .option("--antigravity-socket <path>", "Antigravity local providers: path to existing Unix domain socket.");
  addCredentialCacheOptions(providerSet);
  withExamples(
    providerSet
      .option("--json", "Print the result as JSON.")
      .action((name: string, allOptions: ProviderSetOptions) => {
        const { json, ...options } = allOptions;
        if (Object.entries(allOptions).every(([key, value]) => key === "json" || value === undefined)) {
          throw new UsageError(
            "Nothing to change: pass --display-name, --base-url, --credential, --credential-target, a --credential-cache option, --env, --unset-env, --picker-model, --unset-picker-model, a --catalogue option, --unset-catalogue, or codex/antigravity settings.",
          );
        }
        const codex = codexConfigFromOptions(options);
        const antigravity = antigravityConfigFromOptions(options);
        const existingForCache = readProvider(paths, name);
        const cache = cacheChange(options, existingForCache !== undefined && !isRouterProvider(existingForCache) ? existingForCache.credential.cache : undefined);
        if (options.unsetCatalogue === true && hasCatalogueOptions(options)) {
          throw new UsageError("--unset-catalogue cannot be combined with another --catalogue option.");
        }
        const existingProvider = readProvider(paths, name);
        const catalogue = options.unsetCatalogue === true ? false : catalogueFromOptions(options, existingProvider !== undefined && !isCodexProvider(existingProvider) && !isAntigravityProvider(existingProvider) && !isRouterProvider(existingProvider) ? existingProvider.catalogue : undefined);
        const updated = updateProvider(paths, name, {
          ...(codex === undefined ? {} : { codex }),
          ...(antigravity === undefined ? {} : { antigravity }),
          ...(cache === undefined ? {} : { cache }),
          ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.credential === undefined ? {} : { sources: options.credential }),
          ...(options.credentialTarget === undefined ? {} : { target: options.credentialTarget }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.unsetEnv === undefined ? {} : { unsetEnv: options.unsetEnv }),
          ...(options.pickerModel === undefined ? {} : { pickerModels: pickerModelsFromOption(options.pickerModel) }),
          ...(options.unsetPickerModel === undefined ? {} : { unsetPickerModels: options.unsetPickerModel }),
          ...(catalogue === undefined ? {} : { catalogue }),
        });
        reportMutation(json, { action: "updated", kind: "provider", name, value: updated }, () => {
          console.log(`Updated provider "${name}" (${describeProviderEndpoint(updated)}${isRouterProvider(updated) ? "" : `, credential ${describeCredential(updated.credential)}`}).`);
        });
      }),
    [
      "agent-shim provider set z --base-url https://api.z.ai/api/anthropic",
      "agent-shim provider set z --env API_TIMEOUT_MS=600000",
      "agent-shim provider set z --credential op:op://vault/z/credential --credential-cache-ttl 12h",
      "agent-shim provider set anthropic-api --credential-target apiKey",
      "agent-shim provider set codex --codex-model haiku=gpt-5.6-terra",
      "agent-shim provider set agy --antigravity-model haiku=gemini-2.5-flash",
      "agent-shim provider set o --picker-model deepseek/deepseek-r1=opus --picker-model qwen/qwen3-coder=sonnet",
    ],
  );

  withExamples(
    provider
      .command("list")
      .description("List every API provider.")
      .option("--json", "Print the providers as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const entries = listProviders(paths);
        const aliases = readProviderAliases(paths);
        if (options.json === true) {
          printJson(entries.map((entry) => toProviderView(entry.name, entry.provider, aliasesOf(aliases, entry.name))));
          return;
        }
        if (entries.length === 0) {
          console.log("No providers yet. Run `agent-shim provider add <name>` to create one.");
          return;
        }
        for (const entry of entries) {
          const formerly = aliasesOf(aliases, entry.name);
          console.log(`  ${entry.name} (${entry.provider.displayName}, ${describeProviderEndpoint(entry.provider)})${formerly.length === 0 ? "" : `, formerly ${formerly.join(", ")}`}`);
        }
      }),
    ["agent-shim provider list", "agent-shim provider list --json"],
  );

  withExamples(
    provider
      .command("show <name>")
      .description("Show one provider's definition. Credentials are described by source, never printed.")
      .option("--json", "Print the provider as JSON.")
      .action((name: string, options: Readonly<{ json?: boolean }>) => {
        const found = readProvider(paths, name);
        if (found === undefined) {
          throw new ProviderNotFoundError(name);
        }
        const formerNames = aliasesOf(readProviderAliases(paths), name);
        if (options.json === true) {
          printJson(toProviderView(name, found, formerNames));
          return;
        }
        console.log(`Provider: ${name}`);
        if (formerNames.length > 0) {
          console.log(`Former names: ${formerNames.join(", ")}`);
        }
        console.log(`Display name: ${found.displayName}`);
        console.log(`Kind: ${found.kind ?? "http"}`);
        if (isCodexProvider(found)) {
          const config = resolveCodexConfig(found.codex);
          console.log(`Codex models: ${CLAUDE_TIERS.map((tier) => `${tier}=${config.models[tier]}`).join(", ")}, otherwise ${config.defaultModel}`);
          console.log(`Codex effort: ${config.effort}`);
          console.log(`Codex login: ${config.login}`);
        } else if (isAntigravityProvider(found)) {
          const config = resolveAntigravityConfig(found.antigravity);
          console.log(`Antigravity mode: ${config.mode}`);
          console.log(`Antigravity models: ${CLAUDE_TIERS.map((tier) => `${tier}=${config.models[tier].join(" > ")}`).join(", ")}, otherwise ${config.defaultModel}`);
          if (config.aliases.size > 0) {
            console.log(`Antigravity aliases: ${[...config.aliases].map(([alias, model]) => `${alias}=${model.join(" > ")}`).join(", ")}`);
          }
          console.log(`Antigravity effort: ${config.effort}`);
          console.log(`Antigravity degrade down tiers: ${config.degradeDownTiers ? "on" : "off"}`);
          console.log(`Endpoint: ${describeProviderEndpoint(found)}`);
        } else if (!isRouterProvider(found)) {
          console.log(`Base URL: ${found.baseUrl}`);
        }
        if (!isRouterProvider(found)) {
          console.log(`Credential: ${describeCredential(found.credential)}`);
        }
        const env = Object.entries(isRouterProvider(found) ? {} : found.env ?? {});
        console.log(`Environment: ${env.length === 0 ? "(none)" : env.map(([key, value]) => `${key}=${value}`).join(", ")}`);
        if (!isRouterProvider(found) && found.pickerModels !== undefined) {
          console.log(`Picker models: ${found.pickerModels.map((entry) => `${entry.model} (${entry.tier})`).join(", ")}`);
        }
        if (!isCodexProvider(found) && !isAntigravityProvider(found) && !isRouterProvider(found) && found.catalogue !== undefined) {
          const { tier, include, exclude, url } = found.catalogue;
          console.log(`Catalogue: tier ${tier}${include === undefined ? "" : `, include ${include.join(" ")}`}${exclude === undefined ? "" : `, exclude ${exclude.join(" ")}`}${url === undefined ? "" : `, url ${url}`} (see \`provider models ${name}\`)`);
        }
      }),
    ["agent-shim provider show z", "agent-shim provider show z --json"],
  );

  withExamples(
    provider
      .command("models <name>")
      .description("Show the model catalogue an http provider with a catalogue setting last fetched, and which of its models /model lists. The front door fetches it in the background; --refresh fetches it now.")
      .option("--refresh", "Fetch the catalogue now instead of reading the last one.")
      .option("--json", "Print the catalogue as JSON.")
      .action(async (name: string, options: Readonly<{ refresh?: boolean; json?: boolean }>) => {
        const found = readProvider(paths, name);
        if (found === undefined) {
          throw new ProviderNotFoundError(name);
        }
        if (isCodexProvider(found) || isAntigravityProvider(found) || isRouterProvider(found) || found.catalogue === undefined) {
          throw new UsageError(`Provider "${name}" has no catalogue setting. Set one with \`agent-shim provider set ${name} --catalogue-tier <tier>\`.`);
        }
        const catalogueSetting = found.catalogue;
        const cache = options.refresh === true ? await refreshCatalogueForReal(paths, name, process.env) : parseCatalogueCache(fs.existsSync(catalogueCachePath(paths, name)) ? fs.readFileSync(catalogueCachePath(paths, name), "utf8") : undefined);
        if (cache === undefined) {
          throw new UsageError(`No catalogue has been fetched for "${name}" yet: the front door fetches it shortly after it starts, or run \`agent-shim provider models ${name} --refresh\`.`);
        }
        const listed = filterCatalogue(cache.models, catalogueSetting);
        if (options.json === true) {
          printJson({ name, tier: catalogueSetting.tier, url: cache.url, fetchedAt: new Date(cache.fetchedAt).toISOString(), models: cache.models, listed: listed.map((model) => model.id) });
          return;
        }
        console.log(`Catalogue of ${name}: ${String(cache.models.length)} models from ${cache.url}, fetched ${new Date(cache.fetchedAt).toISOString()}; /model lists ${String(listed.length)} as tier ${catalogueSetting.tier}.`);
        const listedIds = new Set(listed.map((model) => model.id));
        for (const model of cache.models) {
          console.log(`${listedIds.has(model.id) ? "*" : " "} ${model.id}${model.name === undefined ? "" : `  (${model.name})`}`);
        }
      }),
    ["agent-shim provider models o", "agent-shim provider models o --refresh --json"],
  );

  withExamples(
    provider
      .command("remove <name>")
      .description("Delete a provider definition.")
      .option("--yes", "Remove without asking for confirmation (required when standard input is not a terminal).")
      .option("--json", "Print the result as JSON.")
      .action(async (name: string, options: Readonly<{ yes?: boolean; json?: boolean }>) => {
        if (!providerExists(paths, name)) {
          throw new ProviderNotFoundError(name);
        }
        await confirmRemoval(deps, options.yes, `provider "${name}"`);
        removeProvider(paths, name);
        reportMutation(options.json, { action: "removed", kind: "provider", name }, () => {
          console.log(`Removed provider "${name}".`);
        });
      }),
    ["agent-shim provider remove z --yes"],
  );

  withExamples(
    provider
      .command("rename <old> <new>")
      .description("Rename a provider. Sessions already running under the old name keep being served through an alias, and configuration, usage state and the cached credential move to the new name.")
      .option("--json", "Print the result as JSON.")
      .action((from: string, to: string, options: Readonly<{ json?: boolean }>) => {
        const report = renameProvider(paths, from, to, { fs: realFarmFs, credentialCache: realCredentialCacheEnv(paths) });
        reportMutation(options.json, { action: "renamed", kind: "provider", name: to, value: report }, () => {
          console.log(`Renamed provider "${from}" to "${to}".`);
          for (const place of report.updated) {
            console.log(`  updated ${place}`);
          }
          console.log(`"${from}" still resolves to "${to}" for sessions launched under it. Once none is running, \`agent-shim provider unalias ${from}\` forgets it.`);
        });
      }),
    ["agent-shim provider rename z zai"],
  );

  withExamples(
    provider
      .command("unalias <alias>")
      .description("Forget a former provider name. A session still launched under it stops being served.")
      .option("--json", "Print the result as JSON.")
      .action((alias: string, options: Readonly<{ json?: boolean }>) => {
        removeProviderAlias(paths, alias);
        reportMutation(options.json, { action: "removed", kind: "provider alias", name: alias }, () => {
          console.log(`Forgot the former provider name "${alias}".`);
        });
      }),
    ["agent-shim provider unalias z"],
  );
}

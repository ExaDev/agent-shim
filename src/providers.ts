import { Option, type Command } from "commander";
import { confirmRemoval, printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { addCredentialCacheOptions, cacheChange, collectCredentialSource, CREDENTIAL_SOURCE_SYNTAX, type CredentialCacheOptions } from "./cli/credentialOption";
import { collectRepeated, collectStringPair } from "./cli/parsers";
import { resolveCodexConfig } from "./codex/translate";
import { CODEX_EFFORTS, CODEX_TIERS, CodexProviderConfigSchema, isCodexProvider, PROVIDER_CREDENTIAL_TARGETS, PROVIDER_KINDS, type CodexEffort, type CodexProviderConfig, type CredentialSource, type Provider } from "./config/schema";
import { UsageError } from "./cliError";
import { describeCredential, summariseCredential } from "./credential";
import { ProviderNotFoundError, providerExists, readProvider, listProviders, type ProviderCredentialTarget, type ProviderKind, describeProviderEndpoint, addProvider, updateProvider, removeProvider } from "./providersStore";

/** One provider as `provider show --json` and `provider list --json` print it: its name, the file's own fields (less its editor-only `$schema` pointer), and its credential block summarised, so no `literal` source's value is printed. */
function toProviderView(name: string, provider: Provider): Record<string, unknown> {
  return {
    name,
    kind: provider.kind ?? "http",
    displayName: provider.displayName,
    ...(isCodexProvider(provider) ? (provider.codex === undefined ? {} : { codex: provider.codex }) : { baseUrl: provider.baseUrl }),
    credential: summariseCredential(provider.credential),
    ...(provider.env === undefined ? {} : { env: provider.env }),
  };
}

/** Options `provider add` accepts. */
interface ProviderAddOptions extends CodexOptions {
  readonly kind?: ProviderKind;
  readonly displayName: string;
  readonly baseUrl?: string;
  readonly credential: CredentialSource[];
  readonly credentialTarget?: ProviderCredentialTarget;
  readonly env?: Record<string, string>;
}

/** The codex settings options `provider add` and `provider set` share. */
interface CodexOptions {
  readonly codexDefaultModel?: string;
  readonly codexModel?: Record<string, string>;
  readonly codexEffort?: CodexEffort;
}

/** The codex settings block the codex options describe, or undefined when none was given. Tier names are validated by the schema, which names any unknown one. */
function codexConfigFromOptions(options: CodexOptions): CodexProviderConfig | undefined {
  if (options.codexDefaultModel === undefined && options.codexModel === undefined && options.codexEffort === undefined) {
    return undefined;
  }
  const candidate = {
    ...(options.codexDefaultModel === undefined ? {} : { defaultModel: options.codexDefaultModel }),
    ...(options.codexModel === undefined ? {} : { models: options.codexModel }),
    ...(options.codexEffort === undefined ? {} : { effort: options.codexEffort }),
  };
  const parsed = CodexProviderConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new UsageError(`Invalid codex settings: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Options `provider set` accepts. */
interface ProviderSetOptions extends CodexOptions, CredentialCacheOptions {
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credential?: CredentialSource[];
  readonly credentialTarget?: ProviderCredentialTarget;
  readonly env?: Record<string, string>;
  readonly unsetEnv?: readonly string[];
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
      .option("--codex-default-model <model>", "Codex providers: the codex model a request maps to when no tier matches.")
      .option("--codex-model <tier=model>", "Codex providers: the codex model one tier (fable, opus, sonnet or haiku) maps to (repeatable).", collectStringPair)
      .addOption(new Option("--codex-effort <effort>", "Codex providers: the reasoning effort when a request asks for none the backend accepts.").choices(CODEX_EFFORTS))
      .action((name: string, options: ProviderAddOptions) => {
        const codex = codexConfigFromOptions(options);
        const created = addProvider(paths, name, {
          ...(options.kind === undefined ? {} : { kind: options.kind }),
          displayName: options.displayName,
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          sources: options.credential,
          ...(options.credentialTarget === undefined ? {} : { target: options.credentialTarget }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(codex === undefined ? {} : { codex }),
        });
        console.log(`Created provider "${name}" (${describeProviderEndpoint(created)}, credential ${describeCredential(created.credential)}).`);
      }),
    [
      "agent-shim provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --credential env:Z_API_TOKEN",
      "agent-shim provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --credential env:Z_API_TOKEN --credential op:op://vault/z/credential",
      "agent-shim provider add anthropic-api --display-name Anthropic --base-url https://api.anthropic.com --credential-target apiKey --credential keychain:anthropic-api-key",
      "agent-shim provider add local --display-name Local --base-url http://127.0.0.1:4000 --credential literal:dummy",
      "agent-shim provider add codex --kind codex --display-name Codex --credential literal:codex",
      "agent-shim provider add codex --kind codex --display-name Codex --credential literal:codex --codex-model sonnet=gpt-5.6-sol --codex-effort medium",
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
      .option("--codex-default-model <model>", "Codex providers: replace the model a request maps to when no tier matches.")
      .option("--codex-model <tier=model>", "Codex providers: set the codex model one tier maps to (repeatable; other tiers are kept).", collectStringPair)
      .addOption(new Option("--codex-effort <effort>", "Codex providers: replace the default reasoning effort.").choices(CODEX_EFFORTS));
  addCredentialCacheOptions(providerSet);
  withExamples(
    providerSet
      .action((name: string, options: ProviderSetOptions) => {
        if (Object.values(options).every((value) => value === undefined)) {
          throw new UsageError(
            "Nothing to change: pass --display-name, --base-url, --credential, --credential-target, a --credential-cache option, --env, --unset-env, --codex-default-model, --codex-model or --codex-effort.",
          );
        }
        const codex = codexConfigFromOptions(options);
        const cache = cacheChange(options, readProvider(paths, name)?.credential.cache);
        const updated = updateProvider(paths, name, {
          ...(codex === undefined ? {} : { codex }),
          ...(cache === undefined ? {} : { cache }),
          ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.credential === undefined ? {} : { sources: options.credential }),
          ...(options.credentialTarget === undefined ? {} : { target: options.credentialTarget }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.unsetEnv === undefined ? {} : { unsetEnv: options.unsetEnv }),
        });
        console.log(`Updated provider "${name}" (${describeProviderEndpoint(updated)}, credential ${describeCredential(updated.credential)}).`);
      }),
    [
      "agent-shim provider set z --base-url https://api.z.ai/api/anthropic",
      "agent-shim provider set z --env API_TIMEOUT_MS=600000",
      "agent-shim provider set z --credential op:op://vault/z/credential --credential-cache-ttl 12h",
      "agent-shim provider set anthropic-api --credential-target apiKey",
      "agent-shim provider set codex --codex-model haiku=gpt-5.6-terra",
    ],
  );

  withExamples(
    provider
      .command("list")
      .description("List every API provider.")
      .option("--json", "Print the providers as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const entries = listProviders(paths);
        if (options.json === true) {
          printJson(entries.map((entry) => toProviderView(entry.name, entry.provider)));
          return;
        }
        if (entries.length === 0) {
          console.log("No providers yet. Run `agent-shim provider add <name>` to create one.");
          return;
        }
        for (const entry of entries) {
          console.log(`  ${entry.name} (${entry.provider.displayName}, ${describeProviderEndpoint(entry.provider)})`);
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
        if (options.json === true) {
          printJson(toProviderView(name, found));
          return;
        }
        console.log(`Provider: ${name}`);
        console.log(`Display name: ${found.displayName}`);
        console.log(`Kind: ${found.kind ?? "http"}`);
        if (isCodexProvider(found)) {
          const config = resolveCodexConfig(found.codex);
          console.log(`Codex models: ${CODEX_TIERS.map((tier) => `${tier}=${config.models[tier]}`).join(", ")}, otherwise ${config.defaultModel}`);
          console.log(`Codex effort: ${config.effort}`);
        } else {
          console.log(`Base URL: ${found.baseUrl}`);
        }
        console.log(`Credential: ${describeCredential(found.credential)}`);
        const env = Object.entries(found.env ?? {});
        console.log(`Environment: ${env.length === 0 ? "(none)" : env.map(([key, value]) => `${key}=${value}`).join(", ")}`);
      }),
    ["agent-shim provider show z", "agent-shim provider show z --json"],
  );

  withExamples(
    provider
      .command("remove <name>")
      .description("Delete a provider definition.")
      .option("--yes", "Remove without asking for confirmation (required when standard input is not a terminal).")
      .action(async (name: string, options: Readonly<{ yes?: boolean }>) => {
        if (!providerExists(paths, name)) {
          throw new ProviderNotFoundError(name);
        }
        await confirmRemoval(deps, options.yes, `provider "${name}"`);
        removeProvider(paths, name);
        console.log(`Removed provider "${name}".`);
      }),
    ["agent-shim provider remove z --yes"],
  );
}

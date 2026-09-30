import fs from "node:fs";
import path from "node:path";
import { Option, type Command } from "commander";

import { confirmRemoval, printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { collectCredentialSource, CREDENTIAL_SOURCE_SYNTAX } from "./cli/credentialOption";
import { collectRepeated, collectStringPair } from "./cli/parsers";
import { ConfigValidationError } from "./config/load";
import { writeJsonAtomic } from "./config/store";
import {
  CREDENTIAL_TARGET_VARS,
  PROVIDER_CREDENTIAL_TARGETS,
  ProviderSchema,
  type CredentialSource,
  type Provider,
} from "./config/schema";
import { CliError, UsageError } from "./cliError";
import { CREDENTIAL_UNAVAILABLE_EXIT, describeCredential, resolveCredential, summariseCredential, type CredentialPort } from "./credential";
import type { ResolvedProvider } from "./launcher/flags";
import type { FsPort } from "./launcher/ports";
import { assembleCascade, type CascadeInput } from "./resolve/walk";
import type { LayoutPaths } from "./paths";

/** Raised by any operation that requires a provider to already exist, when it does not. */
export class ProviderNotFoundError extends CliError {
  constructor(readonly name: string) {
    super(`No provider named "${name}". Run \`claude-use provider add ${name}\` first.`);
    this.name = "ProviderNotFoundError";
  }
}

/** Raised by `addProvider` when a provider with the given name already has a file. */
export class ProviderAlreadyExistsError extends CliError {
  constructor(readonly providerName: string) {
    super(`A provider named "${providerName}" already exists.`);
    this.name = "ProviderAlreadyExistsError";
  }
}

/**
 * Raised by `addProvider` when `name` fails the provider naming rule: the same rule `IdentitySchema` applies to identity names (start with a letter or number, then letters, numbers, dots, hyphens, underscores, and at signs). Keeping the two rules identical means a name that works for one works for the other, and neither vocabulary can ever produce a path segment that escapes `providers/` or `identities/`.
 */
export class InvalidProviderNameError extends CliError {
  constructor(readonly attemptedName: string) {
    super(
      `"${attemptedName}" is not a valid provider name. Provider names must start with a letter or number ` +
        `and may then contain letters, numbers, dots, hyphens, underscores, and at signs.`,
    );
    this.name = "InvalidProviderNameError";
  }
}

const PROVIDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

function providerJsonPath(paths: LayoutPaths, name: string): string {
  return path.join(paths.providersDir, `${name}.json`);
}

/** True when a provider file exists for `name`, regardless of whether it validates. */
export function providerExists(paths: LayoutPaths, name: string): boolean {
  return fs.existsSync(providerJsonPath(paths, name));
}

/** The provider fields the credential block replaced. A file still carrying any of them is reported with its exact replacement rather than a bare schema error. */
const LEGACY_PROVIDER_FIELDS = ["tokenEnv", "tokenCommand", "authScheme"] as const;

/** The credential variables an old provider file could set in its `env` block, which the credential block now owns. */
const LEGACY_ENV_CREDENTIAL_KEYS: readonly string[] = Object.values(CREDENTIAL_TARGET_VARS);

/** Written in a replacement in place of an old fixed `env.ANTHROPIC_AUTH_TOKEN` value, which is never printed: the person converting the file copies the value across themselves. */
export const LEGACY_LITERAL_PLACEHOLDER = "<the value of env.ANTHROPIC_AUTH_TOKEN>";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What converting one old-format provider file involves: the old fields it uses, and the whole file rewritten in the current format. */
export interface LegacyProviderConversion {
  readonly fields: readonly string[];
  readonly replacement: Record<string, unknown>;
}

/**
 * Recognises a provider file written in the format before the credential block (a `tokenEnv`, `tokenCommand` or `authScheme` field, or a credential variable in `env`, and no `credential`) and builds its exact replacement: `tokenEnv` becomes an `env` source, `tokenCommand` a `command` source, a non-empty fixed `env.ANTHROPIC_AUTH_TOKEN` a `literal` source (its value replaced by `LEGACY_LITERAL_PLACEHOLDER`, never printed), `authScheme` the `target`, and the credential variables leave `env`. Undefined for anything else, including a file that is merely invalid.
 */
export function legacyProviderConversion(raw: unknown): LegacyProviderConversion | undefined {
  if (!isRecord(raw) || "credential" in raw) {
    return undefined;
  }
  const env = isRecord(raw.env) ? raw.env : undefined;
  const legacyEnvKeys = env === undefined ? [] : Object.keys(env).filter((key) => LEGACY_ENV_CREDENTIAL_KEYS.includes(key));
  const fields = [...LEGACY_PROVIDER_FIELDS.filter((field) => field in raw), ...legacyEnvKeys.map((key) => `env.${key}`)];
  if (fields.length === 0) {
    return undefined;
  }

  const sources: unknown[] = [];
  if (typeof raw.tokenEnv === "string") {
    sources.push({ env: raw.tokenEnv });
  }
  if (Array.isArray(raw.tokenCommand)) {
    sources.push({ command: raw.tokenCommand });
  }
  if (typeof env?.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN !== "") {
    sources.push({ literal: LEGACY_LITERAL_PLACEHOLDER });
  }
  const remainingEnv = env === undefined ? undefined : Object.fromEntries(Object.entries(env).filter(([key]) => !LEGACY_ENV_CREDENTIAL_KEYS.includes(key)));
  const replacedKeys: readonly string[] = [...LEGACY_PROVIDER_FIELDS, "env"];
  const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => !replacedKeys.includes(key)));
  return {
    fields,
    replacement: {
      ...rest,
      credential: { sources, ...(raw.authScheme === "apiKey" ? { target: "apiKey" } : {}) },
      ...(remainingEnv === undefined || Object.keys(remainingEnv).length === 0 ? {} : { env: remainingEnv }),
    },
  };
}

/** Raised when a provider file is still in the format before the credential block, naming the old fields and giving the exact replacement. */
export class LegacyProviderFileError extends CliError {
  constructor(
    readonly filePath: string,
    readonly conversion: LegacyProviderConversion,
  ) {
    super(
      `${filePath} uses ${conversion.fields.join(", ")}, which a credential block replaced. Rewrite it as:\n` +
        JSON.stringify(conversion.replacement, null, 2),
    );
    this.name = "LegacyProviderFileError";
  }
}

/** Validates one provider file's parsed content, refusing an old-format file with its replacement (`LegacyProviderFileError`) and any other invalid one with `ConfigValidationError`. */
function parseProviderFile(filePath: string, raw: unknown): Provider {
  const conversion = legacyProviderConversion(raw);
  if (conversion !== undefined) {
    throw new LegacyProviderFileError(filePath, conversion);
  }
  const parsed = ProviderSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(filePath, parsed.error.issues);
  }
  return parsed.data;
}

/** Reads and validates one provider definition, or undefined when it does not exist. */
export function readProvider(paths: LayoutPaths, name: string): Provider | undefined {
  const filePath = providerJsonPath(paths, name);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parseProviderFile(filePath, raw);
}

/**
 * Reads and validates one provider definition through an injected `FsPort`, the same way `loadIdentity` reads an `identity.json`: the launcher never touches the real filesystem directly, so provider loading must flow through the port it is already handed.
 */
export function loadProvider(providersDir: string, name: string, port: FsPort): Provider | undefined {
  const filePath = path.join(providersDir, `${name}.json`);
  const raw = port.readConfigFile(filePath);
  return raw === undefined ? undefined : parseProviderFile(filePath, raw);
}

/** One provider definition as reported by `listProviders`. */
export interface ProviderListEntry {
  readonly name: string;
  readonly provider: Provider;
}

/** Lists every provider under `providersDir` that has a valid `<name>.json`. A file that fails validation is skipped here; `provider list` is the place a broken definition gets surfaced, not a launch. */
export function listProviders(paths: LayoutPaths): readonly ProviderListEntry[] {
  const names = listProviderNames(
    (dir) => fs.readdirSync(dir),
    paths.providersDir,
  );
  const result: ProviderListEntry[] = [];
  for (const name of names) {
    let provider: Provider | undefined;
    try {
      provider = readProvider(paths, name);
    } catch (error) {
      if (!(error instanceof ConfigValidationError || error instanceof LegacyProviderFileError)) {
        throw error;
      }
      console.error(`claude-use: providers/${name}.json is invalid and was skipped: ${error.message}`);
      continue;
    }
    if (provider !== undefined) {
      result.push({ name, provider });
    }
  }
  return result;
}

/**
 * The names of every provider definition under `providersDir`, sorted. `readdir` is injected so the launcher's unknown-provider error can name the known providers through its own `FsPort` in tests rather than a real directory listing.
 */
function listProviderNames(readdir: (dir: string) => readonly string[], providersDir: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdir(providersDir);
  } catch {
    // An absent providers directory means no providers, which is not an error anywhere this is used.
    return [];
  }
  return entries.filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -".json".length)).sort();
}

/** The credential targets a provider may use. */
type ProviderCredentialTarget = (typeof PROVIDER_CREDENTIAL_TARGETS)[number];

/** Everything `addProvider` writes into a fresh provider file. */
export interface AddProviderInput {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly sources: readonly CredentialSource[];
  readonly target?: ProviderCredentialTarget;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Creates a new provider definition. Throws `ProviderAlreadyExistsError` when a provider with this name already has a file, `InvalidProviderNameError` when `name` fails the naming rule, and `ConfigValidationError` when the assembled definition fails `ProviderSchema` (e.g. a `baseUrl` that is not a URL) rather than letting the underlying `ZodError` escape as an unhandled crash.
 */
export function addProvider(paths: LayoutPaths, name: string, input: AddProviderInput): Provider {
  if (providerExists(paths, name)) {
    throw new ProviderAlreadyExistsError(name);
  }
  if (!PROVIDER_NAME_RE.test(name)) {
    throw new InvalidProviderNameError(name);
  }
  const parsed = ProviderSchema.safeParse({
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    credential: { sources: input.sources, ...(input.target === undefined ? {} : { target: input.target }) },
    ...(input.env === undefined || Object.keys(input.env).length === 0 ? {} : { env: input.env }),
  });
  if (!parsed.success) {
    throw new ConfigValidationError(providerJsonPath(paths, name), parsed.error.issues);
  }
  writeJsonAtomic(providerJsonPath(paths, name), parsed.data);
  return parsed.data;
}

/**
 * The fields `updateProvider` changes. `sources` replaces the whole ordered source list (a list is set, not patched, since its order is its meaning); `target` changes where the token goes and keeps the sources. `env` entries merge over the existing ones and `unsetEnv` keys are then deleted.
 */
interface UpdateProviderInput {
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly sources?: readonly CredentialSource[];
  readonly target?: ProviderCredentialTarget;
  readonly env?: Readonly<Record<string, string>>;
  readonly unsetEnv?: readonly string[];
}

/**
 * Updates an existing provider definition in place. Throws `ProviderNotFoundError` when it does not exist, and `ConfigValidationError` when the updated definition fails `ProviderSchema`, leaving the file untouched.
 */
function updateProvider(paths: LayoutPaths, name: string, input: UpdateProviderInput): Provider {
  const existing = readProvider(paths, name);
  if (existing === undefined) {
    throw new ProviderNotFoundError(name);
  }
  const unset = new Set(input.unsetEnv);
  const env = Object.fromEntries(Object.entries({ ...existing.env, ...input.env }).filter(([key]) => !unset.has(key)));
  const target = input.target ?? existing.credential.target;
  const parsed = ProviderSchema.safeParse({
    ...existing,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    credential: {
      sources: input.sources ?? existing.credential.sources,
      ...(target === undefined ? {} : { target }),
    },
    env: Object.keys(env).length === 0 ? undefined : env,
  });
  if (!parsed.success) {
    throw new ConfigValidationError(providerJsonPath(paths, name), parsed.error.issues);
  }
  writeJsonAtomic(providerJsonPath(paths, name), parsed.data);
  return parsed.data;
}

/** Deletes a provider definition. Throws `ProviderNotFoundError` when it does not exist. */
export function removeProvider(paths: LayoutPaths, name: string): void {
  if (!providerExists(paths, name)) {
    throw new ProviderNotFoundError(name);
  }
  fs.rmSync(providerJsonPath(paths, name));
}

/**
 * The provider name the cascade selects through `launch.provider`, if any layer sets one. Last layer wins, the same rule `flattenLayers` applies to every other launch flag.
 */
export function cascadeProviderName(cascade: CascadeInput): string | undefined {
  let name: string | undefined;
  for (const layer of assembleCascade(cascade).layers) {
    if (layer.launch?.provider !== undefined) {
      name = layer.launch.provider;
    }
  }
  return name;
}

/** Inputs to `resolveProvider`. */
export interface ResolveProviderParams {
  readonly paths: LayoutPaths;
  readonly port: FsPort;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Resolves the provider's credential sources. Omitted by a caller that cannot read secret files or run commands; a selected provider is then refused rather than launched without its credential. */
  readonly credentials?: CredentialPort;
  /** The `--provider <name>` flag's value, when one was given. It outranks any cascade layer, matching how the cliOverride layer composes last everywhere else. */
  readonly cliProvider?: string;
  /** The assembled-but-unflattened cascade for this launch, when one was loaded. Its layers are scanned for a `launch.provider` selection so a profile, directory rule, portable file, or the global config can pin a provider exactly the way they pin the other launch flags. */
  readonly cascade?: CascadeInput;
}

/**
 * The outcome of resolving this launch's provider: either a fully-resolved provider (definition plus its resolved credential), or a refusal the launcher turns into a stderr line and a non-zero exit.
 *
 * A provider whose credential block yields no token exits `CREDENTIAL_UNAVAILABLE_EXIT` (64), because the invocation cannot authenticate. An unknown provider name exits 1, matching every other "named thing not found" refusal in the launcher.
 */
export type ProviderResolution =
  | { readonly ok: true; readonly provider: ResolvedProvider; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Resolves which API provider this launch routes through, if any: the `--provider` flag first, then the cascade's `launch.provider` selection. Returns undefined when nothing selected a provider at all.
 *
 * Pure over its injected ports, so the launcher's tests exercise refusals without touching a real providers directory, secret store or terminal: this function decides, and the caller owns the log/exit side effects.
 */
export function resolveProvider(params: ResolveProviderParams): ProviderResolution | undefined {
  const cliName = params.cliProvider !== undefined && params.cliProvider !== "" ? params.cliProvider : undefined;
  const name = cliName ?? (params.cascade === undefined ? undefined : cascadeProviderName(params.cascade));
  if (name === undefined) {
    return undefined;
  }

  const definition = loadProvider(params.paths.providersDir, name, params.port);
  if (definition === undefined) {
    const known = listProviderNames(params.port.readdir, params.paths.providersDir);
    return {
      ok: false,
      status: 1,
      message:
        `claude-use: no provider named "${name}". ` +
        (known.length > 0 ? `Known providers: ${known.join(", ")}.` : "No providers are defined yet; run `claude-use provider add`."),
    };
  }

  if (params.credentials === undefined) {
    return { ok: false, status: 1, message: `claude-use: provider ${name} needs its credential resolved, but this launcher has no credential port wired` };
  }
  const resolution = resolveCredential({ credential: definition.credential, env: params.env, port: params.credentials, subject: `provider ${name}` });
  if (!resolution.ok) {
    return { ok: false, status: CREDENTIAL_UNAVAILABLE_EXIT, message: resolution.message };
  }
  return { ok: true, provider: { name, definition, credential: resolution.credential }, warnings: resolution.credential.warnings };
}

/** One provider as `provider show --json` and `provider list --json` print it: its name, the file's own fields (less its editor-only `$schema` pointer), and its credential block summarised, so no `literal` source's value is printed. */
function toProviderView(name: string, provider: Provider): Record<string, unknown> {
  return {
    name,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    credential: summariseCredential(provider.credential),
    ...(provider.env === undefined ? {} : { env: provider.env }),
  };
}

/** Options `provider add` accepts. */
interface ProviderAddOptions {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly credential: CredentialSource[];
  readonly credentialTarget?: ProviderCredentialTarget;
  readonly env?: Record<string, string>;
}

/** Options `provider set` accepts. */
interface ProviderSetOptions {
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly credential?: CredentialSource[];
  readonly credentialTarget?: ProviderCredentialTarget;
  readonly env?: Record<string, string>;
  readonly unsetEnv?: readonly string[];
}

/** Registers the `claude-use provider` subcommand tree onto `program`. */
export function registerProviderCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const provider = withExamples(
    program.command("provider").description("Manage API providers: Anthropic-compatible endpoints a launch can route through with --provider."),
    ["claude-use provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --credential env:Z_API_TOKEN", "claude-use provider list"],
  );

  withExamples(
    provider
      .command("add <name>")
      .description("Create a new API provider definition. Fails if one with this name already exists.")
      .requiredOption("--display-name <name>", "Human-readable name, exported to the child as CLAUDE_USE_PROVIDER.")
      .requiredOption("--base-url <url>", "Anthropic-compatible base URL the child's requests are sent to.")
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
      .action((name: string, options: ProviderAddOptions) => {
        const created = addProvider(paths, name, {
          displayName: options.displayName,
          baseUrl: options.baseUrl,
          sources: options.credential,
          ...(options.credentialTarget === undefined ? {} : { target: options.credentialTarget }),
          ...(options.env === undefined ? {} : { env: options.env }),
        });
        console.log(`Created provider "${name}" (${created.baseUrl}, credential ${describeCredential(created.credential)}).`);
      }),
    [
      "claude-use provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --credential env:Z_API_TOKEN",
      "claude-use provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --credential env:Z_API_TOKEN --credential op:op://vault/z/credential",
      "claude-use provider add anthropic-api --display-name Anthropic --base-url https://api.anthropic.com --credential-target apiKey --credential keychain:anthropic-api-key",
      "claude-use provider add local --display-name Local --base-url http://127.0.0.1:4000 --credential literal:dummy",
    ],
  );

  withExamples(
    provider
      .command("set <name>")
      .description("Update an existing API provider definition.")
      .option("--display-name <name>", "Replace the human-readable name.")
      .option("--base-url <url>", "Replace the base URL.")
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
      .action((name: string, options: ProviderSetOptions) => {
        if (Object.values(options).every((value) => value === undefined)) {
          throw new UsageError("Nothing to change: pass --display-name, --base-url, --credential, --credential-target, --env or --unset-env.");
        }
        const updated = updateProvider(paths, name, {
          ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.credential === undefined ? {} : { sources: options.credential }),
          ...(options.credentialTarget === undefined ? {} : { target: options.credentialTarget }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.unsetEnv === undefined ? {} : { unsetEnv: options.unsetEnv }),
        });
        console.log(`Updated provider "${name}" (${updated.baseUrl}, credential ${describeCredential(updated.credential)}).`);
      }),
    [
      "claude-use provider set z --base-url https://api.z.ai/api/anthropic",
      "claude-use provider set z --env API_TIMEOUT_MS=600000",
      "claude-use provider set z --credential op:op://vault/z/credential",
      "claude-use provider set anthropic-api --credential-target apiKey",
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
          console.log("No providers yet. Run `claude-use provider add <name>` to create one.");
          return;
        }
        for (const entry of entries) {
          console.log(`  ${entry.name} (${entry.provider.displayName}, ${entry.provider.baseUrl})`);
        }
      }),
    ["claude-use provider list", "claude-use provider list --json"],
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
        console.log(`Base URL: ${found.baseUrl}`);
        console.log(`Credential: ${describeCredential(found.credential)}`);
        const env = Object.entries(found.env ?? {});
        console.log(`Environment: ${env.length === 0 ? "(none)" : env.map(([key, value]) => `${key}=${value}`).join(", ")}`);
      }),
    ["claude-use provider show z", "claude-use provider show z --json"],
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
    ["claude-use provider remove z --yes"],
  );
}

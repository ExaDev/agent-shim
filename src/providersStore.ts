import fs from "node:fs";
import path from "node:path";
import { ConfigValidationError } from "./config/load";
import { writeJsonAtomic } from "./config/store";
import { CREDENTIAL_TARGET_VARS, isCodexProvider, type PROVIDER_CREDENTIAL_TARGETS, type PROVIDER_KINDS, ProviderSchema, type CodexProviderConfig, type CredentialCache, type CredentialSource, type Provider } from "./config/schema";
import { CliError, UsageError } from "./cliError";
import { CREDENTIAL_UNAVAILABLE_EXIT, resolveCredential, type CredentialPort } from "./credential";
import type { ResolvedProvider } from "./launcher/flags";
import type { FsPort } from "./launcher/ports";
import { assembleCascade, type CascadeInput } from "./resolve/walk";
import type { LayoutPaths } from "./paths";

/** Raised by any operation that requires a provider to already exist, when it does not. */
export class ProviderNotFoundError extends CliError {
  constructor(readonly name: string) {
    super(`No provider named "${name}". Run \`agent-shim provider add ${name}\` first.`);
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
      console.error(`agent-shim: providers/${name}.json is invalid and was skipped: ${error.message}`);
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
export type ProviderCredentialTarget = (typeof PROVIDER_CREDENTIAL_TARGETS)[number];

/** The kinds of provider. */
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Where a provider sends its sessions, for display: an `http` provider's base URL, or the front door for a codex provider (whose address exists only at launch). */
export function describeProviderEndpoint(provider: Provider): string {
  return isCodexProvider(provider) ? "codex translation daemon" : provider.baseUrl;
}

/** Everything `addProvider` writes into a fresh provider file. `baseUrl` is required for an `http` provider and refused for a codex one; `codex` applies only to a codex provider. */
export interface AddProviderInput {
  readonly kind?: ProviderKind;
  readonly displayName: string;
  readonly baseUrl?: string;
  readonly sources: readonly CredentialSource[];
  readonly target?: ProviderCredentialTarget;
  readonly env?: Readonly<Record<string, string>>;
  readonly codex?: CodexProviderConfig;
}

/** Raised when a provider option does not fit the provider's kind: a base URL for a codex provider, a missing one for an http provider, or codex settings for an http provider. */
export class ProviderKindMismatchError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderKindMismatchError";
  }
}

/** True when a codex settings block says nothing at all, so writing it would only add noise to the file. */
function isEmptyCodexConfig(config: CodexProviderConfig | undefined): boolean {
  return config === undefined || (config.defaultModel === undefined && config.effort === undefined && (config.models === undefined || Object.keys(config.models).length === 0));
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
  const kind = input.kind ?? "http";
  if (kind === "codex" && input.baseUrl !== undefined) {
    throw new ProviderKindMismatchError("A codex provider has no base URL: the launcher points its sessions at the front-door daemon. Drop --base-url.");
  }
  if (kind === "http" && input.baseUrl === undefined) {
    throw new ProviderKindMismatchError("An http provider needs --base-url.");
  }
  if (kind === "http" && !isEmptyCodexConfig(input.codex)) {
    throw new ProviderKindMismatchError("Codex settings apply only to a codex provider (--kind codex).");
  }
  const shared = {
    displayName: input.displayName,
    credential: { sources: input.sources, ...(input.target === undefined ? {} : { target: input.target }) },
    ...(input.env === undefined || Object.keys(input.env).length === 0 ? {} : { env: input.env }),
  };
  const parsed = ProviderSchema.safeParse(
    kind === "codex"
      ? { kind, ...shared, ...(isEmptyCodexConfig(input.codex) ? {} : { codex: input.codex }) }
      : { ...shared, baseUrl: input.baseUrl },
  );
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
  /** A new cache block, or false to remove it; undefined leaves the existing one. */
  readonly cache?: CredentialCache | false;
  readonly env?: Readonly<Record<string, string>>;
  readonly unsetEnv?: readonly string[];
  /** Merged over a codex provider's existing settings: a field given here replaces that field, and `models` entries merge per tier. */
  readonly codex?: CodexProviderConfig;
}

/**
 * Updates an existing provider definition in place. Throws `ProviderNotFoundError` when it does not exist, and `ConfigValidationError` when the updated definition fails `ProviderSchema`, leaving the file untouched.
 */
export function updateProvider(paths: LayoutPaths, name: string, input: UpdateProviderInput): Provider {
  const existing = readProvider(paths, name);
  if (existing === undefined) {
    throw new ProviderNotFoundError(name);
  }
  const unset = new Set(input.unsetEnv);
  const env = Object.fromEntries(Object.entries({ ...existing.env, ...input.env }).filter(([key]) => !unset.has(key)));
  const target = input.target ?? existing.credential.target;
  const cache = input.cache === undefined ? existing.credential.cache : input.cache === false ? undefined : input.cache;
  if (isCodexProvider(existing) && input.baseUrl !== undefined) {
    throw new ProviderKindMismatchError(`Provider "${name}" is a codex provider, which has no base URL.`);
  }
  if (!isCodexProvider(existing) && !isEmptyCodexConfig(input.codex)) {
    throw new ProviderKindMismatchError(`Provider "${name}" is an http provider; codex settings apply only to a codex provider.`);
  }
  const shared = {
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    credential: {
      sources: input.sources ?? existing.credential.sources,
      ...(target === undefined ? {} : { target }),
      ...(cache === undefined ? {} : { cache }),
    },
    env: Object.keys(env).length === 0 ? undefined : env,
  };
  let candidate: unknown;
  if (isCodexProvider(existing)) {
    const codex: CodexProviderConfig = {
      ...existing.codex,
      ...input.codex,
      ...(existing.codex?.models === undefined && input.codex?.models === undefined ? {} : { models: { ...existing.codex?.models, ...input.codex?.models } }),
    };
    candidate = { ...existing, ...shared, codex: isEmptyCodexConfig(codex) ? undefined : codex };
  } else {
    candidate = { ...existing, ...shared, ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }) };
  }
  const parsed = ProviderSchema.safeParse(candidate);
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
        `agent-shim: no provider named "${name}". ` +
        (known.length > 0 ? `Known providers: ${known.join(", ")}.` : "No providers are defined yet; run `agent-shim provider add`."),
    };
  }

  if (params.credentials === undefined) {
    return { ok: false, status: 1, message: `agent-shim: provider ${name} needs its credential resolved, but this launcher has no credential port wired` };
  }
  const resolution = resolveCredential({ credential: definition.credential, env: params.env, port: params.credentials, subject: `provider ${name}` });
  if (!resolution.ok) {
    return { ok: false, status: CREDENTIAL_UNAVAILABLE_EXIT, message: resolution.message };
  }
  return { ok: true, provider: { name, definition, credential: resolution.credential }, warnings: resolution.credential.warnings };
}

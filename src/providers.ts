import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";

import { parsePair } from "./cli/parsers";
import { ConfigValidationError, loadConfigFile } from "./config/load";
import { readJson, writeJsonAtomic } from "./config/store";
import { ProviderSchema, type Provider } from "./config/schema";
import { CliError } from "./cliError";
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

/** Raised when a `--env KEY=VALUE` flag's value has no `=` at all, or an empty key before it. */
class InvalidProviderEnvPairError extends CliError {
  constructor(readonly raw: string) {
    super(`"${raw}" is not a valid --env value. It must be KEY=VALUE, with the first "=" separating key from value.`);
    this.name = "InvalidProviderEnvPairError";
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

/** Reads and validates one provider definition, or undefined when it does not exist. */
export function readProvider(paths: LayoutPaths, name: string): Provider | undefined {
  return readJson(providerJsonPath(paths, name), ProviderSchema);
}

/**
 * Reads and validates one provider definition through an injected `FsPort`, the same way `loadIdentity` reads an `identity.json`: the launcher never touches the real filesystem directly, so provider loading must flow through the port it is already handed.
 */
export function loadProvider(providersDir: string, name: string, port: FsPort): Provider | undefined {
  return loadConfigFile(path.join(providersDir, `${name}.json`), ProviderSchema, port.readConfigFile)?.config;
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
      if (!(error instanceof ConfigValidationError)) {
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

/** Everything `addProvider` writes into a fresh provider file. */
export interface AddProviderInput {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly tokenEnv: string;
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
    tokenEnv: input.tokenEnv,
    ...(input.env === undefined || Object.keys(input.env).length === 0 ? {} : { env: input.env }),
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

/** Inputs to `resolveProvider`. */
export interface ResolveProviderParams {
  readonly paths: LayoutPaths;
  readonly port: FsPort;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The `--provider <name>` flag's value, when one was given. It outranks any cascade layer, matching how the cliOverride layer composes last everywhere else. */
  readonly cliProvider?: string;
  /** The assembled-but-unflattened cascade for this launch, when one was loaded. Its layers are scanned for a `launch.provider` selection so a profile, directory rule, portable file, or the global config can pin a provider exactly the way they pin the other launch flags. */
  readonly cascade?: CascadeInput;
}

/**
 * The outcome of resolving this launch's provider: either a fully-resolved provider (definition plus the token read out of the parent environment), or a refusal the launcher turns into a stderr line and a non-zero exit.
 *
 * Exit status 64 (`EX_USAGE`) is reserved for the provider being selected but unusable as written: an unset token environment variable means the command line itself is incomplete. An unknown provider name exits 1, matching every other "named thing not found" refusal in the launcher.
 */
/** The exit status for a provider selected whose token environment variable is unset or empty: 64, the conventional `EX_USAGE`, because the invocation asked for a provider the environment cannot authenticate. */
export const PROVIDER_MISSING_TOKEN_EXIT = 64;

export type ProviderResolution =
  | { readonly ok: true; readonly provider: ResolvedProvider }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Resolves which API provider this launch routes through, if any: the `--provider` flag first, then the cascade's `launch.provider` selection. Returns undefined when nothing selected a provider at all.
 *
 * Pure over its injected ports, so the launcher's tests exercise refusals without touching a real providers directory: this function decides, and the caller owns the log/exit side effects.
 */
export function resolveProvider(params: ResolveProviderParams): ProviderResolution | undefined {
  const cliName = params.cliProvider !== undefined && params.cliProvider !== "" ? params.cliProvider : undefined;

  let cascadeName: string | undefined;
  if (cliName === undefined && params.cascade !== undefined) {
    // Last layer wins per field, the same rule flattenLayers applies to every other launch flag.
    for (const layer of assembleCascade(params.cascade).layers) {
      if (layer.launch?.provider !== undefined) {
        cascadeName = layer.launch.provider;
      }
    }
  }

  const name = cliName ?? cascadeName;
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

  const token = params.env[definition.tokenEnv];
  if (token === undefined || token === "") {
    return {
      ok: false,
      status: PROVIDER_MISSING_TOKEN_EXIT,
      message: `claude-use: provider ${name} needs ${definition.tokenEnv} set in your environment`,
    };
  }

  return { ok: true, provider: { name, definition, token } };
}

/** Commander collector for the repeatable `--env KEY=VALUE` flag. */
function collectEnvPairs(value: string, previous: Readonly<Record<string, string>> = {}): Record<string, string> {
  let pair;
  try {
    pair = parsePair(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidProviderEnvPairError(value);
    }
    throw error;
  }
  return { ...previous, [pair.key]: pair.value };
}

/** Registers the `claude-use provider` subcommand tree onto `program`. */
export function registerProviderCommand(program: Command, paths: LayoutPaths): void {
  const provider = program.command("provider").description("Manage API providers the launcher can route a session through.");

  provider
    .command("add <name>")
    .description("Create a new API provider definition.")
    .requiredOption("--display-name <name>", "Human-readable name, exported to the child as CLAUDE_USE_PROVIDER.")
    .requiredOption("--base-url <url>", "Anthropic-compatible base URL the child's requests are sent to.")
    .requiredOption("--token-env <var>", "NAME of the environment variable holding the provider's token (never the token itself).")
    .option("--env <pair>", "Extra KEY=VALUE environment entry for the child (repeatable).", collectEnvPairs)
    .action((name: string, options: Readonly<{ displayName: string; baseUrl: string; tokenEnv: string; env?: Record<string, string> }>) => {
      addProvider(paths, name, {
        displayName: options.displayName,
        baseUrl: options.baseUrl,
        tokenEnv: options.tokenEnv,
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      console.log(`Created provider "${name}" (${options.baseUrl}, token from ${options.tokenEnv}).`);
    });

  provider
    .command("list")
    .description("List every API provider.")
    .action(() => {
      const entries = listProviders(paths);
      if (entries.length === 0) {
        console.log("No providers yet. Run `claude-use provider add <name>` to create one.");
        return;
      }
      for (const entry of entries) {
        console.log(`  ${entry.name} (${entry.provider.displayName}, ${entry.provider.baseUrl})`);
      }
    });

  provider
    .command("show <name>")
    .description("Print one provider's definition.")
    .action((name: string) => {
      const found = readProvider(paths, name);
      if (found === undefined) {
        throw new ProviderNotFoundError(name);
      }
      console.log(JSON.stringify(found, null, 2));
    });

  provider
    .command("remove <name>")
    .description("Delete a provider definition.")
    .action((name: string) => {
      removeProvider(paths, name);
      console.log(`Removed provider "${name}".`);
    });
}

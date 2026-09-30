import fs from "node:fs";
import path from "node:path";
import { Option, type Command } from "commander";

import { confirmRemoval, printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { collectRepeated, collectStringPair } from "./cli/parsers";
import { ConfigValidationError, loadConfigFile } from "./config/load";
import { readJson, writeJsonAtomic } from "./config/store";
import { AUTH_SCHEMES, ProviderSchema, type AuthScheme, type Provider } from "./config/schema";
import { CliError, UsageError } from "./cliError";
import type { ResolvedProvider } from "./launcher/flags";
import type { FsPort, RunPort } from "./launcher/ports";
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
  readonly tokenEnv?: string;
  readonly tokenCommand?: readonly [string, ...string[]];
  readonly authScheme?: AuthScheme;
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
    ...(input.tokenEnv === undefined ? {} : { tokenEnv: input.tokenEnv }),
    ...(input.tokenCommand === undefined ? {} : { tokenCommand: input.tokenCommand }),
    ...(input.authScheme === undefined ? {} : { authScheme: input.authScheme }),
    ...(input.env === undefined || Object.keys(input.env).length === 0 ? {} : { env: input.env }),
  });
  if (!parsed.success) {
    throw new ConfigValidationError(providerJsonPath(paths, name), parsed.error.issues);
  }
  writeJsonAtomic(providerJsonPath(paths, name), parsed.data);
  return parsed.data;
}

/**
 * The fields `updateProvider` changes. `false` removes `tokenEnv` or `tokenCommand`; naming a new `tokenEnv` replaces any `tokenCommand` and vice versa, since a provider has exactly one token source and switching between those two is what setting one means. `env` entries merge over the existing ones and `unsetEnv` keys are then deleted.
 */
interface UpdateProviderInput {
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly tokenEnv?: string | false;
  readonly tokenCommand?: readonly [string, ...string[]] | false;
  readonly authScheme?: AuthScheme;
  readonly env?: Readonly<Record<string, string>>;
  readonly unsetEnv?: readonly string[];
}

/**
 * Updates an existing provider definition in place. Throws `ProviderNotFoundError` when it does not exist, and `ConfigValidationError` when the updated definition fails `ProviderSchema` (e.g. removing the only token source, or leaving two), leaving the file untouched.
 */
function updateProvider(paths: LayoutPaths, name: string, input: UpdateProviderInput): Provider {
  const existing = readProvider(paths, name);
  if (existing === undefined) {
    throw new ProviderNotFoundError(name);
  }
  const unset = new Set(input.unsetEnv);
  const env = Object.fromEntries(Object.entries({ ...existing.env, ...input.env }).filter(([key]) => !unset.has(key)));
  const parsed = ProviderSchema.safeParse({
    ...existing,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.tokenEnv === undefined ? {} : { tokenEnv: input.tokenEnv === false ? undefined : input.tokenEnv }),
    ...(typeof input.tokenEnv === "string" && input.tokenCommand === undefined ? { tokenCommand: undefined } : {}),
    ...(input.tokenCommand === undefined ? {} : { tokenCommand: input.tokenCommand === false ? undefined : input.tokenCommand }),
    ...(input.tokenCommand !== undefined && input.tokenCommand !== false && input.tokenEnv === undefined ? { tokenEnv: undefined } : {}),
    ...(input.authScheme === undefined ? {} : { authScheme: input.authScheme }),
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

/** Inputs to `resolveProvider`. */
export interface ResolveProviderParams {
  readonly paths: LayoutPaths;
  readonly port: FsPort;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Runs a provider's `tokenCommand`. Omitted by a caller that cannot run commands; a provider that needs one is then refused rather than launched without its credential. */
  readonly run?: RunPort;
  /** The `--provider <name>` flag's value, when one was given. It outranks any cascade layer, matching how the cliOverride layer composes last everywhere else. */
  readonly cliProvider?: string;
  /** The assembled-but-unflattened cascade for this launch, when one was loaded. Its layers are scanned for a `launch.provider` selection so a profile, directory rule, portable file, or the global config can pin a provider exactly the way they pin the other launch flags. */
  readonly cascade?: CascadeInput;
}

/**
 * The outcome of resolving this launch's provider: either a fully-resolved provider (definition plus the token read out of the parent environment), or a refusal the launcher turns into a stderr line and a non-zero exit.
 *
 * Exit status 64 (`EX_USAGE`) is reserved for the provider being selected but unusable as written: an unset token environment variable, or a token command that fails or prints nothing, means the invocation cannot authenticate. An unknown provider name exits 1, matching every other "named thing not found" refusal in the launcher.
 */
/** The exit status for a provider selected whose credential cannot be obtained (an unset or empty token environment variable, or a token command that fails or prints nothing): 64, the conventional `EX_USAGE`, because the invocation asked for a provider the environment cannot authenticate. */
export const PROVIDER_MISSING_TOKEN_EXIT = 64;

export type ProviderResolution =
  | { readonly ok: true; readonly provider: ResolvedProvider }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** The outcome of obtaining a provider's token: the token, or the refusal `resolveProvider` reports. */
type TokenOutcome =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Obtains the token from the provider's single configured source (`ProviderSchema` guarantees exactly one): the `tokenEnv` variable in the parent environment, the trimmed stdout of `tokenCommand`, or the fixed `env.ANTHROPIC_AUTH_TOKEN` of a local proxy. Every failure is a status 64 refusal.
 *
 * A refusal message never contains the command's stdout, which is the credential; it carries the exit status and the command's stderr, which is where a well-behaved secret tool explains itself.
 */
function obtainToken(name: string, definition: Provider, params: ResolveProviderParams): TokenOutcome {
  const unusable = (message: string): TokenOutcome => ({ ok: false, status: PROVIDER_MISSING_TOKEN_EXIT, message });

  if (definition.tokenCommand !== undefined) {
    const [command, ...args] = definition.tokenCommand;
    if (params.run === undefined) {
      return { ok: false, status: 1, message: `claude-use: provider ${name} needs its token command run, but this launcher has no command runner wired` };
    }
    const result = params.run.run(command, args);
    if (result.status !== 0) {
      const stderr = result.stderr.trim();
      const outcome = result.status === null ? "could not be run or was killed by a signal" : `exited with status ${String(result.status)}`;
      return unusable(`claude-use: provider ${name}: token command ${command} ${outcome}${stderr === "" ? "" : `: ${stderr}`}`);
    }
    const token = result.stdout.trim();
    return token === "" ? unusable(`claude-use: provider ${name}: token command ${command} printed no token`) : { ok: true, token };
  }

  const token = definition.tokenEnv !== undefined ? params.env[definition.tokenEnv] : definition.env?.ANTHROPIC_AUTH_TOKEN;
  if (token === undefined || token === "") {
    return unusable(
      definition.tokenEnv !== undefined
        ? `claude-use: provider ${name} needs ${definition.tokenEnv} set in your environment`
        : `claude-use: provider ${name} has no usable credential: its env.ANTHROPIC_AUTH_TOKEN is empty`,
    );
  }
  return { ok: true, token };
}

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

  const credential = obtainToken(name, definition, params);
  if (!credential.ok) {
    return credential;
  }
  const token = credential.token;

  return { ok: true, provider: { name, definition, token } };
}

/** One provider as `provider show --json` and `provider list --json` print it: the file's own content (less its editor-only `$schema` pointer) plus its name. */
function toProviderView(name: string, provider: Provider): Record<string, unknown> {
  return { name, ...provider, $schema: undefined };
}

/** Renders where a provider's credential comes from, for the human-readable output: the variable's name or the command's program, never a token value. */
function describeCredential(provider: Provider): string {
  if (provider.tokenEnv !== undefined) {
    return `token from ${provider.tokenEnv}`;
  }
  if (provider.tokenCommand !== undefined) {
    return `token from ${provider.tokenCommand[0]}`;
  }
  return "fixed env.ANTHROPIC_AUTH_TOKEN";
}

/** Options `provider set` accepts. `tokenEnv` and `tokenCommand` are `false` for their `--no-` forms. */
interface ProviderSetOptions {
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly tokenEnv?: string | false;
  readonly tokenCommand?: [string, ...string[]] | false;
  readonly authScheme?: AuthScheme;
  readonly env?: Record<string, string>;
  readonly unsetEnv?: readonly string[];
}

/** Registers the `claude-use provider` subcommand tree onto `program`. */
export function registerProviderCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const provider = withExamples(
    program.command("provider").description("Manage API providers: Anthropic-compatible endpoints a launch can route through with --provider."),
    ["claude-use provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --token-env Z_API_TOKEN", "claude-use provider list"],
  );

  withExamples(
    provider
      .command("add <name>")
      .description("Create a new API provider definition. Fails if one with this name already exists.")
      .requiredOption("--display-name <name>", "Human-readable name, exported to the child as CLAUDE_USE_PROVIDER.")
      .requiredOption("--base-url <url>", "Anthropic-compatible base URL the child's requests are sent to.")
      .option(
        "--token-env <var>",
        "NAME of the environment variable holding the provider's token (never the token itself). Exactly one of --token-env, --token-command or --env ANTHROPIC_AUTH_TOKEN=<fixed dummy token for a local proxy> is required.",
      )
      .option(
        "--token-command <argv...>",
        "Command (program and arguments) run at launch whose trimmed stdout is the token, e.g. --token-command op read op://vault/item/field. Give it last on the command line, since it consumes every following word.",
      )
      .addOption(
        new Option("--auth-scheme <scheme>", "How the token reaches Claude Code: bearer sets ANTHROPIC_AUTH_TOKEN (default), apiKey sets ANTHROPIC_API_KEY.").choices(
          AUTH_SCHEMES,
        ),
      )
      .option("--env <KEY=VALUE>", "Extra environment entry for the child (repeatable).", collectStringPair)
      .action(
        (
          name: string,
          options: Readonly<{
            displayName: string;
            baseUrl: string;
            tokenEnv?: string;
            tokenCommand?: [string, ...string[]];
            authScheme?: AuthScheme;
            env?: Record<string, string>;
          }>,
        ) => {
          const created = addProvider(paths, name, {
            displayName: options.displayName,
            baseUrl: options.baseUrl,
            ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
            ...(options.tokenCommand === undefined ? {} : { tokenCommand: options.tokenCommand }),
            ...(options.authScheme === undefined ? {} : { authScheme: options.authScheme }),
            ...(options.env === undefined ? {} : { env: options.env }),
          });
          console.log(`Created provider "${name}" (${created.baseUrl}, ${describeCredential(created)}).`);
        },
      ),
    [
      "claude-use provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --token-env Z_API_TOKEN",
      "claude-use provider add z --display-name z.ai --base-url https://api.z.ai/api/anthropic --token-command op read op://vault/z/credential",
      "claude-use provider add anthropic-api --display-name Anthropic --base-url https://api.anthropic.com --auth-scheme apiKey --token-env ANTHROPIC_KEY",
      "claude-use provider add local --display-name Local --base-url http://127.0.0.1:4000 --env ANTHROPIC_AUTH_TOKEN=dummy",
    ],
  );

  withExamples(
    provider
      .command("set <name>")
      .description("Update an existing API provider definition.")
      .option("--display-name <name>", "Replace the human-readable name.")
      .option("--base-url <url>", "Replace the base URL.")
      .option("--token-env <var>", "Take the token from this environment variable, replacing any token command.")
      .option("--no-token-env", "Remove tokenEnv (another token source must remain).")
      .option(
        "--token-command <argv...>",
        "Take the token from this command's trimmed stdout, replacing any token variable. Give it last on the command line, since it consumes every following word.",
      )
      .option("--no-token-command", "Remove tokenCommand (another token source must remain).")
      .addOption(
        new Option("--auth-scheme <scheme>", "How the token reaches Claude Code: bearer sets ANTHROPIC_AUTH_TOKEN, apiKey sets ANTHROPIC_API_KEY.").choices(
          AUTH_SCHEMES,
        ),
      )
      .option("--env <KEY=VALUE>", "Add or replace an environment entry for the child (repeatable).", collectStringPair)
      .option("--unset-env <KEY>", "Remove an environment entry (repeatable).", collectRepeated)
      .action((name: string, options: ProviderSetOptions) => {
        if (Object.values(options).every((value) => value === undefined)) {
          throw new UsageError(
            "Nothing to change: pass --display-name, --base-url, --token-env, --token-command (or a --no- form), --auth-scheme, --env or --unset-env.",
          );
        }
        const updated = updateProvider(paths, name, options);
        console.log(`Updated provider "${name}" (${updated.baseUrl}, ${describeCredential(updated)}).`);
      }),
    [
      "claude-use provider set z --base-url https://api.z.ai/api/anthropic",
      "claude-use provider set z --env API_TIMEOUT_MS=600000",
      "claude-use provider set z --token-command op read op://vault/z/credential",
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
      .description("Show one provider's definition. Credentials are named, never printed: tokenEnv is a variable name, and env values are shown as written in the file.")
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
        console.log(
          `Credential: ${found.tokenCommand === undefined ? describeCredential(found) : `token from command ${found.tokenCommand.join(" ")}`}`,
        );
        console.log(`Auth scheme: ${found.authScheme ?? "bearer"}`);
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

import fs from "node:fs";
import path from "node:path";
import { Option, type Command } from "commander";

import { confirmRemoval, printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { collectCredentialSource, CREDENTIAL_SOURCE_SYNTAX } from "./cli/credentialOption";
import { loadClassification } from "./config/classify";
import { ConfigValidationError } from "./config/load";
import { applyPatch, readJson, writeJsonAtomic, writeTextAtomic } from "./config/store";
import { CREDENTIAL_TARGETS, IdentitySchema, type CredentialSource, type CredentialTarget, type Identity } from "./config/schema";
import { describeCredential, summariseCredential, type CredentialSummary } from "./credential";
import { runProfileWizard, type PromptsPort } from "./configure";
import { CliError, PromptCancelledError, UsageError } from "./cliError";
import { resolveFarmConflicts, type FarmConflictChoice } from "./launcher/farmResolve";
import { ensureProfileExists } from "./configProfiles";
import type { LayoutPaths } from "./paths";
import { identityLockPath } from "./launcher/lock";
import { realFarmFs } from "./realPorts";

/** Raised by any operation that requires an identity to already exist, when it does not. */
export class IdentityNotFoundError extends CliError {
  constructor(readonly name: string) {
    super(`No identity named "${name}". Run \`claude-use identity add ${name}\` first.`);
    this.name = "IdentityNotFoundError";
  }
}

/** Raised by `addIdentity` when an identity with the given name already has an `identity.json`. */
export class IdentityAlreadyExistsError extends CliError {
  constructor(readonly identityName: string) {
    super(`An identity named "${identityName}" already exists.`);
    this.name = "IdentityAlreadyExistsError";
  }
}

/** Raised by `addIdentity` when `name` fails `IdentitySchema`'s own naming rule — it must start with a letter or number and may then contain letters, numbers, dots, hyphens, underscores, and at signs, so an email address names an identity directly while a *leading* `@` stays invalid (it would collide with the `@name` selector syntax's first-`@` split). */
export class InvalidIdentityNameError extends CliError {
  constructor(readonly attemptedName: string) {
    super(
      `"${attemptedName}" is not a valid identity name — identity names must start with a letter or number and may then contain letters, numbers, dots, hyphens, underscores, and at signs.`,
    );
    this.name = "InvalidIdentityNameError";
  }
}

function identityJsonPath(paths: LayoutPaths, name: string): string {
  return path.join(paths.identitiesDir, name, "identity.json");
}

function identityExists(paths: LayoutPaths, name: string): boolean {
  return fs.existsSync(identityJsonPath(paths, name));
}

/** Reads and validates one identity's `identity.json`, or undefined when it does not exist. */
export function readIdentity(paths: LayoutPaths, name: string): Identity | undefined {
  return readJson(identityJsonPath(paths, name), IdentitySchema);
}

/**
 * Creates a new identity: validates `name` against `IdentitySchema`'s own naming rule and writes a fresh `identity.json` with `allowAmbientCredential: false` and no `defaultConfigProfile`.
 *
 * Throws `IdentityAlreadyExistsError` if an identity with this name already has an `identity.json` — `add` never silently overwrites an existing identity. Throws `InvalidIdentityNameError` when `name` fails `IdentitySchema`'s naming rule, rather than letting the underlying `ZodError` escape as an unhandled crash.
 */
export function addIdentity(paths: LayoutPaths, name: string): Identity {
  if (identityExists(paths, name)) {
    throw new IdentityAlreadyExistsError(name);
  }
  const parsed = IdentitySchema.safeParse({ name, allowAmbientCredential: false });
  if (!parsed.success) {
    throw new InvalidIdentityNameError(name);
  }
  writeJsonAtomic(identityJsonPath(paths, name), parsed.data);
  return parsed.data;
}

/**
 * Persists `name` as the active identity, written atomically as plain text (not JSON — this file is read by `decideIdentity` in `src/launcher/identity.ts` via a simple UTF-8 read-and-trim, matching the README's documented `~/.claude-use/active-identity` file).
 *
 * Throws `IdentityNotFoundError` when no identity with this name exists yet — selecting an identity that hasn't been created would silently persist a name nothing else can ever load.
 */
export function useIdentity(paths: LayoutPaths, name: string): void {
  if (!identityExists(paths, name)) {
    throw new IdentityNotFoundError(name);
  }
  writeTextAtomic(paths.activeIdentityFile, `${name}\n`);
}

/**
 * The interactive setup wizard for a new identity, offered by the `@<name>` shortcut, `identity use`, and a launch naming an identity that doesn't exist yet, whenever stdin is a real terminal.
 *
 * Validates `name` against `IdentitySchema`'s own naming rule before any prompt appears — offering "Create it now?" for a name that could never validate (one with a leading `@`, say, or any other character the schema rejects) just to fail on confirm is a broken interaction, so an invalid name throws `InvalidIdentityNameError` immediately instead.
 *
 * Confirms the user wants to create the identity, then optionally creates a default configuration profile (reusing `runProfileWizard`), links them, and (unless `activate` is false) sets the identity as active. A cancel at any step writes nothing beyond what was already committed: the identity is only created after the first confirm, and the profile wizard's own cancel handling means a profile-only cancellation still leaves the identity usable. Returns `true` when the identity was created; `false` when the user declined at the initial confirm, leaving the caller to decide what a decline means (every current caller raises `PromptCancelledError`).
 *
 * Driven entirely by the injected `PromptsPort` so the whole flow is unit-testable with a scripted sequence of answers.
 */
export async function runIdentityWizard(
  prompts: PromptsPort,
  paths: LayoutPaths,
  name: string,
  options: Readonly<{ activate?: boolean }> = {},
): Promise<boolean> {
  if (!IdentitySchema.safeParse({ name, allowAmbientCredential: false }).success) {
    throw new InvalidIdentityNameError(name);
  }
  const choice = await prompts.select({
    message: `No identity named "${name}" exists yet. Create it now?`,
    options: [
      { value: "create", label: "Create it" },
      { value: "cancel", label: "Cancel" },
    ],
  });
  if (prompts.isCancel(choice) || choice === "cancel") {
    return false;
  }

  addIdentity(paths, name);

  const profileChoice = await prompts.select({
    message: `Create a default configuration profile for "${name}"?`,
    options: [
      { value: "create", label: "Create and configure a profile" },
      { value: "skip", label: "Skip for now" },
    ],
    // Most identities need no profile of their own at all — they're meant to fall through to whatever the global default (or a directory rule) already resolves to, and a profile only earns its keep once an identity genuinely needs to diverge from that. Defaulting the cursor to "skip" makes the common, no-profile-needed case the one a bare Enter confirms, without reordering the options and making "skip" read as the first, most prominent choice on screen.
    initialValue: "skip",
  });
  if (!prompts.isCancel(profileChoice) && profileChoice === "create") {
    const result = await runProfileWizard(prompts, { paths, defaultNewName: name });
    if (result !== undefined) {
      setDefaultConfigProfile(paths, name, result.name);
    }
  }

  if (options.activate === false) {
    prompts.outro(`Identity "${name}" is set up.`);
    return true;
  }
  useIdentity(paths, name);
  prompts.outro(`Identity "${name}" is set up and active.`);
  return true;
}

/**
 * Makes `name` the active identity, the one behaviour `identity use <name>` and the `@<name>` shortcut share. An existing identity is selected directly. A missing one is offered to `runIdentityWizard` when standard input is a terminal (declining raises `PromptCancelledError`); with no terminal it raises `IdentityNotFoundError`, since there is nothing to prompt on.
 */
async function selectIdentity(deps: CommandDeps, name: string): Promise<void> {
  if (identityExists(deps.paths, name)) {
    useIdentity(deps.paths, name);
  } else if (deps.isInteractive()) {
    if (!(await runIdentityWizard(deps.prompts, deps.paths, name))) {
      throw new PromptCancelledError();
    }
  } else {
    throw new IdentityNotFoundError(name);
  }
  console.log(`Active identity is now "${name}".`);
}

/**
 * Handles the `claude-use @<name>` shortcut for `claude-use identity use <name>`: terser, and matches the `@name` convention `run @name`/`claude @name` already use for selecting an identity, rather than introducing a new one.
 *
 * Deliberately requires the `@` prefix and requires `@<name>` to be the *only* argument, rather than also accepting a bare `claude-use <name>`: identity names are user-chosen and unconstrained against the registered subcommand vocabulary, so a bare positional name could collide with a real subcommand, today by an unlikely coincidence, but the tool's own vocabulary only grows over time. `@` makes the token unambiguous on sight and guarantees no future subcommand name can ever collide with it.
 *
 * Returns `false` when `argv` doesn't match this exact one-argument `@name` shape at all, so the caller falls through to normal Commander subcommand dispatch (including its own "unknown command" error for anything else). Returns `true` once handled; the selection itself is `selectIdentity`, so a missing identity behaves exactly as it does under `identity use`.
 */
export async function tryRunAtIdentityShortcut(deps: CommandDeps, argv: readonly string[]): Promise<boolean> {
  if (argv.length !== 1) {
    return false;
  }
  const [token] = argv;
  if (token === undefined || !token.startsWith("@") || token.length === 1) {
    return false;
  }
  await selectIdentity(deps, token.slice(1));
  return true;
}

/** Reads the persisted active-identity file, or undefined when none is set. */
export function readActiveIdentity(paths: LayoutPaths): string | undefined {
  if (!fs.existsSync(paths.activeIdentityFile)) {
    return undefined;
  }
  const raw = fs.readFileSync(paths.activeIdentityFile, "utf8").trim();
  return raw === "" ? undefined : raw;
}

/**
 * Whether a directory name directly under `identitiesDir` names an actual identity, rather than one of claude-use's own farm directories.
 *
 * `IdentitySchema` requires an identity name to start with a letter or digit, so a leading `.` can only be a resync's own bookkeeping: a `.<identity>.scratch.<suffix>` tree still being built, or a `.<identity>.previous.<suffix>` superseded farm retained for `claude-use identity resolve-conflicts`. Neither is an identity, and neither should be reported as a broken one for lacking an `identity.json` a resync never put there.
 */
export function isIdentityDirectoryName(name: string): boolean {
  return !name.startsWith(".");
}

/** One identity as reported by `listIdentities`, whose `identity.json` parsed and validated cleanly. */
interface IdentityListEntry {
  readonly name: string;
  readonly identity: Identity;
  readonly isActive: boolean;
  readonly problem?: never;
}

/** One identity whose `identity.json` is present but unreadable — malformed JSON, or valid JSON this version's `IdentitySchema` rejects. `problem` carries the reason, already flattened onto a single line. */
interface UnreadableIdentityListEntry {
  readonly name: string;
  readonly identity?: never;
  readonly isActive: boolean;
  readonly problem: string;
}

/** Either shape `listIdentities` can report, discriminated by which of `identity`/`problem` is present rather than by a tag field — the two are never simultaneously satisfiable. */
export type IdentityListing = IdentityListEntry | UnreadableIdentityListEntry;

/**
 * Reads one identity for `listIdentities`, converting an unreadable `identity.json` into a reportable problem string instead of throwing.
 *
 * Only the two failure modes a *file's own content* can produce are caught: a `SyntaxError` from `JSON.parse`, and the `ConfigValidationError` a schema violation raises. Anything else (a permission error, a directory where a file belongs) still propagates, since those are environment faults rather than one identity's data being bad.
 *
 * A wholly absent `identity.json` is neither — it yields `undefined`, and `listIdentities` skips the entry entirely. That is what keeps `identities/` retained superseded farms (`.<name>.previous.<pid>.<uuid>/`, which are real directories with no `identity.json`) out of the listing.
 */
function readIdentityForListing(paths: LayoutPaths, name: string): Identity | { readonly problem: string } | undefined {
  try {
    return readIdentity(paths, name);
  } catch (error) {
    if (error instanceof ConfigValidationError || error instanceof SyntaxError) {
      return { problem: error.message.replace(/\s*\n\s*/g, " ") };
    }
    throw error;
  }
}

/**
 * Lists every identity under `identitiesDir`, marking which one (if any) is currently active.
 *
 * One identity whose `identity.json` cannot be read is reported as its own `UnreadableIdentityListEntry` rather than aborting the whole listing. A single bad file blocking `identity list` outright is exactly the failure mode that hides every *other* identity from view at the moment the user most needs to see them — and the file need not even be corrupt to land here, since a name written by a newer claude-use whose naming rule has since widened is rejected outright by an older binary's own copy of `IdentitySchema`.
 */
export function listIdentities(paths: LayoutPaths): readonly IdentityListing[] {
  if (!fs.existsSync(paths.identitiesDir)) {
    return [];
  }
  const active = readActiveIdentity(paths);
  const names = fs
    .readdirSync(paths.identitiesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isIdentityDirectoryName(entry.name))
    .map((entry) => entry.name)
    .sort();

  const result: IdentityListing[] = [];
  for (const name of names) {
    const read = readIdentityForListing(paths, name);
    if (read === undefined) {
      continue;
    }
    const isActive = name === active;
    result.push("problem" in read ? { name, isActive, problem: read.problem } : { name, identity: read, isActive });
  }
  return result;
}

/**
 * Sets `identity`'s `defaultConfigProfile` field, or clears it when `profileName` is undefined. Throws `IdentityNotFoundError` when the identity does not exist. Whether the profile exists is the caller's concern: `identity set --default-profile` checks it first.
 */
export function setDefaultConfigProfile(paths: LayoutPaths, identityName: string, profileName: string | undefined): Identity {
  if (!identityExists(paths, identityName)) {
    throw new IdentityNotFoundError(identityName);
  }
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, {
    defaultConfigProfile: profileName,
  });
}

/**
 * Patches `identity`'s `allowAmbientCredential` field. Throws `IdentityNotFoundError` when the identity does not exist.
 */
export function setAllowAmbientCredential(paths: LayoutPaths, identityName: string, allow: boolean): Identity {
  if (!identityExists(paths, identityName)) {
    throw new IdentityNotFoundError(identityName);
  }
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, {
    allowAmbientCredential: allow,
  });
}

/** The change `setIdentityCredential` makes: new sources and/or a new target for the credential block, or `false` to remove the block and return the identity to its stored login. */
type IdentityCredentialChange = { readonly sources?: readonly CredentialSource[]; readonly target?: CredentialTarget } | false;

/**
 * Sets, changes or removes `identityName`'s credential block. New `sources` replace the whole ordered list (the order is the meaning); a `target` alone keeps the existing sources, and so needs a credential block to exist already. Throws `IdentityNotFoundError` when the identity does not exist, and `UsageError` when only a target is given for an identity with no credential yet.
 */
function setIdentityCredential(paths: LayoutPaths, identityName: string, change: IdentityCredentialChange): Identity {
  const existing = readIdentity(paths, identityName);
  if (existing === undefined) {
    throw new IdentityNotFoundError(identityName);
  }
  if (change === false) {
    return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, { credential: undefined });
  }
  const sources = change.sources ?? existing.credential?.sources;
  if (sources === undefined) {
    throw new UsageError(`Identity "${identityName}" has no credential yet: pass --credential to give it one before choosing its target.`);
  }
  const target = change.target ?? existing.credential?.target;
  return applyPatch(identityJsonPath(paths, identityName), IdentitySchema, {
    credential: { sources: [...sources], ...(target === undefined ? {} : { target }) },
  });
}

/** Whether `entry` (a name directly under `identitiesDir`) is part of identity `name`'s on-disk state: its farm, the resync lock, or a scratch or superseded farm a resync left behind. */
function belongsToIdentity(entry: string, name: string): boolean {
  return (
    entry === name ||
    entry === path.basename(identityLockPath("", name)) ||
    entry.startsWith(`.${name}.scratch.`) ||
    entry.startsWith(`.${name}.previous.`)
  );
}

/**
 * Deletes identity `name` entirely: its directory under `identitiesDir` (the farm, its `identity.json`, and whatever that farm holds unshared, credentials included), its resync lock, any scratch or superseded farm a resync left behind, and the active-identity selection when it names this identity. Data shared into `~/.claude` stays there, since the farm only ever symlinks to it. Throws `IdentityNotFoundError` when the identity does not exist.
 */
function removeIdentity(paths: LayoutPaths, name: string): void {
  if (!identityExists(paths, name)) {
    throw new IdentityNotFoundError(name);
  }
  for (const entry of fs.readdirSync(paths.identitiesDir)) {
    if (belongsToIdentity(entry, name)) {
      fs.rmSync(path.join(paths.identitiesDir, entry), { recursive: true, force: true });
    }
  }
  if (readActiveIdentity(paths) === name) {
    fs.rmSync(paths.activeIdentityFile);
  }
}

/** One identity as `identity show --json` and `identity list --json` print it. */
interface IdentityView {
  readonly name: string;
  readonly active: boolean;
  readonly directory: string;
  readonly defaultConfigProfile?: string;
  readonly allowAmbientCredential?: boolean;
  /** How the identity authenticates when it has a credential block: its target and each source's kind, never a value. Absent when it uses its stored login. */
  readonly credential?: CredentialSummary;
  readonly problem?: string;
}

function toIdentityView(paths: LayoutPaths, entry: IdentityListing): IdentityView {
  return {
    name: entry.name,
    active: entry.isActive,
    directory: path.join(paths.identitiesDir, entry.name),
    ...(entry.problem === undefined
      ? {
          ...(entry.identity.defaultConfigProfile === undefined ? {} : { defaultConfigProfile: entry.identity.defaultConfigProfile }),
          allowAmbientCredential: entry.identity.allowAmbientCredential,
          ...(entry.identity.credential === undefined ? {} : { credential: summariseCredential(entry.identity.credential) }),
        }
      : { problem: entry.problem }),
  };
}

/** Renders one identity as the single line `identity list` prints for it. */
function formatIdentityLine(entry: IdentityListing): string {
  const marker = entry.isActive ? "* " : "  ";
  if (entry.problem !== undefined) {
    return `${marker}${entry.name} [unreadable: ${entry.problem}]`;
  }
  const defaultProfile =
    entry.identity.defaultConfigProfile === undefined ? "" : ` (default profile: ${entry.identity.defaultConfigProfile})`;
  const ambient = entry.identity.allowAmbientCredential ? " [allows ambient credential]" : "";
  const credential = entry.identity.credential === undefined ? "" : ` [credential ${describeCredential(entry.identity.credential)}]`;
  return `${marker}${entry.name}${defaultProfile}${ambient}${credential}`;
}

/** Options `identity set` accepts. `defaultProfile` is `false` for `--no-default-profile`, and `credential` is `false` for `--no-credential`. */
interface IdentitySetOptions {
  readonly defaultProfile?: string | false;
  readonly allowAmbientCredential?: boolean;
  readonly credential?: CredentialSource[] | false;
  readonly credentialTarget?: CredentialTarget;
}

/** Registers the `claude-use identity` subcommand tree onto `program`. */
export function registerIdentityCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const identity = withExamples(
    program.command("identity").description("Manage identities: each one is a separate Claude Code login with its own credentials."),
    ["claude-use identity add work", "claude-use identity list"],
  );

  withExamples(
    identity
      .command("add <name>")
      .description("Create a new identity. Fails if one with this name already exists.")
      .action((name: string) => {
        addIdentity(paths, name);
        console.log(`Created identity "${name}".`);
      }),
    ["claude-use identity add work"],
  );

  withExamples(
    identity
      .command("list")
      .description("List every identity, marking the active one with *.")
      .option("--json", "Print the identities as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const entries = listIdentities(paths);
        if (options.json === true) {
          printJson(entries.map((entry) => toIdentityView(paths, entry)));
          return;
        }
        if (entries.length === 0) {
          console.log("No identities yet. Run `claude-use identity add <name>` to create one.");
          return;
        }
        for (const entry of entries) {
          console.log(formatIdentityLine(entry));
        }
        if (entries.some((entry) => entry.problem !== undefined)) {
          console.log("\nRun `claude-use doctor` for the full detail on every unreadable entry.");
        }
      }),
    ["claude-use identity list", "claude-use identity list --json"],
  );

  withExamples(
    identity
      .command("show <name>")
      .description("Show one identity's settings and directory.")
      .option("--json", "Print the identity as JSON.")
      .action((name: string, options: Readonly<{ json?: boolean }>) => {
        const entry = listIdentities(paths).find((candidate) => candidate.name === name);
        if (entry === undefined) {
          throw new IdentityNotFoundError(name);
        }
        const view = toIdentityView(paths, entry);
        if (options.json === true) {
          printJson(view);
          return;
        }
        console.log(`Identity: ${view.name}${view.active ? " (active)" : ""}`);
        console.log(`Directory: ${view.directory}`);
        if (view.problem !== undefined) {
          console.log(`Unreadable: ${view.problem}`);
          return;
        }
        console.log(`Default configuration profile: ${view.defaultConfigProfile ?? "(none)"}`);
        console.log(`Allows ambient credential: ${view.allowAmbientCredential === true ? "yes" : "no"}`);
        console.log(`Credential: ${entry.identity?.credential === undefined ? "(none; uses its stored login)" : describeCredential(entry.identity.credential)}`);
      }),
    ["claude-use identity show work", "claude-use identity show work --json"],
  );

  withExamples(
    identity
      .command("set <name>")
      .description("Update an identity's settings.")
      .option("--default-profile <profile>", "Configuration profile this identity uses when nothing more specific selects one.")
      .option("--no-default-profile", "Clear this identity's default configuration profile.")
      .option("--allow-ambient-credential", "Allow this identity to launch even with an ambient credential env var set.")
      .option("--no-allow-ambient-credential", "Disallow ambient credential env vars for this identity (the default).")
      .option(
        "--credential <source>",
        `Authenticate this identity from a token instead of its stored login, replacing any existing sources (repeatable, in the order tried): ${CREDENTIAL_SOURCE_SYNTAX}.`,
        collectCredentialSource,
      )
      .option("--no-credential", "Remove this identity's credential, returning it to its stored login.")
      .addOption(
        new Option(
          "--credential-target <target>",
          "Where the token goes: oauthToken sets CLAUDE_CODE_OAUTH_TOKEN (a `claude setup-token` token), bearer sets ANTHROPIC_AUTH_TOKEN (the default), apiKey sets ANTHROPIC_API_KEY.",
        ).choices(CREDENTIAL_TARGETS),
      )
      .action(async (name: string, options: IdentitySetOptions) => {
        if (Object.values(options).every((value) => value === undefined)) {
          throw new UsageError(
            "Nothing to change: pass --default-profile, --no-default-profile, --allow-ambient-credential, --no-allow-ambient-credential, --credential, --no-credential or --credential-target.",
          );
        }
        if (!identityExists(paths, name)) {
          throw new IdentityNotFoundError(name);
        }
        if (options.defaultProfile !== undefined) {
          const profileName = options.defaultProfile === false ? undefined : options.defaultProfile;
          if (profileName !== undefined) {
            await ensureProfileExists(deps, profileName);
          }
          setDefaultConfigProfile(paths, name, profileName);
          console.log(
            profileName === undefined
              ? `Identity "${name}" no longer has a default configuration profile.`
              : `Identity "${name}" now defaults to configuration profile "${profileName}".`,
          );
        }
        if (options.allowAmbientCredential !== undefined) {
          setAllowAmbientCredential(paths, name, options.allowAmbientCredential);
          console.log(
            `Identity "${name}" ${options.allowAmbientCredential ? "now allows" : "no longer allows"} an ambient credential.`,
          );
        }
        if (options.credential === false) {
          setIdentityCredential(paths, name, false);
          console.log(`Identity "${name}" no longer has a credential and uses its stored login.`);
        } else if (options.credential !== undefined || options.credentialTarget !== undefined) {
          const updated = setIdentityCredential(paths, name, {
            ...(options.credential === undefined ? {} : { sources: options.credential }),
            ...(options.credentialTarget === undefined ? {} : { target: options.credentialTarget }),
          });
          if (updated.credential !== undefined) {
            console.log(`Identity "${name}" now authenticates with credential ${describeCredential(updated.credential)}.`);
          }
        }
      }),
    [
      "claude-use identity set work --default-profile client-acme",
      "claude-use identity set work --allow-ambient-credential",
      "claude-use identity set work --credential-target oauthToken --credential op:op://vault/claude-work/token",
      "claude-use identity set work --no-credential",
    ],
  );

  withExamples(
    identity
      .command("remove <name>")
      .description(
        "Delete an identity and its directory, including its credentials and anything it does not share with ~/.claude. Shared data in ~/.claude is kept.",
      )
      .option("--yes", "Remove without asking for confirmation (required when standard input is not a terminal).")
      .action(async (name: string, options: Readonly<{ yes?: boolean }>) => {
        if (!identityExists(paths, name)) {
          throw new IdentityNotFoundError(name);
        }
        await confirmRemoval(deps, options.yes, `identity "${name}" and its directory ${path.join(paths.identitiesDir, name)}`);
        removeIdentity(paths, name);
        console.log(`Removed identity "${name}".`);
      }),
    ["claude-use identity remove old-client --yes"],
  );

  withExamples(
    identity
      .command("use <name>")
      .description("Select the active identity, used by every launch that names none. Offers to create it on a terminal if it does not exist.")
      .action(async (name: string) => {
        await selectIdentity(deps, name);
      }),
    ["claude-use identity use work", "claude-use @work"],
  );

  withExamples(
    identity
      .command("resolve-conflicts <name>")
      .description("Interactively resolve data a superseded farm left behind when it collides with the current farm's copy.")
      .action(async (name: string) => {
        const result = await resolveFarmConflicts({
          fs: realFarmFs,
          identitiesDir: paths.identitiesDir,
          identity: name,
          classification: loadClassification(paths),
          decide: async (conflict) => {
            const choice = await deps.prompts.select<FarmConflictChoice>({
              message:
                `"${conflict.name}" exists both in the superseded farm (${conflict.previousRoot}) and the ` +
                `current one (${conflict.farmRoot}). Which should be kept?`,
              options: [
                { value: "keep-new", label: "Keep the current farm's copy", hint: "discards the superseded one" },
                { value: "keep-old", label: "Keep the superseded farm's copy", hint: "replaces the current one" },
                { value: "skip", label: "Skip for now", hint: "leaves both copies, asks again next time" },
              ],
            });
            return deps.prompts.isCancel(choice) ? "skip" : choice;
          },
        });

        if (result.autoResolved.length > 0) {
          console.log(
            `Auto-resolved ${String(result.autoResolved.length)} disposable runtime entr${result.autoResolved.length === 1 ? "y" : "ies"} ` +
              `with no prompt (${result.autoResolved.join(", ")}): per-process/per-machine state, never worth asking about.`,
          );
        }
        if (result.resolved.length === 0) {
          if (result.autoResolved.length === 0) {
            console.log(`No superseded farm data to resolve for identity "${name}".`);
          }
          return;
        }
        for (const conflict of result.resolved) {
          console.log(`  ${conflict.name}: ${conflict.choice}`);
        }
        console.log(
          `Resolved ${String(result.resolved.length)} conflict(s): ${String(result.removed.length)} superseded director(ies) fully ` +
            `cleared, ${String(result.retained.length)} still retained pending a skipped conflict.`,
        );
      }),
    ["claude-use identity resolve-conflicts work"],
  );
}

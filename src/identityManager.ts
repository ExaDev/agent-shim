import path from "node:path";
import { Option, type Command } from "commander";
import { confirmRemoval, printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { addCredentialCacheOptions, cacheChange, collectCredentialSource, CREDENTIAL_SOURCE_SYNTAX, type CredentialCacheOptions } from "./cli/credentialOption";
import { loadClassification } from "./config/classify";
import { CREDENTIAL_TARGETS, IdentitySchema, type CredentialSource, type CredentialTarget } from "./config/schema";
import { describeCredential, summariseCredential, type CredentialSummary } from "./credential";
import { runProfileWizard, type PromptsPort } from "./configure";
import { PromptCancelledError, UsageError } from "./cliError";
import { resolveFarmConflicts, type FarmConflictChoice } from "./launcher/farmResolve";
import { ensureProfileExists } from "./configProfiles";
import { poolNameOf } from "./launcher/identity";
import type { LayoutPaths } from "./paths";
import { realFarmFs } from "./realPorts";
import { IdentityNotFoundError, InvalidIdentityNameError, identityExists, readIdentity, addIdentity, useIdentity, type IdentityListing, listIdentities, setDefaultConfigProfile, setAllowAmbientCredential, setIdentityCredential, removeIdentity } from "./identityStore";

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
  if (poolNameOf(name) !== undefined || identityExists(deps.paths, name)) {
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
 * Handles the `agent-shim @<name>` shortcut for `agent-shim identity use <name>`: terser, and matches the `@name` convention `run @name`/`claude @name` already use for selecting an identity, rather than introducing a new one.
 *
 * Deliberately requires the `@` prefix and requires `@<name>` to be the *only* argument, rather than also accepting a bare `agent-shim <name>`: identity names are user-chosen and unconstrained against the registered subcommand vocabulary, so a bare positional name could collide with a real subcommand, today by an unlikely coincidence, but the tool's own vocabulary only grows over time. `@` makes the token unambiguous on sight and guarantees no future subcommand name can ever collide with it.
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
interface IdentitySetOptions extends CredentialCacheOptions {
  readonly defaultProfile?: string | false;
  readonly allowAmbientCredential?: boolean;
  readonly credential?: CredentialSource[] | false;
  readonly credentialTarget?: CredentialTarget;
}

/** Registers the `agent-shim identity` subcommand tree onto `program`. */
export function registerIdentityCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const identity = withExamples(
    program.command("identity").description("Manage identities: each one is a separate Claude Code login with its own credentials."),
    ["agent-shim identity add work", "agent-shim identity list"],
  );

  withExamples(
    identity
      .command("add <name>")
      .description("Create a new identity. Fails if one with this name already exists.")
      .action((name: string) => {
        addIdentity(paths, name);
        console.log(`Created identity "${name}".`);
      }),
    ["agent-shim identity add work"],
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
          console.log("No identities yet. Run `agent-shim identity add <name>` to create one.");
          return;
        }
        for (const entry of entries) {
          console.log(formatIdentityLine(entry));
        }
        if (entries.some((entry) => entry.problem !== undefined)) {
          console.log("\nRun `agent-shim doctor` for the full detail on every unreadable entry.");
        }
      }),
    ["agent-shim identity list", "agent-shim identity list --json"],
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
    ["agent-shim identity show work", "agent-shim identity show work --json"],
  );

  const identitySet = identity
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
      );
  addCredentialCacheOptions(identitySet);
  withExamples(
    identitySet
      .action(async (name: string, options: IdentitySetOptions) => {
        if (Object.values(options).every((value) => value === undefined)) {
          throw new UsageError(
            "Nothing to change: pass --default-profile, --no-default-profile, --allow-ambient-credential, --no-allow-ambient-credential, --credential, --no-credential, --credential-target or a --credential-cache option.",
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
        } else if (options.credential !== undefined || options.credentialTarget !== undefined || cacheChange(options, undefined) !== undefined) {
          const cache = cacheChange(options, readIdentity(paths, name)?.credential?.cache);
          const updated = setIdentityCredential(paths, name, {
            ...(options.credential === undefined ? {} : { sources: options.credential }),
            ...(options.credentialTarget === undefined ? {} : { target: options.credentialTarget }),
            ...(cache === undefined ? {} : { cache }),
          });
          if (updated.credential !== undefined) {
            console.log(`Identity "${name}" now authenticates with credential ${describeCredential(updated.credential)}.`);
          }
        }
      }),
    [
      "agent-shim identity set work --default-profile client-acme",
      "agent-shim identity set work --allow-ambient-credential",
      "agent-shim identity set work --credential-target oauthToken --credential op:op://vault/claude-work/token",
      "agent-shim identity set work --no-credential",
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
    ["agent-shim identity remove old-client --yes"],
  );

  withExamples(
    identity
      .command("use <name>")
      .description("Select the active identity, used by every launch that names none. Offers to create it on a terminal if it does not exist.")
      .action(async (name: string) => {
        await selectIdentity(deps, name);
      }),
    ["agent-shim identity use work", "agent-shim @work"],
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
    ["agent-shim identity resolve-conflicts work"],
  );
}

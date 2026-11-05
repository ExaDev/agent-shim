import path from "node:path";
import { identityCacheKey } from "./credential";
import { Option, type Command } from "commander";
import { confirmRemoval, printJson, reportMutation, withExamples, type CommandDeps } from "./cli/commandDeps";
import { addCredentialCacheOptions, cacheChange, collectCredentialSource, CREDENTIAL_SOURCE_SYNTAX, type CredentialCacheOptions } from "./cli/credentialOption";
import { collectAnchor } from "./cli/parsers";
import { loadClassification } from "./config/classify";
import { CREDENTIAL_TARGETS, IdentitySchema, type Anchor, type CredentialSource, type CredentialTarget } from "./config/schema";
import { describeCredential, summariseCredential, type CredentialSummary } from "./credential";
import { runProfileWizard, type PromptsPort } from "./configure";
import { PromptCancelledError, UsageError } from "./cliError";
import { resolveFarmConflicts, type FarmConflictChoice } from "./launcher/farmResolve";
import { ensureProfileExists } from "./configProfiles";
import { IDENTITY_LABEL_RULE, IdentityLabelSchema } from "./config/names";
import { requireProviderExists } from "./providersStore";
import { poolNameOf } from "./launcher/identity";
import type { LayoutPaths } from "./paths";
import { realFarmFs } from "./realPorts";
import { describeIdentityMove, describeIdentityRename, discardRenameJournal, moveIdentity, renameIdentity, type IdentityRenamePorts } from "./identityRename";
import { realIdentityRenamePorts } from "./realIdentityRename";
import { KEEP_KEYCHAIN_LOGIN_DESCRIPTION, KeychainCacheDeleteError, type KeychainProbe } from "./keychainLogin";
import { InvalidIdentityNameError, REMOVED_STATE, identityExists, readIdentity, addIdentity, addNewIdentity, requireIdentityAddable, useIdentity, type IdentityListing, listIdentities, setDefaultConfigProfile, setIdentityLabel, setIdentityProvider, setAllowAmbientCredential, setIdentityCredential, setIdentityAnchors, removeIdentityWithLockHeld, requireNoUnfinishedRenameNaming, identityDirectory, requireIdentityId, identityNotFound } from "./identityStore";
import { realIdentityNamesLockPorts, withIdentityNamesLock } from "./identityNamesLock";
import { describeAccountHolder, describeIdentityAccount, groupByLogin, loginKeyOf, readIdentityAccount, summariseIdentityAccount, type IdentityAccountRead, type IdentityAccountSummary } from "./identityAccounts";
import { describeAccountPlan } from "./usage/accountDescription";
import { ANCHOR_SYNTAX, formatAnchor } from "./usage/anchor";

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
  keychain: KeychainProbe,
  options: Readonly<{ activate?: boolean }> = {},
): Promise<boolean> {
  if (!IdentitySchema.safeParse({ name, allowAmbientCredential: false }).success) {
    throw new InvalidIdentityNameError(name);
  }
  // Refused here, before the question, so that nobody is asked to create what would then be refused; the refusal names the flag of `identity add` that keeps a login on purpose, since this offer has none.
  const checkedId = requireIdentityAddable(paths, name, keychain, false);
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

  addIdentity(paths, name, { checkedId });

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
async function selectIdentity(deps: CommandDeps, name: string, keychain: KeychainProbe, json?: boolean): Promise<void> {
  if (poolNameOf(name) !== undefined || identityExists(deps.paths, name)) {
    useIdentity(deps.paths, name);
  } else if (deps.isInteractive()) {
    if (!(await runIdentityWizard(deps.prompts, deps.paths, name, keychain))) {
      throw new PromptCancelledError();
    }
  } else {
    throw identityNotFound(deps.paths, name);
  }
  reportMutation(json, { action: "selected", kind: "identity", name }, () => {
    console.log(`Active identity is now "${name}".`);
  });
}

/**
 * Handles the `agent-shim @<name>` shortcut for `agent-shim identity use <name>`: terser, and matches the `@name` convention `run @name`/`claude @name` already use for selecting an identity, rather than introducing a new one.
 *
 * Deliberately requires the `@` prefix and requires `@<name>` to be the *only* argument, rather than also accepting a bare `agent-shim <name>`: identity names are user-chosen and unconstrained against the registered subcommand vocabulary, so a bare positional name could collide with a real subcommand, today by an unlikely coincidence, but the tool's own vocabulary only grows over time. `@` makes the token unambiguous on sight and guarantees no future subcommand name can ever collide with it.
 *
 * Returns `false` when `argv` doesn't match this exact one-argument `@name` shape at all, so the caller falls through to normal Commander subcommand dispatch (including its own "unknown command" error for anything else). Returns `true` once handled; the selection itself is `selectIdentity`, so a missing identity behaves exactly as it does under `identity use`.
 */
export async function tryRunAtIdentityShortcut(deps: CommandDeps, argv: readonly string[], keychain: KeychainProbe): Promise<boolean> {
  if (argv.length !== 1) {
    return false;
  }
  const [token] = argv;
  if (token === undefined || !token.startsWith("@") || token.length === 1) {
    return false;
  }
  await selectIdentity(deps, token.slice(1), keychain);
  return true;
}

/** One identity as `identity show --json` and `identity list --json` print it. */
interface IdentityView {
  readonly name: string;
  readonly active: boolean;
  /** The identity's storage id: the name of its directory under the identities directory, chosen when it was created and kept by a rename, so it names the identity in everything filed on disk or held by a running session (`CLAUDE_CONFIG_DIR`, the usage snapshot and the usage log). */
  readonly id: string;
  /** The identity's directory, `<identities>/<id>`. */
  readonly directory: string;
  /** What the identity is for, in the person's words; display only. Absent when it has none. */
  readonly label?: string;
  readonly defaultConfigProfile?: string;
  /** The provider the identity exists for; absent when it has none. */
  readonly provider?: string;
  readonly allowAmbientCredential?: boolean;
  /** How the identity authenticates when it has a credential block: its target and each source's kind, never a value. Absent when it uses its stored login. */
  readonly credential?: CredentialSummary;
  /** When the front door should have a five-hour window open for the identity; absent when it opens none on a schedule. */
  readonly anchors?: readonly Anchor[];
  /** The email, organisation, role and plan of the identity's stored login; absent when it has none (a token or provider identity, or one never signed in). */
  readonly account?: IdentityAccountSummary;
  /** Why the stored login's profile could not be read, in place of `account`. */
  readonly accountProblem?: string;
  /** The other identities holding the same login (same account and organisation); absent when none does. */
  readonly sharesLoginWith?: readonly string[];
  /** Why `identity.json` cannot be read, in place of what it holds; with `displaced`, where it is instead and what puts it back. */
  readonly problem?: string;
  /** Set when the identity's `identity.json` is displaced (left only in a superseded farm by an interrupted resync) rather than unreadable. */
  readonly displaced?: true;
}

/** One identity's listing entry with the stored login read for it. */
interface IdentityWithAccount {
  readonly entry: IdentityListing;
  readonly read: IdentityAccountRead;
}

function toIdentityView(paths: LayoutPaths, { entry, read }: IdentityWithAccount, sharesLoginWith: readonly string[]): IdentityView {
  const account = read?.account === undefined ? undefined : summariseIdentityAccount(read.account);
  return {
    name: entry.name,
    active: entry.isActive,
    id: entry.id,
    directory: path.join(paths.identitiesDir, entry.id),
    ...(entry.problem === undefined
      ? {
          ...(entry.identity.label === undefined ? {} : { label: entry.identity.label }),
          ...(entry.identity.defaultConfigProfile === undefined ? {} : { defaultConfigProfile: entry.identity.defaultConfigProfile }),
          ...(entry.identity.provider === undefined ? {} : { provider: entry.identity.provider }),
          allowAmbientCredential: entry.identity.allowAmbientCredential,
          ...(entry.identity.credential === undefined ? {} : { credential: summariseCredential(entry.identity.credential) }),
          ...(entry.identity.anchors === undefined ? {} : { anchors: entry.identity.anchors }),
        }
      : { problem: entry.problem, ...(entry.displaced === undefined ? {} : { displaced: entry.displaced }) }),
    ...(account === undefined ? {} : { account }),
    ...(read?.problem === undefined ? {} : { accountProblem: read.problem }),
    ...(sharesLoginWith.length === 0 ? {} : { sharesLoginWith }),
  };
}

/** One identity's listing entry with the view of it that `--json` prints. */
interface IdentityRow {
  readonly entry: IdentityListing;
  readonly view: IdentityView;
}

/**
 * Gathers every identity's row, reading each one's stored login and ordering the list so identities sharing a login (the same account in the same organisation) sit together. Data only: `identity list` and `identity show` render what this returns.
 */
function collectIdentityRows(paths: LayoutPaths, entries: readonly IdentityListing[]): readonly IdentityRow[] {
  const items: readonly IdentityWithAccount[] = entries.map((entry) => ({ entry, read: readIdentityAccount(realFarmFs, paths.identitiesDir, entry.id) }));
  const loginOf = (item: IdentityWithAccount): string | undefined => (item.read?.account === undefined ? undefined : loginKeyOf(item.read.account));
  return groupByLogin(items, loginOf).map((item) => {
    const login = loginOf(item);
    const sharing = login === undefined ? [] : items.filter((other) => other !== item && loginOf(other) === login).map((other) => other.entry.name);
    return { entry: item.entry, view: toIdentityView(paths, item, sharing) };
  });
}

/** Renders one identity as the single line `identity list` prints for it, its account details last. `shared` says another listed identity claims the same name. The id follows the name whenever it differs from it or the name is shared, so two identities claiming one name can be told apart and renamed by id (`identity rename <id> <new> --id`). */
function formatIdentityLine(entry: IdentityListing, view: IdentityView, shared: boolean): string {
  const marker = entry.isActive ? "* " : "  ";
  const named = entry.id === entry.name && !shared ? entry.name : `${entry.name} (id: ${entry.id})`;
  const account = view.account === undefined ? "" : `  ${describeIdentityAccount(view.account)}`;
  const accountProblem = view.accountProblem === undefined ? "" : `  [account unreadable: ${view.accountProblem}]`;
  if (entry.problem !== undefined) {
    return `${marker}${named} [${entry.displaced === undefined ? "unreadable" : "displaced"}: ${entry.problem}]${account}${accountProblem}`;
  }
  const label = entry.identity.label === undefined ? "" : ` (label: ${entry.identity.label})`;
  const defaultProfile =
    entry.identity.defaultConfigProfile === undefined ? "" : ` (default profile: ${entry.identity.defaultConfigProfile})`;
  const provider = entry.identity.provider === undefined ? "" : ` (provider: ${entry.identity.provider})`;
  const ambient = entry.identity.allowAmbientCredential ? " [allows ambient credential]" : "";
  const credential = entry.identity.credential === undefined ? "" : ` [credential ${describeCredential(entry.identity.credential)}]`;
  return `${marker}${named}${label}${defaultProfile}${provider}${ambient}${credential}${account}${accountProblem}`;
}

/** Options `identity set` accepts. `label` is `false` for `--no-label`, `defaultProfile` is `false` for `--no-default-profile`, `provider` is `false` for `--no-provider`, `credential` is `false` for `--no-credential` and `anchor` is `false` for `--no-anchor`. */
interface IdentitySetOptions extends CredentialCacheOptions {
  readonly label?: string | false;
  readonly defaultProfile?: string | false;
  readonly provider?: string | false;
  readonly allowAmbientCredential?: boolean;
  readonly credential?: CredentialSource[] | false;
  readonly credentialTarget?: CredentialTarget;
  readonly anchor?: Anchor[] | false;
  readonly json?: boolean;
}

/** What `identity rename --help` says it does, as the README and the configuration model describe it: the name and its references change and the directory stays, so running sessions are unaffected; `--move` is the physical rename. */
const RENAME_DESCRIPTION =
  "Rename an identity: change its name and rewrite every reference to it. Its directory, login and usage stay where they are, so it goes ahead while sessions run on it. A rename that was interrupted is finished by running the same command again.";

/** What `--move` does, as `moveIdentity` does it. */
const MOVE_DESCRIPTION =
  "Also move the identity's directory to the new name and carry its login across. Only for an identity whose directory has its name; refused while a session is running on it or a launch is starting on it. One that was interrupted is finished by running the same command again.";

/** What `--discard-journal` does and exactly when it accepts and refuses, as `discardRenameJournal` checks it: it removes a record and nothing else. */
const DISCARD_JOURNAL_DESCRIPTION =
  "Remove the record of an unfinished rename of <old> to <new>. Accepted when the identity exists under neither name or under both, or under <old> alone and the record shows no step as begun or done; refused when the identity exists under only one name and the record shows a step as begun or done or the identity is under <new>, where running the rename again finishes it. It changes no identity.";

/**
 * Registers the `agent-shim identity` subcommand tree onto `program`. `renamePorts` is what `identity rename` reaches the machine through (the Keychain, the process table, the resync lock): the real ones unless a test passes fakes.
 */
export function registerIdentityCommand(program: Command, deps: CommandDeps, renamePorts: IdentityRenamePorts = realIdentityRenamePorts(deps.paths)): void {
  const { paths } = deps;
  const identity = withExamples(
    program.command("identity").description("Manage identities: each one is a separate Claude Code login with its own credentials."),
    ["agent-shim identity add work", "agent-shim identity list"],
  );

  withExamples(
    identity
      .command("add <name>")
      .description("Create a new identity. Fails if one with this name already exists.")
      .option("--keep-keychain-login", KEEP_KEYCHAIN_LOGIN_DESCRIPTION)
      .option("--json", "Print the result as JSON.")
      .action((name: string, options: Readonly<{ keepKeychainLogin?: boolean; json?: boolean }>) => {
        const created = addNewIdentity(paths, name, renamePorts, options.keepKeychainLogin === true);
        reportMutation(options.json, { action: "created", kind: "identity", name, value: created }, () => {
          console.log(`Created identity "${name}".`);
        });
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
        const rows = collectIdentityRows(paths, entries);
        if (options.json === true) {
          printJson(rows.map((row) => row.view));
          return;
        }
        if (rows.length === 0) {
          console.log("No identities yet. Run `agent-shim identity add <name>` to create one.");
          return;
        }
        for (const row of rows) {
          console.log(formatIdentityLine(row.entry, row.view, entries.some((other) => other.id !== row.entry.id && other.name === row.entry.name)));
        }
        const kinds = [
          ...(entries.some((entry) => entry.problem !== undefined && entry.displaced === undefined) ? ["unreadable"] : []),
          ...(entries.some((entry) => entry.displaced !== undefined) ? ["displaced"] : []),
        ];
        if (kinds.length > 0) {
          console.log(`\nRun \`agent-shim doctor\` for the full detail on every ${kinds.join(" or ")} entry.`);
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
        const id = requireIdentityId(paths, name);
        const row = collectIdentityRows(paths, listIdentities(paths)).find((candidate) => candidate.entry.id === id);
        if (row === undefined) {
          throw identityNotFound(paths, name);
        }
        const { entry, view } = row;
        if (options.json === true) {
          printJson(view);
          return;
        }
        console.log(`Identity: ${view.name}${view.active ? " (active)" : ""}`);
        console.log(`Directory: ${view.directory}`);
        const holder = view.account === undefined ? undefined : describeAccountHolder(view.account);
        if (holder !== undefined) {
          console.log(`Account: ${holder}`);
        }
        if (view.account?.organizationRole !== undefined) {
          console.log(`Role: ${view.account.organizationRole}`);
        }
        const plan = view.account === undefined ? undefined : describeAccountPlan(view.account);
        if (plan !== undefined) {
          console.log(`Plan: ${plan}`);
        }
        if (view.accountProblem !== undefined) {
          console.log(`Account unreadable: ${view.accountProblem}`);
        }
        if (view.sharesLoginWith !== undefined) {
          console.log(`Shares login with: ${view.sharesLoginWith.join(", ")}`);
        }
        if (view.problem !== undefined) {
          console.log(`${view.displaced === undefined ? "Unreadable" : "Displaced"}: ${view.problem}`);
          return;
        }
        console.log(`Label: ${view.label ?? "(none)"}`);
        console.log(`Default configuration profile: ${view.defaultConfigProfile ?? "(none)"}`);
        console.log(`Provider: ${view.provider ?? "(none)"}`);
        console.log(`Allows ambient credential: ${view.allowAmbientCredential === true ? "yes" : "no"}`);
        console.log(`Credential: ${entry.identity?.credential === undefined ? "(none; uses its stored login)" : describeCredential(entry.identity.credential)}`);
        console.log(`Anchors: ${view.anchors === undefined ? "(none)" : view.anchors.map(formatAnchor).join(" ")}`);
      }),
    ["agent-shim identity show work", "agent-shim identity show work --json"],
  );

  const identitySet = identity
      .command("set <name>")
      .description("Update an identity's settings.")
      .option("--json", "Print the result as JSON.")
      .option("--label <text>", "Free text shown beside this identity's name in `identity list` and `show`, the launch banner and the statusline. Display only: the name stays the key.")
      .option("--no-label", "Clear this identity's label.")
      .option("--default-profile <profile>", "Configuration profile this identity uses when nothing more specific selects one.")
      .option("--no-default-profile", "Clear this identity's default configuration profile.")
      .option("--provider <provider>", "Provider this identity exists for: a launch on it routes through the provider unless a flag, directory rule or profile selects another, and doctor expects no stored login.")
      .option("--no-provider", "Clear this identity's provider.")
      .option("--allow-ambient-credential", "Allow this identity to launch even with an ambient credential env var set.")
      .option("--no-allow-ambient-credential", "Disallow ambient credential env vars for this identity (the default).")
      .option(
        "--credential <source>",
        `Authenticate this identity from a token instead of its stored login, replacing any existing sources (repeatable, in the order tried): ${CREDENTIAL_SOURCE_SYNTAX}.`,
        collectCredentialSource,
      )
      .option("--no-credential", "Remove this identity's credential, returning it to its stored login.")
      .option(
        "--anchor <spec>",
        `Have the front door open a five-hour window for this identity at these times when none is open, so its window resets when you want (repeatable, replacing any existing anchors): ${ANCHOR_SYNTAX}.`,
        collectAnchor,
      )
      .option("--no-anchor", "Remove this identity's anchors.")
      .addOption(
        new Option(
          "--credential-target <target>",
          "Where the token goes: oauthToken sets CLAUDE_CODE_OAUTH_TOKEN (a `claude setup-token` token), bearer sets ANTHROPIC_AUTH_TOKEN (the default), apiKey sets ANTHROPIC_API_KEY.",
        ).choices(CREDENTIAL_TARGETS),
      );
  addCredentialCacheOptions(identitySet);
  withExamples(
    identitySet
      .action(async (name: string, allOptions: IdentitySetOptions) => {
        const { json, ...options } = allOptions;
        if (Object.entries(allOptions).every(([key, value]) => key === "json" || value === undefined)) {
          throw new UsageError(
            "Nothing to change: pass --label, --no-label, --default-profile, --no-default-profile, --provider, --no-provider, --allow-ambient-credential, --no-allow-ambient-credential, --credential, --no-credential, --credential-target, --anchor, --no-anchor or a --credential-cache option.",
          );
        }
        if (!identityExists(paths, name)) {
          throw identityNotFound(paths, name);
        }
        const label = typeof options.label === "string" ? IdentityLabelSchema.safeParse(options.label) : undefined;
        if (label?.success === false) {
          throw new UsageError(`Identity label ${JSON.stringify(options.label)} ${IDENTITY_LABEL_RULE}.`);
        }
        if (typeof options.provider === "string") {
          requireProviderExists(paths, options.provider);
        }
        const messages: string[] = [];
        if (options.label !== undefined) {
          const labelText = options.label === false ? undefined : options.label;
          setIdentityLabel(paths, name, labelText);
          messages.push(labelText === undefined ? `Identity "${name}" no longer has a label.` : `Identity "${name}" is now labelled ${JSON.stringify(labelText)}.`);
        }
        if (options.defaultProfile !== undefined) {
          const profileName = options.defaultProfile === false ? undefined : options.defaultProfile;
          if (profileName !== undefined) {
            await ensureProfileExists(deps, profileName);
          }
          setDefaultConfigProfile(paths, name, profileName);
          messages.push(
            profileName === undefined
              ? `Identity "${name}" no longer has a default configuration profile.`
              : `Identity "${name}" now defaults to configuration profile "${profileName}".`,
          );
        }
        if (options.provider !== undefined) {
          const providerName = options.provider === false ? undefined : options.provider;
          setIdentityProvider(paths, name, providerName);
          messages.push(providerName === undefined ? `Identity "${name}" no longer has a provider.` : `Identity "${name}" now runs on provider "${providerName}" unless something more specific selects one.`);
        }
        if (options.allowAmbientCredential !== undefined) {
          setAllowAmbientCredential(paths, name, options.allowAmbientCredential);
          messages.push(`Identity "${name}" ${options.allowAmbientCredential ? "now allows" : "no longer allows"} an ambient credential.`);
        }
        if (options.credential === false) {
          setIdentityCredential(paths, name, false);
          messages.push(`Identity "${name}" no longer has a credential and uses its stored login.`);
        } else if (options.credential !== undefined || options.credentialTarget !== undefined || cacheChange(options, undefined) !== undefined) {
          const cache = cacheChange(options, readIdentity(paths, name)?.credential?.cache);
          const updated = setIdentityCredential(paths, name, {
            ...(options.credential === undefined ? {} : { sources: options.credential }),
            ...(options.credentialTarget === undefined ? {} : { target: options.credentialTarget }),
            ...(cache === undefined ? {} : { cache }),
          });
          if (updated.credential !== undefined) {
            messages.push(`Identity "${name}" now authenticates with credential ${describeCredential(updated.credential)}.`);
          }
        }
        if (options.anchor !== undefined) {
          const updated = setIdentityAnchors(paths, name, options.anchor === false ? undefined : options.anchor);
          messages.push(updated.anchors === undefined ? `Identity "${name}" no longer has anchors.` : `Identity "${name}" now has anchors ${updated.anchors.map(formatAnchor).join(" ")}.`);
        }
        reportMutation(json, { action: "updated", kind: "identity", name, value: readIdentity(paths, name) }, () => {
          for (const message of messages) {
            console.log(message);
          }
        });
      }),
    [
      "agent-shim identity set work --label \"Example Org\"",
      "agent-shim identity set work --default-profile client-acme",
      "agent-shim identity set minimax --provider minimax",
      "agent-shim identity set work --allow-ambient-credential",
      "agent-shim identity set work --credential-target oauthToken --credential op:op://vault/claude-work/token",
      "agent-shim identity set work --no-credential",
      "agent-shim identity set work --anchor mon-fri@06:00",
      "agent-shim identity set work --no-anchor",
    ],
  );

  withExamples(
    identity
      .command("remove <name>")
      .description(
        `Delete an identity and its directory, including its credentials and anything it does not share with ~/.claude, and ${REMOVED_STATE}. Shared data in ~/.claude is kept.`,
      )
      .option("--yes", "Remove without asking for confirmation (required when standard input is not a terminal).")
      .option("--json", "Print the result as JSON.")
      .action(async (name: string, options: Readonly<{ yes?: boolean; json?: boolean }>) => {
        requireNoUnfinishedRenameNaming(paths, name, "remove");
        const id = requireIdentityId(paths, name);
        await confirmRemoval(deps, options.yes, `identity "${name}", its directory ${identityDirectory(paths, id)}, and ${REMOVED_STATE}`);
        withIdentityNamesLock(paths, realIdentityNamesLockPorts, () => {
        const removed = removeIdentityWithLockHeld(paths, name, realIdentityNamesLockPorts);
        // The Keychain store holds a cached credential the store function cannot reach; forgetting it keeps a later identity given the same id from reading it.
        if (renamePorts.credentialCache.platform === "darwin") {
          // The identity is removed by now, so a delete that fails says so beside the command that deletes the entry left behind.
          try {
            renamePorts.credentialCache.port.remove("keychain", identityCacheKey(removed));
          } catch (error: unknown) {
            if (error instanceof KeychainCacheDeleteError) {
              throw error.afterRemoving(name);
            }
            throw error;
          }
        }
        });
        reportMutation(options.json, { action: "removed", kind: "identity", name }, () => {
          console.log(`Removed identity "${name}".`);
        });
      }),
    ["agent-shim identity remove old-client --yes"],
  );

  withExamples(
    identity
      .command("rename <old> <new>")
      .description(RENAME_DESCRIPTION)
      .allowUnknownOption(true)
      .option("--move", MOVE_DESCRIPTION)
      .option("--id", "Take <old> as the identity's id (its directory under identities/) rather than its name: how one of two identities that claim one name is renamed. References to a name two identities claim are left as they are. Not with --move.")
      .option("--dry-run", "Print what would be rewritten (and, with --move, moved), and change nothing.")
      .option("--discard-journal", `Only with --move. ${DISCARD_JOURNAL_DESCRIPTION}`)
      .option("--json", "Print the result as JSON.")
      .action(async (from: string, to: string, options: Readonly<{ move?: boolean; id?: boolean; dryRun?: boolean; discardJournal?: boolean; json?: boolean }>) => {
        const dryRun = options.dryRun === true;
        const move = options.move === true;
        const byId = options.id === true;
        if (!byId && from.startsWith("-")) {
          throw new UsageError(`unknown option '${from}'`);
        }
        if (byId && move) {
          throw new UsageError("--id renames the name alone, and --move moves an identity whose directory has its name; give one or the other.");
        }
        if (options.discardJournal === true) {
          if (!move) {
            throw new UsageError("--discard-journal removes the record of an unfinished rename with --move, and is given with --move.");
          }
          if (dryRun) {
            throw new UsageError("--discard-journal removes a record and has no dry run; it changes no identity.");
          }
          const discarded = discardRenameJournal(paths, from, to, renamePorts);
          reportMutation(options.json, { action: "removed", kind: "rename-journal", name: to, value: discarded }, () => {
            console.log(`Discarded the record of the unfinished rename of "${from}" to "${to}".`);
          });
          return;
        }
        const report = move ? (dryRun ? describeIdentityMove(paths, from, to, renamePorts) : await moveIdentity(paths, from, to, renamePorts)) : dryRun ? describeIdentityRename(paths, from, to, renamePorts, { byId }) : await renameIdentity(paths, from, to, renamePorts, { byId });
        reportMutation(options.json, { action: dryRun ? "planned" : "renamed", kind: "identity", name: to, value: report }, () => {
          console.log(dryRun ? `Would rename identity "${report.from}" to "${to}":` : `Renamed identity "${report.from}" to "${to}".`);
          for (const step of report.steps) {
            console.log(`  ${step}`);
          }
          for (const warning of report.warnings) {
            console.warn(`warning: ${warning}`);
          }
          console.log(
          dryRun
            ? "Nothing was changed."
            : move
              ? `A committed .agent-shim.json that names "${report.from}" is yours to update, and the usage log keeps its past records under the identity's former id, "${report.from}".`
              : report.shared
                ? `Another identity also has the name "${report.from}", so the references to it, here and in any committed .agent-shim.json, stay with that identity.`
                : `A committed .agent-shim.json that names "${report.from}" is yours to update.`,
        );
        });
      }),
    ["agent-shim identity rename work client", "agent-shim identity rename work client --dry-run", "agent-shim identity rename work client --move"],
  );

  withExamples(
    identity
      .command("use <name>")
      .description("Select the active identity, used by every launch that names none. Offers to create it on a terminal if it does not exist.")
      .option("--json", "Print the result as JSON.")
      .action(async (name: string, options: Readonly<{ json?: boolean }>) => {
        await selectIdentity(deps, name, renamePorts, options.json);
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
          // The farm and its superseded copies are filed under the identity's id.
          identity: requireIdentityId(paths, name),
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

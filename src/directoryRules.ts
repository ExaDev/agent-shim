import type { Command } from "commander";

import { confirmRemoval, printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { readJson, writeJsonAtomic } from "./config/store";
import { ConfigValidationError } from "./config/load";
import { DirectoryRulesSchema, type DirectoryRule, type DirectoryRules } from "./config/schema";
import { CliError, UsageError } from "./cliError";
import { ensureProfileExists } from "./configProfiles";
import { IdentityNotFoundError, readIdentity } from "./identityManager";
import type { LayoutPaths } from "./paths";

/** Raised by `removeDirectoryRule`, `updateDirectoryRule` and `rule show` when no rule matches the given path exactly. */
export class DirectoryRuleNotFoundError extends CliError {
  constructor(readonly rulePath: string) {
    super(`No directory rule found for path "${rulePath}".`);
    this.name = "DirectoryRuleNotFoundError";
  }
}

/** Raised by `addDirectoryRule` when neither `--config-profile` nor `--identity` is given, and by `updateDirectoryRule` when an update would leave a rule that sets nothing at all: a rule that pins and overrides nothing would do nothing. */
export class DirectoryRuleMissingTargetError extends CliError {
  constructor() {
    super("A directory rule must set at least one of --config-profile or --identity.");
    this.name = "DirectoryRuleMissingTargetError";
  }
}

/** Raised by `addDirectoryRule` when a rule for the exact path already exists: `rule add` creates, `rule set` updates. */
export class DirectoryRuleAlreadyExistsError extends CliError {
  constructor(readonly rulePath: string) {
    super(`A directory rule for path "${rulePath}" already exists. Use \`agent-shim rule set\` to change it.`);
    this.name = "DirectoryRuleAlreadyExistsError";
  }
}

/** Reads `~/.agent-shim/directory-rules.json`, or an empty rule set when the file does not exist yet. */
export function readDirectoryRules(paths: LayoutPaths): DirectoryRules {
  return readJson(paths.directoryRulesFile, DirectoryRulesSchema) ?? { rules: [] };
}

/** Validates and writes the whole `~/.agent-shim/directory-rules.json` file. Exported so `src/configure.ts` can update a single rule's `categories`/`entries` in place without duplicating this validate-then-write step. Throws `ConfigValidationError` when `rules` fails `DirectoryRulesSchema`, rather than letting the underlying `ZodError` escape as an unhandled crash. */
export function writeDirectoryRules(paths: LayoutPaths, rules: DirectoryRules): void {
  const parsed = DirectoryRulesSchema.safeParse(rules);
  if (!parsed.success) {
    throw new ConfigValidationError(paths.directoryRulesFile, parsed.error.issues);
  }
  writeJsonAtomic(paths.directoryRulesFile, parsed.data);
}

/** Lists every directory rule, in file order. */
export function listDirectoryRules(paths: LayoutPaths): readonly DirectoryRule[] {
  return readDirectoryRules(paths).rules;
}

/** Inputs to `addDirectoryRule` beyond the path itself. */
export interface AddDirectoryRuleOptions {
  readonly configProfile?: string;
  readonly identity?: string;
}

/**
 * Adds a new directory rule for `rulePath`. Throws `DirectoryRuleAlreadyExistsError` when a rule for that exact path already exists (`updateDirectoryRule` changes one), and `DirectoryRuleMissingTargetError` when neither `configProfile` nor `identity` is given, since a rule that pins neither would do nothing.
 */
export function addDirectoryRule(paths: LayoutPaths, rulePath: string, options: AddDirectoryRuleOptions): DirectoryRule {
  if (options.configProfile === undefined && options.identity === undefined) {
    throw new DirectoryRuleMissingTargetError();
  }
  const current = readDirectoryRules(paths);
  if (current.rules.some((rule) => rule.path === rulePath)) {
    throw new DirectoryRuleAlreadyExistsError(rulePath);
  }
  const created = buildNewRule(rulePath, options);
  writeDirectoryRules(paths, { ...current, rules: [...current.rules, created] });
  return created;
}

/** The fields `updateDirectoryRule` changes. A value of `false` removes that field from the rule. */
export interface UpdateDirectoryRuleOptions {
  readonly configProfile?: string | false;
  readonly identity?: string | false;
}

/** Whether `rule` still does anything: pins a profile or identity, or carries its own categories, entries or launch settings (which `agent-shim configure` writes). */
function ruleHasEffect(rule: DirectoryRule): boolean {
  return (
    rule.configProfile !== undefined ||
    rule.identity !== undefined ||
    rule.categories !== undefined ||
    rule.entries !== undefined ||
    rule.launch !== undefined
  );
}

/**
 * Updates the existing directory rule for `rulePath` in place, keeping its position in the file and every field not named. Throws `DirectoryRuleNotFoundError` when no rule matches that exact path, and `DirectoryRuleMissingTargetError` when the update would leave a rule that does nothing (remove it with `removeDirectoryRule` instead).
 */
export function updateDirectoryRule(paths: LayoutPaths, rulePath: string, options: UpdateDirectoryRuleOptions): DirectoryRule {
  const current = readDirectoryRules(paths);
  const index = current.rules.findIndex((rule) => rule.path === rulePath);
  const existing = index === -1 ? undefined : current.rules[index];
  if (existing === undefined) {
    throw new DirectoryRuleNotFoundError(rulePath);
  }
  const { configProfile, identity, ...rest } = existing;
  const nextConfigProfile = options.configProfile === undefined ? configProfile : options.configProfile === false ? undefined : options.configProfile;
  const nextIdentity = options.identity === undefined ? identity : options.identity === false ? undefined : options.identity;
  const updated: DirectoryRule = {
    ...rest,
    ...(nextConfigProfile === undefined ? {} : { configProfile: nextConfigProfile }),
    ...(nextIdentity === undefined ? {} : { identity: nextIdentity }),
  };
  if (!ruleHasEffect(updated)) {
    throw new DirectoryRuleMissingTargetError();
  }
  const nextRules = [...current.rules];
  nextRules[index] = updated;
  writeDirectoryRules(paths, { ...current, rules: nextRules });
  return updated;
}

function buildNewRule(rulePath: string, options: AddDirectoryRuleOptions): DirectoryRule {
  return {
    path: rulePath,
    ...(options.configProfile !== undefined ? { configProfile: options.configProfile } : {}),
    ...(options.identity !== undefined ? { identity: options.identity } : {}),
  };
}

/** Removes the directory rule for `rulePath`. Throws `DirectoryRuleNotFoundError` when no rule matches that exact path. */
export function removeDirectoryRule(paths: LayoutPaths, rulePath: string): void {
  const current = readDirectoryRules(paths);
  const nextRules = current.rules.filter((rule) => rule.path !== rulePath);
  if (nextRules.length === current.rules.length) {
    throw new DirectoryRuleNotFoundError(rulePath);
  }
  writeDirectoryRules(paths, { ...current, rules: nextRules });
}

/** Renders a rule's own settings as `key=value` parts, for `rule list` and `rule show`. */
function describeRule(rule: DirectoryRule): string {
  const parts = Object.entries(rule)
    .filter(([key]) => key !== "path")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  return parts.length === 0 ? "(nothing)" : parts.join(", ");
}

/** Checks the targets a `rule add`/`rule set` names before the rule is written: a missing profile is offered for creation on a terminal (`ensureProfileExists`), and a missing identity is refused, since pinning a path to an identity that does not exist would fail every launch there. */
async function checkRuleTargets(deps: CommandDeps, options: Readonly<{ configProfile?: string | false; identity?: string | false }>): Promise<void> {
  if (typeof options.identity === "string" && readIdentity(deps.paths, options.identity) === undefined) {
    throw new IdentityNotFoundError(options.identity);
  }
  if (typeof options.configProfile === "string") {
    await ensureProfileExists(deps, options.configProfile);
  }
}

/** Registers the `agent-shim rule` subcommand tree onto `program`. */
export function registerRuleCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const rule = withExamples(
    program
      .command("rule")
      .description("Manage directory rules: pin an identity or configuration profile to every launch under a path."),
    ["agent-shim rule add ~/work/acme --config-profile client-acme", "agent-shim rule list"],
  );

  withExamples(
    rule
      .command("add <path>")
      .description("Add a directory rule for a path. Fails if a rule for that exact path already exists.")
      .option("--config-profile <profile>", "Configuration profile to select under this path.")
      .option("--identity <identity>", "Identity to pin under this path.")
      .action(async (rulePath: string, options: Readonly<{ configProfile?: string; identity?: string }>) => {
        await checkRuleTargets(deps, options);
        addDirectoryRule(paths, rulePath, options);
        console.log(`Added directory rule for "${rulePath}".`);
      }),
    ["agent-shim rule add ~/work/acme --config-profile client-acme", "agent-shim rule add ~/personal --identity personal"],
  );

  withExamples(
    rule
      .command("set <path>")
      .description("Update the directory rule for a path.")
      .option("--config-profile <profile>", "Configuration profile to select under this path.")
      .option("--no-config-profile", "Stop selecting a configuration profile under this path.")
      .option("--identity <identity>", "Identity to pin under this path.")
      .option("--no-identity", "Stop pinning an identity under this path.")
      .action(async (rulePath: string, options: Readonly<{ configProfile?: string | false; identity?: string | false }>) => {
        if (options.configProfile === undefined && options.identity === undefined) {
          throw new UsageError("Nothing to change: pass --config-profile, --no-config-profile, --identity or --no-identity.");
        }
        await checkRuleTargets(deps, options);
        updateDirectoryRule(paths, rulePath, options);
        console.log(`Updated directory rule for "${rulePath}".`);
      }),
    ["agent-shim rule set ~/work/acme --identity work", "agent-shim rule set ~/work/acme --no-config-profile"],
  );

  withExamples(
    rule
      .command("list")
      .description("List every directory rule, in file order.")
      .option("--json", "Print the rules as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const entries = listDirectoryRules(paths);
        if (options.json === true) {
          printJson(entries);
          return;
        }
        if (entries.length === 0) {
          console.log("No directory rules yet. Run `agent-shim rule add <path>` to create one.");
          return;
        }
        for (const entry of entries) {
          console.log(`  ${entry.path} (${describeRule(entry)})`);
        }
      }),
    ["agent-shim rule list", "agent-shim rule list --json"],
  );

  withExamples(
    rule
      .command("show <path>")
      .description("Show the directory rule for a path, matched exactly as it was written.")
      .option("--json", "Print the rule as JSON.")
      .action((rulePath: string, options: Readonly<{ json?: boolean }>) => {
        const found = listDirectoryRules(paths).find((entry) => entry.path === rulePath);
        if (found === undefined) {
          throw new DirectoryRuleNotFoundError(rulePath);
        }
        if (options.json === true) {
          printJson(found);
          return;
        }
        console.log(`Directory rule: ${found.path}`);
        console.log(`Settings: ${describeRule(found)}`);
      }),
    ["agent-shim rule show ~/work/acme"],
  );

  withExamples(
    rule
      .command("remove <path>")
      .description("Remove the directory rule for a path.")
      .option("--yes", "Remove without asking for confirmation (required when standard input is not a terminal).")
      .action(async (rulePath: string, options: Readonly<{ yes?: boolean }>) => {
        if (!listDirectoryRules(paths).some((entry) => entry.path === rulePath)) {
          throw new DirectoryRuleNotFoundError(rulePath);
        }
        await confirmRemoval(deps, options.yes, `the directory rule for "${rulePath}"`);
        removeDirectoryRule(paths, rulePath);
        console.log(`Removed directory rule for "${rulePath}".`);
      }),
    ["agent-shim rule remove ~/work/acme --yes"],
  );
}

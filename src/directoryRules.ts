import type { Command } from "commander";
import { confirmRemoval, printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import type { DirectoryRule } from "./config/schema";
import { UsageError } from "./cliError";
import { ensureProfileExists } from "./configProfiles";
import { IdentityNotFoundError, readIdentity } from "./identityManager";
import { DirectoryRuleNotFoundError, listDirectoryRules, addDirectoryRule, updateDirectoryRule, removeDirectoryRule } from "./directoryRulesStore";

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

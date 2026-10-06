import type { Command } from "commander";
import { confirmRemoval, printJson, reportMutation, withExamples, type CommandDeps } from "./cli/commandDeps";
import type { DirectoryRule } from "./config/schema";
import { UsageError } from "./cliError";
import { ensureProfileExists } from "./configProfiles";
import { POOL_SELECTOR_PREFIX } from "./config/schema";
import { IdentityNotFoundError, readIdentity } from "./identityStore";
import { PoolNotFoundError, readPools } from "./poolStore";
import { DirectoryRuleNotFoundError, listDirectoryRules, addDirectoryRule, updateDirectoryRule, removeDirectoryRule } from "./directoryRulesStore";

/** Renders a rule's own settings as `key=value` parts, for `rule list` and `rule show`. */
function describeRule(rule: DirectoryRule): string {
  const parts = Object.entries(rule)
    .filter(([key]) => key !== "path")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  return parts.length === 0 ? "(nothing)" : parts.join(", ");
}

/** Checks the targets a `rule add`/`rule set` names before the rule is written: a missing profile is offered for creation on a terminal (`ensureProfileExists`), and a missing identity or pool is refused, since pinning a path to a selector that names nothing would fail every launch there. The identity may be `pool:<name>`, the selector form the schema and the launcher both accept. */
async function checkRuleTargets(deps: CommandDeps, options: Readonly<{ configProfile?: string | false; identity?: string | false }>): Promise<void> {
  if (typeof options.identity === "string") {
    if (options.identity.startsWith(POOL_SELECTOR_PREFIX)) {
      const poolName = options.identity.slice(POOL_SELECTOR_PREFIX.length);
      if (readPools(deps.paths)[poolName] === undefined) {
        throw new PoolNotFoundError(poolName);
      }
    } else if (readIdentity(deps.paths, options.identity) === undefined) {
      throw new IdentityNotFoundError(options.identity);
    }
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
      .option("--json", "Print the result as JSON.")
      .action(async (rulePath: string, allOptions: Readonly<{ configProfile?: string; identity?: string; json?: boolean }>) => {
        const { json, ...options } = allOptions;
        await checkRuleTargets(deps, options);
        const created = addDirectoryRule(paths, rulePath, options);
        reportMutation(json, { action: "created", kind: "rule", name: rulePath, value: created }, () => {
          console.log(`Added directory rule for "${rulePath}".`);
        });
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
      .option("--json", "Print the result as JSON.")
      .action(async (rulePath: string, allOptions: Readonly<{ configProfile?: string | false; identity?: string | false; json?: boolean }>) => {
        const { json, ...options } = allOptions;
        if (options.configProfile === undefined && options.identity === undefined) {
          throw new UsageError("Nothing to change: pass --config-profile, --no-config-profile, --identity or --no-identity.");
        }
        await checkRuleTargets(deps, options);
        const updated = updateDirectoryRule(paths, rulePath, options);
        reportMutation(json, { action: "updated", kind: "rule", name: rulePath, value: updated }, () => {
          console.log(`Updated directory rule for "${rulePath}".`);
        });
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
      .option("--json", "Print the result as JSON.")
      .action(async (rulePath: string, options: Readonly<{ yes?: boolean; json?: boolean }>) => {
        if (!listDirectoryRules(paths).some((entry) => entry.path === rulePath)) {
          throw new DirectoryRuleNotFoundError(rulePath);
        }
        await confirmRemoval(deps, options.yes, `the directory rule for "${rulePath}"`);
        removeDirectoryRule(paths, rulePath);
        reportMutation(options.json, { action: "removed", kind: "rule", name: rulePath }, () => {
          console.log(`Removed directory rule for "${rulePath}".`);
        });
      }),
    ["agent-shim rule remove ~/work/acme --yes"],
  );
}

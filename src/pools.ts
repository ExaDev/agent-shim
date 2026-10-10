import type { Command } from "commander";
import { Option } from "commander";
import { confirmRemoval, printJson, reportMutation, withExamples, type CommandDeps } from "./cli/commandDeps";
import { UsageError } from "./cliError";
import { collectRepeated } from "./cli/parsers";
import { POOL_PREFERENCES, POOL_SELECTOR_PREFIX, type PoolPreference } from "./config/schema";
import { listIdentities, readActiveIdentity, useIdentity, IdentityNotFoundError } from "./identityStore";
import type { LayoutPaths } from "./paths";
import { addPool, readPools, removePool, requirePool, setPool } from "./poolStore";
import { poolNameOf } from "./launcher/identity";
import { poolMemberIdentity } from "./config/schema";
import { realFarmFs, realFsPort } from "./realPorts";
import { formatAge } from "./usage/preflight";
import { collectPoolPick } from "./poolPickReport";
import type { PoolPickReport } from "./usage/pickReportSchema";

function formatPoolPick(report: PoolPickReport, nowMs: number): string[] {
  const head =
    report.pick === undefined
      ? `Pool ${report.pool}: every member is refused right now${report.earliestReturn === undefined ? "" : `; ${report.earliestReturn.identity} returns at ${report.earliestReturn.at} (in ${formatAge(Date.parse(report.earliestReturn.at) - nowMs)})`}`
      : `Pool ${report.pool}: a launch from ${report.directory} would run as ${report.pick}`;
  const rows = report.candidates.map((candidate, index) => {
    const score = candidate.score === undefined ? "" : ` score ${candidate.score.toFixed(2)}${candidate.scoreWindow === "fiveHour" ? " by 5h reset" : " by 7d reset"}`;
    const dry = candidate.feasible ? "" : " (5h would run dry)";
    return `  ${String(index + 1)}. ${candidate.identity} [${candidate.class}${score}]${dry}\n     ${candidate.reasons.join("; ")}`;
  });
  return [head, ...rows, ...report.missing.map((name) => `  (skipped: ${name} is not an identity)`), ...(report.stickyProblem === undefined ? [] : [`Note: ${report.stickyProblem}; the last-pick record was ignored.`])];
}

/** Throws `IdentityNotFoundError` for any of `names` that is a direct member but not an identity, so a pool never starts with a member nothing can load. `pool:<name>` members are the store's concern: `addPool` and `setPool` check them against the pool map. */
function requireIdentities(paths: LayoutPaths, names: readonly string[]): void {
  const existing = new Set(listIdentities(paths).map((entry) => entry.name));
  for (const name of names) {
    if (poolNameOf(name) === undefined && !existing.has(name)) {
      throw new IdentityNotFoundError(name);
    }
  }
}

interface PoolMembersOptions {
  readonly identity?: readonly string[];
  readonly preference?: PoolPreference;
  readonly json?: boolean;
}

/** What `pool set` may change: the full new member list, the preference (false clears it back to the default), or both. */
interface PoolSetOptions {
  readonly identity?: readonly string[];
  readonly preference?: PoolPreference | false;
  readonly json?: boolean;
}

function membersOf(options: Readonly<Pick<PoolMembersOptions, "identity">>): readonly string[] {
  if (options.identity === undefined || options.identity.length === 0) {
    throw new UsageError("A pool needs at least one member: pass --identity <name> (repeatable).");
  }
  return options.identity;
}

const PREFERENCE_DESCRIPTION = "How a launch picks a member: score (the default) picks the member whose remaining quota expires soonest; listed tries the members in the order the pool lists them, skipping any that is refused right now.";

/** Registers the `agent-shim pool` subcommand tree onto `program`. */
export function registerPoolCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const pool = withExamples(
    program.command("pool").description("Manage pools: named sets of identities that a launch picks one member of, by remaining quota or the pool's listed order, with `claude @pool:<name>`."),
    ["agent-shim pool add subs --identity work --identity personal", "agent-shim pool pick subs"],
  );

  withExamples(
    pool
      .command("add <name>")
      .description("Define a pool. Fails if one with this name already exists.")
      .option("--identity <name>", "A member: an identity name, or pool:<name> to nest another pool with its own policy (repeatable).", collectRepeated)
      .addOption(new Option("--preference <mode>", PREFERENCE_DESCRIPTION).choices(POOL_PREFERENCES))
      .option("--json", "Print the result as JSON.")
      .action((name: string, options: Readonly<PoolMembersOptions>) => {
        const members = membersOf(options);
        requireIdentities(paths, members);
        const created = addPool(paths, name, members, options.preference);
        reportMutation(options.json, { action: "created", kind: "pool", name, value: created }, () => {
          console.log(`Created pool "${name}" with ${members.join(", ")}.`);
        });
      }),
    ["agent-shim pool add subs --identity work --identity personal", "agent-shim pool add client --identity client-main --identity spare --preference listed"],
  );

  withExamples(
    pool
      .command("set <name>")
      .description("Replace a pool's members, its preference, or both.")
      .option("--identity <name>", "A member: an identity name, or pool:<name> to nest another pool with its own policy (repeatable); the full new list. Kept as-is when this option is absent.", collectRepeated)
      .addOption(new Option("--preference <mode>", PREFERENCE_DESCRIPTION).choices(POOL_PREFERENCES))
      .option("--no-preference", "Clear the preference back to the default, score.")
      .option("--json", "Print the result as JSON.")
      .action((name: string, options: Readonly<PoolSetOptions>) => {
        const existing = requirePool(paths, name);
        if (options.identity === undefined && options.preference === undefined) {
          throw new UsageError("Nothing to change: pass --identity, --preference or --no-preference.");
        }
        const members = options.identity === undefined ? existing.identities : membersOf(options);
        if (options.identity !== undefined) {
          // Only the freshly listed names are validated: the pass-through keeps object entries whose condition the CLI does not restate.
          requireIdentities(paths, membersOf(options));
        }
        // The listing prints member names whichever form an entry takes; an object entry's condition is configuration the ranking reads, not something the CLI restates.
        const preference = options.preference === undefined ? existing.preference : options.preference === false ? undefined : options.preference;
        const updated = setPool(paths, name, members, preference);
        reportMutation(options.json, { action: "updated", kind: "pool", name, value: updated }, () => {
          console.log(`Pool "${name}" now has ${members.map(poolMemberIdentity).join(", ")}.`);
        });
      }),
    ["agent-shim pool set subs --identity work --identity personal --identity spare", "agent-shim pool set subs --preference listed"],
  );

  withExamples(
    pool
      .command("list")
      .description("List every pool and its members, marking the active selection with *.")
      .option("--json", "Print the pools as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const pools = readPools(paths);
        const active = readActiveIdentity(paths);
        if (options.json === true) {
          printJson(Object.entries(pools).map(([name, entry]) => ({ name, identities: entry.identities, ...(entry.preference === undefined ? {} : { preference: entry.preference }), active: active === `${POOL_SELECTOR_PREFIX}${name}` })));
          return;
        }
        const names = Object.keys(pools).sort();
        if (names.length === 0) {
          console.log("No pools yet. Run `agent-shim pool add <name> --identity <name>...` to create one.");
          return;
        }
        for (const name of names) {
          const entry = pools[name];
          console.log(`${active === `${POOL_SELECTOR_PREFIX}${name}` ? "*" : " "} ${name}: ${(entry?.identities ?? []).map(poolMemberIdentity).join(", ")}${entry?.preference === undefined ? "" : " (preference: listed)"}`);
        }
      }),
    ["agent-shim pool list", "agent-shim pool list --json"],
  );

  withExamples(
    pool
      .command("show <name>")
      .description("Show one pool's members.")
      .option("--json", "Print the pool as JSON.")
      .action((name: string, options: Readonly<{ json?: boolean }>) => {
        const entry = requirePool(paths, name);
        if (options.json === true) {
          printJson({ name, identities: entry.identities, ...(entry.preference === undefined ? {} : { preference: entry.preference }) });
          return;
        }
        console.log(`Pool: ${name}`);
        console.log(`Members: ${entry.identities.map(poolMemberIdentity).join(", ")}`);
        if (entry.preference !== undefined) {
          console.log(`Preference: ${entry.preference}`);
        }
      }),
    ["agent-shim pool show subs"],
  );

  withExamples(
    pool
      .command("remove <name>")
      .description("Delete a pool. Its member identities are untouched.")
      .option("--yes", "Skip the confirmation prompt.")
      .option("--json", "Print the result as JSON.")
      .action(async (name: string, options: Readonly<{ yes?: boolean; json?: boolean }>) => {
        requirePool(paths, name);
        await confirmRemoval(deps, options.yes, `pool "${name}"`);
        removePool(paths, name);
        reportMutation(options.json, { action: "removed", kind: "pool", name }, () => {
          console.log(`Removed pool "${name}".`);
        });
      }),
    ["agent-shim pool remove subs --yes"],
  );

  withExamples(
    pool
      .command("use <name>")
      .description("Make launches with no other selection pick a member of this pool.")
      .option("--json", "Print the result as JSON.")
      .action((name: string, options: Readonly<{ json?: boolean }>) => {
        useIdentity(paths, `${POOL_SELECTOR_PREFIX}${name}`);
        reportMutation(options.json, { action: "selected", kind: "pool", name }, () => {
          console.log(`Active selection is now pool "${name}".`);
        });
      }),
    ["agent-shim pool use subs"],
  );

  withExamples(
    pool
      .command("pick <name>")
      .description("Show how a launch from this directory would rank the pool's members right now, and which it would run as. Read-only: it records nothing.")
      .option("--json", "Print the ranking as JSON.")
      .action((name: string, options: Readonly<{ json?: boolean }>) => {
        const nowMs = Date.now();
        const report = collectPoolPick({ paths, fs: realFsPort, usageFs: realFarmFs, poolName: name, pools: readPools(paths), directory: process.cwd(), nowMs });
        if (options.json === true) {
          printJson(report);
          return;
        }
        for (const line of formatPoolPick(report, nowMs)) {
          console.log(line);
        }
      }),
    ["agent-shim pool pick subs", "agent-shim pool pick subs --json"],
  );
}

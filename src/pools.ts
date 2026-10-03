import type { Command } from "commander";
import { confirmRemoval, printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { UsageError } from "./cliError";
import { collectRepeated } from "./cli/parsers";
import { POOL_SELECTOR_PREFIX } from "./config/schema";
import { listIdentities, readActiveIdentity, useIdentity, IdentityNotFoundError } from "./identityStore";
import type { LayoutPaths } from "./paths";
import { addPool, readPools, removePool, requirePool, setPool } from "./poolStore";
import { realFarmFs, realFsPort } from "./realPorts";
import { formatAge } from "./usage/preflight";
import { type PoolPickReport, collectPoolPick } from "./poolPickReport";

function formatPoolPick(report: PoolPickReport, nowMs: number): string[] {
  const head =
    report.pick === undefined
      ? `Pool ${report.pool}: every member is refused right now${report.earliestReturn === undefined ? "" : `; ${report.earliestReturn.identity} returns at ${report.earliestReturn.at} (in ${formatAge(Date.parse(report.earliestReturn.at) - nowMs)})`}`
      : `Pool ${report.pool}: a launch from ${report.directory} would run as ${report.pick}`;
  const rows = report.candidates.map((candidate, index) => {
    const score = candidate.score === undefined ? "" : ` score ${candidate.score.toFixed(2)}`;
    const dry = candidate.feasible ? "" : " (5h would run dry)";
    return `  ${String(index + 1)}. ${candidate.identity} [${candidate.class}${score}]${dry}\n     ${candidate.reasons.join("; ")}`;
  });
  return [head, ...rows, ...report.missing.map((name) => `  (skipped: ${name} is not an identity)`), ...(report.stickyProblem === undefined ? [] : [`Note: ${report.stickyProblem}; the last-pick record was ignored.`])];
}

/** Throws `IdentityNotFoundError` for any of `names` that is not an identity, so a pool never starts with a member nothing can load. */
function requireIdentities(paths: LayoutPaths, names: readonly string[]): void {
  const existing = new Set(listIdentities(paths).map((entry) => entry.name));
  for (const name of names) {
    if (!existing.has(name)) {
      throw new IdentityNotFoundError(name);
    }
  }
}

interface PoolMembersOptions {
  readonly identity?: readonly string[];
}

function membersOf(options: Readonly<PoolMembersOptions>): readonly string[] {
  if (options.identity === undefined || options.identity.length === 0) {
    throw new UsageError("A pool needs at least one member: pass --identity <name> (repeatable).");
  }
  return options.identity;
}

/** Registers the `agent-shim pool` subcommand tree onto `program`. */
export function registerPoolCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const pool = withExamples(
    program.command("pool").description("Manage pools: named sets of identities that a launch picks one member of, by remaining quota, with `claude @pool:<name>`."),
    ["agent-shim pool add subs --identity work --identity personal", "agent-shim pool pick subs"],
  );

  withExamples(
    pool
      .command("add <name>")
      .description("Define a pool. Fails if one with this name already exists.")
      .option("--identity <name>", "A member identity (repeatable).", collectRepeated)
      .action((name: string, options: Readonly<PoolMembersOptions>) => {
        const members = membersOf(options);
        requireIdentities(paths, members);
        addPool(paths, name, members);
        console.log(`Created pool "${name}" with ${members.join(", ")}.`);
      }),
    ["agent-shim pool add subs --identity work --identity personal"],
  );

  withExamples(
    pool
      .command("set <name>")
      .description("Replace a pool's members.")
      .option("--identity <name>", "A member identity (repeatable); the full new list.", collectRepeated)
      .action((name: string, options: Readonly<PoolMembersOptions>) => {
        const members = membersOf(options);
        requireIdentities(paths, members);
        setPool(paths, name, members);
        console.log(`Pool "${name}" now has ${members.join(", ")}.`);
      }),
    ["agent-shim pool set subs --identity work --identity personal --identity spare"],
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
          printJson(Object.entries(pools).map(([name, entry]) => ({ name, identities: entry.identities, active: active === `${POOL_SELECTOR_PREFIX}${name}` })));
          return;
        }
        const names = Object.keys(pools).sort();
        if (names.length === 0) {
          console.log("No pools yet. Run `agent-shim pool add <name> --identity <name>...` to create one.");
          return;
        }
        for (const name of names) {
          console.log(`${active === `${POOL_SELECTOR_PREFIX}${name}` ? "*" : " "} ${name}: ${(pools[name]?.identities ?? []).join(", ")}`);
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
          printJson({ name, identities: entry.identities });
          return;
        }
        console.log(`Pool: ${name}`);
        console.log(`Members: ${entry.identities.join(", ")}`);
      }),
    ["agent-shim pool show subs"],
  );

  withExamples(
    pool
      .command("remove <name>")
      .description("Delete a pool. Its member identities are untouched.")
      .option("--yes", "Skip the confirmation prompt.")
      .action(async (name: string, options: Readonly<{ yes?: boolean }>) => {
        requirePool(paths, name);
        await confirmRemoval(deps, options.yes, `pool "${name}"`);
        removePool(paths, name);
        console.log(`Removed pool "${name}".`);
      }),
    ["agent-shim pool remove subs --yes"],
  );

  withExamples(
    pool
      .command("use <name>")
      .description("Make launches with no other selection pick a member of this pool.")
      .action((name: string) => {
        useIdentity(paths, `${POOL_SELECTOR_PREFIX}${name}`);
        console.log(`Active selection is now pool "${name}".`);
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
        const report = collectPoolPick({ paths, fs: realFsPort, usageFs: realFarmFs, poolName: name, pool: requirePool(paths, name), directory: process.cwd(), nowMs });
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

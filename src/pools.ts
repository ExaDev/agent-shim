import type { Command } from "commander";

import { confirmRemoval, printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { UsageError } from "./cliError";
import { collectRepeated } from "./cli/parsers";
import type { Pool } from "./config/schema";
import { listIdentities, readActiveIdentity, useIdentity, IdentityNotFoundError } from "./identityManager";
import { splitMembers } from "./launcher/pool";
import { POOL_SELECTOR_PREFIX } from "./config/schema";
import type { FarmFs, FsPort } from "./launcher/ports";
import type { LayoutPaths } from "./paths";
import { addPool, readPools, removePool, requirePool, setPool } from "./poolStore";
import { realFarmFs, realFsPort } from "./realPorts";
import { rankPoolFromStore, readStickyPick } from "./usage/poolPick";
import type { Candidate, PoolRanking } from "./usage/pick";
import { formatAge } from "./usage/preflight";

/** What `pool pick` reports: the ranking a launch from `directory` would act on right now. */
export interface PoolPickReport {
  readonly pool: string;
  readonly directory: string;
  /** The member a launch would run as, absent when every member is refused. */
  readonly pick?: string;
  readonly candidates: readonly PoolPickCandidateView[];
  /** Members that name an identity that does not exist; a launch skips them. */
  readonly missing: readonly string[];
  /** When nothing can be picked, the soonest any member returns. */
  readonly earliestReturn?: { readonly identity: string; readonly at: string };
  /** Why the last-pick record could not be read, when that is the case. */
  readonly stickyProblem?: string;
}

/** One ranked member as `pool pick --json` prints it. */
interface PoolPickCandidateView {
  readonly identity: string;
  readonly class: Candidate["class"];
  readonly score?: number;
  readonly feasible: boolean;
  readonly blockedUntil?: string;
  readonly plan: Candidate["plan"];
  readonly reasons: readonly string[];
}

function candidateView(candidate: Candidate): PoolPickCandidateView {
  return {
    identity: candidate.identity,
    class: candidate.class,
    ...(candidate.score === undefined ? {} : { score: candidate.score }),
    feasible: candidate.feasible,
    ...(candidate.blockedUntilMs === undefined ? {} : { blockedUntil: new Date(candidate.blockedUntilMs).toISOString() }),
    plan: candidate.plan,
    reasons: candidate.reasons,
  };
}

/**
 * Ranks a pool exactly as a launch from `directory` would right now, without recording a pick. Shares `rankPoolFromStore` with the launcher, so what this prints is what a launch does.
 */
export function collectPoolPick(params: Readonly<{ paths: LayoutPaths; fs: FsPort; usageFs: FarmFs; poolName: string; pool: Pool; directory: string; nowMs: number }>): PoolPickReport {
  const { present, missing } = splitMembers(params.pool, params.paths, params.fs);
  const sticky = readStickyPick(params.usageFs, params.paths.usagePicksFile, params.directory);
  const ranking: PoolRanking = rankPoolFromStore({
    fs: params.usageFs,
    paths: params.paths,
    identities: present,
    nowMs: params.nowMs,
    resuming: false,
    ...(sticky.sticky === undefined ? {} : { sticky: sticky.sticky }),
  });
  return {
    pool: params.poolName,
    directory: params.directory,
    ...(ranking.pick === undefined ? {} : { pick: ranking.pick.identity }),
    candidates: ranking.candidates.map(candidateView),
    missing,
    ...(ranking.earliestReturn === undefined ? {} : { earliestReturn: { identity: ranking.earliestReturn.identity, at: new Date(ranking.earliestReturn.atMs).toISOString() } }),
    ...(sticky.problem === undefined ? {} : { stickyProblem: sticky.problem }),
  };
}

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

/** Registers the `claude-use pool` subcommand tree onto `program`. */
export function registerPoolCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const pool = withExamples(
    program.command("pool").description("Manage pools: named sets of identities that a launch picks one member of, by remaining quota, with `claude @pool:<name>`."),
    ["claude-use pool add subs --identity work --identity personal", "claude-use pool pick subs"],
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
    ["claude-use pool add subs --identity work --identity personal"],
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
    ["claude-use pool set subs --identity work --identity personal --identity spare"],
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
          console.log("No pools yet. Run `claude-use pool add <name> --identity <name>...` to create one.");
          return;
        }
        for (const name of names) {
          console.log(`${active === `${POOL_SELECTOR_PREFIX}${name}` ? "*" : " "} ${name}: ${(pools[name]?.identities ?? []).join(", ")}`);
        }
      }),
    ["claude-use pool list", "claude-use pool list --json"],
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
    ["claude-use pool show subs"],
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
    ["claude-use pool remove subs --yes"],
  );

  withExamples(
    pool
      .command("use <name>")
      .description("Make launches with no other selection pick a member of this pool.")
      .action((name: string) => {
        useIdentity(paths, `${POOL_SELECTOR_PREFIX}${name}`);
        console.log(`Active selection is now pool "${name}".`);
      }),
    ["claude-use pool use subs"],
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
    ["claude-use pool pick subs", "claude-use pool pick subs --json"],
  );
}

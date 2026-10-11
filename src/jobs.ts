import path from "node:path";

import { Option, type Command } from "commander";

import { confirmRemoval, printJson, reportMutation, withExamples, type CommandDeps } from "./cli/commandDeps";
import { collectAnchor, collectRepeated, parseDurationLiteral } from "./cli/parsers";
import { UsageError } from "./cliError";
import { JOB_WINDOWS, type Anchor, type Job, type JobWindow } from "./config/schema";
import { identityExists, requireIdentityNames } from "./identityStore";
import { addJob, readJobs, removeJob, requireJob } from "./jobStore";
import { readPools, requirePool } from "./poolStore";
import { realFarmFs, spawnDetachedSupervisor } from "./realPorts";
import { ANCHOR_SYNTAX, formatAnchor } from "./usage/anchor";
import { resolveJobIdentity } from "./usage/jobTarget";
import { createRealJobRunner } from "./usage/realJobRunner";

interface JobAddOptions {
  readonly identity?: string;
  readonly pool?: string;
  readonly at?: Anchor[];
  readonly beforeReset?: JobWindow;
  readonly lead?: string;
  readonly prompt?: string;
  readonly cwd?: string;
  readonly timeout?: string;
  readonly model?: string;
  readonly allowedTool?: string[];
  readonly json?: boolean;
}

/** The job these options describe, or a `UsageError` naming what is missing or contradictory. */
function jobOf(options: Readonly<JobAddOptions>): Job {
  if ((options.identity === undefined) === (options.pool === undefined)) {
    throw new UsageError("A job runs as one identity or one pool's pick: pass exactly one of --identity or --pool.");
  }
  if ((options.at === undefined) === (options.beforeReset === undefined)) {
    throw new UsageError("A job needs exactly one trigger: pass --at (repeatable) or --before-reset with --lead.");
  }
  if (options.beforeReset !== undefined && options.lead === undefined) {
    throw new UsageError("--before-reset needs --lead, how long before the window resets the job runs.");
  }
  if (options.at !== undefined && options.lead !== undefined) {
    throw new UsageError("--lead only goes with --before-reset.");
  }
  if (options.prompt === undefined || options.timeout === undefined) {
    throw new UsageError("A job needs --prompt, what to run, and --timeout, how long one run may take.");
  }
  return {
    target: options.identity === undefined ? { pool: options.pool ?? "" } : { identity: options.identity },
    trigger: options.at === undefined ? { beforeReset: options.beforeReset ?? "fiveHour", lead: options.lead ?? "" } : { at: options.at },
    prompt: options.prompt,
    cwd: path.resolve(options.cwd ?? process.cwd()),
    timeout: options.timeout,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.allowedTool === undefined ? {} : { allowedTools: options.allowedTool }),
  };
}

function describeTrigger(job: Readonly<Job>): string {
  return "at" in job.trigger ? `at ${job.trigger.at.map(formatAnchor).join(" ")}` : `${job.trigger.lead} before the ${job.trigger.beforeReset} window resets`;
}

function describeTarget(job: Readonly<Job>): string {
  return "identity" in job.target ? `identity ${job.target.identity}` : `the pick of pool ${job.target.pool}`;
}

/** Registers the `agent-shim job` subcommand tree onto `program`. */
export function registerJobCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const job = withExamples(
    program.command("job").description("Manage jobs: prompts the front door runs unattended as an identity, on a schedule or shortly before a quota window resets to use quota that would expire."),
    ["agent-shim job add digest --identity work --before-reset sevenDay --lead 6h --prompt 'summarise open PRs' --timeout 30m", "agent-shim job list"],
  );

  withExamples(
    job
      .command("add <name>")
      .description("Define a job. Fails if one with this name already exists.")
      .option("--identity <name>", "Run as this identity.")
      .option("--pool <name>", "Run as whichever member of this pool the ranking picks when the job fires.")
      .option("--at <spec>", `Run at these times (repeatable): ${ANCHOR_SYNTAX}.`, collectAnchor)
      .addOption(new Option("--before-reset <window>", "Run once per instance of this quota window, when it has --lead or less left.").choices(JOB_WINDOWS))
      .option("--lead <duration>", "With --before-reset: how long before the window resets the job runs, a count followed by m, h, d or w, such as 6h.", parseDurationLiteral)
      .option("--prompt <text>", "What to run.")
      .option("--cwd <dir>", "The directory the run works in. Defaults to the current directory.")
      .option("--timeout <duration>", "How long one run may take, such as 30m. A run that goes on longer is stopped.", parseDurationLiteral)
      .option("--model <model>", "The model to run with. Defaults to the settings' own.")
      .option("--allowed-tool <tool>", "A tool the run may use without asking, beyond what its settings allow (repeatable). An unattended run cannot answer a permission prompt, so any other tool is refused.", collectRepeated)
      .option("--json", "Print the result as JSON.")
      .action((name: string, options: Readonly<JobAddOptions>) => {
        const defined = jobOf(options);
        if ("identity" in defined.target) {
          requireIdentityNames(paths, [defined.target.identity]);
        } else {
          requirePool(paths, defined.target.pool);
        }
        const created = addJob(paths, name, defined);
        reportMutation(options.json, { action: "created", kind: "job", name, value: created }, () => {
          console.log(`Created job "${name}": runs as ${describeTarget(created)}, ${describeTrigger(created)}.`);
        });
      }),
    ["agent-shim job add digest --identity work --at mon-fri@06:00 --prompt 'summarise open PRs' --timeout 30m --cwd ~/work/app", "agent-shim job add burn --pool subs --before-reset fiveHour --lead 20m --prompt 'continue the migration plan' --timeout 20m --allowed-tool Read --allowed-tool Edit"],
  );

  withExamples(
    job
      .command("list")
      .description("List every job.")
      .option("--json", "Print the jobs as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const jobs = readJobs(paths);
        if (options.json === true) {
          printJson(Object.entries(jobs).map(([name, entry]) => ({ name, ...entry })));
          return;
        }
        const names = Object.keys(jobs).sort();
        if (names.length === 0) {
          console.log("No jobs yet. Run `agent-shim job add <name> ...` to create one.");
          return;
        }
        for (const name of names) {
          const entry = jobs[name];
          if (entry !== undefined) {
            console.log(`${name}: ${describeTarget(entry)}, ${describeTrigger(entry)}`);
          }
        }
      }),
    ["agent-shim job list", "agent-shim job list --json"],
  );

  withExamples(
    job
      .command("show <name>")
      .description("Show one job.")
      .option("--json", "Print the job as JSON.")
      .action((name: string, options: Readonly<{ json?: boolean }>) => {
        const entry = requireJob(paths, name);
        if (options.json === true) {
          printJson({ name, ...entry });
          return;
        }
        console.log(`Job: ${name}`);
        console.log(`Runs as: ${describeTarget(entry)}`);
        console.log(`Trigger: ${describeTrigger(entry)}`);
        console.log(`Directory: ${entry.cwd}`);
        console.log(`Timeout: ${entry.timeout}`);
        if (entry.model !== undefined) {
          console.log(`Model: ${entry.model}`);
        }
        if (entry.allowedTools !== undefined) {
          console.log(`Allowed tools: ${entry.allowedTools.join(", ")}`);
        }
        console.log(`Prompt: ${entry.prompt}`);
        console.log(`Results: ${path.join(paths.jobLogsDir, `${name}.log`)}`);
      }),
    ["agent-shim job show digest"],
  );

  withExamples(
    job
      .command("remove <name>")
      .description("Delete a job.")
      .option("--yes", "Skip the confirmation prompt.")
      .option("--json", "Print the result as JSON.")
      .action(async (name: string, options: Readonly<{ yes?: boolean; json?: boolean }>) => {
        requireJob(paths, name);
        await confirmRemoval(deps, options.yes, `job "${name}"`);
        removeJob(paths, name);
        reportMutation(options.json, { action: "removed", kind: "job", name }, () => {
          console.log(`Removed job "${name}".`);
        });
      }),
    ["agent-shim job remove digest --yes"],
  );

  withExamples(
    job
      .command("run <name>")
      .description("Run a job now, in this terminal, as its trigger would: for a pool the member is picked at this moment. The result is appended to the job's log, and a failure exits non-zero.")
      .action(async (name: string) => {
        const entry = requireJob(paths, name);
        const identity = resolveJobIdentity({ paths, fs: realFarmFs, pools: readPools(paths), nowMs: Date.now(), identityExists: (candidate) => identityExists(paths, candidate) }, entry.target);
        if (identity === undefined) {
          throw new UsageError(`No member of the job's pool can be picked right now.`);
        }
        await createRealJobRunner({ paths, spawnDaemon: spawnDetachedSupervisor, fs: realFarmFs, now: () => new Date() })(name, identity, entry);
        console.log(`Ran job "${name}" as ${identity}; the result is in ${path.join(paths.jobLogsDir, `${name}.log`)}.`);
      }),
    ["agent-shim job run digest"],
  );
}

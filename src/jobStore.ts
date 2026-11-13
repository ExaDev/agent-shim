import { CliError } from "./cliError";
import { readGlobalConfig } from "./configProfilesStore";
import { applyPatch } from "./config/store";
import { GlobalConfigSchema, PoolNameSchema, type Job } from "./config/schema";
import type { LayoutPaths } from "./paths";
import { ownEntry } from "./ownEntry";

/** Raised when a command names a job that is not defined in the global config. */
class JobNotFoundError extends CliError {
  constructor(readonly jobName: string) {
    super(`No job named "${jobName}". Run \`agent-shim job add ${jobName} ...\` first.`);
    this.name = "JobNotFoundError";
  }
}

/** Raised by `addJob` when a job with the given name is already defined. */
class JobAlreadyExistsError extends CliError {
  constructor(readonly jobName: string) {
    super(`A job named "${jobName}" already exists. Remove it with \`agent-shim job remove ${jobName}\` to define it again.`);
    this.name = "JobAlreadyExistsError";
  }
}

/** Raised when a job name fails `PoolNameSchema`, the shape a pool name has. */
class InvalidJobNameError extends CliError {
  constructor(readonly attemptedName: string) {
    super(`"${attemptedName}" is not a valid job name: it must start with a letter or number and may then contain letters, numbers, dots, hyphens and underscores.`);
    this.name = "InvalidJobNameError";
  }
}

/** The jobs defined in `~/.agent-shim/config.json`, by name. */
export function readJobs(paths: LayoutPaths): Readonly<Record<string, Job>> {
  return readGlobalConfig(paths)?.jobs ?? {};
}

/** The job named `name`; throws `JobNotFoundError` when none is defined. */
export function requireJob(paths: LayoutPaths, name: string): Job {
  const job = ownEntry(readJobs(paths), name);
  if (job === undefined) {
    throw new JobNotFoundError(name);
  }
  return job;
}

/**
 * Writes the whole `jobs` map back, because `applyPatch` replaces top-level keys wholesale. An empty map removes the key instead of leaving `jobs: {}`, so a configuration that no longer defines a job reads again as one from before jobs existed to any older agent-shim sharing the file, whose strict schema rejects an unknown key even when it is empty.
 */
function writeJobs(paths: LayoutPaths, jobs: Readonly<Record<string, Job>>): void {
  applyPatch(paths.globalConfigFile, GlobalConfigSchema, { jobs: Object.keys(jobs).length === 0 ? undefined : jobs }, { defaults: {} });
}

/** Defines a new job. Throws `InvalidJobNameError` for a name `PoolNameSchema`, the shape a pool name has rejects and `JobAlreadyExistsError` for one already defined. Whether the target identity or pool exists is the caller's concern, since the command that has the layout checks it. */
export function addJob(paths: LayoutPaths, name: string, job: Job): Job {
  if (!PoolNameSchema.safeParse(name).success) {
    throw new InvalidJobNameError(name);
  }
  const jobs = readJobs(paths);
  if (ownEntry(jobs, name) !== undefined) {
    throw new JobAlreadyExistsError(name);
  }
  writeJobs(paths, { ...jobs, [name]: job });
  return job;
}

/** Removes a job. Throws `JobNotFoundError` when it is not defined. */
export function removeJob(paths: LayoutPaths, name: string): void {
  requireJob(paths, name);
  writeJobs(paths, Object.fromEntries(Object.entries(readJobs(paths)).filter(([existing]) => existing !== name)));
}

/** The jobs with every job that runs as identity `from` running as `to`, and the names of the jobs that changed. Undefined when no job runs as `from`. A job that targets a pool is not an identity's. */
export function renameIdentityInJobs(jobs: Readonly<Record<string, Job>>, from: string, to: string): { readonly jobs: Record<string, Job>; readonly renamed: readonly string[] } | undefined {
  const runsAsFrom = (job: Job): boolean => "identity" in job.target && job.target.identity === from;
  const renamed = Object.entries(jobs).filter(([, job]) => runsAsFrom(job)).map(([name]) => name);
  if (renamed.length === 0) {
    return undefined;
  }
  return { jobs: Object.fromEntries(Object.entries(jobs).map(([name, job]) => [name, runsAsFrom(job) ? { ...job, target: { identity: to } } : job])), renamed };
}

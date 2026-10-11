import path from "node:path";

import type { Job } from "../config/schema";
import type { FarmFs } from "../launcher/ports";
import { parseDuration } from "../resolve/conditions";
import { withIdentityClaude, type IdentityClaudeParams } from "./identityClaude";

/** The launch flags a job run adds: no daemons beyond the identity's own routing, and usage tracking on so the door records the run against the identity. */
const JOB_LAUNCH_FLAGS = ["--no-headroom", "--no-remote-control", "--track-usage"] as const;

/** What a run appends to its job's log: when it ended, who ran it, and the result or the error. */
function logEntry(name: string, identity: string, endedAt: Readonly<Date>, outcome: string): string {
  return `${endedAt.toISOString()} job ${name} as ${identity}\n${outcome.trimEnd()}\n\n`;
}

/** The filesystem effects a run's log needs. */
type JobLogFs = Pick<FarmFs, "mkdirPrivate" | "appendFilePrivate">;

/**
 * Runs a job as an identity through the Agent SDK, unattended: the user's, project and local settings apply, the job's `allowedTools` are the only tools it may use beyond what those settings allow, and nothing can be asked of a person, so a tool outside them is refused (`dontAsk`) rather than waited on. The run is bounded by the job's `timeout`. Its result, or why it failed, is appended to `<jobLogsDir>/<name>.log`, and a failure also throws.
 */
export function createRealJobRunner(params: Omit<IdentityClaudeParams, "cwd" | "timeoutMs"> & { readonly fs: JobLogFs; readonly now: () => Date }): (name: string, identity: string, job: Job) => Promise<void> {
  return async (name, identity, job) => {
    const logFile = path.join(params.paths.jobLogsDir, `${name}.log`);
    const append = (outcome: string): void => {
      params.fs.mkdirPrivate(params.paths.jobLogsDir);
      params.fs.appendFilePrivate(logFile, logEntry(name, identity, params.now(), outcome));
    };
    try {
      const result = await withIdentityClaude({ paths: params.paths, spawnDaemon: params.spawnDaemon, cwd: job.cwd, timeoutMs: parseDuration(job.timeout) }, identity, JOB_LAUNCH_FLAGS, async ({ bin, env, cwd, abort }) => {
        // Loaded here, not at the top of the file, so a library host that never runs a job never loads the SDK.
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        const session = query({
          prompt: job.prompt,
          options: {
            pathToClaudeCodeExecutable: bin,
            env,
            cwd,
            abortController: abort,
            settingSources: ["user", "project", "local"],
            permissionMode: "dontAsk",
            ...(job.model === undefined ? {} : { model: job.model }),
            ...(job.allowedTools === undefined ? {} : { allowedTools: [...job.allowedTools] }),
          },
        });
        try {
          for await (const message of session) {
            if (message.type === "result") {
              if (message.subtype !== "success") {
                throw new Error(`the run ended as ${message.subtype}`);
              }
              return message.result;
            }
          }
          throw new Error("the run ended without a result");
        } finally {
          session.close();
        }
      });
      append(result);
    } catch (error) {
      append(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
}

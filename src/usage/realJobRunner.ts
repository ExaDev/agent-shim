import path from "node:path";

import type { Job } from "../config/schema";
import type { FarmFs } from "../launcher/ports";
import { parseDuration } from "../resolve/conditions";
import { withIdentityClaude, type IdentityClaudeParams } from "./identityClaude";

/** The launch flags a job run adds: no daemons beyond the identity's own routing, and usage tracking on so the door records the run against the identity. */
const JOB_LAUNCH_FLAGS = ["--no-headroom", "--no-remote-control", "--track-usage"] as const;

/**
 * What an unattended run takes from the repository it works in: nothing that can run code. Only the user's own settings load, never the project's or local ones, and no MCP server starts, including those a project's `.mcp.json` names (`strictMcpConfig` ignores every source but the empty map given). A repository's committed settings and MCP file can change after the job was defined, so a pulled change could otherwise add a hook, widen a permission or start a command-backed server that the front door then runs as the person's identity without another authorisation.
 */
export const JOB_ISOLATION_OPTIONS = { settingSources: ["user"], mcpServers: {}, strictMcpConfig: true } as const;

/** What a run appends to its job's log: when it ended, who ran it, and the result or the error. */
function logEntry(name: string, identity: string, endedAt: Readonly<Date>, outcome: string): string {
  return `${endedAt.toISOString()} job ${name} as ${identity}\n${outcome.trimEnd()}\n\n`;
}

/** The filesystem effects a run's log needs. */
type JobLogFs = Pick<FarmFs, "mkdirPrivate" | "appendFilePrivate">;

/**
 * Runs a job as an identity through the Agent SDK, unattended: only the user's own settings apply, the job's `allowedTools` are the only tools it may use beyond what those settings allow, and nothing can be asked of a person, so a tool outside them is refused (`dontAsk`) rather than waited on. The run is bounded by the job's `timeout`. Its result, or why it failed, is appended to `<jobLogsDir>/<name>.log`, and a failure also throws.
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
            settingSources: [...JOB_ISOLATION_OPTIONS.settingSources],
            mcpServers: JOB_ISOLATION_OPTIONS.mcpServers,
            strictMcpConfig: JOB_ISOLATION_OPTIONS.strictMcpConfig,
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

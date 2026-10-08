import { availableParallelism } from "node:os";

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { buildFarmRuntime, LaunchRefusedError, realPrepareLaunchParams } from "../launchWiring";
import { prepareLaunch } from "../launcher";
import type { LayoutPaths } from "../paths";
import type { DaemonSpawner } from "../realPorts";
import { createAnthropicUsageRefresher, unifiedFromReportedLimits, type AnthropicUsageRefresher } from "./anthropicUsageRefresh";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { QUOTA_REQUEST_TIMEOUT_MS } from "./quotaRefresh";
import type { UnifiedRateLimit } from "./schema";
import type { UsageStore } from "./store";

/** The launch flags a probe adds: no daemons beyond what the identity's own routing needs, since the probe only asks the usage endpoint and sends no model request. */
const PROBE_LAUNCH_FLAGS = ["--no-headroom", "--no-remote-control"] as const;

/** The environment variable that makes a launch skip identity resolution, which would point a probe at the wrong account. */
const CONFIG_DIR_VARIABLE = "CLAUDE_CONFIG_DIR";

/** The environment as the SDK's `env` option takes it: defined values only. */
function definedEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));
}

/** A prompt stream that never yields and ends when `signal` aborts, so the SDK holds the CLI open for control requests without ever starting a turn. */
function idlePrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () =>
        await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({ done: true, value: undefined });
          }, { once: true });
        }),
    }),
  };
}

/** What the real probe needs beyond the state root. */
interface RealAnthropicUsageProbeParams {
  readonly paths: LayoutPaths;
  /** The directory launches are planned for. */
  readonly cwd: string;
  /** Starts the front door and headroom daemons an identity's launch routes through. */
  readonly spawnDaemon: DaemonSpawner;
  /** The longest one probe may take, which also bounds the CLI's start-up. */
  readonly timeoutMs: number;
}

/**
 * Fetches an identity's plan windows from the usage endpoint the way `/usage` does: it plans a launch for the identity (so the CLI runs with the identity's own configuration directory, credential and routing), starts the real `claude` binary through the Agent SDK with no prompt, tools or MCP servers, and asks it for the usage report. No model request is made. Resolves undefined when the account has no plan windows to report; throws with the reason when the launch is refused or the report cannot be fetched.
 */
function createRealAnthropicUsageProbe(params: RealAnthropicUsageProbeParams): (identity: string) => Promise<UnifiedRateLimit | undefined> {
  return async (identity) => {
    const refusals: string[] = [];
    const plan = prepareLaunch(
      realPrepareLaunchParams(params.paths, {
        proc: {
          env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== CONFIG_DIR_VARIABLE)),
          argv: [`@${identity}`, ...PROBE_LAUNCH_FLAGS],
          exit: (code) => {
            throw new LaunchRefusedError(refusals.join("\n") || `the launch was refused (exit ${String(code)})`, code);
          },
        },
        log: {
          info: () => undefined,
          warn: () => undefined,
          error: (message) => {
            refusals.push(message);
          },
        },
        spawnDaemon: params.spawnDaemon,
        farm: buildFarmRuntime(params.paths, params.cwd),
      }),
    );
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
    }, params.timeoutMs);
    try {
      const session = query({
        prompt: idlePrompt(abort.signal),
        options: {
          pathToClaudeCodeExecutable: plan.bin,
          env: definedEnvironment(plan.env),
          cwd: params.cwd,
          abortController: abort,
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
        },
      });
      try {
        const report = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
        return unifiedFromReportedLimits(report.rate_limits_available ? report.rate_limits : null);
      } finally {
        session.close();
      }
    } finally {
      clearTimeout(timer);
      plan.release();
    }
  };
}

/** What the real refresher needs: the probe's inputs, and the store that records what it fetches. */
interface RealAnthropicUsageRefresherParams extends Omit<RealAnthropicUsageProbeParams, "timeoutMs"> {
  readonly store: UsageStore;
  readonly log: (line: string) => void;
}

/** The refresher wired to the real probe and the usage store: what a launch's pool pick, the front door's background refresh and `agent-shim usage --refresh` all run, so every path fetches and records identically. One probe is bounded by the same period as one usage-endpoint request. */
export function createRealAnthropicUsageRefresher(params: RealAnthropicUsageRefresherParams): AnthropicUsageRefresher {
  return createAnthropicUsageRefresher({
    probe: createRealAnthropicUsageProbe({ paths: params.paths, cwd: params.cwd, spawnDaemon: params.spawnDaemon, timeoutMs: QUOTA_REQUEST_TIMEOUT_MS }),
    record: (identity, rateLimit) => {
      params.store.recordRateLimit(identity, ANTHROPIC_PROVIDER, rateLimit);
    },
    now: () => Date.now(),
    log: params.log,
    concurrency: availableParallelism(),
  });
}

import { availableParallelism } from "node:os";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { createAnthropicUsageRefresher, unifiedFromReportedLimits, type AnthropicUsageRefresher } from "./anthropicUsageRefresh";
import { withIdentityClaude, type IdentityClaudeParams } from "./identityClaude";
import { ANTHROPIC_PROVIDER } from "./middleware";
import { QUOTA_REQUEST_TIMEOUT_MS } from "./quotaRefresh";
import type { UnifiedRateLimit } from "./schema";
import type { UsageStore } from "./store";

/** The launch flags a probe adds: no daemons beyond what the identity's own routing needs, since the probe only asks the usage endpoint and sends no model request. */
const PROBE_LAUNCH_FLAGS = ["--no-headroom", "--no-remote-control"] as const;

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
type RealAnthropicUsageProbeParams = IdentityClaudeParams;

/**
 * Fetches an identity's plan windows from the usage endpoint the way `/usage` does: it plans a launch for the identity (so the CLI runs with the identity's own configuration directory, credential and routing), starts the real `claude` binary through the Agent SDK with no prompt, tools or MCP servers, and asks it for the usage report. No model request is made. Resolves undefined when the account has no plan windows to report; throws with the reason when the launch is refused or the report cannot be fetched.
 */
function createRealAnthropicUsageProbe(params: RealAnthropicUsageProbeParams): (identity: string) => Promise<UnifiedRateLimit | undefined> {
  return async (identity) =>
    await withIdentityClaude(params, identity, PROBE_LAUNCH_FLAGS, async ({ bin, env, cwd, abort }) => {
      // Loaded here, not at the top of the file, so a library host that never asks for usage never loads the SDK.
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const session = query({
        prompt: idlePrompt(abort.signal),
        options: {
          pathToClaudeCodeExecutable: bin,
          env,
          cwd,
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
    });
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

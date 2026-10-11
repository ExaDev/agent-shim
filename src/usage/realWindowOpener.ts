import { withIdentityClaude, type IdentityClaudeParams } from "./identityClaude";
import { successfulResult } from "./sdkResult";
import type { WindowOpener } from "./windowKeeper";

/** The launch flags an opener adds: no daemons beyond the identity's own routing, and usage tracking on so the door records the rate-limit headers of the request, which is what shows the window opened. */
const OPENER_LAUNCH_FLAGS = ["--no-headroom", "--no-remote-control", "--track-usage"] as const;

/** The cheapest model tier, so the request that opens a window draws as little as a request can. */
const WINDOW_OPENING_MODEL = "haiku";

/** One word asked of the model, with a system prompt that asks for nothing more, so the request and its answer stay as small as the SDK allows. */
const WINDOW_OPENING_PROMPT = "ok";
const WINDOW_OPENING_SYSTEM_PROMPT = "Reply with one word.";

/** The longest one opening may take: the CLI's start-up and one model turn, against the ten seconds a usage-endpoint call is given. */
const WINDOW_OPEN_TIMEOUT_MS = 60_000;

/**
 * Opens a five-hour window for an identity by sending one real request through the Agent SDK as that identity: no tools, no MCP servers, no settings sources, nothing persisted, the cheapest model and a single turn. The request is real because a window starts at the first request the account serves, which the usage-endpoint probe (no model request) never makes. Throws with the SDK's own error when the turn fails, and `LaunchRefusedError` when the identity cannot be launched.
 */
export function createRealWindowOpener(params: Omit<IdentityClaudeParams, "timeoutMs">): WindowOpener {
  return async (identity) => {
    await withIdentityClaude({ ...params, timeoutMs: WINDOW_OPEN_TIMEOUT_MS }, identity, OPENER_LAUNCH_FLAGS, async ({ bin, env, cwd, abort }) => {
      // Loaded here, not at the top of the file, so a library host that never opens a window never loads the SDK.
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const session = query({
        prompt: WINDOW_OPENING_PROMPT,
        options: {
          pathToClaudeCodeExecutable: bin,
          env,
          cwd,
          abortController: abort,
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          model: WINDOW_OPENING_MODEL,
          maxTurns: 1,
          tools: [],
          systemPrompt: WINDOW_OPENING_SYSTEM_PROMPT,
          thinking: { type: "disabled" },
        },
      });
      try {
        for await (const message of session) {
          if (message.type === "result") {
            successfulResult(message);
            return;
          }
        }
        throw new Error("the opening request ended without a result");
      } finally {
        session.close();
      }
    });
  };
}

import { withIdentityClaude, type IdentityClaudeParams } from "../usage/identityClaude";
import { JOB_ISOLATION_OPTIONS } from "../usage/realJobRunner";
import { successfulResult } from "../usage/sdkResult";

/** The launch flags a compaction adds: no daemons beyond the identity's own routing, and usage tracking on so the door records the request against the identity it was made as. */
const COMPACT_LAUNCH_FLAGS = ["--no-headroom", "--no-remote-control", "--track-usage"] as const;

/** The most a compaction may run before it is abandoned. It summarises the whole of a conversation's context, which for a large one is a long request; this bounds a request that has hung, not a slow one. */
export const COMPACT_TIMEOUT_MS = 900_000;

/** What a compaction came to. A failure is thrown. */
export type CompactionResult = { readonly kind: "compacted"; readonly beforeTokens?: number; readonly afterTokens?: number } | { readonly kind: "unchanged"; readonly reason: string };

/** The conversation to compact and who compacts it. */
export interface CompactRequest {
  readonly identity: string;
  readonly sessionId: string;
  /** The working directory the conversation belongs to: its transcript is kept under it. */
  readonly cwd: string;
}

/** The size figures a compaction boundary message carries, when it carries them. */
function boundarySizes(message: object): { readonly beforeTokens?: number; readonly afterTokens?: number } {
  if (!("compact_metadata" in message) || typeof message.compact_metadata !== "object" || message.compact_metadata === null) {
    return {};
  }
  const metadata = message.compact_metadata;
  const before = "pre_tokens" in metadata && typeof metadata.pre_tokens === "number" ? metadata.pre_tokens : undefined;
  const after = "post_tokens" in metadata && typeof metadata.post_tokens === "number" ? metadata.post_tokens : undefined;
  return { ...(before === undefined ? {} : { beforeTokens: before }), ...(after === undefined ? {} : { afterTokens: after }) };
}

/**
 * Compacts a conversation as an identity: resumes it through the Agent SDK, with the real `claude` running as that identity (its configuration directory, credential and routing), and sends `/compact`. That is one summarisation request over the conversation's own context, made as the account the session has been running on, and the only model request agent-shim sends on a session's behalf. Only the person's own settings apply and no MCP server starts, as for a job. The conversation keeps its session id; its transcript gains the compaction boundary, which a later `--resume` loads.
 *
 * "Not enough messages to compact" is not a failure: there was nothing to compact, and the conversation is as it was. Aborting `signal` abandons the request.
 */
export function createRealCompactor(params: Omit<IdentityClaudeParams, "cwd" | "timeoutMs">): (request: CompactRequest, signal: AbortSignal) => Promise<CompactionResult> {
  return async (request, signal) =>
    await withIdentityClaude({ paths: params.paths, spawnDaemon: params.spawnDaemon, cwd: request.cwd, timeoutMs: COMPACT_TIMEOUT_MS }, request.identity, COMPACT_LAUNCH_FLAGS, async ({ bin, env, cwd, abort }) => {
      signal.addEventListener("abort", () => {
        abort.abort();
      });
      // Loaded here, not at the top of the file, so a library host that never compacts never loads the SDK.
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const session = query({
        prompt: "/compact",
        options: {
          pathToClaudeCodeExecutable: bin,
          env,
          cwd,
          abortController: abort,
          resume: request.sessionId,
          settingSources: [...JOB_ISOLATION_OPTIONS.settingSources],
          mcpServers: JOB_ISOLATION_OPTIONS.mcpServers,
          strictMcpConfig: JOB_ISOLATION_OPTIONS.strictMcpConfig,
        },
      });
      try {
        let sizes: ReturnType<typeof boundarySizes> | undefined;
        for await (const message of session) {
          if (message.type === "system" && message.subtype === "compact_boundary") {
            sizes = boundarySizes(message);
          }
          if (message.type === "result") {
            const text = successfulResult(message);
            return sizes === undefined ? { kind: "unchanged" as const, reason: text === "" ? "nothing was compacted" : text } : { kind: "compacted" as const, ...sizes };
          }
        }
        throw new Error("the compaction ended without a result");
      } finally {
        session.close();
      }
    });
}

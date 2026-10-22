/** The labels claude-hud draws beside the model name (`getProviderLabel` in its `src/stdin.ts`), each under the condition `modelPlatformOf` states: the names of products, which no language translates. */
export type ModelPlatform = "Bedrock" | "Vertex" | "MiniMax" | "Enterprise";

/** The value Claude Code's switches to a cloud platform (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) take when they are on. */
const SWITCH_ON = "1";

/** The base URLs claude-hud labels MiniMax (its `MINIMAX_ANTHROPIC_ENDPOINTS`), each as its origin and path with no trailing slash, the form a base URL is compared in. */
const MINIMAX_ENDPOINTS: ReadonlySet<string> = new Set(["https://api.minimax.io/anthropic", "https://api.minimaxi.com/anthropic"]);

/** The model ids claude-hud labels Enterprise (its `isEnterpriseModelId`), in lower case. */
const ENTERPRISE_MODEL_IDS: ReadonlySet<string> = new Set(["opusplan", "sonnetplan", "haikuplan"]);

/** Whether the session's Anthropic base URL (`ANTHROPIC_BASE_URL`, else `ANTHROPIC_API_BASE_URL`, each trimmed and ignored when empty) is one of `MINIMAX_ENDPOINTS`, compared by origin and path with any trailing slash dropped; a base URL that is not a URL is no endpoint. */
function isMiniMaxEndpoint(env: Readonly<Record<string, string | undefined>>): boolean {
  const base = [env.ANTHROPIC_BASE_URL, env.ANTHROPIC_API_BASE_URL].map((value) => value?.trim() ?? "").find((value) => value !== "");
  if (base === undefined || !URL.canParse(base)) {
    return false;
  }
  const url = new URL(base);
  return MINIMAX_ENDPOINTS.has(`${url.origin}${url.pathname.replace(/\/+$/, "")}`);
}

/**
 * The label claude-hud draws beside the model name, as its `getProviderLabel` chooses it, or undefined when none applies: Bedrock when `CLAUDE_CODE_USE_BEDROCK` is on, else Vertex when `CLAUDE_CODE_USE_VERTEX` is on, else MiniMax when the Anthropic base URL is one of `MINIMAX_ENDPOINTS`, else Enterprise when the client's model id is one of `ENTERPRISE_MODEL_IDS` in any case. The first that holds wins.
 * @param env - The environment the statusline runs in, which is the client's.
 * @param modelId - The model id the client's payload reports, or undefined when it reports none.
 */
export function modelPlatformOf(env: Readonly<Record<string, string | undefined>>, modelId: string | undefined): ModelPlatform | undefined {
  if (env.CLAUDE_CODE_USE_BEDROCK === SWITCH_ON) {
    return "Bedrock";
  }
  if (env.CLAUDE_CODE_USE_VERTEX === SWITCH_ON) {
    return "Vertex";
  }
  if (isMiniMaxEndpoint(env)) {
    return "MiniMax";
  }
  if (modelId !== undefined && ENTERPRISE_MODEL_IDS.has(modelId.toLowerCase())) {
    return "Enterprise";
  }
  return undefined;
}

/** The text claude-hud's `isBedrockModelId` looks for in a model id, which Amazon Bedrock's model ids for Anthropic's models carry. */
const BEDROCK_MODEL_ID_MARK = "anthropic.claude-";

/**
 * Whether a model id is a Bedrock one, as claude-hud's `isBedrockModelId` decides it: it contains `anthropic.claude-` in any case.
 * @param modelId - The model id the client's payload reports, or undefined when it reports none.
 */
export function isBedrockModelId(modelId: string | undefined): boolean {
  return modelId?.toLowerCase().includes(BEDROCK_MODEL_ID_MARK) === true;
}

/**
 * Whether the subscription windows (the signed-in account's five-hour, weekly and per-model weekly windows) do not apply to the session, as claude-hud's `shouldHideUsage` decides it: it is a Bedrock session, by the Bedrock switch (`modelPlatformOf` choosing Bedrock) or by a Bedrock model id (`isBedrockModelId`), and Bedrock is billed by use with none of those windows to spend. A provider's own windows and a model family's are not subscription windows and this says nothing about them.
 * @param env - The environment the statusline runs in, which is the client's.
 * @param modelId - The model id the client's payload reports, or undefined when it reports none.
 */
export function hidesSubscriptionWindows(env: Readonly<Record<string, string | undefined>>, modelId: string | undefined): boolean {
  return modelPlatformOf(env, modelId) === "Bedrock" || isBedrockModelId(modelId);
}

/** The platforms a session can reach a Claude model through other than Anthropic's own API, by the name the statusline draws for each: the names of products, which no language translates. */
export type ModelPlatform = "Bedrock" | "Vertex" | "MiniMax" | "Enterprise";

/** The value Claude Code's switches to a cloud platform (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) take when they are on. */
const SWITCH_ON = "1";

/** The Anthropic-compatible endpoints MiniMax serves, each as its origin and path with no trailing slash, the form a base URL is compared in. */
const MINIMAX_ENDPOINTS: ReadonlySet<string> = new Set(["https://api.minimax.io/anthropic", "https://api.minimaxi.com/anthropic"]);

/** The model ids Claude Code's enterprise plans select a planning mode by, in lower case. */
const ENTERPRISE_MODEL_IDS: ReadonlySet<string> = new Set(["opusplan", "sonnetplan", "haikuplan"]);

/** Whether the session's Anthropic base URL (`ANTHROPIC_BASE_URL`, else `ANTHROPIC_API_BASE_URL`, each trimmed and ignored when empty) is one of MiniMax's endpoints, compared by origin and path with any trailing slash dropped; a base URL that is not a URL is no endpoint. */
function isMiniMaxEndpoint(env: Readonly<Record<string, string | undefined>>): boolean {
  const base = [env.ANTHROPIC_BASE_URL, env.ANTHROPIC_API_BASE_URL].map((value) => value?.trim() ?? "").find((value) => value !== "");
  if (base === undefined || !URL.canParse(base)) {
    return false;
  }
  const url = new URL(base);
  return MINIMAX_ENDPOINTS.has(`${url.origin}${url.pathname.replace(/\/+$/, "")}`);
}

/**
 * The platform the session's model is served through, as claude-hud detects it, or undefined for Anthropic's own API: Bedrock when `CLAUDE_CODE_USE_BEDROCK` is on, else Vertex when `CLAUDE_CODE_USE_VERTEX` is on, else MiniMax when the Anthropic base URL is a MiniMax endpoint, else Enterprise when the client's model id is one of the enterprise planning modes. The first that holds wins.
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

/** The text a Bedrock model id carries, which a session routed through Amazon Bedrock reports even when no environment switch says so. */
const BEDROCK_MODEL_ID_MARK = "anthropic.claude-";

/**
 * Whether the subscription windows do not apply to the session, as claude-hud decides it: it is served through Amazon Bedrock, by the environment switch or by the model id the client reports, and Bedrock is billed by use with no five-hour or weekly window to draw.
 * @param env - The environment the statusline runs in, which is the client's.
 * @param modelId - The model id the client's payload reports, or undefined when it reports none.
 */
export function hidesSubscriptionWindows(env: Readonly<Record<string, string | undefined>>, modelId: string | undefined): boolean {
  return modelPlatformOf(env, modelId) === "Bedrock" || (modelId?.toLowerCase().includes(BEDROCK_MODEL_ID_MARK) ?? false);
}

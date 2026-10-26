import type { UsageRecord } from "../usage/schema";
import type { StatuslineSummary } from "./enrich";
import type { RenderContext } from "./elements/context";
import type { ClientPayload } from "./payload";
import { isBedrockModelId } from "./platform";

/** A model's prices in US dollars per million tokens, as `agent-shim model price` stores them, keyed by `<provider>/<model>`. */
export type ModelPrices = Readonly<Record<string, Readonly<{ input: number; output: number }>>>;

const TOKENS_PER_MILLION = 1_000_000;

/** A cache write costs this multiple of the input price and a cache read this fraction of it: Anthropic's published prompt-caching ratios. The prices agent-shim holds carry no cache figures, so another provider's cache tokens are priced by the same ratios, which makes its estimate an approximation. */
const CACHE_WRITE_PRICE_RATIO = 1.25;
const CACHE_READ_PRICE_RATIO = 0.1;

/**
 * What the requests the door served for one session cost, priced from the configured per-model prices, or undefined when there is nothing to state. A request whose model has no configured price makes the whole figure undefined: a total that silently left a request out would read as lower than the bill, which is worse than no total. Requests that returned no token counts (errors, aborted calls) cost nothing and are skipped.
 */
export function doorCostUsdOf(records: readonly UsageRecord[], prices: ModelPrices): number | undefined {
  let totalUsd = 0;
  let costed = 0;
  for (const record of records) {
    const { usage } = record;
    if (usage === undefined) {
      continue;
    }
    const price = record.model === undefined ? undefined : prices[`${record.provider}/${record.model}`];
    if (price === undefined) {
      return undefined;
    }
    const inputUsd = ((usage.inputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) * CACHE_WRITE_PRICE_RATIO + (usage.cacheReadInputTokens ?? 0) * CACHE_READ_PRICE_RATIO) * price.input;
    totalUsd += (inputUsd + (usage.outputTokens ?? 0) * price.output) / TOKENS_PER_MILLION;
    costed += 1;
  }
  return costed === 0 ? undefined : totalUsd;
}

/** Whether a model id names a cloud platform's own copy of a model (a Bedrock id, `isBedrockModelId`, or Vertex's `...@<version>`), whose bill is the platform's and not the client's. */
function isCloudModelId(modelId: string | undefined): boolean {
  return modelId !== undefined && (isBedrockModelId(modelId) || modelId.includes("@"));
}

/** Whether the session's spend is billed by someone other than Anthropic for the client's own sign-in: its launch selected a provider, or its model id is a cloud platform's. The client's cost figure is then a table lookup for a name it may not know, not a bill. */
function isRoutedSession(summary: StatuslineSummary, payload: ClientPayload): boolean {
  return summary.provider !== undefined || isCloudModelId(payload.model?.id);
}

/** A session's cost and where it came from: `native` is the client's own figure, `estimate` one priced from the door's usage log. */
export interface SessionCost {
  readonly usd: number;
  readonly source: "native" | "estimate";
}

/**
 * The cost to draw for the session. A direct session draws the client's own figure, else the door's estimate when prices are configured. A routed session draws nothing unless `cost.routed` is set, because the client's figure is not its bill; with it set, the door's real requests priced by the configured prices come first, and the client's figure only when it is above zero (a routed session's client reads zero until its first response).
 */
export function resolveSessionCost({ summary, payload, settings }: RenderContext): SessionCost | undefined {
  const native = payload.cost?.total_cost_usd;
  const door = summary.doorCostUsd;
  if (!isRoutedSession(summary, payload)) {
    if (native !== undefined) {
      return { usd: native, source: "native" };
    }
    return door === undefined ? undefined : { usd: door, source: "estimate" };
  }
  if (!settings.cost.routed) {
    return undefined;
  }
  if (door !== undefined) {
    return { usd: door, source: "estimate" };
  }
  return native !== undefined && native > 0 ? { usd: native, source: "native" } : undefined;
}

/** Amounts from a dollar up are written to the cent; below it they carry more places, so a session's first cents are not drawn as nothing. */
const CENTS_FROM_USD = 1;
const MILLS_FROM_USD = 0.1;
const MILL_PLACES = 3;
const FINE_PLACES = 4;

/** A dollar amount as `$1.23`, `$0.123` or `$0.0123`. */
export function formatUsd(usd: number): string {
  if (usd >= CENTS_FROM_USD) {
    return `$${usd.toFixed(2)}`;
  }
  return usd >= MILLS_FROM_USD ? `$${usd.toFixed(MILL_PLACES)}` : `$${usd.toFixed(FINE_PLACES)}`;
}

import type { UsageRecord } from "../usage/schema";

/** What has been observed about one target (`provider/model` or `acct:identity/model`), as the ranked and adaptive modes read it. */
export interface TargetObservation {
  /** The median latency of the target's completed requests, in milliseconds. */
  readonly latencyMs: number | undefined;
  /** The share of the target's requests that completed, from 0 to 1. */
  readonly successRate: number | undefined;
  /** The observed token mix: input, output and cache-read tokens the target has served, for weighing a price. */
  readonly tokenMix: { readonly input: number; readonly output: number; readonly cacheRead: number } | undefined;
}

/** The key an observation is held under: the record's provider and model together. */
export function targetOf(record: Readonly<Pick<UsageRecord, "provider"> & { readonly model?: string }>): string | undefined {
  return record.model === undefined ? undefined : `${record.provider}/${record.model}`;
}

/** The median of a list of numbers, or undefined for an empty one. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const above = sorted[middle];
  const below = sorted[middle - 1];
  return sorted.length % 2 === 0 && above !== undefined && below !== undefined ? (above + below) / 2 : sorted[middle];
}

/** How many recent records per target the observation carries: enough to be stable, few enough that one bad minute ages out. */
export const OBSERVATION_WINDOW = 20;

/**
 * Folds one finished record into the per-target observations. A record without a model (a count-tokens call, a refused request) leaves everything unchanged, because it says nothing about a target's speed or reliability.
 */
export function observeRecord(observations: ReadonlyMap<string, readonly UsageRecord[]>, record: Readonly<UsageRecord>): Map<string, readonly UsageRecord[]> {
  const target = targetOf(record);
  if (target === undefined) {
    return new Map(observations);
  }
  const kept = [...(observations.get(target) ?? []), record].slice(-OBSERVATION_WINDOW);
  return new Map(observations).set(target, kept);
}

/** The observation a target's recent records give: its median latency, its success rate and the tokens it has served. */
export function observationOf(records: readonly UsageRecord[]): TargetObservation {
  const completed = records.filter((record) => record.outcome === "completed");
  const latencies = completed.map((record) => record.latencyMs);
  const usage = records.flatMap((record) => (record.usage === undefined ? [] : [record.usage]));
  const input = usage.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0);
  const output = usage.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0);
  const cacheRead = usage.reduce((sum, entry) => sum + (entry.cacheReadInputTokens ?? 0), 0);
  return {
    latencyMs: median(latencies),
    successRate: records.length === 0 ? undefined : completed.length / records.length,
    tokenMix: input + output + cacheRead === 0 ? undefined : { input, output, cacheRead },
  };
}

/** Blends a target's input and output prices into the per-million-token figure the `cheapest` mode ranks by, weighted by the tokens the session has actually been sending. Cache reads count in the denominator at nothing, because a cache hit costs a fraction of either price and the blend needs only to rank. */
export function blendedPricePerMTok(prices: Readonly<{ input: number; output: number }>, mix: Readonly<{ input: number; output: number; cacheRead: number }>): number | undefined {
  const total = mix.input + mix.output + mix.cacheRead;
  if (total === 0) {
    return undefined;
  }
  return (prices.input * mix.input + prices.output * mix.output) / total;
}

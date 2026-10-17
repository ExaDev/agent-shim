import { describe, expect, it } from "vitest";

import type { UsageRecord } from "../usage/schema";
import { blendedPricePerMTok, observeRecord, observationOf, OBSERVATION_WINDOW, targetOf } from "./signals";

/** A finished record for a model, with the fields the observations read. */
function record(overrides: Partial<Pick<UsageRecord, "provider" | "model" | "latencyMs" | "outcome" | "usage">> & { readonly model?: string }): UsageRecord {
  return {
    schemaVersion: 1,
    at: "2026-10-17T00:00:00.000Z",
    provider: "z",
    route: "passthrough",
    method: "POST",
    endpoint: "/v1/messages",
    status: 200,
    latencyMs: 100,
    durationMs: 150,
    outcome: "completed",
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
    ...overrides,
    ...(overrides.usage === undefined ? {} : { usage: overrides.usage }),
  };
}

const EXTRA_RECORDS = 5;
const PRICE_INPUT = 3;
const PRICE_OUTPUT = 9;
const MIX_INPUT = 300;
const MIX_OUTPUT = 100;
const MIX_CACHE = 600;

describe("targetOf", () => {
  it("keys a record by its provider and model, and a record with no model not at all", () => {
    expect(targetOf({ provider: "z", model: "glm-5.3" })).toBe("z/glm-5.3");
    expect(targetOf({ provider: "z" })).toBeUndefined();
  });
});

describe("observeRecord and observationOf", () => {
  it("holds each target's records apart, keyed by target", () => {
    const observations = observeRecord(observeRecord(new Map(), record({ model: "a" })), record({ model: "b", provider: "m" }));
    expect([...observations.keys()].sort()).toEqual(["m/b", "z/a"]);
  });

  it("keeps only the recent window per target", () => {
    let observations = new Map();
    for (let index = 0; index < OBSERVATION_WINDOW + EXTRA_RECORDS; index += 1) {
      observations = observeRecord(observations, record({ model: "a", latencyMs: index }));
    }
    expect(observations.get("z/a")).toHaveLength(OBSERVATION_WINDOW);
  });

  it("reads the median latency of completed requests and the share that completed", () => {
    const records = [record({ model: "a", latencyMs: 100 }), record({ model: "a", latencyMs: 300 }), record({ model: "a", latencyMs: 200 }), record({ model: "a", outcome: "aborted", latencyMs: 999 })];
    expect(observationOf(records)).toMatchObject({ latencyMs: 200, successRate: 0.75 });
  });

  it("sums the tokens served into the mix, and yields nothing for records without usage", () => {
    expect(observationOf([record({ model: "a", usage: { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 60, cacheCreationInputTokens: 0 } })]).tokenMix).toEqual({ input: 100, output: 40, cacheRead: 60 });
    expect(observationOf([record({ model: "a" })]).tokenMix).toBeUndefined();
    expect(observationOf([])).toEqual({ latencyMs: undefined, successRate: undefined, tokenMix: undefined });
  });
});

describe("blendedPricePerMTok", () => {
  it("weights the input and output prices by the tokens actually sent", () => {
    expect(blendedPricePerMTok({ input: PRICE_INPUT, output: PRICE_OUTPUT }, { input: MIX_INPUT, output: MIX_OUTPUT, cacheRead: 0 })).toBe((PRICE_INPUT * MIX_INPUT + PRICE_OUTPUT * MIX_OUTPUT) / (MIX_INPUT + MIX_OUTPUT));
  });

  it("counts cache reads in the denominator at nothing, so a cache-heavy session lowers the blend", () => {
    expect(blendedPricePerMTok({ input: PRICE_INPUT, output: PRICE_OUTPUT }, { input: MIX_INPUT, output: MIX_OUTPUT, cacheRead: MIX_CACHE })).toBe((PRICE_INPUT * MIX_INPUT + PRICE_OUTPUT * MIX_OUTPUT) / (MIX_INPUT + MIX_OUTPUT + MIX_CACHE));
  });

  it("yields nothing for an empty mix", () => {
    expect(blendedPricePerMTok({ input: PRICE_INPUT, output: PRICE_OUTPUT }, { input: 0, output: 0, cacheRead: 0 })).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { resolveStatusline } from "../config/statusline";
import { USAGE_SCHEMA_VERSION, type UsageRecord } from "../usage/schema";
import { doorCostUsdOf, formatUsd, resolveSessionCost, type ModelPrices } from "./cost";
import { fakeRenderContext, fakeStatuslineSummary } from "./testing";

const MILLION = 1_000_000;
const GLM_INPUT = 0.6;
const GLM_OUTPUT = 2.2;
const OPUS_OUTPUT = 25;
const CACHE_WRITE_RATIO = 1.25;
const CACHE_READ_RATIO = 0.1;
const PRICES: ModelPrices = { "z/glm-5.3": { input: GLM_INPUT, output: GLM_OUTPUT }, "anthropic/claude-opus-5-5": { input: 5, output: OPUS_OUTPUT } };
const NATIVE_USD = 1.234;
const DOOR_USD = 0.5;

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return { schemaVersion: USAGE_SCHEMA_VERSION, at: "2026-10-19T10:00:00.000Z", provider: "z", route: "passthrough", method: "POST", endpoint: "/v1/messages", status: 200, latencyMs: 1, durationMs: 1, outcome: "completed", ...overrides };
}

describe("doorCostUsdOf", () => {
  it("prices input and output tokens per million", () => {
    const cost = doorCostUsdOf([record({ model: "glm-5.3", usage: { inputTokens: MILLION, outputTokens: MILLION / 2 } })], PRICES);
    expect(cost).toBeCloseTo(GLM_INPUT + GLM_OUTPUT / 2);
  });

  it("prices a cache write at one and a quarter times the input price and a cache read at a tenth", () => {
    const cost = doorCostUsdOf([record({ model: "glm-5.3", usage: { cacheCreationInputTokens: MILLION, cacheReadInputTokens: MILLION } })], PRICES);
    expect(cost).toBeCloseTo(GLM_INPUT * CACHE_WRITE_RATIO + GLM_INPUT * CACHE_READ_RATIO);
  });

  it("sums the requests, each at its own provider and model's price", () => {
    const cost = doorCostUsdOf([record({ model: "glm-5.3", usage: { inputTokens: MILLION } }), record({ provider: "anthropic", model: "claude-opus-5-5", usage: { outputTokens: MILLION } })], PRICES);
    expect(cost).toBeCloseTo(GLM_INPUT + OPUS_OUTPUT);
  });

  it("states nothing when a request's model has no price, rather than a total that leaves it out", () => {
    const records = [record({ model: "glm-5.3", usage: { inputTokens: MILLION } }), record({ model: "glm-6", usage: { inputTokens: 1 } })];
    expect(doorCostUsdOf(records, PRICES)).toBeUndefined();
    expect(doorCostUsdOf([record({ usage: { inputTokens: 1 } })], PRICES)).toBeUndefined();
  });

  it("skips requests with no token counts, and states nothing when none had any", () => {
    expect(doorCostUsdOf([record({ model: "glm-6", status: 500 })], PRICES)).toBeUndefined();
    expect(doorCostUsdOf([], PRICES)).toBeUndefined();
    expect(doorCostUsdOf([record({ model: "glm-6" }), record({ model: "glm-5.3", usage: { inputTokens: MILLION } })], PRICES)).toBeCloseTo(GLM_INPUT);
  });
});

describe("a routed session", () => {
  const cost = { total_cost_usd: NATIVE_USD };
  const enabled = resolveStatusline({ cost: { routed: true } });
  /** Whether the context's session is drawn as routed: with routed cost off it draws no cost at all, and with it on the client's own figure. */
  const isRouted = (context: Parameters<typeof resolveSessionCost>[0]): boolean => resolveSessionCost(context) === undefined && resolveSessionCost({ ...context, settings: enabled }) !== undefined;

  it("is not one when the session is on the client's own sign-in with a direct model id", () => {
    expect(isRouted(fakeRenderContext({ payload: { cost } }))).toBe(false);
  });

  it("is one when the launch selected a provider", () => {
    expect(isRouted(fakeRenderContext({ payload: { cost }, summary: fakeStatuslineSummary({ provider: "z.ai" }) }))).toBe(true);
  });

  it("is one for a Bedrock or Vertex model id", () => {
    for (const id of ["us.anthropic.claude-sonnet-4-5-v1:0", "claude-sonnet-4-5@20250929"]) {
      expect(isRouted(fakeRenderContext({ payload: { cost, model: { id } } })), id).toBe(true);
    }
  });
});

describe("resolveSessionCost", () => {
  const cost = { total_cost_usd: NATIVE_USD };

  it("draws a direct session's own figure, as native", () => {
    expect(resolveSessionCost(fakeRenderContext({ payload: { cost }, summary: fakeStatuslineSummary({ doorCostUsd: DOOR_USD }) }))).toEqual({ usd: NATIVE_USD, source: "native" });
  });

  it("falls back to the door's estimate for a direct session whose client reports no figure", () => {
    expect(resolveSessionCost(fakeRenderContext({ summary: fakeStatuslineSummary({ doorCostUsd: DOOR_USD }) }))).toEqual({ usd: DOOR_USD, source: "estimate" });
    expect(resolveSessionCost(fakeRenderContext())).toBeUndefined();
  });

  it("draws nothing for a routed session unless routed cost is set", () => {
    const summary = fakeStatuslineSummary({ provider: "z.ai", doorCostUsd: DOOR_USD });
    expect(resolveSessionCost(fakeRenderContext({ summary, payload: { cost } }))).toBeUndefined();
    const enabled = resolveStatusline({ cost: { routed: true } });
    expect(resolveSessionCost(fakeRenderContext({ summary, payload: { cost }, settings: enabled }))).toEqual({ usd: DOOR_USD, source: "estimate" });
  });

  it("prefers the door's figure for a routed session, and uses the client's only when it is above zero", () => {
    const settings = resolveStatusline({ cost: { routed: true } });
    const routed = fakeStatuslineSummary({ provider: "z.ai" });
    expect(resolveSessionCost(fakeRenderContext({ summary: routed, payload: { cost }, settings }))).toEqual({ usd: NATIVE_USD, source: "native" });
    expect(resolveSessionCost(fakeRenderContext({ summary: routed, payload: { cost: { total_cost_usd: 0 } }, settings }))).toBeUndefined();
  });
});

const SEVERAL_DOLLARS = 12.345;
const HALF_A_DOLLAR = 0.5;
const A_TENTH = 0.1;
const A_FEW_CENTS = 0.0123;
/** Amounts and how they are written: to the cent from a dollar, three places from a tenth, four below. */
const AMOUNTS: readonly (readonly [number, string])[] = [
  [SEVERAL_DOLLARS, "$12.35"],
  [1, "$1.00"],
  [HALF_A_DOLLAR, "$0.500"],
  [A_TENTH, "$0.100"],
  [A_FEW_CENTS, "$0.0123"],
  [0, "$0.0000"],
];

describe("formatUsd", () => {
  it("writes a dollar and over to the cent, and less with more places so the first cents show", () => {
    for (const [usd, text] of AMOUNTS) {
      expect(formatUsd(usd), text).toBe(text);
    }
  });
});

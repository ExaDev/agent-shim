import { describe, expect, it } from "vitest";

import { parseTranscriptRecord } from "./record";
import { EMPTY_TOKEN_STATE, foldTokens, TokenStateSchema, totalTokens } from "./tokens";

function line(id: string | undefined, usage: Record<string, unknown>, type = "assistant"): string {
  return JSON.stringify({ type, message: { ...(id === undefined ? {} : { id }), usage } });
}

const FIRST = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 };
const SECOND = { input_tokens: 2, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 1100 };
const BOTH = { inputTokens: 12, outputTokens: 12, cacheCreationTokens: 100, cacheReadTokens: 2100 };
const ONLY_FIRST = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 100, cacheReadTokens: 1000 };
const INPUT_OF_BOTH = 12;
const STREAMED_OUTPUT_START = 1;
const STREAMED_OUTPUT_PEAK = 9;
const STREAMED_OUTPUT_UNDERSTATED = 4;
const NEGATIVE_COUNT = -1;
const HALF_TOKEN = 0.5;
const QUARTER_TOKEN = 0.25;
const ALMOST_TWO_TOKENS = 1.9;
const OUTPUT_OF_FRACTIONS = 20;

function fold(lines: readonly string[], from = EMPTY_TOKEN_STATE) {
  return lines.reduce((state, text) => {
    const record = parseTranscriptRecord(text);
    return record === undefined ? state : foldTokens(state, record);
  }, from);
}

describe("foldTokens", () => {
  it("sums the four counts over the responses", () => {
    expect(fold([line("a", FIRST), line("b", SECOND)]).totals).toEqual(BOTH);
  });

  it("truncates each response's counts to whole tokens before summing them, as claude-hud does", () => {
    const fractions = fold([line("a", { input_tokens: HALF_TOKEN, output_tokens: OUTPUT_OF_FRACTIONS }), line("b", { input_tokens: QUARTER_TOKEN, output_tokens: 0 })]);
    expect(fractions.totals).toEqual({ inputTokens: 0, outputTokens: OUTPUT_OF_FRACTIONS, cacheCreationTokens: 0, cacheReadTokens: 0 });
    expect(fold([line("c", { cache_read_input_tokens: ALMOST_TWO_TOKENS })]).totals.cacheReadTokens).toBe(1);
  });

  it("adds the growth of a streamed response in whole tokens, each record's count truncated first", () => {
    const streamed = fold([line("a", { output_tokens: HALF_TOKEN }), line("a", { output_tokens: ALMOST_TWO_TOKENS }), line("a", { output_tokens: ALMOST_TWO_TOKENS })]);
    expect(streamed.totals.outputTokens).toBe(1);
  });

  it("counts a response once however many of its records repeat its usage", () => {
    expect(fold([line("a", FIRST), line("a", FIRST), line("a", FIRST)]).totals).toEqual(ONLY_FIRST);
  });

  it("adds only the growth of a response's output as its later records carry more of it", () => {
    const streamed = fold([
      line("a", { ...FIRST, output_tokens: STREAMED_OUTPUT_START }),
      line("a", { ...FIRST, output_tokens: STREAMED_OUTPUT_PEAK }),
      line("a", { ...FIRST, output_tokens: STREAMED_OUTPUT_UNDERSTATED }),
    ]).totals;
    expect(streamed.outputTokens).toBe(STREAMED_OUTPUT_PEAK);
    expect(streamed.inputTokens).toBe(ONLY_FIRST.inputTokens);
  });

  it("tells responses apart by their id even when other records fall between a response's records", () => {
    const between = JSON.stringify({ type: "user", message: { content: "x" } });
    expect(fold([line("a", FIRST), between, line("a", FIRST), line("b", SECOND)]).totals.inputTokens).toBe(INPUT_OF_BOTH);
  });

  it("tells a response with no id from its neighbour by its counts", () => {
    expect(fold([line(undefined, FIRST), line(undefined, FIRST), line(undefined, SECOND)]).totals.inputTokens).toBe(INPUT_OF_BOTH);
  });

  it("reads a count that is missing or malformed as nothing, and skips records that carry no usage", () => {
    const lines = [line("a", { input_tokens: 3 }), line("b", { input_tokens: "many", output_tokens: 2 }), line("c", { input_tokens: NEGATIVE_COUNT }), line("d", FIRST, "user"), JSON.stringify({ type: "assistant", message: { id: "e" } })];
    expect(fold(lines).totals).toEqual({ inputTokens: 3, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0 });
  });

  it("carries on from a state kept between refreshes, so reading in two parts gives what reading whole does", () => {
    const lines = [line("a", FIRST), line("a", FIRST), line("b", SECOND), line("b", SECOND), line("c", FIRST)];
    const whole = fold(lines);
    for (let split = 0; split <= lines.length; split += 1) {
      const kept = TokenStateSchema.parse(JSON.parse(JSON.stringify(fold(lines.slice(0, split)))));
      expect(fold(lines.slice(split), kept), `split at ${String(split)}`).toEqual(whole);
    }
  });
});

describe("totalTokens", () => {
  it("adds the four counts", () => {
    expect(totalTokens(BOTH)).toBe(BOTH.inputTokens + BOTH.outputTokens + BOTH.cacheCreationTokens + BOTH.cacheReadTokens);
  });
});

describe("TokenStateSchema", () => {
  it("refuses a state with a negative or missing count, so a damaged cache is not trusted", () => {
    expect(TokenStateSchema.safeParse({ totals: { ...ONLY_FIRST, inputTokens: NEGATIVE_COUNT } }).success).toBe(false);
    expect(TokenStateSchema.safeParse({ totals: { inputTokens: 1 } }).success).toBe(false);
  });

  it("refuses a state holding a fraction of a token, which was folded before counts were truncated", () => {
    expect(TokenStateSchema.safeParse({ totals: { ...ONLY_FIRST, inputTokens: HALF_TOKEN } }).success).toBe(false);
  });
});

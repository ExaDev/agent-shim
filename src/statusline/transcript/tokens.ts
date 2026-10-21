import { z } from "zod";

import type { TranscriptRecord } from "./record";

const tokenCount = z.number().nonnegative();

/** The tokens a session has used, summed over every response its transcript records, by the four counts the API reports. */
const SessionTokensSchema = z.strictObject({ inputTokens: tokenCount, outputTokens: tokenCount, cacheCreationTokens: tokenCount, cacheReadTokens: tokenCount });
export type SessionTokens = z.infer<typeof SessionTokensSchema>;

/** What folding the records so far has found: the totals, and the response whose records were read last, because more of its records may follow. It is JSON-serialisable, because the statusline keeps it between refreshes. */
export const TokenStateSchema = z.strictObject({
  totals: SessionTokensSchema,
  open: z.strictObject({ key: z.string(), usage: SessionTokensSchema }).optional(),
});
export type TokenState = z.infer<typeof TokenStateSchema>;

const NO_TOKENS: SessionTokens = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

/** The state before any record has been read. */
export const EMPTY_TOKEN_STATE: TokenState = { totals: NO_TOKENS };

/** The sum of the four counts: everything the session has had processed. */
export function totalTokens(tokens: Readonly<SessionTokens>): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
}

/** What a response's later records add to its earlier ones: its counts only grow while it streams, so each count adds its increase, and a record that repeats or understates it adds nothing. */
function increase(from: Readonly<SessionTokens>, to: Readonly<SessionTokens>): SessionTokens {
  return {
    inputTokens: Math.max(0, to.inputTokens - from.inputTokens),
    outputTokens: Math.max(0, to.outputTokens - from.outputTokens),
    cacheCreationTokens: Math.max(0, to.cacheCreationTokens - from.cacheCreationTokens),
    cacheReadTokens: Math.max(0, to.cacheReadTokens - from.cacheReadTokens),
  };
}

function sum(left: Readonly<SessionTokens>, right: Readonly<SessionTokens>): SessionTokens {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  };
}

function larger(left: Readonly<SessionTokens>, right: Readonly<SessionTokens>): SessionTokens {
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    cacheCreationTokens: Math.max(left.cacheCreationTokens, right.cacheCreationTokens),
    cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
  };
}

/**
 * `state` after one more transcript record, read in file order. Claude Code writes one record per content block of a response and repeats the response's usage on each, so the records of one response are one response: they are told apart by the response's id, and only their increase is counted. The records of a response are adjacent among the records that carry usage (others may fall between them), which is why remembering only the last response is enough. A response without an id is told apart from its neighbours by its counts, so two identical records in a row are one response written twice.
 */
export function foldTokens(state: TokenState, record: TranscriptRecord): TokenState {
  const usage = record.message?.usage;
  if (record.type !== "assistant" || usage === undefined) {
    return state;
  }
  // The counters are never negative, so a counter of zero falls back to the same zero and either way reads the same.
  const counts: SessionTokens = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
  // The schema's least message id is one character, so an empty one is already absent and the fallback reads the same.
  const key = record.message?.id ?? `${String(counts.inputTokens)}|${String(counts.outputTokens)}|${String(counts.cacheCreationTokens)}|${String(counts.cacheReadTokens)}`;
  if (state.open?.key === key) {
    return { totals: sum(state.totals, increase(state.open.usage, counts)), open: { key, usage: larger(state.open.usage, counts) } };
  }
  return { totals: sum(state.totals, counts), open: { key, usage: counts } };
}

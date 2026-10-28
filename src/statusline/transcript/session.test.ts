import { describe, expect, it } from "vitest";

import { PROMPT_CACHE_TTL_SECONDS } from "../../config/statusline";
import { parseTranscriptRecord } from "./record";
import { EMPTY_LATEST_STATE, EMPTY_SESSION_STATE, foldLatest, foldSession, LatestStateSchema, sessionFactsOf, type LatestState, type SessionFacts, type SessionState } from "./session";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const SECOND = 1_000;
const MINUTE = 60_000;
/** The tokens a compaction left, and the same with a fraction the client might write, which is truncated to it. */
const POST_TOKENS = 30_000;
const POST_TOKENS_FRACTIONAL = 30_000.7;
/** The tokens the context held before a compaction, which the client writes beside the tokens it left. */
const PRE_TOKENS = 150_000;
/** A number of milliseconds beyond the range `new Date` accepts, which it reads as no date. */
const BEYOND_DATE_RANGE_MS = 1e20;
/** A time before the epoch, which a transcript can be stamped with on a clock set back that far. */
const BEFORE_EPOCH = "1969-12-31T23:59:59.000Z";
/** A time later than any clock the tests run at. */
const AFTER_ANY_CLOCK = "9999-12-31T00:00:00.000Z";

/** Offsets from `T0`, named for what they are. */
const AT = {
  minusFiveSeconds: -5_000,
  twoSeconds: 2_000,
  fiveSeconds: 5_000,
  nineSeconds: 9_000,
  tenSeconds: 10_000,
  twelveSeconds: 12_000,
  twentySeconds: 20_000,
  thirtySeconds: 30_000,
  fortySeconds: 40_000,
  twoMinutes: 120_000,
  fiveMinutes: 300_000,
};

/** The ISO time `ms` after `T0`. */
function at(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

/** The facts after folding records in order. */
function factsOf(...records: readonly Record<string, unknown>[]): SessionFacts {
  return sessionFactsOf(
    records.reduce<SessionState>((state, record) => {
      const parsed = parseTranscriptRecord(JSON.stringify(record));
      return parsed === undefined ? state : foldSession(state, parsed);
    }, EMPTY_SESSION_STATE),
  );
}

const prompt = (ms: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "user", timestamp: at(ms), message: { content: "hello" }, ...extra });
const reply = (ms: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "assistant", timestamp: at(ms), requestId: "req-1", message: { model: "claude-sonnet-5-5", content: [] }, ...extra });
const write = (tier: "ephemeral_5m_input_tokens" | "ephemeral_1h_input_tokens"): Record<string, unknown> => ({ message: { usage: { cache_creation: { [tier]: 100 } } } });

describe("session facts from the transcript", () => {
  it("names the session by its `/rename` title, else its generated name, whichever order they were written in", () => {
    expect(factsOf({ type: "user", slug: "zesty-prancing-umbrella" }).title).toBe("zesty-prancing-umbrella");
    expect(factsOf({ type: "custom-title", customTitle: "my-name" }, { type: "user", slug: "zesty-prancing-umbrella" }).title).toBe("my-name");
    expect(factsOf({ type: "user", slug: "zesty-prancing-umbrella" }, { type: "custom-title", customTitle: "my-name" }).title).toBe("my-name");
    expect(factsOf({ type: "custom-title", customTitle: "first" }, { type: "custom-title", customTitle: "second" }).title).toBe("second");
    expect(factsOf({ type: "custom-title", customTitle: "first" }, { type: "custom-title" }).title).toBe("first");
    expect(factsOf({ type: "ai-title", aiTitle: "generated title" }, { type: "ai-title" }).title).toBe("generated title");
    expect(factsOf({ type: "user" }).title).toBeUndefined();
  });

  it("falls back to the title Claude Code generated, last, and past a name that is empty", () => {
    expect(factsOf({ type: "ai-title", aiTitle: "generated title" }).title).toBe("generated title");
    expect(factsOf({ type: "ai-title", aiTitle: "generated title" }, { type: "user", slug: "slug-name" }).title).toBe("slug-name");
    expect(factsOf({ type: "ai-title", aiTitle: "generated title" }, { type: "custom-title", customTitle: "my-name" }).title).toBe("my-name");
    expect(factsOf({ type: "custom-title", customTitle: "" }, { type: "user", slug: "slug-name" }).title).toBe("slug-name");
    expect(factsOf({ type: "custom-title", customTitle: "" }, { type: "ai-title", aiTitle: "generated title" }).title).toBe("generated title");
    expect(factsOf({ type: "custom-title", customTitle: "" }).title).toBeUndefined();
  });

  it("chooses the first name that has visible text once escape sequences and control characters are removed and space trimmed", () => {
    expect(factsOf({ type: "custom-title", customTitle: "\u001b[2J\u0007" }, { type: "user", slug: "slug-name" }).title).toBe("slug-name");
    expect(factsOf({ type: "custom-title", customTitle: "   " }, { type: "user", slug: "slug-name" }).title).toBe("slug-name");
    expect(factsOf({ type: "custom-title", customTitle: "\u001b]0;pwned\u0007" }, { type: "user", slug: "\u0000 " }, { type: "ai-title", aiTitle: "generated title" }).title).toBe("generated title");
    expect(factsOf({ type: "custom-title", customTitle: " \u001b[2Jname\u0007 " }).title).toBe("name");
    expect(factsOf({ type: "custom-title", customTitle: "\u200b" }, { type: "user", slug: "slug-name" }).title).toBe("slug-name");
    expect(factsOf({ type: "custom-title", customTitle: "\u2800\u3164 " }, { type: "user", slug: "slug-name" }).title).toBe("slug-name");
    expect(factsOf({ type: "custom-title", customTitle: "\u200b" }).title).toBeUndefined();
    expect(factsOf({ type: "custom-title", customTitle: "\u001b[2J" }).title).toBeUndefined();
  });

  it("starts the session at the first timestamp any record carries, skipping records with no usable one", () => {
    expect(factsOf({ type: "history-suppression", ts: at(0) }, { type: "user", timestamp: "not a date" }, prompt(AT.fiveSeconds), prompt(AT.nineSeconds)).startedAtMs).toBe(T0 + AT.fiveSeconds);
    expect(factsOf({ type: "permission-mode" }).startedAtMs).toBeUndefined();
  });

  it("dates the last response by the latest assistant record, subagents' included", () => {
    expect(factsOf(prompt(0), reply(AT.tenSeconds), prompt(AT.twentySeconds)).lastResponseAtMs).toBe(T0 + AT.tenSeconds);
    expect(factsOf(prompt(0), reply(AT.tenSeconds), reply(AT.thirtySeconds, { isSidechain: true })).lastResponseAtMs).toBe(T0 + AT.thirtySeconds);
    expect(factsOf(prompt(0)).lastResponseAtMs).toBeUndefined();
  });

  it("counts compaction markers that carry a time, from /compact and automatic compaction alike", () => {
    const boundary = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "system", subtype: "compact_boundary", timestamp: at(MINUTE), ...extra });
    expect(factsOf(prompt(0), boundary(), prompt(AT.twoMinutes), boundary({ compactMetadata: { trigger: "manual" } })).compactions).toBe(2);
    expect(factsOf(boundary({ timestamp: undefined })).compactions).toBe(0);
    expect(factsOf({ type: "system", subtype: "turn_duration", timestamp: at(0) }).compactions).toBe(0);
  });

  it("keeps the compaction stamped latest with the tokens it left, truncated, the first of two stamped alike, and none without a time", () => {
    const boundary = (ms: number, compactMetadata?: Record<string, unknown>): Record<string, unknown> => ({ type: "system", subtype: "compact_boundary", timestamp: at(ms), ...(compactMetadata === undefined ? {} : { compactMetadata }) });
    expect(factsOf(boundary(MINUTE, { postTokens: POST_TOKENS_FRACTIONAL })).lastCompaction).toEqual({ atMs: T0 + MINUTE, postTokens: POST_TOKENS });
    expect(factsOf(boundary(AT.twoMinutes, { postTokens: POST_TOKENS }), boundary(MINUTE)).lastCompaction).toEqual({ atMs: T0 + AT.twoMinutes, postTokens: POST_TOKENS });
    expect(factsOf(boundary(MINUTE, { postTokens: POST_TOKENS }), boundary(MINUTE)).lastCompaction).toEqual({ atMs: T0 + MINUTE, postTokens: POST_TOKENS });
    expect(factsOf(boundary(MINUTE, { postTokens: 0 })).lastCompaction).toEqual({ atMs: T0 + MINUTE, postTokens: 0 });
    // A boundary that recorded no tokens still holds its place by its time: neither an earlier one nor one stamped alike that recorded tokens replaces it.
    expect(factsOf(boundary(AT.twoMinutes), boundary(MINUTE, { postTokens: POST_TOKENS })).lastCompaction).toEqual({ atMs: T0 + AT.twoMinutes });
    expect(factsOf(boundary(MINUTE), boundary(MINUTE, { postTokens: POST_TOKENS })).lastCompaction).toEqual({ atMs: T0 + MINUTE });
    expect(factsOf(boundary(MINUTE, { postTokens: POST_TOKENS }), boundary(AT.twoMinutes, { postTokens: -1 })).lastCompaction).toEqual({ atMs: T0 + AT.twoMinutes });
    expect(factsOf(boundary(MINUTE, { postTokens: "many" })).lastCompaction).toEqual({ atMs: T0 + MINUTE });
    expect(factsOf({ type: "system", subtype: "compact_boundary", compactMetadata: { postTokens: POST_TOKENS } }).lastCompaction).toBeUndefined();
    expect(factsOf(prompt(0)).lastCompaction).toBeUndefined();
  });

  it("keeps a compaction stamped after the present over an earlier one, as claude-hud compares the stamps alone", () => {
    const earlier = { type: "system", subtype: "compact_boundary", timestamp: at(MINUTE), compactMetadata: { postTokens: POST_TOKENS } };
    const ahead = { type: "system", subtype: "compact_boundary", timestamp: AFTER_ANY_CLOCK, compactMetadata: { postTokens: PRE_TOKENS } };
    expect(factsOf(earlier, ahead).lastCompaction).toEqual({ atMs: Date.parse(AFTER_ANY_CLOCK), postTokens: PRE_TOKENS });
  });

  it.each([
    { label: "a number of milliseconds", timestamp: T0 + MINUTE },
    { label: "true", timestamp: true },
    { label: "an array holding a date", timestamp: [at(MINUTE)] },
  ])("neither counts nor keeps a compaction stamped with $label, which claude-hud's new Date reads as a time, since a timestamp that is not a string is none", ({ timestamp }) => {
    const facts = factsOf({ type: "system", subtype: "compact_boundary", timestamp, compactMetadata: { postTokens: POST_TOKENS } });
    expect(facts.lastCompaction).toBeUndefined();
    expect(facts.compactions).toBe(0);
    const afterEarlier = factsOf({ type: "system", subtype: "compact_boundary", timestamp: at(0), compactMetadata: { postTokens: PRE_TOKENS } }, { type: "system", subtype: "compact_boundary", timestamp, compactMetadata: { postTokens: POST_TOKENS } });
    expect(afterEarlier.lastCompaction).toEqual({ atMs: T0, postTokens: PRE_TOKENS });
  });

  it.each([
    { label: "a number of milliseconds beyond the range new Date accepts", timestamp: BEYOND_DATE_RANGE_MS },
    { label: "an empty array", timestamp: [] },
    { label: "an array whose text is not a date", timestamp: ["not a date"] },
  ])("neither counts nor keeps a compaction stamped with $label, which claude-hud's new Date reads as no date either", ({ timestamp }) => {
    const facts = factsOf({ type: "system", subtype: "compact_boundary", timestamp, compactMetadata: { postTokens: POST_TOKENS } });
    expect(facts.lastCompaction).toBeUndefined();
    expect(facts.compactions).toBe(0);
  });

  it("keeps a compaction whose postTokens JSON parses to Infinity with no tokens, as it keeps one with a negative count", () => {
    const record = parseTranscriptRecord(`{"type":"system","subtype":"compact_boundary","timestamp":"${at(MINUTE)}","compactMetadata":{"postTokens":1e999}}`);
    if (record === undefined) {
      throw new Error("the boundary record did not parse");
    }
    expect(foldLatest(EMPTY_LATEST_STATE, record).compaction).toEqual({ atMs: T0 + MINUTE });
  });

  it("keeps a compaction stamped before the epoch in a state that loads again", () => {
    const record = parseTranscriptRecord(JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: BEFORE_EPOCH, compactMetadata: { postTokens: POST_TOKENS } }));
    if (record === undefined) {
      throw new Error("the boundary record did not parse");
    }
    const latest = foldLatest(EMPTY_LATEST_STATE, record);
    expect(latest.compaction).toEqual({ atMs: Date.parse(BEFORE_EPOCH), postTokens: POST_TOKENS });
    expect(LatestStateSchema.parse(JSON.parse(JSON.stringify(latest)))).toEqual(latest);
  });

  it("refuses a kept state whose compaction holds a fraction of a token or a negative count, neither of which the fold writes, so the reader reads such a cache as none and folds the transcript again", () => {
    expect(LatestStateSchema.safeParse({ ...EMPTY_LATEST_STATE, compaction: { atMs: T0, postTokens: POST_TOKENS_FRACTIONAL } }).success).toBe(false);
    expect(LatestStateSchema.safeParse({ ...EMPTY_LATEST_STATE, compaction: { atMs: T0, postTokens: -POST_TOKENS } }).success).toBe(false);
    expect(LatestStateSchema.safeParse({ ...EMPTY_LATEST_STATE, compaction: { atMs: T0, postTokens: POST_TOKENS } }).success).toBe(true);
  });

  it.each(["micro_compact_boundary", "compact_boundary_summary", "Compact_boundary"])("keeps no compaction for a system record whose subtype %s is not exactly `compact_boundary`, as claude-hud compares it", (subtype) => {
    const facts = factsOf({ type: "system", subtype, timestamp: at(MINUTE), compactMetadata: { postTokens: POST_TOKENS } });
    expect(facts.lastCompaction).toBeUndefined();
    expect(facts.compactions).toBe(0);
  });

  it.each(["user", "assistant"])("keeps no compaction from a %s record carrying the compact_boundary subtype, as claude-hud reads only a system record as one", (type) => {
    expect(factsOf({ type, subtype: "compact_boundary", timestamp: at(MINUTE), compactMetadata: { postTokens: POST_TOKENS } }).lastCompaction).toBeUndefined();
  });

  it.each(["turn_duration", "local_command"])("keeps the compaction before a later system record of subtype %s, which is not one, as claude-hud reads only a `compact_boundary` as one", (subtype) => {
    const facts = factsOf({ type: "system", subtype: "compact_boundary", timestamp: at(MINUTE), compactMetadata: { postTokens: POST_TOKENS } }, { type: "system", subtype, timestamp: at(AT.twoMinutes), content: "done" });
    expect(facts.lastCompaction).toEqual({ atMs: T0 + MINUTE, postTokens: POST_TOKENS });
    expect(facts.compactions).toBe(1);
  });

  it.each([{ label: "a string", compactMetadata: "compacted" }, { label: "null", compactMetadata: null }, { label: "an array", compactMetadata: [POST_TOKENS] }])("counts and keeps a compaction whose metadata is $label, with no tokens, as claude-hud reads no postTokens from it", ({ compactMetadata }) => {
    const facts = factsOf({ type: "system", subtype: "compact_boundary", timestamp: at(MINUTE), compactMetadata });
    expect(facts.lastCompaction).toEqual({ atMs: T0 + MINUTE });
    expect(facts.compactions).toBe(1);
  });

  it.each([{ label: "a string", postTokens: String(POST_TOKENS) }, { label: "true", postTokens: true }, { label: "null", postTokens: null }])("keeps a compaction whose postTokens is $label with no tokens, as claude-hud reads them only from a number", ({ postTokens }) => {
    expect(factsOf({ type: "system", subtype: "compact_boundary", timestamp: at(MINUTE), compactMetadata: { postTokens } }).lastCompaction).toEqual({ atMs: T0 + MINUTE });
  });

  it("reads the tokens a compaction left beside the other fields the client writes in its metadata", () => {
    const facts = factsOf({ type: "system", subtype: "compact_boundary", timestamp: at(MINUTE), compactMetadata: { trigger: "manual", preTokens: PRE_TOKENS, postTokens: POST_TOKENS } });
    expect(facts.lastCompaction).toEqual({ atMs: T0 + MINUTE, postTokens: POST_TOKENS });
  });

  it("counts a compaction written in a subagent's record as claude-hud counts it", () => {
    const facts = factsOf({ type: "system", subtype: "compact_boundary", timestamp: at(MINUTE), isSidechain: true, compactMetadata: { postTokens: POST_TOKENS } });
    expect(facts.lastCompaction).toEqual({ atMs: T0 + MINUTE, postTokens: POST_TOKENS });
    expect(facts.compactions).toBe(1);
  });

  it("survives a record of the wrong shape, reading each bad field as absent", () => {
    expect(factsOf({ type: 7, timestamp: at(0), message: "text", isSidechain: "yes", slug: 3 }).startedAtMs).toBe(T0);
    expect(parseTranscriptRecord("not json")).toBeUndefined();
    expect(parseTranscriptRecord("[1,2]")).toBeUndefined();
  });
});

describe("the prompt cache's clock", () => {
  it("anchors a response to the request it answers, not to the response, because the cache's life starts with the request", () => {
    expect(factsOf(prompt(0), reply(AT.fortySeconds)).promptCache).toEqual({ anchorAtMs: T0, ttlSeconds: undefined });
  });

  it("gives the records of one request one anchor, and the next request the record before it", () => {
    const facts = factsOf(prompt(0), reply(AT.tenSeconds), reply(AT.twelveSeconds), { type: "user", timestamp: at(MINUTE), message: { content: [{ type: "tool_result" }] } }, reply(MINUTE + AT.fiveSeconds, { requestId: "req-2" }));
    expect(facts.promptCache?.anchorAtMs).toBe(T0 + MINUTE);
    expect(factsOf(prompt(0), reply(AT.tenSeconds), reply(AT.twelveSeconds)).promptCache?.anchorAtMs).toBe(T0);
  });

  it("counts a request still waiting for its response, because it has already refreshed the cache", () => {
    expect(factsOf(prompt(0), reply(AT.tenSeconds), prompt(AT.fiveMinutes)).promptCache?.anchorAtMs).toBe(T0 + AT.fiveMinutes);
    expect(factsOf(prompt(0)).promptCache?.anchorAtMs).toBe(T0);
  });

  it("takes a user record of an unrecognised shape for a prompt, being far likelier a message than a client-side aside", () => {
    const unrecognised = { type: "user", timestamp: at(AT.fiveMinutes) };
    expect(factsOf(prompt(0), reply(AT.tenSeconds), unrecognised).promptCache?.anchorAtMs).toBe(T0 + AT.fiveMinutes);
  });

  it("does not count a pending request stamped before the response it follows, which is clock skew", () => {
    expect(factsOf(prompt(0), reply(AT.tenSeconds), prompt(AT.minusFiveSeconds)).promptCache?.anchorAtMs).toBe(T0);
  });

  it("does not count what Claude Code writes locally as a request: slash commands and an interrupt; a tool result is one even beside such a note, as claude-hud counts it", () => {
    const local = (content: unknown): Record<string, unknown> => ({ type: "user", timestamp: at(AT.fiveMinutes), message: { content } });
    for (const content of ["<command-name>/model</command-name>", "<local-command-stdout>ok</local-command-stdout>", "[Request interrupted by user]", [{ type: "text", text: "<command-message>x</command-message>" }]]) {
      expect(factsOf(prompt(0), reply(AT.tenSeconds), local(content)).promptCache?.anchorAtMs, JSON.stringify(content)).toBe(T0);
    }
    expect(factsOf(prompt(0), reply(AT.tenSeconds), local([{ type: "text", text: "a real prompt" }])).promptCache?.anchorAtMs).toBe(T0 + AT.fiveMinutes);
    expect(factsOf(prompt(0), reply(AT.tenSeconds), local([{ type: "tool_result", tool_use_id: "call" }, { type: "text", text: "<command-message>x</command-message>" }])).promptCache?.anchorAtMs).toBe(T0 + AT.fiveMinutes);
  });

  it("leaves subagents out, because they run against a cache of their own", () => {
    const facts = factsOf(prompt(0), reply(AT.tenSeconds), prompt(MINUTE, { isSidechain: true }), reply(MINUTE + SECOND, { isSidechain: true, requestId: "sub" }));
    expect(facts.promptCache?.anchorAtMs).toBe(T0);
  });

  it("falls back to the response itself when no record precedes it", () => {
    expect(factsOf(reply(AT.tenSeconds)).promptCache?.anchorAtMs).toBe(T0 + AT.tenSeconds);
    expect(factsOf(prompt(AT.thirtySeconds), reply(AT.tenSeconds)).promptCache?.anchorAtMs).toBe(T0 + AT.tenSeconds);
  });

  it("reads the tier from the cache writes, the shorter when a request wrote to both, and keeps it through a pure cache read", () => {
    expect(factsOf(prompt(0), reply(SECOND, write("ephemeral_5m_input_tokens"))).promptCache?.ttlSeconds).toBe(PROMPT_CACHE_TTL_SECONDS.fiveMinutes);
    expect(factsOf(prompt(0), reply(SECOND, write("ephemeral_1h_input_tokens"))).promptCache?.ttlSeconds).toBe(PROMPT_CACHE_TTL_SECONDS.oneHour);
    expect(factsOf(prompt(0), reply(SECOND, { message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 9 } } } })).promptCache?.ttlSeconds).toBe(PROMPT_CACHE_TTL_SECONDS.fiveMinutes);
    expect(factsOf(prompt(0), reply(SECOND, write("ephemeral_1h_input_tokens")), prompt(MINUTE), reply(MINUTE + SECOND, { requestId: "req-2", message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } } })).promptCache?.ttlSeconds).toBe(PROMPT_CACHE_TTL_SECONDS.oneHour);
  });

  it("has no clock before the main conversation sends a request", () => {
    expect(factsOf({ type: "permission-mode" }, { type: "system", subtype: "turn_duration", timestamp: at(0) }).promptCache).toBeUndefined();
  });
});

describe("session facts with the end of the transcript read on its own", () => {
  const stateOf = (...records: readonly Record<string, unknown>[]): SessionState =>
    records.reduce<SessionState>((state, record) => {
      const parsed = parseTranscriptRecord(JSON.stringify(record));
      return parsed === undefined ? state : foldSession(state, parsed);
    }, EMPTY_SESSION_STATE);
  const endOf = (...records: readonly Record<string, unknown>[]): LatestState =>
    records.reduce<LatestState>((state, record) => {
      const parsed = parseTranscriptRecord(JSON.stringify(record));
      return parsed === undefined ? state : foldLatest(state, parsed);
    }, EMPTY_LATEST_STATE);

  it("takes the latest-state facts from the end and the cumulative ones from the state", () => {
    const state = stateOf(prompt(0, { slug: "old" }), reply(SECOND), { type: "system", subtype: "compact_boundary", timestamp: at(MINUTE) });
    const facts = sessionFactsOf(state, endOf(prompt(AT.fiveMinutes), reply(AT.fiveMinutes + SECOND, { slug: "new" })));
    expect(facts).toMatchObject({ title: "new", lastResponseAtMs: T0 + AT.fiveMinutes + SECOND, startedAtMs: T0, compactions: 1 });
    expect(facts.promptCache?.anchorAtMs).toBe(T0 + AT.fiveMinutes);
  });

  it("keeps what the state has for a fact the end does not set, and the state's cache clock when the end holds no request", () => {
    const state = stateOf(prompt(0), reply(SECOND, { slug: "old" }), { type: "ai-title", aiTitle: "Earlier title" });
    const facts = sessionFactsOf(state, endOf({ type: "permission-mode" }, { type: "system", subtype: "turn_duration", timestamp: at(AT.fiveMinutes) }));
    expect(facts).toMatchObject({ title: "old", lastResponseAtMs: T0 + SECOND });
    expect(facts.promptCache?.anchorAtMs).toBe(T0);
  });

  it("keeps the tier the state's writes showed when the end holds a request but no write that names one, and takes the end's when it names one", () => {
    const state = stateOf(prompt(0), reply(SECOND, write("ephemeral_1h_input_tokens")));
    const withoutTier = endOf(prompt(AT.fiveMinutes), reply(AT.fiveMinutes + SECOND, { requestId: "req-2", message: { usage: { cache_read_input_tokens: 9 } } }));
    expect(sessionFactsOf(state, withoutTier).promptCache).toEqual({ anchorAtMs: T0 + AT.fiveMinutes, ttlSeconds: PROMPT_CACHE_TTL_SECONDS.oneHour });
    const withTier = endOf(prompt(AT.fiveMinutes), reply(AT.fiveMinutes + SECOND, { requestId: "req-2", ...write("ephemeral_5m_input_tokens") }));
    expect(sessionFactsOf(state, withTier).promptCache?.ttlSeconds).toBe(PROMPT_CACHE_TTL_SECONDS.fiveMinutes);
  });

  it("takes the compaction stamped later of the state's and the end's, and the state's, read first, when the two are stamped alike", () => {
    const boundary = (ms: number, postTokens: number): Record<string, unknown> => ({ type: "system", subtype: "compact_boundary", timestamp: at(ms), compactMetadata: { postTokens } });
    const state = stateOf(boundary(AT.twoMinutes, POST_TOKENS));
    expect(sessionFactsOf(state, endOf(boundary(AT.fiveMinutes, 1))).lastCompaction).toEqual({ atMs: T0 + AT.fiveMinutes, postTokens: 1 });
    expect(sessionFactsOf(state, endOf(boundary(MINUTE, 1))).lastCompaction).toEqual({ atMs: T0 + AT.twoMinutes, postTokens: POST_TOKENS });
    expect(sessionFactsOf(state, endOf(boundary(AT.twoMinutes, 1))).lastCompaction).toEqual({ atMs: T0 + AT.twoMinutes, postTokens: POST_TOKENS });
    expect(sessionFactsOf(state, endOf(prompt(AT.fiveMinutes))).lastCompaction).toEqual({ atMs: T0 + AT.twoMinutes, postTokens: POST_TOKENS });
  });

  it("is what the state alone says when there is no end to read", () => {
    const state = stateOf(prompt(0), reply(SECOND));
    expect(sessionFactsOf(state, undefined)).toEqual(sessionFactsOf(state));
  });
});

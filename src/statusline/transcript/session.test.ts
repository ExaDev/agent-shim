import { describe, expect, it } from "vitest";

import { PROMPT_CACHE_TTL_SECONDS } from "../../config/statusline";
import { parseTranscriptRecord } from "./record";
import { EMPTY_SESSION_STATE, foldSession, sessionFactsOf, type SessionFacts, type SessionState } from "./session";

const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const SECOND = 1_000;
const MINUTE = 60_000;

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

  it("does not count a pending request stamped before the response it follows, which is clock skew", () => {
    expect(factsOf(prompt(0), reply(AT.tenSeconds), prompt(AT.minusFiveSeconds)).promptCache?.anchorAtMs).toBe(T0);
  });

  it("does not count what Claude Code writes locally as a request: slash commands and an interrupt", () => {
    const local = (content: unknown): Record<string, unknown> => ({ type: "user", timestamp: at(AT.fiveMinutes), message: { content } });
    for (const content of ["<command-name>/model</command-name>", "<local-command-stdout>ok</local-command-stdout>", "[Request interrupted by user]", [{ type: "text", text: "<command-message>x</command-message>" }]]) {
      expect(factsOf(prompt(0), reply(AT.tenSeconds), local(content)).promptCache?.anchorAtMs, JSON.stringify(content)).toBe(T0);
    }
    expect(factsOf(prompt(0), reply(AT.tenSeconds), local([{ type: "text", text: "a real prompt" }])).promptCache?.anchorAtMs).toBe(T0 + AT.fiveMinutes);
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

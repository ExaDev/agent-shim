import { describe, expect, it } from "vitest";

import {
  baselineCost,
  buildRequests,
  CACHE_READ_RATIO_DEFAULT,
  CACHE_READ_RATIO_OPUS,
  CACHE_WRITE_RATIO,
  cacheWeightedCost,
  mainChain,
  OMITTED_TOOL_RESULT,
  parseTranscript,
  parseTransforms,
  percentile,
  pickTranscripts,
  placeholderPrefix,
  preservedPrefix,
  renderTable,
  replayableToolResult,
  segmentsOf,
  summarise,
  toMessages,
  type ChatMessage,
  type RequestRecord,
  type TranscriptEntry,
} from "./headroom-measure-core";

/** The message count of a conversation at its first, second and third user turn (user, assistant, user, assistant, user). */
const FIRST_TURN_MESSAGES = 1;
const SECOND_TURN_MESSAGES = 3;
const THIRD_TURN_MESSAGES = 5;

/** A request window larger than any conversation used here, so it keeps every request. */
const WINDOW_LARGER_THAN_WORKLOAD = 10;

const SYSTEM_TOKENS = 1000;
const TOOLS_TOKENS = 800;
const CHARS_PER_TOKEN = 4;

const TOKENS = 1000;
const COMPRESSED_TOKENS = 900;
const MORE_COMPRESSED_TOKENS = 800;
const TEN_PERCENT = 10;
const PERCENT = 100;
const RECORD_BYTES = 100;
/** The bytes of a request an earlier request already covers, when the rest is new. */
const REUSED_BYTES = 80;

const SAMPLE_COUNT = 5;
const MEDIAN = 50;
const MAXIMUM = 100;
/** The median of 1 to SAMPLE_COUNT by nearest rank. */
const MEDIAN_OF_SAMPLE = 3;

const FAST_THROUGH_MS = 14;
const FAST_DIRECT_MS = 4;
const SLOW_THROUGH_MS = 30;
const SLOW_DIRECT_MS = 5;

const LARGEST_BYTES = 900;
const RUNNER_UP_BYTES = 800;
const MIDDLE_BYTES = 700;
const LOWER_BYTES = 600;
const TINY_BYTES = 50;
const MINIMUM_BYTES = 100;
const PICK_COUNT = 3;

/** The segments ahead of the rewritten message: the tools, the system prompt and the first message. */
const UNCHANGED_SEGMENTS = 3;

/** A header line, a separator line and one row. */
const TABLE_LINES_FOR_ONE_VARIANT = 3;

const text = (value: string) => ({ type: "text", text: value });
const entry = (
  uuid: string,
  parentUuid: string | null,
  role: "user" | "assistant",
  content: NonNullable<TranscriptEntry["message"]>["content"],
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry => ({
  type: role,
  uuid,
  parentUuid,
  message: { role, content },
  ...extra,
});

describe("parseTranscript", () => {
  it("skips blank lines, partial lines and lines that are not conversation-shaped", () => {
    const lines = [JSON.stringify({ type: "user", uuid: "a", message: { role: "user", content: "hi" } }), "", '{"type":"user","uuid":"b","message":{"role":"us', JSON.stringify({ nope: true })];
    expect(parseTranscript(lines).map((parsed) => parsed.uuid)).toEqual(["a"]);
  });
});

describe("mainChain", () => {
  it("follows parents from the last conversation entry and drops an abandoned branch", () => {
    const entries = [entry("1", null, "user", "start"), entry("2", "1", "assistant", [text("abandoned")]), entry("3", "1", "assistant", [text("kept")]), entry("4", "3", "user", "next")];
    expect(mainChain(entries).map((item) => item.uuid)).toEqual(["1", "3", "4"]);
  });

  it("excludes sidechain entries even when they are last in the file", () => {
    const entries = [entry("1", null, "user", "start"), entry("2", "1", "assistant", [text("answer")]), entry("3", "2", "user", "side", { isSidechain: true })];
    expect(mainChain(entries).map((item) => item.uuid)).toEqual(["1", "2"]);
  });

  it("returns nothing for a transcript with no conversation entries", () => {
    expect(mainChain([])).toEqual([]);
  });

  it("stops on a parent cycle instead of looping", () => {
    const entries = [entry("a", "b", "user", "x"), entry("b", "a", "assistant", [text("y")])];
    expect(mainChain(entries).length).toBeLessThanOrEqual(entries.length);
  });
});

describe("toMessages", () => {
  const call = { type: "tool_use", id: "t1", name: "Bash", input: {} };

  it("merges the per-block assistant lines and per-result user lines Claude Code writes", () => {
    const chain = [
      entry("1", null, "user", "run it"),
      entry("2", "1", "assistant", [text("ok")]),
      entry("3", "2", "assistant", [call]),
      entry("4", "3", "user", [{ type: "tool_result", tool_use_id: "t1", content: "out" }]),
    ];
    const messages = toMessages(chain);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]?.content).toHaveLength(2);
  });

  it("drops thinking and image blocks and any message they leave empty", () => {
    const chain = [entry("1", null, "user", "q"), entry("2", "1", "assistant", [{ type: "thinking", thinking: "..." }]), entry("3", "2", "assistant", [text("a")])];
    const messages = toMessages(chain);
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain("thinking");
  });

  it("drops a tool result whose call is not in the previous assistant message", () => {
    const chain = [entry("1", null, "user", "q"), entry("2", "1", "assistant", [text("a")]), entry("3", "2", "user", [{ type: "tool_result", tool_use_id: "ghost", content: "x" }, text("kept")])];
    expect(toMessages(chain).at(-1)?.content).toEqual([text("kept")]);
  });

  it("starts with a user message", () => {
    const chain = [entry("1", null, "assistant", [text("leading")]), entry("2", "1", "user", "q")];
    expect(toMessages(chain)[0]?.role).toBe("user");
  });
});

describe("replayableToolResult", () => {
  it("leaves a string result and a non-result block untouched", () => {
    const result = { type: "tool_result", tool_use_id: "t", content: "plain" };
    expect(replayableToolResult(result)).toEqual(result);
  });

  it("keeps only the text items of a list result", () => {
    const result = { type: "tool_result", tool_use_id: "t", content: [{ type: "tool_reference", tool_name: "x" }, { type: "text", text: "kept" }, { type: "image", source: {} }] };
    expect(replayableToolResult(result).content).toEqual([{ type: "text", text: "kept" }]);
  });

  it("answers a result left with nothing by a short placeholder", () => {
    const result = { type: "tool_result", tool_use_id: "t", content: [{ type: "tool_reference", tool_name: "x" }] };
    expect(replayableToolResult(result).content).toBe(OMITTED_TOOL_RESULT);
  });

  it("is applied to every tool result when a conversation is converted", () => {
    const call = { type: "tool_use", id: "t1", name: "Bash", input: {} };
    const chain = [
      entry("1", null, "user", "q"),
      entry("2", "1", "assistant", [call]),
      entry("3", "2", "user", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference", tool_name: "x" }] }]),
    ];
    expect(JSON.stringify(toMessages(chain))).not.toContain("tool_reference");
  });
});

describe("buildRequests", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [text("1")] },
    { role: "assistant", content: [text("2")] },
    { role: "user", content: [text("3")] },
    { role: "assistant", content: [text("4")] },
    { role: "user", content: [text("5")] },
  ];

  it("makes a request after every user message, each one extending the one before", () => {
    const requests = buildRequests(messages, WINDOW_LARGER_THAN_WORKLOAD);
    expect(requests.map((request) => request.messages.length)).toEqual([FIRST_TURN_MESSAGES, SECOND_TURN_MESSAGES, THIRD_TURN_MESSAGES]);
    for (let index = 1; index < requests.length; index += 1) {
      const previous = requests[index - 1]?.messages ?? [];
      expect(requests[index]?.messages.slice(0, previous.length)).toEqual(previous);
    }
  });

  it("keeps the last count requests as one contiguous window", () => {
    expect(buildRequests(messages, 2).map((request) => request.messages.length)).toEqual([SECOND_TURN_MESSAGES, THIRD_TURN_MESSAGES]);
  });
});

describe("placeholderPrefix", () => {
  it("is deterministic and at least the size asked for", () => {
    const first = placeholderPrefix({ systemTokens: SYSTEM_TOKENS, toolsTokens: TOOLS_TOKENS });
    const second = placeholderPrefix({ systemTokens: SYSTEM_TOKENS, toolsTokens: TOOLS_TOKENS });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.system.length).toBeGreaterThanOrEqual(SYSTEM_TOKENS * CHARS_PER_TOKEN);
    expect(JSON.stringify(first.tools).length).toBeGreaterThanOrEqual(TOOLS_TOKENS * CHARS_PER_TOKEN);
  });
});

describe("preservedPrefix", () => {
  const body = (messages: readonly unknown[], tools: unknown = [{ name: "t" }]) => ({ tools, system: "sys", messages });
  const total = (segments: readonly string[]) => segments.reduce((sum, segment) => sum + segment.length, 0);

  it("treats the first request of a session as having nothing reusable", () => {
    const next = segmentsOf(body([{ role: "user", content: "a" }]));
    expect(preservedPrefix(undefined, next).preservedBytes).toBe(0);
  });

  it("preserves everything when the next request only appends", () => {
    const a = segmentsOf(body([{ role: "user", content: "a" }]));
    const b = segmentsOf(body([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]));
    const result = preservedPrefix(a, b);
    expect(result.preservedBytes).toBe(total(a));
    expect(result.preservedBytes).toBeLessThan(result.totalBytes);
  });

  it("stops at the first rewritten message and counts nothing after it", () => {
    const a = segmentsOf(body([{ role: "user", content: "a" }, { role: "assistant", content: "bbbb" }, { role: "user", content: "c" }]));
    const b = segmentsOf(body([{ role: "user", content: "a" }, { role: "assistant", content: "rewritten" }, { role: "user", content: "c" }, { role: "assistant", content: "d" }]));
    const unchangedHead = b.slice(0, UNCHANGED_SEGMENTS);
    expect(preservedPrefix(a, b).preservedBytes).toBe(total(unchangedHead));
  });

  it("ignores cache_control placement and key order", () => {
    const a = segmentsOf(body([{ role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] }]));
    const b = segmentsOf(body([{ content: [{ text: "a", type: "text" }], role: "user" }, { role: "assistant", content: "b" }]));
    expect(preservedPrefix(a, b).preservedBytes).toBe(total(a));
  });

  it("loses the whole prefix when the tools change, because tools come first", () => {
    const a = segmentsOf(body([{ role: "user", content: "a" }], [{ name: "one" }]));
    const b = segmentsOf(body([{ role: "user", content: "a" }], [{ name: "two" }]));
    expect(preservedPrefix(a, b).preservedBytes).toBe(0);
  });
});

describe("cacheWeightedCost", () => {
  it("prices a fully reused prefix at the read multiplier and a cold one at the write multiplier", () => {
    expect(cacheWeightedCost(TOKENS, 1, CACHE_READ_RATIO_DEFAULT)).toBeCloseTo(TOKENS * CACHE_READ_RATIO_DEFAULT);
    expect(cacheWeightedCost(TOKENS, 0, CACHE_READ_RATIO_DEFAULT)).toBeCloseTo(TOKENS * CACHE_WRITE_RATIO);
  });
});

describe("parseTransforms and percentile", () => {
  it("splits the header and tolerates absence", () => {
    expect(parseTransforms("router:tool_result:smart_crusher, cache_mode:cold_start_full")).toEqual(["router:tool_result:smart_crusher", "cache_mode:cold_start_full"]);
    expect(parseTransforms(null)).toEqual([]);
    expect(parseTransforms("")).toEqual([]);
  });

  it("takes the nearest-rank percentile of an unsorted sample", () => {
    const sample = Array.from({ length: SAMPLE_COUNT }, (_, index) => SAMPLE_COUNT - index);
    expect(percentile(sample, MEDIAN)).toBe(MEDIAN_OF_SAMPLE);
    expect(percentile(sample, MAXIMUM)).toBe(SAMPLE_COUNT);
    expect(percentile([], MEDIAN)).toBe(0);
  });
});

describe("summarise", () => {
  const rec = (overrides: Partial<RequestRecord>): RequestRecord => ({
    session: "s",
    index: 1,
    status: 200,
    tokensBefore: TOKENS,
    tokensAfter: TOKENS,
    transforms: [],
    preservedBytes: RECORD_BYTES,
    totalBytes: RECORD_BYTES,
    baselinePreservedBytes: RECORD_BYTES,
    baselineTotalBytes: RECORD_BYTES,
    throughMs: FAST_THROUGH_MS,
    directMs: FAST_DIRECT_MS,
    ...overrides,
  });
  const ratios = { default: CACHE_READ_RATIO_DEFAULT };

  it("reports a baseline-equivalent variant as costing the same", () => {
    const summary = summarise("same", [rec({}), rec({ index: 2 })], ratios);
    expect(summary.costVersusBaselinePercent.default).toBeCloseTo(0);
    expect(summary.tokensRemovedPercent).toBe(0);
  });

  it("shows compression that keeps the prefix as a saving", () => {
    const summary = summarise("kept", [rec({ tokensAfter: COMPRESSED_TOKENS })], ratios);
    expect(summary.tokensRemovedPercent).toBeCloseTo(TEN_PERCENT);
    expect(summary.costVersusBaselinePercent.default).toBeCloseTo(-TEN_PERCENT);
  });

  it("shows compression that busts the prefix as a net loss despite removing tokens", () => {
    const summary = summarise("busted", [rec({ tokensAfter: COMPRESSED_TOKENS, preservedBytes: 0 })], ratios);
    expect(summary.tokensRemovedPercent).toBeCloseTo(TEN_PERCENT);
    expect(summary.costVersusBaselinePercent.default).toBeGreaterThan(PERCENT);
  });

  it("charges a variant that changes nothing exactly what the unmodified conversation costs, even though each request's newest messages are never cached yet", () => {
    const partlyReused = { preservedBytes: REUSED_BYTES, totalBytes: RECORD_BYTES, baselinePreservedBytes: REUSED_BYTES, baselineTotalBytes: RECORD_BYTES };
    const summary = summarise("unchanged", [rec(partlyReused), rec({ ...partlyReused, index: 2 })], ratios);
    expect(summary.tokensRemovedPercent).toBe(0);
    expect(summary.costVersusBaselinePercent.default).toBeCloseTo(0);
  });

  it("counts a first request as a cold write in both the variant and the baseline", () => {
    const first = rec({ index: 0, preservedBytes: 0, baselinePreservedBytes: 0 });
    expect(baselineCost([first], CACHE_READ_RATIO_DEFAULT)).toBeCloseTo(TOKENS * CACHE_WRITE_RATIO);
    expect(summarise("first", [first], ratios).costVersusBaselinePercent.default).toBeCloseTo(0);
  });

  it("counts requests per transform and the tokens those requests saved", () => {
    const records = [
      rec({ tokensAfter: MORE_COMPRESSED_TOKENS, transforms: ["a", "b"] }),
      rec({ tokensAfter: COMPRESSED_TOKENS, transforms: ["a"] }),
      rec({ transforms: ["b"] }),
    ];
    const summary = summarise("t", records, ratios);
    const savedByA = TOKENS - MORE_COMPRESSED_TOKENS + (TOKENS - COMPRESSED_TOKENS);
    expect(summary.transforms.find((transform) => transform.name === "a")).toEqual({ name: "a", requests: 2, tokensSaved: savedByA });
    expect(summary.compressedPercent).toBeCloseTo((2 / records.length) * PERCENT);
  });

  it("reports added latency as the difference to the direct round trip", () => {
    const summary = summarise("lat", [rec({ throughMs: FAST_THROUGH_MS, directMs: FAST_DIRECT_MS }), rec({ throughMs: SLOW_THROUGH_MS, directMs: SLOW_DIRECT_MS })], ratios);
    expect(summary.addedLatencyP50Ms).toBe(FAST_THROUGH_MS - FAST_DIRECT_MS);
    expect(summary.addedLatencyP95Ms).toBe(SLOW_THROUGH_MS - SLOW_DIRECT_MS);
  });
});

describe("renderTable", () => {
  it("renders one row per variant with a column for each read multiplier", () => {
    const summary = summarise("v", [], { default: CACHE_READ_RATIO_DEFAULT, opus: CACHE_READ_RATIO_OPUS });
    const table = renderTable([summary]);
    expect(table).toContain("input cost vs unmodified (default)");
    expect(table).toContain("input cost vs unmodified (opus)");
    expect(table.split("\n")).toHaveLength(TABLE_LINES_FOR_ONE_VARIANT);
  });
});

describe("pickTranscripts", () => {
  it("takes the largest per project, skips small files and stops at the count", () => {
    const candidates = [
      { file: "a1", project: "a", bytes: LARGEST_BYTES },
      { file: "a2", project: "a", bytes: RUNNER_UP_BYTES },
      { file: "b1", project: "b", bytes: MIDDLE_BYTES },
      { file: "c1", project: "c", bytes: TINY_BYTES },
      { file: "d1", project: "d", bytes: LOWER_BYTES },
    ];
    expect(pickTranscripts(candidates, PICK_COUNT, MINIMUM_BYTES).map((pick) => pick.file)).toEqual(["a1", "b1", "d1"]);
  });
});

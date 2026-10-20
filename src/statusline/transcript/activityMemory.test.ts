import { describe, expect, it } from "vitest";

import {
  activityFactsOf,
  EMPTY_ACTIVITY_LATEST,
  replayMemoryOf,
  shortestDigestChars,
  MAX_LIVE_AGENT_MS,
  CALL_DIGEST_CHARS,
  MAX_REMEMBERED_CALLS,
  MAX_SKIPPED_CALLS,
  MAX_TRACKED_AGENTS,
  MAX_COUNTED_NAMES,
  MAX_TRACKED_TOOL_CALLS,
  type ActivityState,
} from "./activity";

import { T0, SECOND, MINUTE, STEP, MANY_TIMES_THE_LIMIT, EXTRA_CALLS, BYTES_PER_KIBIBYTE, QUOTES_AND_COMMA_BYTES, NAME_MEMORY_KIBIBYTES, at, use, result, fold, LIMITS, factsAt } from "./activityTesting";

/** The calls forgotten when the newest of them has the last one-digit time in base 36 (the 36 times from 0 to 35), so a floor of that digit is compared with the longer times that follow. */
const FORGOTTEN_PAST_ONE_DIGIT = 36;
/** The copies of the memory of calls the cache file holds at once while the state catches up, and what the memory of calls and the list of skipped calls may each take of it in all of those copies: the budgets the production constants state. */
const CACHE_COPIES_OF_THE_MEMORY = 2;
const CALL_MEMORY_KIBIBYTES = 64;
const SKIPPED_MEMORY_KIBIBYTES = 4;
const CALL_MEMORY_BYTES = CALL_MEMORY_KIBIBYTES * BYTES_PER_KIBIBYTE;
const SKIPPED_MEMORY_BYTES = SKIPPED_MEMORY_KIBIBYTES * BYTES_PER_KIBIBYTE;
const NAME_MEMORY_BYTES = NAME_MEMORY_KIBIBYTES * BYTES_PER_KIBIBYTE;
const DIGEST_BITS_PER_CHAR = 6;
/** The bounds the digest length is derived from: a session of at most this many powers of two new calls loses one to a digest match with a chance below the minus of this many powers of two. */
const SESSION_CALLS_BOUND_BITS = 20;
const SESSION_LOSS_TOLERANCE_BITS = 10;
const BASE_36 = 36;
const TIME_CHARS_IN_AN_ENTRY = 9;
const HALF = 0.5;
/** The characters whose bits (six each) just equal the bits that two to the twelfth entries need, which is the same as two characters hold; a digest needs more bits than that, so one character more. */
const CHARS_WHEN_BITS_ARE_EXACT = 2;

describe("history written again by a resumed session", () => {
  it("adds no call that left the tracked window and is written again, with its result, in the same order", () => {
    const history = Array.from({ length: MAX_TRACKED_TOOL_CALLS + EXTRA_CALLS }, (_, index) => [use(`h${String(index)}`, `Tool${String(index)}`, {}, index), result(`h${String(index)}`, index)]).flat();
    const once = factsAt(history).tools;
    expect(factsAt([...history, ...history.slice(0, EXTRA_CALLS * 2)]).tools).toEqual(once);
    expect(factsAt([...history, ...history.slice(0, EXTRA_CALLS * 2), use("new", "Fresh", {}, MINUTE)]).tools.at(-1)).toMatchObject({ name: "Fresh", status: "running" });
  });

  it("adds no agent that left the tracked window and is written again, as running", () => {
    const history = Array.from({ length: MAX_TRACKED_AGENTS + EXTRA_CALLS }, (_, index) => [use(`g${String(index)}`, "Agent", { subagent_type: `T${String(index)}`, run_in_background: true }, index), result(`g${String(index)}`, index, false, { toolUseResult: { isAsync: true } })]).flat();
    const once = factsAt(history).agents;
    expect(factsAt([...history, ...history.slice(0, EXTRA_CALLS * 2)]).agents).toEqual(once);
  });

  it("adds no task written again, so the list is not rebuilt from its own copy", () => {
    const history = [...Array.from({ length: 3 }, (_, index) => [use(`c${String(index)}`, "TaskCreate", { subject: `task ${String(index)}` }, index), { type: "user", timestamp: at(index), message: { content: [{ type: "tool_result", tool_use_id: `c${String(index)}`, content: `Task #${String(index + 1)} created` }] } }]).flat()];
    expect(factsAt([...history, ...history.slice(0, 2)]).todos).toEqual(factsAt(history).todos);
  });

  it("remembers the latest calls only, so a bounded number of them are kept in the state", () => {
    const records = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`s${String(index)}`, "Read", {}, index));
    const { rememberedCalls, forgottenUpToMs } = fold(records).latest;
    expect(rememberedCalls).toHaveLength(MAX_REMEMBERED_CALLS);
    expect(forgottenUpToMs).toBe(T0 + EXTRA_CALLS - 1);
  });

  it("adds no call written again after the memory has forgotten it, and leaves a newer todo list alone", () => {
    const list = (subject: string, ms: number): Record<string, unknown> => use(`w${subject}`, "TodoWrite", { todos: [{ content: subject, status: "pending", activeForm: subject }] }, ms);
    const history = [list("old", 0), ...Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`f${String(index)}`, "Read", {}, index + 1)), list("new", MAX_REMEMBERED_CALLS + EXTRA_CALLS + 1)];
    const once = factsAt(history);
    expect(once.todos.map((item) => item.content)).toEqual(["new"]);
    const again = factsAt([...history, list("old", 0), use("f0", "Read", {}, 1)]);
    expect(again.todos).toEqual(once.todos);
    expect(again.tools).toEqual(once.tools);
  });

  it("is not blinded by one call stamped far ahead of the rest: calls written after it are still new once it is forgotten", () => {
    const ahead = use("ahead", "Read", {}, MANY_TIMES_THE_LIMIT * MAX_LIVE_AGENT_MS);
    const history = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`k${String(index)}`, "Glob", {}, (index + 1) * SECOND));
    const fresh = [use("fresh1", "Grep", {}, MAX_REMEMBERED_CALLS * SECOND + MINUTE), use("write", "TodoWrite", { todos: [{ content: "now", status: "in_progress" }] }, MAX_REMEMBERED_CALLS * SECOND + MINUTE + SECOND)];
    const state = fold([ahead, ...history]);
    expect(state.latest.forgottenUpToMs).toBeLessThan(T0 + MANY_TIMES_THE_LIMIT * MAX_LIVE_AGENT_MS);
    const facts = activityFactsOf(fold(fresh, state), T0 + SECOND, LIMITS);
    expect(facts.tools.map((tool) => tool.name)).toContain("Grep");
    expect(facts.todos.map((todo) => todo.content)).toEqual(["now"]);
  });

  it("takes calls stamped in the same millisecond, as parallel calls are, for calls in order", () => {
    const records = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`p${String(index)}`, "Glob", {}, 0));
    expect(fold(records).latest.forgottenUpToMs).toBe(T0);
  });

  it("compares times as text from the first millisecond of the clock, which a fixed width keeps in order", () => {
    const records = Array.from({ length: MAX_REMEMBERED_CALLS + FORGOTTEN_PAST_ONE_DIGIT }, (_, index) => ({ type: "assistant", timestamp: new Date(index).toISOString(), message: { content: [{ type: "tool_use", id: `e${String(index)}`, name: "Glob", input: {} }] } }));
    expect(fold(records).latest.forgottenUpToMs).toBe(FORGOTTEN_PAST_ONE_DIGIT - 1);
  });

  it("is not held back by one genuine call written late, stamped as far back as the memory spans: the history it leaves is still recognised", () => {
    const history = Array.from({ length: MAX_REMEMBERED_CALLS + MAX_REMEMBERED_CALLS / 2 }, (_, index) => use(`h${String(index)}`, "Glob", {}, index * SECOND));
    const state = fold(history);
    const late = use("late", "Grep", {}, (state.latest.forgottenUpToMs ?? 0) - T0 + SECOND / 2);
    const after = Array.from({ length: MAX_SKIPPED_CALLS + EXTRA_CALLS }, (_, index) => use(`a${String(index)}`, "Glob", {}, (history.length + index) * SECOND));
    const replayed = fold([late, ...after], state);
    const before = replayed.latest.rememberedCalls;
    const again = fold(history, replayed);
    expect(again.latest.rememberedCalls).toEqual(before);
  });

  it("does not take a call stamped ahead for the floor, even when it is older than the newest call, so a late genuine call between is still new", () => {
    const ahead = use("ahead", "Read", {}, MAX_REMEMBERED_CALLS * SECOND);
    const history = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`h${String(index)}`, "Glob", {}, (index + 1) * SECOND));
    const late = use("late", "Grep", {}, MAX_REMEMBERED_CALLS * SECOND - SECOND / 2);
    expect(activityFactsOf(fold([late], fold([ahead, ...history])), T0 + SECOND, LIMITS).tools.map((tool) => tool.name)).toContain("Grep");
  });

  it("still recognises the replay of a call stamped ahead once it is forgotten, so an old todo list does not replace the current one", () => {
    const list = (id: string, content: string, ms: number): Record<string, unknown> => use(id, "TodoWrite", { todos: [{ content, status: "in_progress" }] }, ms);
    const aheadMs = MANY_TIMES_THE_LIMIT * MAX_LIVE_AGENT_MS;
    const history = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`h${String(index)}`, "Glob", {}, (index + 1) * SECOND));
    const current = list("current", "current list", (MAX_REMEMBERED_CALLS + EXTRA_CALLS + 1) * SECOND);
    const written = fold([current], fold([list("old", "old list", aheadMs), ...history]));
    expect(written.latest.skippedCalls).toHaveLength(1);
    const todos = (state: ActivityState): (string | undefined)[] => activityFactsOf(state, T0 + SECOND, LIMITS).todos.map((todo) => todo.content);
    expect(todos(written)).toEqual(["current list"]);
    expect(todos(fold([list("old", "old list", aheadMs), current], written))).toEqual(["current list"]);
  });

  it("keeps the memory of calls and the list of skipped calls, in the cache file's copies of them, within their byte budgets, and uses all of each", () => {
    const ahead = Array.from({ length: MAX_SKIPPED_CALLS + EXTRA_CALLS }, (_, index) => use(`s${String(index)}`, "Read", {}, MANY_TIMES_THE_LIMIT * MAX_LIVE_AGENT_MS + index));
    const history = Array.from({ length: MAX_REMEMBERED_CALLS + MAX_SKIPPED_CALLS + EXTRA_CALLS }, (_, index) => use(`h${String(index)}`, "Glob", {}, (index + 1) * SECOND));
    const { rememberedCalls, skippedCalls } = fold([...ahead, ...history]).latest;
    expect(rememberedCalls).toHaveLength(MAX_REMEMBERED_CALLS);
    expect(skippedCalls).toHaveLength(MAX_SKIPPED_CALLS);
    const entryBytes = (rememberedCalls[0]?.length ?? 0) + QUOTES_AND_COMMA_BYTES;
    expect(MAX_REMEMBERED_CALLS * entryBytes * CACHE_COPIES_OF_THE_MEMORY).toBeLessThanOrEqual(CALL_MEMORY_BYTES);
    expect((MAX_REMEMBERED_CALLS + 1) * entryBytes * CACHE_COPIES_OF_THE_MEMORY).toBeGreaterThan(CALL_MEMORY_BYTES);
    expect(MAX_SKIPPED_CALLS * entryBytes * CACHE_COPIES_OF_THE_MEMORY).toBeLessThanOrEqual(SKIPPED_MEMORY_BYTES);
    expect((MAX_SKIPPED_CALLS + 1) * entryBytes * CACHE_COPIES_OF_THE_MEMORY).toBeGreaterThan(SKIPPED_MEMORY_BYTES);
    expect((JSON.stringify(rememberedCalls).length + JSON.stringify(skippedCalls).length) * CACHE_COPIES_OF_THE_MEMORY).toBeLessThanOrEqual(CALL_MEMORY_BYTES + SKIPPED_MEMORY_BYTES);
  });

  it("derives the digest length from the stated bounds: long enough for them, and no longer than they need", () => {
    // The entries the budgets hold for a digest of `chars` characters, worked out from the budgets the production constants state, since a shorter digest leaves room for more of them.
    const entriesAt = (chars: number): number => {
      const callBytes = CACHE_COPIES_OF_THE_MEMORY * (chars + TIME_CHARS_IN_AN_ENTRY + QUOTES_AND_COMMA_BYTES);
      return Math.max(Math.floor(CALL_MEMORY_BYTES / callBytes) + Math.floor(SKIPPED_MEMORY_BYTES / callBytes), Math.floor(NAME_MEMORY_BYTES / (chars + QUOTES_AND_COMMA_BYTES)));
    };
    const neededAt = (chars: number): number => SESSION_CALLS_BOUND_BITS + Math.log2(entriesAt(chars)) + SESSION_LOSS_TOLERANCE_BITS;
    expect(entriesAt(CALL_DIGEST_CHARS)).toBe(Math.max(MAX_REMEMBERED_CALLS + MAX_SKIPPED_CALLS, MAX_COUNTED_NAMES));
    expect(DIGEST_BITS_PER_CHAR * CALL_DIGEST_CHARS).toBeGreaterThan(neededAt(CALL_DIGEST_CHARS));
    expect(DIGEST_BITS_PER_CHAR * (CALL_DIGEST_CHARS - 1)).toBeLessThanOrEqual(neededAt(CALL_DIGEST_CHARS - 1));
    const untimed = fold([{ type: "assistant", message: { content: [{ type: "tool_use", id: "u", name: "Glob", input: {} }] } }]).latest.rememberedCalls[0];
    expect(untimed).toHaveLength(CALL_DIGEST_CHARS);
  });

  it("finds the shortest digest with more bits than the bound and the entries need, and one more character when the bits are exactly what they need", () => {
    expect(shortestDigestChars(DIGEST_BITS_PER_CHAR, () => 1)).toBe(2);
    expect(shortestDigestChars(DIGEST_BITS_PER_CHAR - 1, () => 1)).toBe(1);
    expect(shortestDigestChars(0, () => 2 ** DIGEST_BITS_PER_CHAR)).toBe(2);
    expect(shortestDigestChars(0, () => 2 ** (DIGEST_BITS_PER_CHAR + DIGEST_BITS_PER_CHAR))).toBe(CHARS_WHEN_BITS_ARE_EXACT + 1);
  });

  it("takes a forgotten call for in order while up to half of the timed calls after it are older, and not once one more is", () => {
    const olderCalls = Math.floor(MAX_REMEMBERED_CALLS * HALF);
    const records = (older: number): Record<string, unknown>[] => [
      use("first", "Glob", {}, MINUTE),
      ...Array.from({ length: older }, (_, index) => use(`o${String(index)}`, "Glob", {}, MINUTE - (index + 1))),
      ...Array.from({ length: MAX_REMEMBERED_CALLS - older }, (_, index) => use(`n${String(index)}`, "Glob", {}, MINUTE + index)),
    ];
    expect(fold(records(olderCalls)).latest).toMatchObject({ forgottenUpToMs: T0 + MINUTE, skippedCalls: [] });
    const skipped = fold(records(olderCalls + 1)).latest;
    expect(skipped.forgottenUpToMs).toBeUndefined();
    expect(skipped.skippedCalls).toHaveLength(1);
  });

  it("lets go of the oldest skipped calls, and keeps the newest, when there is no room", () => {
    const aheadMs = MANY_TIMES_THE_LIMIT * MAX_LIVE_AGENT_MS;
    const ahead = Array.from({ length: MAX_SKIPPED_CALLS + EXTRA_CALLS }, (_, index) => use(`s${String(index)}`, "Read", {}, aheadMs + index));
    const history = Array.from({ length: MAX_REMEMBERED_CALLS + MAX_SKIPPED_CALLS + EXTRA_CALLS }, (_, index) => use(`h${String(index)}`, "Glob", {}, (index + 1) * SECOND));
    const state = fold([...ahead, ...history]);
    const readAsNew = (record: Record<string, unknown>): boolean => fold([record], state).latest.rememberedCalls.at(-1) !== state.latest.rememberedCalls.at(-1);
    expect(readAsNew(ahead[0] ?? {})).toBe(true);
    expect(readAsNew(ahead.at(-1) ?? {})).toBe(false);
  });

  it("forgets a skipped call once the floor has passed its time, and not before", () => {
    const ahead = use("ahead", "Read", {}, MAX_REMEMBERED_CALLS * SECOND);
    const history = (length: number): Record<string, unknown>[] => Array.from({ length }, (_, index) => use(`h${String(index)}`, "Glob", {}, (index + 1) * SECOND));
    expect(fold([ahead, ...history(MAX_REMEMBERED_CALLS)]).latest.skippedCalls).toHaveLength(1);
    expect(fold([ahead, ...history(2 * MAX_REMEMBERED_CALLS - 1)]).latest.skippedCalls).toHaveLength(1);
    const equal = fold([ahead, ...history(2 * MAX_REMEMBERED_CALLS)]).latest;
    expect(equal.forgottenUpToMs).toBe(T0 + MAX_REMEMBERED_CALLS * SECOND);
    expect(equal.skippedCalls).toEqual([]);
  });

  it("keeps the floor it has when a call older than it is forgotten later", () => {
    const calls = [use("first", "Glob", {}, MINUTE), use("late", "Glob", {}, MINUTE / 2), ...Array.from({ length: MAX_REMEMBERED_CALLS }, (_, index) => use(`d${String(index)}`, "Glob", {}, MINUTE + SECOND * (index + 1)))];
    expect(fold(calls).latest.forgottenUpToMs).toBe(T0 + MINUTE);
  });

  it("hands the next fold the floor and the skipped calls with the calls it remembers, and nothing else", () => {
    const history = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`h${String(index)}`, "Glob", {}, (index + 1) * SECOND));
    const { latest } = fold([use("ahead", "Read", {}, MANY_TIMES_THE_LIMIT * MAX_LIVE_AGENT_MS), ...history]);
    expect(latest.skippedCalls).toHaveLength(1);
    expect(latest.forgottenUpToMs).toBeDefined();
    expect(replayMemoryOf(latest)).toEqual({ ...EMPTY_ACTIVITY_LATEST, rememberedCalls: latest.rememberedCalls, skippedCalls: latest.skippedCalls, forgottenUpToMs: latest.forgottenUpToMs });
  });

  const untimedCall = (id: string): Record<string, unknown> => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Glob", input: {} }] } });

  it("keeps a skipped call the floor has already passed out of the list, which untimed calls diluting the memory can bring about", () => {
    // Told with a memory of four and a skipped list of three: c2@9, c4@9, c6 with no time, c8@1, c10 and c11 with no time. The untimed calls between c4 and c8 are stretched to fill the memory's real length; c2 is forgotten while c4 and c8 are the timed calls remembered after it (one of two older, which leaves it in order) and c4 while c8 alone is (one of one, which does not), so c4 reaches the skipped list only for the floor to drop it.
    const AHEAD_STAMP_MS = 9;
    const OLDER_STAMP_MS = 1;
    /** The calls of that telling that stay remembered (c8, c10 and c11), so the untimed stretch between c4 and c8 fills the memory's length less them. */
    const REMEMBERED_ANCHOR_CALLS = 3;
    const filler = Array.from({ length: MAX_REMEMBERED_CALLS - REMEMBERED_ANCHOR_CALLS }, (_, index) => untimedCall(`c6-${String(index)}`));
    const calls = [use("c2", "Glob", {}, AHEAD_STAMP_MS), use("c4", "Glob", {}, AHEAD_STAMP_MS), ...filler, use("c8", "Glob", {}, OLDER_STAMP_MS), untimedCall("c10"), untimedCall("c11")];
    const state = fold(calls);
    expect(state.latest.forgottenUpToMs).toBe(T0 + AHEAD_STAMP_MS);
    expect(state.latest.skippedCalls).toEqual([]);
    expect(state.latest.rememberedCalls).toHaveLength(MAX_REMEMBERED_CALLS);
    expect(fold([use("c4", "Glob", {}, AHEAD_STAMP_MS)], state).latest.rememberedCalls).toBe(state.latest.rememberedCalls);
  });

  it("leaves calls with no time out of the count that decides whether a forgotten call is in order", () => {
    const calls = [use("only", "Glob", {}, MINUTE), ...Array.from({ length: MAX_REMEMBERED_CALLS }, (_, index) => untimedCall(`u${String(index)}`))];
    const { forgottenUpToMs, skippedCalls } = fold(calls).latest;
    expect(forgottenUpToMs).toBe(T0 + MINUTE);
    expect(skippedCalls).toEqual([]);
  });

  it("keeps a call with no time out of the floor and the skipped calls, since it has nothing to give them", () => {
    const untimed = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: `u${String(index)}`, name: "Glob", input: {} }] } }));
    const { forgottenUpToMs, skippedCalls } = fold(untimed).latest;
    expect(forgottenUpToMs).toBeUndefined();
    expect(skippedCalls).toEqual([]);
  });

  it("keeps a time only when it fits the fixed width and is not negative", () => {
    const entryOf = (isoTime: string): string => fold([{ type: "assistant", timestamp: isoTime, message: { content: [{ type: "tool_use", id: "t", name: "Glob", input: {} }] } }]).latest.rememberedCalls[0] ?? "";
    const widest = BASE_36 ** TIME_CHARS_IN_AN_ENTRY;
    expect(entryOf(new Date(widest - 1).toISOString())).toHaveLength(CALL_DIGEST_CHARS + TIME_CHARS_IN_AN_ENTRY);
    expect(entryOf(new Date(widest).toISOString())).toHaveLength(CALL_DIGEST_CHARS);
    expect(entryOf(new Date(0).toISOString())).toHaveLength(CALL_DIGEST_CHARS + TIME_CHARS_IN_AN_ENTRY);
    expect(entryOf(new Date(-1).toISOString())).toHaveLength(CALL_DIGEST_CHARS);
  });

  it("reads a call never written before as history when it is no newer than the newest call forgotten, and as new when it is newer", () => {
    const history = Array.from({ length: MAX_REMEMBERED_CALLS + EXTRA_CALLS }, (_, index) => use(`k${String(index)}`, "Glob", {}, index));
    const newestForgotten = EXTRA_CALLS - 1;
    const names = (ms: number): string[] => activityFactsOf(fold([use("stray", "Grep", {}, ms)], fold(history)), T0 + SECOND, LIMITS).tools.map((tool) => tool.name);
    expect(names(newestForgotten)).not.toContain("Grep");
    expect(names(newestForgotten + 1)).toContain("Grep");
  });

  it("reads a call that was never written, and is no older than the newest forgotten, as new while the memory holds it", () => {
    const records = [use("a", "Read", {}, MINUTE), use("b", "Grep", {}, 0)];
    expect(factsAt(records).tools.map((tool) => tool.name)).toEqual(["Read", "Grep"]);
  });

  it("keeps no result for a call that was read and has left the tracked window, and applies every result waiting for a call", () => {
    const history = Array.from({ length: MAX_TRACKED_TOOL_CALLS + EXTRA_CALLS }, (_, index) => use(`k${String(index)}`, "Read", {}, index));
    expect(fold([...history, result("k0", STEP.fifth)]).latest.unmatchedResults).toEqual([]);
    const launch = result("j", 1, false, { toolUseResult: { isAsync: true } });
    const ended = { type: "queue-operation", operation: "enqueue", timestamp: at(STEP.third), content: "<task-notification><task-id>t</task-id><tool-use-id>j</tool-use-id></task-notification>" };
    const [agent] = factsAt([launch, ended, use("j", "Agent", { subagent_type: "x", run_in_background: true }, 0)]).agents;
    expect(agent).toMatchObject({ status: "completed", endedAtMs: T0 + STEP.third });
  });
});

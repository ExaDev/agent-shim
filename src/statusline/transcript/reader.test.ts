import { describe, expect, it } from "vitest";

import { CACHE_RETENTION_MS, cacheFileFor } from "../cacheFile";
import { PROMPT_CACHE_TTL_SECONDS } from "../../config/statusline";
import type { StatuslinePorts } from "../ports";
import { fakeStatuslineFilesystem, fakeStatuslinePorts, type FakeStatuslineFilesystem } from "../testing";
import { MAX_LIVE_TOOL_CALL_MS } from "./activity";
import { FINGERPRINT_BYTES, MAX_TRANSCRIPT_READ_BYTES, readTranscript } from "./reader";

const TRANSCRIPT = "/sessions/one.jsonl";
const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const MINUTE = 60_000;

/** Offsets from `T0`, named for what they are. */
const AT = {
  twoMinutes: 120_000,
  threeMinutes: 180_000,
};
const LINE_BYTES = 1_024;
/** The most one refresh reads while the cumulative facts are behind, fingerprint check aside: a window from where the cache ends and the window at the end of the transcript, which is one byte longer so it can tell whether it starts on a line. */
const MAX_READ_PER_REFRESH = 2 * MAX_TRANSCRIPT_READ_BYTES + 1;
/** A line length that does not divide a read, so a read ends inside a line, and how often a record in a run is a compaction. */
const ODD_LINE_BYTES = 997;
const BOUNDARY_EVERY = 7;
/** How many reads a transcript is a little over, three days in milliseconds, and the bytes of a line that are not its filler. */
const OVER_TWO_WINDOWS = 2.5;
const OVER_TWO_WINDOWS_ALIGNED = 3;
const FOUR_WINDOWS_ISH = 3.5;
const SECOND_MS = 1_000;
const THREE_DAYS = 259_200_000;
const PARTIAL_LINE_OVERHEAD = 11;
/** Digits of the response ids the token tests write, enough for every record of a transcript several reads long. */
const ID_DIGITS = 6;
const FIRST_INPUT = 10;
const FIRST_OUTPUT = 5;
const SECOND_INPUT = 20;
const GROWN_OUTPUT = 9;
const CACHE_READ = 100;
/** How many times the filler repeats so a transcript is several reads long, and how many lines past one read another is. */
const FILLER_READS = 3;
const LINES_PAST_A_READ = 5;
/** How many different skills the old part of the activity transcript uses, round and round. */
const EARLY_SKILLS = 3;
const THREE_BOUNDARIES = 3;
/** A first line longer than the part of it that identifies a transcript. */
const OVERSIZED_FIRST_LINE = 70_000;
/** A first line a little longer than the part of it that identifies a transcript, and a first line still being written. */
const LONG_FIRST_LINE = 2 * FINGERPRINT_BYTES;
const UNFINISHED_LINE_BYTES = 100;
/** The bytes cut off the end of a line to leave it half written. */
const HALF_WRITTEN_BYTES = -20;

const at = (ms: number): string => new Date(T0 + ms).toISOString();
const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;
const boundary = (ms: number): string => line({ type: "system", subtype: "compact_boundary", timestamp: at(ms) });
const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** Ports over an in-memory disk that add up the bytes every range read returned, except the reads that check a cache against the file's first line, which are all of one length and are not what a refresh is bounded by, and note each directory listed. */
function countingPorts(disk: FakeStatuslineFilesystem): { readonly ports: StatuslinePorts; readonly listings: string[]; bytesRead: () => number } {
  const listings: string[] = [];
  let total = 0;
  const ports = fakeStatuslinePorts({
    ...disk.ports,
    readRange: (path, start, length) => {
      const range = disk.ports.readRange(path, start, length);
      total += length === FINGERPRINT_BYTES ? 0 : (range?.bytes.length ?? 0);
      return range;
    },
    listDirectory: (path) => {
      listings.push(path);
      return disk.ports.listDirectory(path);
    },
  });
  return { ports, listings, bytesRead: () => total };
}

/** A line of exactly `ODD_LINE_BYTES` bytes, newline included. */
function oddLine(record: Record<string, unknown>): string {
  const json = JSON.stringify(record);
  return `${json}${" ".repeat(ODD_LINE_BYTES - 1 - json.length)}\n`;
}

/** One line of exactly `LINE_BYTES` bytes, newline included, so a file of them has a known layout. */
function paddedLine(record: Record<string, unknown>): string {
  const json = JSON.stringify(record);
  return `${json}${" ".repeat(LINE_BYTES - 1 - json.length)}\n`;
}

describe("readTranscript", () => {
  it("reads the session facts from the transcript", () => {
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: line({ type: "user", timestamp: at(0), slug: "zesty", message: { content: "hi" } }) + line({ type: "assistant", timestamp: at(MINUTE), requestId: "r", message: {} }) + boundary(AT.twoMinutes) });
    const facts = readTranscript(fakeStatuslinePorts(disk.ports), TRANSCRIPT, T0);
    expect(facts).toMatchObject({ complete: true, bytes: bytesOf(disk.files.get(TRANSCRIPT) ?? ""), session: { title: "zesty", startedAtMs: T0, lastResponseAtMs: T0 + MINUTE, compactions: 1 } });
  });

  it("reads only what was appended since the last refresh, and nothing when nothing was", () => {
    const first = line({ type: "user", timestamp: at(0), message: { content: "hi" } }) + boundary(MINUTE);
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: first });
    const { ports, bytesRead } = countingPorts(disk);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(1);
    const afterFirst = bytesRead();
    expect(afterFirst).toBe(bytesOf(first));

    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(1);
    expect(bytesRead() - afterFirst).toBe(0);

    const appended = boundary(AT.twoMinutes);
    disk.files.set(TRANSCRIPT, first + appended);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(2);
    expect(bytesRead() - afterFirst).toBe(bytesOf(appended));
  });

  it("leaves a record the client is still writing for the refresh that finds it whole", () => {
    const whole = boundary(0);
    const half = boundary(MINUTE).slice(0, HALF_WRITTEN_BYTES);
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: whole + half });
    const ports = fakeStatuslinePorts(disk.ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(1);
    disk.files.set(TRANSCRIPT, whole + boundary(MINUTE));
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(2);
  });

  it("keeps what it learned in the cache directory, so a new process carries on from it", () => {
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: boundary(0) });
    readTranscript(fakeStatuslinePorts(disk.ports), TRANSCRIPT, T0);
    const cacheFile = cacheFileFor(fakeStatuslinePorts(), "transcript", TRANSCRIPT);
    expect(cacheFile.startsWith(`${fakeStatuslinePorts().stateDirectory}/`)).toBe(true);
    expect(disk.files.get(cacheFile)).toContain('"compactions":1');
    expect(cacheFileFor(fakeStatuslinePorts(), "transcript", "/sessions/two.jsonl")).not.toBe(cacheFile);
  });

  it("rebuilds from the transcript when the cache is unreadable, from another version, or describes a longer file", () => {
    const text = boundary(0) + boundary(MINUTE);
    const cacheFile = cacheFileFor(fakeStatuslinePorts(), "transcript", TRANSCRIPT);
    const staleCaches = ["{not json", JSON.stringify({ version: 0, offset: 0, complete: true, session: { compactions: 9, cache: {} } }), JSON.stringify({ version: 1, offset: 999_999, complete: true, session: { compactions: 9, cache: {} } })];
    for (const stale of staleCaches) {
      const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: text, [cacheFile]: stale });
      expect(readTranscript(fakeStatuslinePorts(disk.ports), TRANSCRIPT, T0)?.session.compactions, stale).toBe(2);
    }
  });

  it("forgets the cache files not written to for long when it first writes a transcript's cache, and keeps the others", () => {
    const stale = cacheFileFor(fakeStatuslinePorts(), "transcript", "/sessions/old.jsonl");
    const recent = cacheFileFor(fakeStatuslinePorts(), "transcript", "/sessions/recent.jsonl");
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: boundary(0), [stale]: "{}", [recent]: "{}" });
    const modifiedAtMs = new Map([
      [stale, T0 - CACHE_RETENTION_MS - 1],
      [recent, T0 - CACHE_RETENTION_MS],
    ]);
    readTranscript(fakeStatuslinePorts({ ...disk.ports, modifiedAtMs: (path) => modifiedAtMs.get(path) }), TRANSCRIPT, T0);
    expect(disk.files.has(stale)).toBe(false);
    expect(disk.files.has(recent)).toBe(true);
    expect(disk.files.has(cacheFileFor(fakeStatuslinePorts(), "transcript", TRANSCRIPT))).toBe(true);
  });

  it("sums the tokens of the responses, counting a response whose records straddle two refreshes once", () => {
    const response = (id: string, input: number, output: number): string => line({ type: "assistant", timestamp: at(0), message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: CACHE_READ } } });
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: response("a", FIRST_INPUT, FIRST_OUTPUT) + response("b", SECOND_INPUT, 1) });
    const ports = fakeStatuslinePorts(disk.ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.tokens).toEqual({ inputTokens: FIRST_INPUT + SECOND_INPUT, outputTokens: FIRST_OUTPUT + 1, cacheCreationTokens: 0, cacheReadTokens: 2 * CACHE_READ });
    disk.files.set(TRANSCRIPT, (disk.files.get(TRANSCRIPT) ?? "") + response("b", SECOND_INPUT, GROWN_OUTPUT));
    expect(readTranscript(ports, TRANSCRIPT, T0)?.tokens).toEqual({ inputTokens: FIRST_INPUT + SECOND_INPUT, outputTokens: FIRST_OUTPUT + GROWN_OUTPUT, cacheCreationTokens: 0, cacheReadTokens: 2 * CACHE_READ });
  });

  it("sums the tokens of a transcript bigger than a read over successive refreshes, short of the total until it has caught up and equal to it after", () => {
    const filler = paddedLine({ type: "assistant", timestamp: at(0), message: { id: "x", usage: { input_tokens: 1 } } });
    const responses = (FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / LINE_BYTES;
    // Each record is a response of its own: the ids differ, so none is taken for a repeat of the one before.
    const text = Array.from({ length: responses }, (_, index) => filler.replace('"id":"x"', `"id":"r${String(index).padStart(ID_DIGITS, "0")}"`)).join("");
    const ports = fakeStatuslinePorts(fakeStatuslineFilesystem({ [TRANSCRIPT]: text }).ports);
    const first = readTranscript(ports, TRANSCRIPT, T0);
    expect(first?.complete).toBe(false);
    expect(first?.tokens.inputTokens).toBeLessThan(responses);
    let facts = first;
    while (facts?.complete === false) {
      facts = readTranscript(ports, TRANSCRIPT, T0);
    }
    expect(facts?.tokens.inputTokens).toBe(responses);
  });

  it("reads a transcript it cannot read as nothing", () => {
    expect(readTranscript(fakeStatuslinePorts(fakeStatuslineFilesystem({}).ports), TRANSCRIPT, T0)).toBeUndefined();
  });

  it("catches up with a transcript bigger than a read one read per refresh, each bounded by a read, and says so until it has", () => {
    const fillerLines = (FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / LINE_BYTES;
    const early = paddedLine({ type: "system", subtype: "compact_boundary", timestamp: at(0) });
    const filler = paddedLine({ type: "user", timestamp: at(MINUTE), message: { content: "x" } });
    const recent = paddedLine({ type: "system", subtype: "compact_boundary", timestamp: at(AT.twoMinutes) });
    const title = paddedLine({ type: "custom-title", customTitle: "late-name" });
    const text = early + filler.repeat(fillerLines) + recent + title;
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: text });
    const { ports, bytesRead } = countingPorts(disk);
    let facts = readTranscript(ports, TRANSCRIPT, T0);
    const reads = [bytesRead()];
    const completes = [facts?.complete];
    while (facts?.complete === false && completes.length <= FILLER_READS + 1) {
      const before = bytesRead();
      facts = readTranscript(ports, TRANSCRIPT, T0);
      reads.push(bytesRead() - before);
      completes.push(facts?.complete);
    }
    expect(facts).toMatchObject({ complete: true, bytes: bytesOf(text), session: { startedAtMs: T0, compactions: 2, title: "late-name" } });
    expect(completes).toEqual([...Array.from({ length: FILLER_READS }, () => false), true]);
    expect(reads.every((read) => read <= MAX_READ_PER_REFRESH)).toBe(true);

    const afterConverging = bytesRead();
    readTranscript(ports, TRANSCRIPT, T0);
    expect(bytesRead() - afterConverging).toBe(0);
  });

  it("reads at most one read from where the cache ends on each refresh, and the same counts as the whole transcript holds, across reads that end inside a line", () => {
    const fillerLines = (FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / ODD_LINE_BYTES;
    const lines = Array.from({ length: fillerLines }, (_, index) => oddLine(index % BOUNDARY_EVERY === 0 ? { type: "system", subtype: "compact_boundary", timestamp: at(index) } : { type: "user", timestamp: at(index), message: { content: "x" } }));
    const text = lines.join("") + boundary(AT.twoMinutes);
    const expectedCompactions = lines.filter((entry) => entry.includes("compact_boundary")).length + 1;
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: text });
    const { ports, bytesRead } = countingPorts(disk);
    let facts = readTranscript(ports, TRANSCRIPT, T0);
    let refreshes = 1;
    expect(bytesRead()).toBeLessThanOrEqual(MAX_READ_PER_REFRESH);
    while (facts?.complete === false) {
      const before = bytesRead();
      facts = readTranscript(ports, TRANSCRIPT, T0);
      refreshes += 1;
      expect(bytesRead() - before).toBeLessThanOrEqual(MAX_READ_PER_REFRESH);
      expect(refreshes).toBeLessThanOrEqual(Math.ceil(bytesOf(text) / MAX_TRANSCRIPT_READ_BYTES) + 1);
    }
    expect(facts?.session.compactions).toBe(expectedCompactions);
    // More than one read was needed, so the equality above is the result of folding across read boundaries that fall inside lines.
    expect(refreshes).toBeGreaterThan(FILLER_READS);
  });

  it("reports what the end of a long transcript says on the first refresh, while the totals are still being caught up", () => {
    const records = Math.ceil((OVER_TWO_WINDOWS * MAX_TRANSCRIPT_READ_BYTES) / ODD_LINE_BYTES);
    // Each record is a response of its own, so each adds its token to the totals.
    const old = Array.from({ length: records }, (_, index) => oddLine({ type: "assistant", timestamp: at(0), slug: "old-slug", requestId: "r", message: { id: `o${String(index)}`, usage: { input_tokens: 1 } } })).join("");
    const newest = line({ type: "assistant", timestamp: at(THREE_DAYS), requestId: "r-final", message: { id: "final", usage: { input_tokens: 1 } } }) + line({ type: "custom-title", customTitle: "Final name" });
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: old + newest });
    const { ports, bytesRead } = countingPorts(disk);

    const first = readTranscript(ports, TRANSCRIPT, T0);
    expect(first).toMatchObject({ complete: false, session: { title: "Final name", lastResponseAtMs: T0 + THREE_DAYS, startedAtMs: T0 } });
    // The cache clock is anchored to the request the last response answers, which is the record before it.
    expect(first?.session.promptCache?.anchorAtMs).toBe(T0);
    expect(first?.tokens.inputTokens).toBeLessThan(records + 1);
    expect(bytesRead()).toBeLessThanOrEqual(MAX_READ_PER_REFRESH);

    let facts = first;
    let refreshes = 1;
    while (facts?.complete === false) {
      const before = bytesRead();
      facts = readTranscript(ports, TRANSCRIPT, T0);
      refreshes += 1;
      expect(bytesRead() - before).toBeLessThanOrEqual(MAX_READ_PER_REFRESH);
      expect(facts?.session, `refresh ${String(refreshes)}`).toMatchObject({ title: "Final name", lastResponseAtMs: T0 + THREE_DAYS });
    }
    // The totals after catching up are those of a full scan, and the latest-state facts are still the end's.
    expect(facts).toMatchObject({ complete: true, tokens: { inputTokens: records + 1 }, session: { title: "Final name", lastResponseAtMs: T0 + THREE_DAYS, startedAtMs: T0 } });
    expect(disk.files.get(cacheFileFor(ports, "transcript", TRANSCRIPT))).not.toContain('"newer"');
  });

  it("reads what the session is doing: its tool calls, agents and todo list, and the skills and servers it has used", () => {
    const calls: readonly (readonly [string, string, Record<string, unknown>])[] = [
      ["r", "Read", { file_path: "/a/b.ts" }],
      ["s", "Skill", { skill: "commit" }],
      ["m", "mcp__github__list_issues", {}],
      ["g", "Agent", { subagent_type: "Explore", description: "Look around" }],
      ["t", "TaskCreate", { subject: "Write it" }],
    ];
    const text =
      calls
        .map(([id, name, input], index) => line({ type: "assistant", timestamp: at(index * SECOND_MS), message: { content: [{ type: "tool_use", id, name, input }] } }))
        .join("") + line({ type: "user", timestamp: at(calls.length * SECOND_MS), message: { content: [{ type: "tool_result", tool_use_id: "r", content: "ok" }] } });
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: text });
    const facts = readTranscript(fakeStatuslinePorts(disk.ports), TRANSCRIPT, T0 + (calls.length + 1) * SECOND_MS);
    expect(facts?.activity.tools.map((tool) => `${tool.name}:${tool.status}`)).toEqual(["Read:completed", "Skill:running", "mcp__github__list_issues:running"]);
    expect(facts?.activity).toMatchObject({ skills: ["commit"], mcpServers: ["github"], agents: [{ type: "Explore", description: "Look around", status: "running" }], todos: [{ content: "Write it", status: "pending" }] });
  });

  it("pairs a tool call with a result that arrives in a later refresh, from the cache, and ages a call with no result by the clock it is given", () => {
    const call = line({ type: "assistant", timestamp: at(0), message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "sleep 5" } }] } });
    const answer = line({ type: "user", timestamp: at(SECOND_MS), message: { content: [{ type: "tool_result", tool_use_id: "x", content: "" }] } });
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: call });
    expect(readTranscript(fakeStatuslinePorts(disk.ports), TRANSCRIPT, T0)?.activity.tools).toEqual([{ name: "Bash", target: "sleep 5", status: "running" }]);
    expect(readTranscript(fakeStatuslinePorts(disk.ports), TRANSCRIPT, T0 + MAX_LIVE_TOOL_CALL_MS + 1)?.activity.tools).toEqual([]);
    disk.files.set(TRANSCRIPT, call + answer);
    expect(readTranscript(fakeStatuslinePorts(disk.ports), TRANSCRIPT, T0 + MAX_LIVE_TOOL_CALL_MS + 1)?.activity.tools).toEqual([{ name: "Bash", target: "sleep 5", status: "completed" }]);
  });

  it("reports the calls and todo list the end of a long transcript holds on the first refresh, and the skills only once it has caught up", () => {
    const records = Math.ceil((OVER_TWO_WINDOWS * MAX_TRANSCRIPT_READ_BYTES) / ODD_LINE_BYTES);
    const old = Array.from({ length: records }, (_, index) => oddLine({ type: "assistant", timestamp: at(0), message: { id: `o${String(index)}`, content: [{ type: "tool_use", id: `old${String(index)}`, name: "Skill", input: { skill: `early-${String(index % EARLY_SKILLS)}` } }] } })).join("");
    const newest =
      line({ type: "assistant", timestamp: at(THREE_DAYS), message: { content: [{ type: "tool_use", id: "last", name: "Grep", input: { pattern: "needle" } }] } }) +
      line({ type: "assistant", timestamp: at(THREE_DAYS), message: { content: [{ type: "tool_use", id: "todo", name: "TodoWrite", input: { todos: [{ content: "Finish", status: "in_progress" }] } }, { type: "tool_use", id: "skill-late", name: "Skill", input: { skill: "late" } }] } });
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: old + newest });
    const { ports, bytesRead } = countingPorts(disk);

    const first = readTranscript(ports, TRANSCRIPT, T0 + THREE_DAYS);
    expect(first).toMatchObject({ complete: false, activity: { todos: [{ content: "Finish", status: "in_progress" }] } });
    expect(first?.activity.tools.map((tool) => tool.name)).toContain("Grep");
    expect(first?.activity.skills).not.toContain("late");
    expect(bytesRead()).toBeLessThanOrEqual(MAX_READ_PER_REFRESH);

    let facts = first;
    while (facts?.complete === false) {
      const before = bytesRead();
      facts = readTranscript(ports, TRANSCRIPT, T0 + THREE_DAYS);
      expect(bytesRead() - before).toBeLessThanOrEqual(MAX_READ_PER_REFRESH);
      expect(facts?.activity.todos).toEqual([{ content: "Finish", status: "in_progress" }]);
    }
    expect(facts?.activity.skills).toEqual(["early-0", "early-1", "early-2", "late"]);
    expect(facts?.activity.tools.at(-1)?.name).toBe("Skill");
  });

  it("keeps the cache tier an early write showed when the end of the transcript holds a request but no write that names a tier", () => {
    const write = oddLine({ type: "assistant", timestamp: at(0), requestId: "r0", message: { id: "w", usage: { cache_creation: { ephemeral_1h_input_tokens: 5 } } } });
    const filler = oddLine({ type: "user", timestamp: at(MINUTE), message: { content: "x" } }).repeat(Math.ceil((OVER_TWO_WINDOWS * MAX_TRANSCRIPT_READ_BYTES) / ODD_LINE_BYTES));
    const end = line({ type: "user", timestamp: at(AT.twoMinutes), message: { content: "next" } }) + line({ type: "assistant", timestamp: at(AT.threeMinutes), requestId: "r1", message: { id: "r", usage: { cache_read_input_tokens: 9 } } });
    const ports = fakeStatuslinePorts(fakeStatuslineFilesystem({ [TRANSCRIPT]: write + filler + end }).ports);
    const first = readTranscript(ports, TRANSCRIPT, T0);
    expect(first).toMatchObject({ complete: false, session: { promptCache: { ttlSeconds: PROMPT_CACHE_TTL_SECONDS.oneHour } } });
    expect(first?.session.promptCache?.anchorAtMs).toBe(T0 + AT.twoMinutes);
    let facts = first;
    while (facts?.complete === false) {
      facts = readTranscript(ports, TRANSCRIPT, T0);
    }
    expect(facts?.session.promptCache).toEqual({ anchorAtMs: T0 + AT.twoMinutes, ttlSeconds: PROMPT_CACHE_TTL_SECONDS.oneHour });
  });

  it("shows a title set in the middle of a long transcript only when the reader reaches it, since the last window holds none", () => {
    const filler = oddLine({ type: "user", timestamp: at(0), message: { content: "x" } });
    const half = filler.repeat(Math.ceil(MAX_TRANSCRIPT_READ_BYTES / ODD_LINE_BYTES));
    const text = line({ type: "custom-title", customTitle: "A" }) + half + line({ type: "custom-title", customTitle: "B" }) + half.repeat(2) + half.slice(0, MAX_TRANSCRIPT_READ_BYTES);
    const ports = fakeStatuslinePorts(fakeStatuslineFilesystem({ [TRANSCRIPT]: text }).ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.title).toBe("A");
    let facts = readTranscript(ports, TRANSCRIPT, T0);
    expect(facts?.session.title).toBe("B");
    while (facts?.complete === false) {
      facts = readTranscript(ports, TRANSCRIPT, T0);
    }
    expect(facts?.session.title).toBe("B");
  });

  it("reads a tail window that starts exactly on a line from its first whole line", () => {
    const filler = paddedLine({ type: "user", timestamp: at(0), message: { content: "x" } });
    const windowLines = MAX_TRANSCRIPT_READ_BYTES / LINE_BYTES;
    // Three windows of lines: the title "Old" is in the first, and the last window begins on the line that sets "Aligned".
    const text = paddedLine({ type: "custom-title", customTitle: "Old" }) + filler.repeat(2 * windowLines - 1) + paddedLine({ type: "custom-title", customTitle: "Aligned" }) + filler.repeat(windowLines - 1);
    expect(bytesOf(text)).toBe(OVER_TWO_WINDOWS_ALIGNED * MAX_TRANSCRIPT_READ_BYTES);
    const ports = fakeStatuslinePorts(fakeStatuslineFilesystem({ [TRANSCRIPT]: text }).ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { title: "Aligned" } });
  });

  it("does not trust a fold of the end that lies past the end of a transcript that was cut short", () => {
    const record = (index: number): string => oddLine({ type: "assistant", timestamp: at(index * SECOND_MS), requestId: `r${String(index)}`, message: { id: `m${String(index)}` } });
    const total = Math.ceil((FOUR_WINDOWS_ISH * MAX_TRANSCRIPT_READ_BYTES) / ODD_LINE_BYTES);
    const cut = Math.ceil((OVER_TWO_WINDOWS * MAX_TRANSCRIPT_READ_BYTES) / ODD_LINE_BYTES);
    const lines = Array.from({ length: total }, (_, index) => record(index));
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: lines.join("") });
    const ports = fakeStatuslinePorts(disk.ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { lastResponseAtMs: T0 + (total - 1) * SECOND_MS } });
    // The transcript is cut to a length between where the cumulative fold is and where the fold of the end read to, keeping its start.
    disk.files.set(TRANSCRIPT, lines.slice(0, cut).join(""));
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { lastResponseAtMs: T0 + (cut - 1) * SECOND_MS } });
  });

  it("keeps a title the first window read when the end of the transcript sets none, and a later one over it when it does", () => {
    const title = line({ type: "ai-title", aiTitle: "Early title" });
    const records = Math.ceil((OVER_TWO_WINDOWS * MAX_TRANSCRIPT_READ_BYTES) / ODD_LINE_BYTES);
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: title + oddLine({ type: "user", timestamp: at(0), message: { content: "x" } }).repeat(records) });
    const ports = fakeStatuslinePorts(disk.ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { title: "Early title" } });
    disk.files.set(TRANSCRIPT, (disk.files.get(TRANSCRIPT) ?? "") + line({ type: "custom-title", customTitle: "Renamed" }));
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { title: "Renamed" } });
  });

  it("folds what is appended while it is still catching up into the end's facts, reading only the appended bytes for them", () => {
    const records = Math.ceil((OVER_TWO_WINDOWS * MAX_TRANSCRIPT_READ_BYTES) / ODD_LINE_BYTES);
    const text = oddLine({ type: "assistant", timestamp: at(0), requestId: "r", message: { id: "old" } }).repeat(records);
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: text });
    const { ports, bytesRead } = countingPorts(disk);
    readTranscript(ports, TRANSCRIPT, T0);
    const appended = line({ type: "assistant", timestamp: at(THREE_DAYS), requestId: "r-new", message: { id: "new" } });
    disk.files.set(TRANSCRIPT, text + appended);
    const before = bytesRead();
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { lastResponseAtMs: T0 + THREE_DAYS } });
    expect(bytesRead() - before).toBe(MAX_TRANSCRIPT_READ_BYTES + bytesOf(appended));
  });

  it("is complete after the read that takes in exactly one window to the end of the transcript", () => {
    const text = paddedLine({ type: "system", subtype: "compact_boundary", timestamp: at(0) }).repeat((2 * MAX_TRANSCRIPT_READ_BYTES) / LINE_BYTES);
    const ports = fakeStatuslinePorts(fakeStatuslineFilesystem({ [TRANSCRIPT]: text }).ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.complete).toBe(false);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: true, session: { compactions: (2 * MAX_TRANSCRIPT_READ_BYTES) / LINE_BYTES } });
  });

  it("takes a line of exactly one window with no newline yet for a line still being written, and a line that no longer fits a window with its newline for a bigger one", () => {
    const whole = paddedLine({ type: "system", subtype: "compact_boundary", timestamp: at(0) }).repeat(MAX_TRANSCRIPT_READ_BYTES / LINE_BYTES);
    const partial = `{"note":"${"x".repeat(MAX_TRANSCRIPT_READ_BYTES - PARTIAL_LINE_OVERHEAD)}"}`;
    expect(bytesOf(partial)).toBe(MAX_TRANSCRIPT_READ_BYTES);
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: whole + partial });
    const ports = fakeStatuslinePorts(disk.ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.complete).toBe(false);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: true, session: { compactions: MAX_TRANSCRIPT_READ_BYTES / LINE_BYTES } });
    disk.files.set(TRANSCRIPT, `${whole}${partial}\n${boundary(MINUTE)}`);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false });
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { compactions: MAX_TRANSCRIPT_READ_BYTES / LINE_BYTES + 1 } });
  });

  it("folds what is appended after it has caught up without reading the rest again", () => {
    const text = paddedLine({ type: "system", subtype: "compact_boundary", timestamp: at(0) }).repeat((FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / LINE_BYTES);
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: text });
    const { ports, bytesRead } = countingPorts(disk);
    let facts = readTranscript(ports, TRANSCRIPT, T0);
    while (facts?.complete === false) {
      facts = readTranscript(ports, TRANSCRIPT, T0);
    }
    expect(facts?.session.compactions).toBe((FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / LINE_BYTES);
    const before = bytesRead();
    const appended = boundary(MINUTE);
    disk.files.set(TRANSCRIPT, text + appended);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: true, session: { compactions: (FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / LINE_BYTES + 1 } });
    expect(bytesRead() - before).toBe(bytesOf(appended));
  });

  it("takes the first line of the window when the window starts exactly on a line", () => {
    const lines = MAX_TRANSCRIPT_READ_BYTES / LINE_BYTES + LINES_PAST_A_READ;
    const text = paddedLine({ type: "system", subtype: "compact_boundary", timestamp: at(0) }).repeat(lines);
    expect(bytesOf(text) % LINE_BYTES).toBe(0);
    const facts = readTranscript(fakeStatuslinePorts(fakeStatuslineFilesystem({ [TRANSCRIPT]: text }).ports), TRANSCRIPT, T0);
    expect(facts?.session.compactions).toBe(MAX_TRANSCRIPT_READ_BYTES / LINE_BYTES);
  });

  it("catches up over successive refreshes with a transcript that has grown by more than a read takes in, and says so until it has", () => {
    const first = boundary(0);
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: first });
    const ports = fakeStatuslinePorts(disk.ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: true, session: { compactions: 1 } });

    const middle = paddedLine({ type: "system", subtype: "compact_boundary", timestamp: at(MINUTE) });
    const filler = paddedLine({ type: "user", timestamp: at(AT.twoMinutes), message: { content: "x" } }).repeat(MAX_TRANSCRIPT_READ_BYTES / LINE_BYTES);
    disk.files.set(TRANSCRIPT, first + middle + filler + boundary(AT.threeMinutes));
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { startedAtMs: T0, compactions: 2 } });
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: true, session: { startedAtMs: T0, compactions: THREE_BOUNDARIES } });
  });

  it("starts again when the file at the path begins with the same line but is shorter than what was read of it", () => {
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: boundary(0) + boundary(MINUTE) + boundary(AT.twoMinutes) });
    const ports = fakeStatuslinePorts(disk.ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(THREE_BOUNDARIES);
    disk.files.set(TRANSCRIPT, boundary(0));
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(1);
  });

  it("keeps its cache across refreshes for a first line longer than the part of it that identifies the transcript", () => {
    const first = line({ type: "mode", note: "x".repeat(LONG_FIRST_LINE) });
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: first + boundary(0) });
    const { ports, bytesRead } = countingPorts(disk);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(1);
    const afterFirst = bytesRead();
    const appended = boundary(MINUTE);
    disk.files.set(TRANSCRIPT, first + boundary(0) + appended);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(2);
    expect(bytesRead() - afterFirst).toBe(bytesOf(appended));
  });

  it("writes no cache while the first line is still being written", () => {
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: line({ type: "mode", note: "x".repeat(2 * UNFINISHED_LINE_BYTES) }).slice(0, UNFINISHED_LINE_BYTES) });
    const { ports } = countingPorts(disk);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(0);
    expect([...disk.files.keys()]).toEqual([TRANSCRIPT]);
  });

  it("passes a single line bigger than a read a read at a time, while it is still being written, reading no more than a refresh may", () => {
    const huge = line({ type: "user", timestamp: at(0), message: { content: "x".repeat(MAX_TRANSCRIPT_READ_BYTES + LINE_BYTES) } });
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: huge.slice(0, -1) });
    const { ports, bytesRead } = countingPorts(disk);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { startedAtMs: undefined, compactions: 0 } });
    expect(bytesRead()).toBeLessThanOrEqual(MAX_READ_PER_REFRESH);
    const afterFirst = bytesRead();
    readTranscript(ports, TRANSCRIPT, T0);
    expect(bytesRead() - afterFirst).toBeLessThanOrEqual(MAX_READ_PER_REFRESH);
    const afterSecond = bytesRead();
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false });
    expect(bytesRead() - afterSecond).toBe(0);
    // The line ends, and the records after it are folded, though the facts stay incomplete: what the line said is lost.
    disk.files.set(TRANSCRIPT, huge + boundary(MINUTE));
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { compactions: 1 } });
  });

  it("takes the start from a timestamped record past a long untimestamped first line", () => {
    const untimestamped = line({ type: "file-history-snapshot", snapshot: "x".repeat(OVERSIZED_FIRST_LINE) });
    const filler = paddedLine({ type: "user", timestamp: at(MINUTE), message: { content: "x" } }).repeat((FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / LINE_BYTES);
    const text = untimestamped + line({ type: "user", timestamp: at(0) }) + filler;
    const facts = readTranscript(fakeStatuslinePorts(fakeStatuslineFilesystem({ [TRANSCRIPT]: text }).ports), TRANSCRIPT, T0);
    expect(facts).toMatchObject({ complete: false, session: { startedAtMs: T0 } });
  });

  it("finds the start wherever the first timestamp is, once it has caught up, and shows none before", () => {
    const filler = paddedLine({ type: "mode" }).repeat((FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / LINE_BYTES);
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: filler + line({ type: "user", timestamp: at(MINUTE) }) });
    const ports = fakeStatuslinePorts(disk.ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.startedAtMs).toBeUndefined();
    let facts = readTranscript(ports, TRANSCRIPT, T0);
    while (facts?.complete === false) {
      facts = readTranscript(ports, TRANSCRIPT, T0);
    }
    expect(facts?.session.startedAtMs).toBe(T0 + MINUTE);
    disk.files.set(TRANSCRIPT, (disk.files.get(TRANSCRIPT) ?? "") + line({ type: "user", timestamp: at(AT.twoMinutes) }));
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.startedAtMs).toBe(T0 + MINUTE);
  });

  it("leaves the start unknown for good when a line too big to read came before any timestamp", () => {
    const huge = line({ type: "mode", note: "x".repeat(MAX_TRANSCRIPT_READ_BYTES + LINE_BYTES) });
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: huge + line({ type: "user", timestamp: at(MINUTE) }) });
    const ports = fakeStatuslinePorts(disk.ports);
    for (let refresh = 0; refresh < THREE_BOUNDARIES; refresh += 1) {
      readTranscript(ports, TRANSCRIPT, T0);
    }
    disk.files.set(TRANSCRIPT, (disk.files.get(TRANSCRIPT) ?? "") + line({ type: "user", timestamp: at(AT.twoMinutes) }));
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { startedAtMs: undefined } });
  });

  it("does not use the state of a different file that has taken the path's place, even a longer one", () => {
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: line({ type: "user", timestamp: at(0), slug: "old" }) + boundary(MINUTE) });
    const ports = fakeStatuslinePorts(disk.ports);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ session: { title: "old", compactions: 1, startedAtMs: T0 } });
    disk.files.set(TRANSCRIPT, line({ type: "user", timestamp: at(AT.threeMinutes), slug: "new" }) + boundary(AT.threeMinutes) + boundary(AT.threeMinutes) + boundary(AT.threeMinutes));
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ session: { title: "new", compactions: THREE_BOUNDARIES, startedAtMs: T0 + AT.threeMinutes } });
  });

  it("passes a complete line longer than a read, so later refreshes read only what is new", () => {
    const first = boundary(0);
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: first });
    const { ports, bytesRead } = countingPorts(disk);
    readTranscript(ports, TRANSCRIPT, T0);
    const oversized = line({ type: "user", timestamp: at(MINUTE), message: { content: "x".repeat(MAX_TRANSCRIPT_READ_BYTES + LINE_BYTES) } });
    disk.files.set(TRANSCRIPT, first + oversized);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { compactions: 1 } });
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { compactions: 1 } });
    const afterOversized = bytesRead();
    const appended = boundary(AT.twoMinutes);
    disk.files.set(TRANSCRIPT, first + oversized + appended);
    expect(readTranscript(ports, TRANSCRIPT, T0)?.session.compactions).toBe(2);
    expect(bytesRead() - afterOversized).toBe(bytesOf(appended));
  });

  it("scans the cache directory only when it first writes a transcript's cache, not when nothing could be saved or on later writes", () => {
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: "" });
    const { ports, listings } = countingPorts(disk);
    readTranscript(ports, TRANSCRIPT, T0);
    readTranscript(ports, TRANSCRIPT, T0);
    expect(listings).toEqual([]);
    disk.files.set(TRANSCRIPT, boundary(0));
    readTranscript(ports, TRANSCRIPT, T0);
    disk.files.set(TRANSCRIPT, boundary(0) + boundary(MINUTE));
    readTranscript(ports, TRANSCRIPT, T0);
    expect(listings).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";

import { CACHE_RETENTION_MS, cacheFileFor } from "../cacheFile";
import type { StatuslinePorts } from "../ports";
import { fakeStatuslineFilesystem, fakeStatuslinePorts, type FakeStatuslineFilesystem } from "../testing";
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
/** A line length that does not divide a read, so a read ends inside a line, and how often a record in a run is a compaction. */
const ODD_LINE_BYTES = 997;
const BOUNDARY_EVERY = 7;
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
    expect(reads.every((read) => read <= MAX_TRANSCRIPT_READ_BYTES)).toBe(true);

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
    expect(bytesRead()).toBeLessThanOrEqual(MAX_TRANSCRIPT_READ_BYTES);
    while (facts?.complete === false) {
      const before = bytesRead();
      facts = readTranscript(ports, TRANSCRIPT, T0);
      refreshes += 1;
      expect(bytesRead() - before).toBeLessThanOrEqual(MAX_TRANSCRIPT_READ_BYTES);
      expect(refreshes).toBeLessThanOrEqual(Math.ceil(bytesOf(text) / MAX_TRANSCRIPT_READ_BYTES) + 1);
    }
    expect(facts?.session.compactions).toBe(expectedCompactions);
    // More than one read was needed, so the equality above is the result of folding across read boundaries that fall inside lines.
    expect(refreshes).toBeGreaterThan(FILLER_READS);
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

  it("passes a single line bigger than a read a read at a time, while it is still being written, without ever reading more than a read", () => {
    const huge = line({ type: "user", timestamp: at(0), message: { content: "x".repeat(MAX_TRANSCRIPT_READ_BYTES + LINE_BYTES) } });
    const disk = fakeStatuslineFilesystem({ [TRANSCRIPT]: huge.slice(0, -1) });
    const { ports, bytesRead } = countingPorts(disk);
    expect(readTranscript(ports, TRANSCRIPT, T0)).toMatchObject({ complete: false, session: { startedAtMs: undefined, compactions: 0 } });
    expect(bytesRead()).toBeLessThanOrEqual(MAX_TRANSCRIPT_READ_BYTES);
    const afterFirst = bytesRead();
    readTranscript(ports, TRANSCRIPT, T0);
    expect(bytesRead() - afterFirst).toBeLessThanOrEqual(MAX_TRANSCRIPT_READ_BYTES);
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

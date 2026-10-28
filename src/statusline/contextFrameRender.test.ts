import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveStatusline, type StatuslineSettings } from "../config/statusline";
import { CACHE_RETENTION_MS, cacheFileFor } from "./cacheFile";
import { CONTEXT_RECORD_MAX_AGE_MS, CONTEXT_WRITE_INTERVAL_MS } from "./contextFrame";
import { parseClientPayload, viewOf, type ContextWindowFrame } from "./payload";
import { realStatuslinePorts, type StatuslinePorts } from "./ports";
import { ELEMENTS, type ElementRegistry } from "./elements/registry";
import { renderStatuslineBlock } from "./render";
import { fakeStatuslineFilesystem, fakeStatuslinePorts, fakeStatuslineSummary } from "./testing";
import { MAX_TRANSCRIPT_READ_BYTES, readTranscript } from "./transcript/reader";
import type { Compaction } from "./transcript/session";
import { T0, SECOND, WINDOW, NEGATIVE_PERCENT, SMALLER_WINDOW, GOOD_PERCENT, LATER_PERCENT, GOOD_HELD, POST_TOKENS, POST_PERCENT, FRACTIONAL_POST_TOKENS, FULL_PERCENT, NEGATIVE_COUNT, EMPTY_WINDOW, NEGATIVE_WINDOW, SLIVER_HELD, MOST_HELD_WRITTEN_AS_NONE, LEAST_HELD_WRITTEN_AS_SOME, QUARTER_HELD, HALF_HIT_RATIO, CRITICAL_POST_TOKENS, ZERO_USAGE, TRANSCRIPT, OTHER_TRANSCRIPT, RED, FILLER_CHARACTERS, FILLER_READS, GOOD_INPUT, GOOD_CACHE_READ, GOOD, LATER, HIGH, ZERO, machine, drawnAt, contextLine, stripAnsi, renderAt, usage } from "./contextFrameTesting";

/** A percentage above 0 the row writes as `0.0%`: a frame reporting it is not a suspicious zero, so neither agent-shim nor claude-hud rewrites it. */
const PERCENT_WRITTEN_AS_NONE = 0.04;

/** Offsets within one second of `T0` of a reading and of a compaction stamped after it, which a comparison to the whole second would put at the same time. */
const READING_OFFSET_MS = 200;
const BOUNDARY_OFFSET_MS = 500;

/** Tokens a compaction left that make 33.36% of `WINDOW`, which the row writes rounded to the nearest tenth as `33.4%`. */
const ROUNDED_UP_POST_TOKENS = 66_720;

/** Tokens a record holds that make 30% of `WINDOW`. */
const RESTORED_HELD = 60_000;

/** Half a token: a fraction a client's figures can carry, which the record keeps as it is. */
const HALF_TOKEN = 0.5;

describe("the context row on a suspicious zero", () => {
  it("draws the last good frame's tokens, percentage, colour, cache hit share and breakdown", () => {
    const box = machine();
    contextLine(box, HIGH, T0);
    const line = contextLine(box, ZERO, T0 + SECOND);
    expect(stripAnsi(line)).toMatch(/^Ctx 184k\/200k \[.*\] 92\.0% \(Cache: 98%\) \(in: 4\.0k, cache: 180k\)$/);
    expect(line).toContain(`${RED}92.0%`);
  });

  it("draws the percentage the newest compaction in the transcript left, with no breakdown, read through the transcript reader", () => {
    const box = machine({ [TRANSCRIPT]: `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(T0 + SECOND).toISOString(), compactMetadata: { postTokens: POST_TOKENS } })}\n` });
    contextLine(box, HIGH, T0);
    expect(stripAnsi(contextLine(box, ZERO, T0 + 2 * SECOND))).toMatch(/^Ctx 0\/200k \[.*\] 15\.0%$/);
  });

  it("draws the percentage a compaction left to one decimal, rounded to the nearest", () => {
    const boundary = (postTokens: number): string => `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(T0).toISOString(), compactMetadata: { postTokens } })}\n`;
    expect(stripAnsi(contextLine(machine({ [TRANSCRIPT]: boundary(FRACTIONAL_POST_TOKENS) }), ZERO, T0 + SECOND))).toMatch(/^Ctx 0\/200k \[.*\] 15\.5%$/);
    expect(stripAnsi(contextLine(machine({ [TRANSCRIPT]: boundary(ROUNDED_UP_POST_TOKENS) }), ZERO, T0 + SECOND))).toMatch(/^Ctx 0\/200k \[.*\] 33\.4%$/);
  });

  it("draws the last good frame's tokens over a window of 0 the frame reports, keeping that window as claude-hud does", () => {
    const box = machine();
    contextLine(box, GOOD, T0);
    expect(stripAnsi(contextLine(box, { ...ZERO, context_window_size: EMPTY_WINDOW }, T0 + SECOND))).toMatch(/^Ctx 80k\/0 /);
  });

  it("measures the last good frame's tokens against a window the settings give", () => {
    const box = machine();
    contextLine(box, GOOD, T0);
    expect(stripAnsi(contextLine(box, ZERO, T0 + SECOND, { context: { autoCompactWindow: SMALLER_WINDOW } }))).toMatch(/^Ctx 80k\/100k \[.*\] 80\.0% \(Cache: 99%\)$/);
  });

  it("draws the estimate from the tokens held where the row makes one, and the last good frame where it makes none", () => {
    const box = machine();
    contextLine(box, GOOD, T0);
    expect(stripAnsi(contextLine(box, { ...ZERO, total_input_tokens: POST_TOKENS }, T0 + SECOND))).toMatch(/^Ctx 30k\/200k \[.*\] 18\.7%$/);
    for (const unestimated of [{ used_percentage: 0, total_input_tokens: POST_TOKENS }, { ...ZERO, total_input_tokens: NEGATIVE_COUNT }]) {
      expect(stripAnsi(contextLine(box, unestimated, T0 + SECOND))).toMatch(/^Ctx 80k\/200k \[.*\] 40\.0% \(Cache: 99%\)$/);
    }
    expect(stripAnsi(contextLine(box, { ...ZERO, total_input_tokens: POST_TOKENS }, T0 + SECOND, { context: { estimate: "never" } }))).toMatch(/^Ctx 80k\/200k \[.*\] 40\.0% \(Cache: 99%\)$/);
  });

  it.each([
    ["a percentage of 0", { ...ZERO, total_input_tokens: SLIVER_HELD }],
    ["no percentage", { context_window_size: WINDOW, total_input_tokens: SLIVER_HELD }],
  ])("draws an estimate below 1% from the tokens held beside %s as it stands, since any percentage in use above 0 to one decimal is a reading", (_name, frame) => {
    const box = machine();
    contextLine(box, GOOD, T0);
    expect(stripAnsi(contextLine(box, frame, T0 + SECOND, { context: { estimate: "raw" } }))).toMatch(/^Ctx 600\/200k \[.*\] 0\.3%$/);
  });

  it("draws a frame reporting a percentage above 0 that the row writes as 0.0% as it stands and keeps it, since only a suspicious zero is rewritten, as in claude-hud", () => {
    const box = machine();
    contextLine(box, GOOD, T0);
    expect(stripAnsi(contextLine(box, { context_window_size: WINDOW, used_percentage: PERCENT_WRITTEN_AS_NONE }, T0 + CONTEXT_WRITE_INTERVAL_MS))).toMatch(/^Ctx \[.*\] 0\.0%$/);
    expect(stripAnsi(contextLine(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS + SECOND))).toMatch(/^Ctx \[.*\] 0\.0%$/);
  });

  it("draws no row from a frame reporting a percentage without total_input_tokens while a window is set, and keeps it, since only a suspicious zero is rewritten, as in claude-hud", () => {
    const box = machine();
    contextLine(box, GOOD, T0);
    const settings: StatuslineSettings = { context: { autoCompactWindow: SMALLER_WINDOW } };
    expect(stripAnsi(contextLine(box, { context_window_size: WINDOW, used_percentage: LATER_PERCENT }, T0 + CONTEXT_WRITE_INTERVAL_MS, settings))).toBe("");
    expect(stripAnsi(contextLine(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS + SECOND))).toMatch(/^Ctx \[.*\] 60\.0%$/);
  });

  it("measures a frame reporting 0 tokens held against a window the settings give as 0.0%, and draws no row from one that does not report them", () => {
    const box = machine();
    const settings: StatuslineSettings = { context: { autoCompactWindow: SMALLER_WINDOW } };
    expect(stripAnsi(contextLine(box, { ...GOOD, total_input_tokens: 0 }, T0, settings))).toMatch(/^Ctx 0\/100k \[.*\] 0\.0% \(Cache: 99%\)$/);
    expect(stripAnsi(contextLine(box, { context_window_size: WINDOW, used_percentage: GOOD_PERCENT }, T0, settings))).toBe("");
  });

  it.each<[string, StatuslineSettings]>([
    ["buffered", {}],
    ["raw", { context: { estimate: "raw" } }],
  ])("rewrites a frame whose %s estimate from the tokens held the row would write as 0.0%%, as claude-hud rewrites it, and draws the least estimate it writes as 0.1%% as it stands", (_, settings) => {
    const box = machine();
    contextLine(box, GOOD, T0);
    expect(stripAnsi(contextLine(box, { ...ZERO, total_input_tokens: MOST_HELD_WRITTEN_AS_NONE }, T0 + SECOND, settings))).toMatch(/^Ctx 80k\/200k \[.*\] 40\.0% \(Cache: 99%\)$/);
    expect(stripAnsi(contextLine(box, { ...ZERO, total_input_tokens: LEAST_HELD_WRITTEN_AS_SOME }, T0 + SECOND, settings))).toMatch(/^Ctx 100\/200k \[.*\] 0\.1%$/);
  });

  describe.each<[string, StatuslineSettings["context"]]>([
    ["buffered", {}],
    ["raw", { estimate: "raw" }],
  ])("under the %s estimate", (_, estimate) => {
    it.each<[NonNullable<NonNullable<StatuslineSettings["context"]>["value"]>, RegExp, RegExp]>([
      ["both", /^Ctx 200k\/200k \[.*\] 100\.0%$/, /^Ctx 80k\/200k \[.*\] 40\.0% \(Cache: 99%\)$/],
      ["percent", /^Ctx \[.*\] 100\.0%$/, /^Ctx \[.*\] 40\.0% \(Cache: 99%\)$/],
      ["tokens", /^Ctx \[.*\] 200k\/200k$/, /^Ctx \[.*\] 80k\/200k \(Cache: 99%\)$/],
      ["remaining", /^Ctx \[.*\] 0\.0%$/, /^Ctx \[.*\] 60\.0% \(Cache: 99%\)$/],
    ])("decides by the percentage in use whatever context.value %s writes, so a whole window held stands and an estimate of 0.0 to one decimal is rewritten", (value, stands, rewritten) => {
      const box = machine();
      contextLine(box, GOOD, T0);
      const settings: StatuslineSettings = { context: { ...estimate, value } };
      expect(stripAnsi(contextLine(box, { ...ZERO, total_input_tokens: WINDOW }, T0 + SECOND, settings))).toMatch(stands);
      expect(stripAnsi(contextLine(box, { ...ZERO, total_input_tokens: MOST_HELD_WRITTEN_AS_NONE }, T0 + SECOND, settings))).toMatch(rewritten);
    });
  });

  it("measures the tokens a frame with no window holds against the window the settings give to decide that it is a reading", () => {
    const box = machine();
    contextLine(box, GOOD, T0);
    expect(stripAnsi(contextLine(box, { used_percentage: 0, total_input_tokens: QUARTER_HELD }, T0 + SECOND, { context: { autoCompactWindow: WINDOW } }))).toMatch(/^Ctx 50k\/200k \[.*\] 25\.0%$/);
  });

  it("draws the hit ratio the payload reports beside a rewritten frame, as it does beside the payload's own", () => {
    const box = machine();
    contextLine(box, GOOD, T0);
    const line = renderAt(box, { transcript_path: TRANSCRIPT, context_window: ZERO, prompt_cache: { hit_ratio: HALF_HIT_RATIO } }, T0 + SECOND, { layout: { header: [], rows: ["context"] } });
    expect(stripAnsi(line)).toMatch(/^Ctx 80k\/200k \[.*\] 40\.0% \(Cache: 50%\)$/);
  });

  it("rewrites a frame whose last request carries other fields beside four counters of 0, as claude-hud checks only the four", () => {
    const box = machine();
    contextLine(box, GOOD, T0);
    expect(stripAnsi(contextLine(box, { ...ZERO, current_usage: { ...ZERO_USAGE, service_tier: "standard" } }, T0 + SECOND))).toMatch(/ 40\.0% /);
  });

  it("keeps the frame's last request beside the percentage a compaction left, so the breakdown reads the frame's own counters", () => {
    const box = machine({ [TRANSCRIPT]: `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(T0).toISOString(), compactMetadata: { postTokens: CRITICAL_POST_TOKENS } })}\n` });
    expect(stripAnsi(contextLine(box, { ...ZERO, current_usage: ZERO_USAGE }, T0 + SECOND))).toMatch(/^Ctx 0\/200k \[.*\] 90\.0% \(in: 0, cache: 0\)$/);
  });

  it("reads a percentage or a counter of the last request that is not a number as absent, so the frame is rewritten", () => {
    const box = machine();
    contextLine(box, GOOD, T0);
    for (const malformed of [{ ...ZERO, used_percentage: "abc" }, { ...ZERO, current_usage: { input_tokens: "x" } }]) {
      expect(stripAnsi(contextLine(box, malformed, T0 + SECOND))).toMatch(/ 40\.0% /);
    }
  });

  it("reads a percentage or a counter of the last request too large for a number, which JSON parses to Infinity, as absent, so the frame is rewritten", () => {
    const box = machine();
    contextLine(box, GOOD, T0);
    for (const overflowing of ['{"context_window_size":200000,"used_percentage":1e999}', '{"context_window_size":200000,"used_percentage":0,"current_usage":{"input_tokens":1e999}}']) {
      const frame: unknown = JSON.parse(overflowing);
      expect(stripAnsi(contextLine(box, frame, T0 + SECOND))).toMatch(/ 40\.0% /);
    }
  });

  it("restores the last good frame past later system records that are not compactions, as claude-hud does", () => {
    const record = cacheFileFor(fakeStatuslinePorts(), "context", TRANSCRIPT);
    const kept = { savedAtMs: T0 - SECOND, observedAtMs: T0 - SECOND, usedPercentage: GOOD_PERCENT, windowTokens: WINDOW };
    const lines = [
      { type: "system", subtype: "compact_boundary", timestamp: new Date(T0 - 2 * SECOND).toISOString(), compactMetadata: { postTokens: POST_TOKENS } },
      { type: "system", subtype: "turn_duration", timestamp: new Date(T0).toISOString(), content: "done" },
      { type: "system", subtype: "local_command", timestamp: new Date(T0 + SECOND).toISOString(), content: "done" },
    ];
    const box = machine({ [TRANSCRIPT]: lines.map((line) => `${JSON.stringify(line)}\n`).join(""), [record]: JSON.stringify(kept) });
    expect(stripAnsi(contextLine(box, ZERO, T0 + 2 * SECOND))).toMatch(/ 40\.0%$/);
  });

  it("draws the percentage a compaction in the newest window left while the transcript reader is still catching up with a transcript too big to read at once", () => {
    const filler = promptLine(T0 - SECOND, FILLER_CHARACTERS).repeat(Math.ceil((FILLER_READS * MAX_TRANSCRIPT_READ_BYTES) / FILLER_CHARACTERS));
    const boundary = `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(T0 + SECOND).toISOString(), compactMetadata: { postTokens: POST_TOKENS } })}\n`;
    const text = filler + boundary;
    expect(readTranscript(fakeStatuslinePorts(fakeStatuslineFilesystem({ [TRANSCRIPT]: text }).ports), TRANSCRIPT, T0)?.complete).toBe(false);
    const box = machine({ [TRANSCRIPT]: text });
    contextLine(box, HIGH, T0);
    expect(stripAnsi(contextLine(box, ZERO, T0 + 2 * SECOND))).toMatch(/^Ctx 0\/200k \[.*\] 15\.0%$/);
  });

  it("counts a compaction stamped later than the reading within the same second, comparing the two to the millisecond as claude-hud does", () => {
    const boundary = `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(T0 + BOUNDARY_OFFSET_MS).toISOString(), compactMetadata: { postTokens: POST_TOKENS } })}\n`;
    const box = machine({ [TRANSCRIPT]: boundary });
    contextLine(box, GOOD, T0 + READING_OFFSET_MS);
    expect(stripAnsi(contextLine(box, ZERO, T0 + SECOND))).toMatch(/^Ctx 0\/200k \[.*\] 15\.0%$/);
  });

  it("draws no tokens held for a restored frame whose record holds none, rather than the tokens the zero frame reports", () => {
    const box = machine();
    drawnAt(box, { context_window_size: WINDOW, used_percentage: GOOD_PERCENT, current_usage: GOOD.current_usage }, T0);
    expect(stripAnsi(contextLine(box, { ...ZERO, total_input_tokens: MOST_HELD_WRITTEN_AS_NONE }, T0 + SECOND))).toMatch(/^Ctx \[.*\] 40\.0% \(Cache: 99%\)$/);
  });

  it("draws the zero as before when there is no record and no compaction", () => {
    expect(stripAnsi(contextLine(machine(), ZERO, T0))).toMatch(/^Ctx 0\/200k \[.*\] 0\.0%$/);
  });
});

/** A transcript line of `characters` characters of prompt, written at `atMs`. */
function promptLine(atMs: number, characters: number): string {
  return `${JSON.stringify({ type: "user", timestamp: new Date(atMs).toISOString(), message: { role: "user", content: "x".repeat(characters) } })}\n`;
}

/** Enough prompt for the transcript's growth between two refreshes a second apart to give a speed. */
const GROWTH_CHARACTERS = 4_000;
/** A directory the statusline runs in other than the fake ports' own. */
const OTHER_WORKING_DIRECTORY = "/work/other";

describe("the speed on a suspicious zero", () => {
  /** The speed segment alone for `frame`, rendered with `box`'s ports at `nowMs` after the transcript has grown by a line, for a payload naming `transcriptPath`. */
  function speedAt(box: ReturnType<typeof machine>, frame: ContextWindowFrame, nowMs: number, transcriptPath = TRANSCRIPT): string {
    box.at(nowMs);
    box.files.set(TRANSCRIPT, `${box.files.get(TRANSCRIPT) ?? ""}${promptLine(nowMs, GROWTH_CHARACTERS)}`);
    const payload = parseClientPayload({ transcript_path: transcriptPath, context_window: frame });
    return renderStatuslineBlock({ summary: fakeStatuslineSummary(), view: viewOf(payload), payload, terminalWidth: 200, nowMs, settings: resolveStatusline({ layout: { header: ["speed"], rows: [] } }), ports: box.ports });
  }

  /** `GOOD` with more output tokens written since. */
  const WRITING: ContextWindowFrame = { ...GOOD, current_usage: { ...usage(GOOD_INPUT, GOOD_CACHE_READ), output_tokens: GOOD_INPUT } };

  /** `GOOD` with a last request that reports no output tokens, so the speed is measured by the transcript's growth. */
  const SILENT: ContextWindowFrame = { ...GOOD, current_usage: { input_tokens: GOOD_INPUT, cache_read_input_tokens: GOOD_CACHE_READ } };

  it("keeps the sample for the transcript path with the white space around it removed, as claude-hud does, so a padded path measures against the unpadded one's sample", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    speedAt(box, GOOD, T0);
    expect(speedAt(box, WRITING, T0 + SECOND, ` ${TRANSCRIPT}\t`)).toMatch(/^out: \d+\.\d tok\/s$/);
    expect(box.files.has(cacheFileFor(box.ports, "speed", TRANSCRIPT))).toBe(true);
  });

  it("measures the growth of the transcript at the path with the white space around it removed when the frame reports no output tokens, as claude-hud does", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    const padded = ` ${TRANSCRIPT}\t`;
    speedAt(box, SILENT, T0, padded);
    expect(speedAt(box, SILENT, T0 + SECOND, padded)).toMatch(/^out: \d+\.\d tok\/s$/);
  });

  it("keeps no sample while no file is at the transcript path, so the refresh on which it appears draws no speed and the next measures its growth, as claude-hud does", () => {
    const box = machine();
    expect(speedAt(box, SILENT, T0, OTHER_TRANSCRIPT)).toBe("");
    const first = promptLine(T0, GROWTH_CHARACTERS);
    box.files.set(OTHER_TRANSCRIPT, first);
    expect(speedAt(box, SILENT, T0 + SECOND, OTHER_TRANSCRIPT)).toBe("");
    box.files.set(OTHER_TRANSCRIPT, `${first}${promptLine(T0 + SECOND, GROWTH_CHARACTERS)}`);
    expect(speedAt(box, SILENT, T0 + 2 * SECOND, OTHER_TRANSCRIPT)).toMatch(/^out: \d+\.\d tok\/s$/);
  });

  it("measures the transcript's size as the file system reports it, without reading the file, as claude-hud stats it", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    const unreadable = { ...box, ports: { ...box.ports, readRange: () => undefined } };
    speedAt(unreadable, SILENT, T0);
    expect(speedAt(unreadable, SILENT, T0 + SECOND)).toMatch(/^out: \d+\.\d tok\/s$/);
  });

  it("keeps the sample for the transcript path resolved against the directory the statusline runs in, so one relative path sent from two directories keeps two samples, as claude-hud resolves it against its own", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    const runningIn = (directory: string): ReturnType<typeof machine> => ({ ...box, ports: { ...box.ports, absolutePath: (target) => path.resolve(directory, target) } });
    const relative = path.basename(TRANSCRIPT);
    speedAt(runningIn(path.dirname(TRANSCRIPT)), GOOD, T0, relative);
    expect(speedAt(runningIn(OTHER_WORKING_DIRECTORY), WRITING, T0 + SECOND, relative)).toBe("");
    expect(speedAt(box, WRITING, T0 + SECOND)).toMatch(/^out: \d+\.\d tok\/s$/);
  });

  it.each(["  ", "\t\n"])("draws no speed and keeps no sample for a transcript path of white space alone (%j), as claude-hud draws none", (blank) => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    speedAt(box, GOOD, T0, blank);
    expect(speedAt(box, WRITING, T0 + SECOND, blank)).toBe("");
    expect(box.files.has(cacheFileFor(box.ports, "speed", blank))).toBe(false);
    expect(box.files.has(cacheFileFor(box.ports, "speed", ""))).toBe(false);
  });

  it("measures the restored frame's output tokens, as claude-hud's rewritten payload does, so a restored count that has not moved shows no speed", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    speedAt(box, GOOD, T0);
    expect(speedAt(box, ZERO, T0 + SECOND)).toBe("");
    expect(speedAt(box, ZERO, T0 + 2 * SECOND)).toBe("");
  });

  it("measures the transcript's growth on a suspicious zero the row draws as it stands from the tokens it holds, where claude-hud measures the output tokens of the last good frame it restores", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    speedAt(box, GOOD, T0);
    const holding: ContextWindowFrame = { ...ZERO, total_input_tokens: RESTORED_HELD };
    speedAt(box, holding, T0 + SECOND);
    expect(speedAt(box, holding, T0 + 2 * SECOND)).toMatch(/^out: \d+\.\d tok\/s$/);
  });

  it("reads the record once in a render that draws both the speed and the context row", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    const record = cacheFileFor(box.ports, "context", TRANSCRIPT);
    let reads = 0;
    const counted: StatuslinePorts = {
      ...box.ports,
      readText: (target) => {
        reads += target === record ? 1 : 0;
        return box.ports.readText(target);
      },
    };
    drawnAt(box, GOOD, T0);
    const payload = parseClientPayload({ transcript_path: TRANSCRIPT, context_window: ZERO });
    renderStatuslineBlock({ summary: fakeStatuslineSummary(), view: viewOf(payload), payload, terminalWidth: 200, nowMs: T0 + SECOND, settings: resolveStatusline({ layout: { header: ["speed"], rows: ["context"] } }), ports: counted });
    expect(reads).toBe(1);
  });

  it("measures the output tokens of a frame given a compaction's percentage, not the transcript's growth", () => {
    const boundary = `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(T0).toISOString(), compactMetadata: { postTokens: CRITICAL_POST_TOKENS } })}\n`;
    const box = machine({ [TRANSCRIPT]: boundary });
    const zeroCounters: ContextWindowFrame = { ...ZERO, current_usage: ZERO_USAGE };
    speedAt(box, zeroCounters, T0 + SECOND);
    expect(speedAt(box, zeroCounters, T0 + 2 * SECOND)).toBe("");
  });

  it("draws no speed on the first refresh measured by the transcript's growth after one measured by output tokens, since one sample is kept per transcript, where claude-hud keeps one per basis", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    speedAt(box, GOOD, T0);
    expect(speedAt(box, { context_window_size: WINDOW, used_percentage: GOOD_PERCENT }, T0 + SECOND)).toBe("");
  });

  it("keeps a restored frame's sample by its output tokens alone, so the next refresh measured by the transcript's growth draws no speed either", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    speedAt(box, GOOD, T0);
    expect(speedAt(box, ZERO, T0 + SECOND)).toBe("");
    expect(speedAt(box, { context_window_size: WINDOW, used_percentage: GOOD_PERCENT }, T0 + 2 * SECOND)).toBe("");
  });

  it("keeps a sample measured by an output count of 0 by that count alone, so the next refresh measured by the transcript's growth draws no speed", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    speedAt(box, { ...GOOD, current_usage: { ...usage(GOOD_INPUT, GOOD_CACHE_READ), output_tokens: 0 } }, T0);
    expect(speedAt(box, { context_window_size: WINDOW, used_percentage: GOOD_PERCENT }, T0 + SECOND)).toBe("");
  });

  it("estimates from the transcript's growth when the frame drawn reports no output tokens", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    speedAt(box, ZERO, T0);
    expect(speedAt(box, ZERO, T0 + SECOND)).toMatch(/^out: \d+\.\d tok\/s$/);
  });

  it("measures the transcript's growth on a frame restored from a record with no last request, not the zero frame's own count", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    drawnAt(box, { context_window_size: WINDOW, used_percentage: GOOD_PERCENT, total_input_tokens: GOOD_HELD }, T0);
    const zeroCounters: ContextWindowFrame = { ...ZERO, current_usage: ZERO_USAGE };
    speedAt(box, zeroCounters, T0 + SECOND);
    expect(speedAt(box, zeroCounters, T0 + 2 * SECOND)).toMatch(/^out: \d+\.\d tok\/s$/);
  });

  it("estimates from the transcript's growth when the frame drawn reports a last request without its output tokens, as claude-hud does", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    const noOutput: ContextWindowFrame = { ...GOOD, current_usage: { input_tokens: GOOD_INPUT, cache_read_input_tokens: GOOD_CACHE_READ } };
    speedAt(box, noOutput, T0);
    expect(speedAt(box, noOutput, T0 + SECOND)).toMatch(/^out: \d+\.\d tok\/s$/);
  });
});

/** The ids of two sessions: the record is keyed by the transcript the payload names, never by the session's id. */
const SESSION_ID = "session-a";
const OTHER_SESSION_ID = "session-b";
/** How far ahead of the clock a record is written (beyond the write interval), and how far ahead of it the reading behind a record was taken (beyond a compaction stamped a write interval later). */
const AHEAD_INTERVALS = 3;
const AHEAD_MS = AHEAD_INTERVALS * CONTEXT_WRITE_INTERVAL_MS;
const FAR_AHEAD_MS = AHEAD_INTERVALS * AHEAD_MS;
/** A time of writing ahead of the clock by more than the longest a record is drawn for. */
const BEYOND_MAX_AGE_AHEAD_MS = 2 * CONTEXT_RECORD_MAX_AGE_MS;
/** How many times `WINDOW` the window a frame reports after a switch to a larger model is. */
const WINDOW_GROWTH = 5;
/** The refresh, counted in write intervals, at which a record written back twice is restored a third time. */
const THIRD_RESTORE_INTERVALS = 3;

describe("the record kept whatever the layout draws", () => {
  const nothingFromTheFrame: StatuslineSettings = { layout: { header: [], rows: [] } };

  it("keeps a good frame in a render that lists neither the context row nor the speed segment, so a later zero draws it", () => {
    const box = machine();
    renderAt(box, { transcript_path: TRANSCRIPT, context_window: GOOD }, T0, nothingFromTheFrame);
    expect(box.files.has(cacheFileFor(box.ports, "context", TRANSCRIPT))).toBe(true);
    expect(stripAnsi(contextLine(box, ZERO, T0 + SECOND))).toMatch(/ 40\.0% /);
  });

  it("writes a restored frame back in such a render, measuring the record's age from that write", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    renderAt(box, { transcript_path: TRANSCRIPT, context_window: ZERO }, T0 + CONTEXT_RECORD_MAX_AGE_MS, nothingFromTheFrame);
    expect(stripAnsi(contextLine(box, ZERO, T0 + CONTEXT_RECORD_MAX_AGE_MS + SECOND))).toMatch(/ 40\.0% /);
  });

  it("keeps a good frame in a compact render that lists nothing, so a later zero draws it", () => {
    const box = machine();
    renderAt(box, { transcript_path: TRANSCRIPT, context_window: GOOD }, T0, { layout: { mode: "compact", header: [], rows: [] } });
    expect(stripAnsi(contextLine(box, ZERO, T0 + SECOND))).toMatch(/ 40\.0% /);
  });

  it("is worked out where the first element asks for it, so the elements before that one do their reading first, as before the render asked on its own", () => {
    const box = machine();
    const record = cacheFileFor(box.ports, "context", TRANSCRIPT);
    const order: string[] = [];
    const counted: StatuslinePorts = {
      ...box.ports,
      // A read of the record starts by asking for its size, which tells a regular file from anything else.
      fileSize: (target) => {
        order.push(target === record ? "record" : "other");
        return box.ports.fileSize(target);
      },
    };
    const elements: ElementRegistry = {
      ...ELEMENTS,
      header: {
        ...ELEMENTS.header,
        model: () => {
          order.push("model");
          return undefined;
        },
      },
    };
    const parsed = parseClientPayload({ transcript_path: TRANSCRIPT, context_window: ZERO });
    renderStatuslineBlock({ summary: fakeStatuslineSummary(), view: viewOf(parsed), payload: parsed, terminalWidth: 200, nowMs: T0, settings: resolveStatusline({ layout: { header: ["model"], rows: ["context"] } }), ports: counted, elements });
    expect(order.filter((step) => step !== "other")).toEqual(["model", "record"]);
  });

  it("is worked out after every row when no element asks for it, so the rows do their reading first, as before the render asked on its own", () => {
    const box = machine();
    const record = cacheFileFor(box.ports, "context", TRANSCRIPT);
    const order: string[] = [];
    const counted: StatuslinePorts = {
      ...box.ports,
      // A read of the record starts by asking for its size, which tells a regular file from anything else.
      fileSize: (target) => {
        order.push(target === record ? "record" : "other");
        return box.ports.fileSize(target);
      },
    };
    const elements: ElementRegistry = {
      ...ELEMENTS,
      rows: {
        ...ELEMENTS.rows,
        tokens: () => {
          order.push("tokens");
          return { kind: "text", lines: [] };
        },
      },
    };
    const parsed = parseClientPayload({ transcript_path: TRANSCRIPT, context_window: ZERO });
    renderStatuslineBlock({ summary: fakeStatuslineSummary(), view: viewOf(parsed), payload: parsed, terminalWidth: 200, nowMs: T0, settings: resolveStatusline({ layout: { header: [], rows: ["tokens"] } }), ports: counted, elements });
    expect(order.filter((step) => step !== "other")).toEqual(["tokens", "record"]);
  });

  it("reads the transcript in such a render only for a frame the rewrite may take", () => {
    const box = machine({ [TRANSCRIPT]: promptLine(T0, 1) });
    let reads = 0;
    const counted: StatuslinePorts = {
      ...box.ports,
      readRange: (target, position, length) => {
        reads += target === TRANSCRIPT ? 1 : 0;
        return box.ports.readRange(target, position, length);
      },
      readText: (target) => {
        reads += target === TRANSCRIPT ? 1 : 0;
        return box.ports.readText(target);
      },
    };
    const render = (frame: ContextWindowFrame, nowMs: number): void => {
      box.at(nowMs);
      const parsed = parseClientPayload({ transcript_path: TRANSCRIPT, context_window: frame });
      renderStatuslineBlock({ summary: fakeStatuslineSummary(), view: viewOf(parsed), payload: parsed, terminalWidth: 200, nowMs, settings: resolveStatusline(nothingFromTheFrame), ports: counted });
    };
    render(GOOD, T0);
    expect(reads).toBe(0);
    render(ZERO, T0 + SECOND);
    expect(reads).toBeGreaterThan(0);
  });
});

describe("the record keyed by the transcript", () => {
  it("restores the record of the transcript the payload names, whatever the session's id", () => {
    const box = machine();
    renderAt(box, { session_id: SESSION_ID, transcript_path: TRANSCRIPT, context_window: GOOD }, T0, {});
    expect(stripAnsi(renderAt(box, { session_id: SESSION_ID, transcript_path: OTHER_TRANSCRIPT, context_window: ZERO }, T0 + SECOND, { layout: { header: [], rows: ["context"] } }))).toMatch(/ 0\.0%$/);
    expect(stripAnsi(renderAt(box, { session_id: OTHER_SESSION_ID, transcript_path: TRANSCRIPT, context_window: ZERO }, T0 + SECOND, { layout: { header: [], rows: ["context"] } }))).toMatch(/ 40\.0% /);
  });

  it("keys the record the row draws from by the transcript path with the white space around it removed, as claude-hud does, so a padded path names the same record", () => {
    const box = machine();
    const rowOnly: StatuslineSettings = { layout: { header: [], rows: ["context"] } };
    renderAt(box, { transcript_path: TRANSCRIPT, context_window: GOOD }, T0, rowOnly);
    expect(stripAnsi(renderAt(box, { transcript_path: `${TRANSCRIPT} `, context_window: ZERO }, T0 + SECOND, rowOnly))).toMatch(/ 40\.0% /);
  });

  it("reads the compaction from the transcript at the path as the payload sends it, so a padded path names a transcript that is not there", () => {
    const box = machine({ [TRANSCRIPT]: `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(T0).toISOString(), compactMetadata: { postTokens: POST_TOKENS } })}\n` });
    const rowOnly: StatuslineSettings = { layout: { header: [], rows: ["context"] } };
    expect(stripAnsi(renderAt(box, { transcript_path: `${TRANSCRIPT} `, context_window: ZERO }, T0 + SECOND, rowOnly))).toMatch(/ 0\.0%$/);
    expect(stripAnsi(renderAt(box, { transcript_path: TRANSCRIPT, context_window: ZERO }, T0 + SECOND, rowOnly))).toMatch(/ 15\.0%$/);
  });
});

describe("the record of an odd good frame", () => {
  it.each<[string, ContextWindowFrame]>([
    ["a negative figure of tokens held", { ...GOOD, total_input_tokens: NEGATIVE_COUNT }],
    ["a negative counter of the last request", { ...GOOD, current_usage: { ...ZERO_USAGE, input_tokens: NEGATIVE_COUNT, output_tokens: NEGATIVE_COUNT, cache_creation_input_tokens: NEGATIVE_COUNT, cache_read_input_tokens: NEGATIVE_COUNT } }],
    ["a percentage above 100", { ...GOOD, used_percentage: FULL_PERCENT + GOOD_PERCENT }],
    ["a fraction of a token in the tokens held", { ...GOOD, total_input_tokens: GOOD_HELD + HALF_TOKEN }],
    ["a fraction of a token in each counter of the last request", { ...GOOD, current_usage: { input_tokens: GOOD_INPUT + HALF_TOKEN, output_tokens: HALF_TOKEN, cache_creation_input_tokens: HALF_TOKEN, cache_read_input_tokens: GOOD_CACHE_READ + HALF_TOKEN } }],
  ])("is written in a shape it reads back, for a frame with %s", (_, odd) => {
    const box = machine();
    drawnAt(box, odd, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND)).toEqual({ ...ZERO, used_percentage: odd.used_percentage, total_input_tokens: odd.total_input_tokens, current_usage: odd.current_usage });
  });
});

describe("a record written or observed ahead of the clock", () => {
  it.each([AHEAD_MS, BEYOND_MAX_AGE_AHEAD_MS])("is not written over while its time of writing is ahead of the clock, however far (%i ms)", (aheadMs) => {
    const box = machine();
    drawnAt(box, GOOD, T0 + aheadMs);
    drawnAt(box, LATER, T0);
    expect(drawnAt(box, ZERO, T0)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("keeps the time of a reading ahead of the clock through a write-back, so a compaction stamped before that time does not count", () => {
    const file = cacheFileFor(fakeStatuslinePorts(), "context", TRANSCRIPT);
    const ahead = { savedAtMs: T0 - SECOND, observedAtMs: T0 + FAR_AHEAD_MS, usedPercentage: GOOD_PERCENT, windowTokens: WINDOW };
    const box = machine({ [file]: JSON.stringify(ahead) });
    expect(drawnAt(box, ZERO, T0)?.used_percentage).toBe(GOOD_PERCENT);
    expect(box.files.get(file)).toContain(`"observedAtMs":${String(T0 + FAR_AHEAD_MS)}`);
    expect(drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS, { atMs: T0 + SECOND, postTokens: POST_TOKENS })?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("keeps a frame given the percentage of a compaction stamped ahead of the clock as read at that compaction's time, so a later frame restores it over a new window rather than counting the compaction again", () => {
    // The parity document's kept differences: "The compaction guard compares a compaction's time with the time of the reading the last good frame came from, which [...] for a frame given a compaction's percentage, is that compaction's time", so claude-hud, which compares with its last write, counts the compaction again and draws it over the new window.
    const box = machine();
    const ahead: Compaction = { atMs: T0 + FAR_AHEAD_MS, postTokens: POST_TOKENS };
    expect(drawnAt(box, ZERO, T0, ahead)?.used_percentage).toBe(POST_PERCENT);
    const widened = { ...ZERO, context_window_size: WINDOW * WINDOW_GROWTH };
    expect(drawnAt(box, widened, T0 + CONTEXT_WRITE_INTERVAL_MS + SECOND, ahead)).toEqual({ ...widened, used_percentage: POST_PERCENT });
  });
});

describe("a restored frame written back", () => {
  it("keeps the restored tokens and last request, so the next restore draws them again", () => {
    const box = machine();
    drawnAt(box, GOOD, T0);
    const restoredFrame = { ...ZERO, used_percentage: GOOD_PERCENT, total_input_tokens: GOOD_HELD, current_usage: GOOD.current_usage };
    expect(drawnAt(box, ZERO, T0 + CONTEXT_WRITE_INTERVAL_MS)).toEqual(restoredFrame);
    expect(drawnAt(box, ZERO, T0 + 2 * CONTEXT_WRITE_INTERVAL_MS)).toEqual(restoredFrame);
    expect(stripAnsi(contextLine(box, ZERO, T0 + THIRD_RESTORE_INTERVALS * CONTEXT_WRITE_INTERVAL_MS))).toMatch(/^Ctx 80k\/200k /);
  });
});

describe("a good frame that reports no last request", () => {
  it("is restored with no last request, so the row draws no breakdown for it, as claude-hud restores its null", () => {
    const box = machine();
    drawnAt(box, { context_window_size: WINDOW, used_percentage: GOOD_PERCENT, total_input_tokens: GOOD_HELD }, T0);
    expect(drawnAt(box, ZERO, T0 + SECOND)).toEqual({ ...ZERO, used_percentage: GOOD_PERCENT, total_input_tokens: GOOD_HELD, current_usage: undefined });
  });
});

/** A fraction of a millisecond, which no clock reading carries but a record's time may. */
const HALF_A_MILLISECOND = 0.5;

describe("a record in the shape agent-shim reads", () => {
  it("is restored whatever number its times and window hold, a time with a fraction of a millisecond and a window of 0 or below included", () => {
    const record = cacheFileFor(fakeStatuslinePorts(), "context", TRANSCRIPT);
    const kept = { savedAtMs: T0 - SECOND + HALF_A_MILLISECOND, observedAtMs: T0 - SECOND + HALF_A_MILLISECOND, usedPercentage: GOOD_PERCENT, windowTokens: NEGATIVE_WINDOW };
    const box = machine({ [record]: JSON.stringify(kept) });
    expect(drawnAt(box, ZERO, T0)?.used_percentage).toBe(GOOD_PERCENT);
  });

  it("is restored when it holds no window, the frame keeping its own", () => {
    const record = cacheFileFor(fakeStatuslinePorts(), "context", TRANSCRIPT);
    const kept = { savedAtMs: T0 - SECOND, observedAtMs: T0 - SECOND, usedPercentage: GOOD_PERCENT };
    const box = machine({ [record]: JSON.stringify(kept) });
    expect(drawnAt(box, ZERO, T0)).toEqual({ ...ZERO, used_percentage: GOOD_PERCENT, total_input_tokens: undefined, current_usage: undefined });
  });
});

describe("a restored record holding a percentage of 0 or below", () => {
  it("is drawn from the tokens it holds, the row reading the frame drawn and not the payload's, whose percentage is 0 too", () => {
    const record = cacheFileFor(fakeStatuslinePorts(), "context", TRANSCRIPT);
    const kept = { savedAtMs: T0 - SECOND, observedAtMs: T0 - SECOND, usedPercentage: 0, totalInputTokens: RESTORED_HELD, windowTokens: WINDOW };
    const box = machine({ [record]: JSON.stringify(kept) });
    const line = stripAnsi(contextLine(box, ZERO, T0, { context: { estimate: "raw" } }));
    expect(line).toContain("60k/200k");
    expect(line).toMatch(/ 30\.0%$/);
  });

  it("is drawn with a negative percentage as a frame reporting none: from the tokens it holds, or as no row when it holds none", () => {
    const record = cacheFileFor(fakeStatuslinePorts(), "context", TRANSCRIPT);
    const negative = { savedAtMs: T0 - SECOND, observedAtMs: T0 - SECOND, usedPercentage: NEGATIVE_PERCENT, windowTokens: WINDOW };
    const settings: StatuslineSettings = { context: { estimate: "raw" } };
    expect(stripAnsi(contextLine(machine({ [record]: JSON.stringify(negative) }), ZERO, T0, settings))).toBe("");
    const held = stripAnsi(contextLine(machine({ [record]: JSON.stringify({ ...negative, totalInputTokens: RESTORED_HELD }) }), ZERO, T0, settings));
    expect(held).toMatch(/ 30\.0%$/);
  });
});

describe("the order a frame is rewritten in", () => {
  it("reads the record before the transcript, so a record the transcript read's housekeeping removes is still the one this frame restores", () => {
    const record = cacheFileFor(fakeStatuslinePorts(), "context", TRANSCRIPT);
    const kept = { savedAtMs: T0 - SECOND, observedAtMs: T0 - SECOND, usedPercentage: GOOD_PERCENT, windowTokens: WINDOW };
    const boundary = `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(T0 - 2 * SECOND).toISOString(), compactMetadata: { postTokens: POST_TOKENS } })}\n`;
    const box = machine({ [TRANSCRIPT]: boundary, [record]: JSON.stringify(kept) });
    // Last written, by the file's own time, before the retention of the statusline's session state, which the transcript reader's first write prunes by.
    box.mtimes.set(path.normalize(record), T0 - CACHE_RETENTION_MS - SECOND);
    expect(stripAnsi(contextLine(box, ZERO, T0))).toMatch(/ 40\.0%$/);
  });
});

describe("the speed measured by the transcript's growth on the file system", () => {
  /** A frame that reports no last request, so the speed is measured by the transcript's growth. */
  const NO_OUTPUT: ContextWindowFrame = { context_window_size: WINDOW, used_percentage: GOOD_PERCENT };

  /** `use`d with a throwaway directory holding the empty transcript `t.jsonl`, a directory `sub`, and a link `ln` to the directory `elsewhere/deep`, removed afterwards. */
  function onDisk(use: (directory: string, transcript: string) => void): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-speed-"));
    try {
      const transcript = path.join(directory, "t.jsonl");
      fs.writeFileSync(transcript, "");
      fs.mkdirSync(path.join(directory, "sub"));
      fs.mkdirSync(path.join(directory, "elsewhere", "deep"), { recursive: true });
      fs.symlinkSync(path.join(directory, "elsewhere", "deep"), path.join(directory, "ln"));
      use(directory, transcript);
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  }

  /** The speed segment alone at `nowMs`, rendered with real ports keeping state beneath `directory`, for a payload naming `transcriptPath`. */
  function speedOnDisk(directory: string, transcriptPath: string, nowMs: number): string {
    const payload = parseClientPayload({ transcript_path: transcriptPath, context_window: NO_OUTPUT });
    return renderStatuslineBlock({ summary: fakeStatuslineSummary(), view: viewOf(payload), payload, terminalWidth: 200, nowMs, settings: resolveStatusline({ layout: { header: ["speed"], rows: [] } }), ports: realStatuslinePorts({}, path.join(directory, "state")) });
  }

  /** Renders the speed for `transcriptPath` at `T0` and then a second later, `transcript` having grown by a line before each refresh after the first when `growFirst` is false and before both when it is true, and returns the second refresh's speed. */
  function speedAfterGrowth(directory: string, transcript: string, transcriptPath: string, growFirst: boolean): string {
    if (growFirst) {
      fs.appendFileSync(transcript, promptLine(T0, GROWTH_CHARACTERS));
    }
    speedOnDisk(directory, transcriptPath, T0);
    fs.appendFileSync(transcript, promptLine(T0 + SECOND, GROWTH_CHARACTERS));
    return speedOnDisk(directory, transcriptPath, T0 + SECOND);
  }

  it("measures a transcript that was empty from a size of 0, as claude-hud does, so the next refresh draws its growth", () => {
    onDisk((directory, transcript) => {
      expect(speedAfterGrowth(directory, transcript, transcript, false)).toMatch(/^out: \d+\.\d tok\/s$/);
    });
  });

  it.each([
    ["the transcript path", (_directory: string, transcript: string) => transcript],
    ["a `..` after a directory", (directory: string) => `${directory}/sub/../t.jsonl`],
  ])("measures the growth of the file at %s, which the file system reaches", (_name, spell) => {
    onDisk((directory, transcript) => {
      expect(speedAfterGrowth(directory, transcript, spell(directory, transcript), true)).toMatch(/^out: \d+\.\d tok\/s$/);
    });
  });

  it.each([
    ["a trailing separator after the transcript", (_directory: string, transcript: string) => `${transcript}/`],
    ["a `..` after a directory that does not exist", (directory: string) => `${directory}/missing/../t.jsonl`],
    ["a `..` after a link to a directory elsewhere", (directory: string) => `${directory}/ln/../t.jsonl`],
  ])("draws no speed for %s, which the file system does not take to the transcript though the path cleaned as text names it, as claude-hud stats the path as sent", (_name, spell) => {
    onDisk((directory, transcript) => {
      expect(speedAfterGrowth(directory, transcript, spell(directory, transcript), true)).toBe("");
    });
  });
});

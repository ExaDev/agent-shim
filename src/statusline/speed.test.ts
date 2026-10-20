import { describe, expect, it } from "vitest";

import { cacheFileFor } from "./cacheFile";
import { MIN_SPEED_GAP_MS, SPEED_WINDOW_MS, speedBetween, TRANSCRIPT_BYTES_PER_TOKEN, trackSpeed, type SpeedSample } from "./speed";
import { fakeStatuslineFilesystem, fakeStatuslinePorts } from "./testing";

const T0 = 1_000_000;
const GAP_MS = 1_000;
const TOKENS = 40;
/** Counts of output tokens at the earlier refresh, a later one that is lower (a new request), and the count a new request starts from. */
const BASE_TOKENS = 100;
const LATER_COUNT = 500;
const NEW_REQUEST_COUNT = 20;
/** A transcript's size at the earlier refresh. */
const BASE_BYTES = 10_000;
const MS_PER_SECOND = 1_000;

const tokens = (at: number, outputTokens: number): SpeedSample => ({ at, outputTokens });
const bytes = (at: number, transcriptBytes: number): SpeedSample => ({ at, transcriptBytes });

describe("speedBetween", () => {
  it("is the tokens written between two refreshes over the time between them", () => {
    expect(speedBetween(tokens(T0, BASE_TOKENS), tokens(T0 + GAP_MS, BASE_TOKENS + TOKENS))).toEqual({ tokensPerSecond: TOKENS, remember: true });
    expect(speedBetween(tokens(T0, BASE_TOKENS), tokens(T0 + 2 * GAP_MS, BASE_TOKENS + TOKENS)).tokensPerSecond).toBe(TOKENS / 2);
  });

  it("has no speed at the first sample, and keeps the sample to measure the next against", () => {
    expect(speedBetween(undefined, tokens(T0, BASE_TOKENS))).toEqual({ tokensPerSecond: undefined, remember: true });
  });

  it("has no speed when the count went backwards, which is a new request, but starts again from it", () => {
    expect(speedBetween(tokens(T0, LATER_COUNT), tokens(T0 + GAP_MS, NEW_REQUEST_COUNT))).toEqual({ tokensPerSecond: undefined, remember: true });
  });

  it("has no speed across a gap that spans a pause, and starts again from the new sample", () => {
    expect(speedBetween(tokens(T0, BASE_TOKENS), tokens(T0 + SPEED_WINDOW_MS + 1, BASE_TOKENS + TOKENS))).toEqual({ tokensPerSecond: undefined, remember: true });
    expect(speedBetween(tokens(T0, BASE_TOKENS), tokens(T0 + SPEED_WINDOW_MS, BASE_TOKENS + TOKENS)).tokensPerSecond).toBe(TOKENS / (SPEED_WINDOW_MS / MS_PER_SECOND));
  });

  it("has no speed when nothing was written, and starts again from the new sample", () => {
    expect(speedBetween(tokens(T0, BASE_TOKENS), tokens(T0 + GAP_MS, BASE_TOKENS))).toEqual({ tokensPerSecond: undefined, remember: true });
  });

  it("keeps the earlier sample through a gap too short to measure, so the next refresh measures over a longer one", () => {
    expect(speedBetween(tokens(T0, BASE_TOKENS), tokens(T0 + MIN_SPEED_GAP_MS - 1, BASE_TOKENS + TOKENS))).toEqual({ tokensPerSecond: undefined, remember: false });
    expect(speedBetween(tokens(T0, BASE_TOKENS), tokens(T0 + MIN_SPEED_GAP_MS, BASE_TOKENS + TOKENS)).tokensPerSecond).toBe(TOKENS / (MIN_SPEED_GAP_MS / MS_PER_SECOND));
  });

  it("estimates tokens from the transcript's growth when the client reports no output tokens", () => {
    expect(speedBetween(bytes(T0, BASE_BYTES), bytes(T0 + GAP_MS, BASE_BYTES + TOKENS * TRANSCRIPT_BYTES_PER_TOKEN))).toEqual({ tokensPerSecond: TOKENS, remember: true });
  });

  it("measures on one basis only: counted tokens against a sample that has them, estimates against one that has the size", () => {
    expect(speedBetween(bytes(T0, BASE_TOKENS), tokens(T0 + GAP_MS, LATER_COUNT))).toEqual({ tokensPerSecond: undefined, remember: true });
    expect(speedBetween(tokens(T0, BASE_TOKENS), bytes(T0 + GAP_MS, LATER_COUNT))).toEqual({ tokensPerSecond: undefined, remember: true });
    expect(speedBetween({ at: T0, outputTokens: BASE_TOKENS, transcriptBytes: 1_000 }, { at: T0 + GAP_MS, outputTokens: BASE_TOKENS + TOKENS, transcriptBytes: 999_999 }).tokensPerSecond).toBe(TOKENS);
  });

  it("has no speed, and keeps nothing, with neither a count nor a size to measure", () => {
    expect(speedBetween(tokens(T0, BASE_TOKENS), { at: T0 + GAP_MS })).toEqual({ tokensPerSecond: undefined, remember: false });
  });
});

describe("trackSpeed", () => {
  const TRANSCRIPT = "/sessions/one.jsonl";

  it("measures against the sample the previous refresh kept for the same transcript", () => {
    const disk = fakeStatuslineFilesystem({});
    const ports = fakeStatuslinePorts(disk.ports);
    expect(trackSpeed(ports, TRANSCRIPT, tokens(T0, BASE_TOKENS))).toBeUndefined();
    expect(trackSpeed(ports, TRANSCRIPT, tokens(T0 + GAP_MS, BASE_TOKENS + TOKENS))).toBe(TOKENS);
    expect(disk.files.get(cacheFileFor(ports, "speed", TRANSCRIPT))).toBe(JSON.stringify(tokens(T0 + GAP_MS, BASE_TOKENS + TOKENS)));
  });

  it("keeps each session's sample apart, so a session that is streaming does not make an idle one look fast", () => {
    const ports = fakeStatuslinePorts(fakeStatuslineFilesystem({}).ports);
    trackSpeed(ports, "/sessions/idle.jsonl", tokens(T0, BASE_TOKENS));
    trackSpeed(ports, "/sessions/streaming.jsonl", tokens(T0, BASE_TOKENS));
    expect(trackSpeed(ports, "/sessions/streaming.jsonl", tokens(T0 + GAP_MS, BASE_TOKENS + TOKENS))).toBe(TOKENS);
    expect(trackSpeed(ports, "/sessions/idle.jsonl", tokens(T0 + GAP_MS, BASE_TOKENS))).toBeUndefined();
  });

  it("starts again when the kept sample is not one it wrote", () => {
    const ports = fakeStatuslinePorts(fakeStatuslineFilesystem({ [cacheFileFor(fakeStatuslinePorts(), "speed", TRANSCRIPT)]: '{"at":"yesterday"}' }).ports);
    expect(trackSpeed(ports, TRANSCRIPT, tokens(T0, BASE_TOKENS))).toBeUndefined();
    expect(trackSpeed(ports, TRANSCRIPT, tokens(T0 + GAP_MS, BASE_TOKENS + TOKENS))).toBe(TOKENS);
  });
});
